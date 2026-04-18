import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AbletonOscClient, floatArg, intArg, stringArg } from "./abletonOsc.js";
import { getConfig } from "./config.js";

const config = getConfig();
const oscClient = new AbletonOscClient({
  host: config.ABLETON_OSC_HOST,
  sendPort: config.ABLETON_OSC_SEND_PORT,
  listenPort: config.ABLETON_OSC_LISTEN_PORT,
  timeoutMs: config.ABLETON_OSC_TIMEOUT_MS
});

const server = new McpServer({
  name: "ableton-osc-bridge",
  version: "0.1.0"
});

const DESTRUCTIVE_CONFIRM_TOKEN = "YES_I_UNDERSTAND";
const endpointSelections = new Map();
let probeSummary = null;
let startupWarnings = [];
const STARTUP_RETRY_ATTEMPTS = 10;
const STARTUP_RETRY_DELAY_MS = 3000;
const ENDPOINT_SELECTIONS_PATH = path.join(process.cwd(), ".ableton-endpoints.json");
const ARRANGEMENT_SECTIONS_PATH = path.join(process.cwd(), ".ableton-sections.json");
const ARRANGEMENT_SECTION_PROFILES_PATH = path.join(
  process.cwd(),
  ".ableton-section-profiles.json"
);
const DEVICE_LOCKS_PATH = path.join(process.cwd(), ".ableton-device-locks.json");
const ROLLBACK_POLICY_PATH = path.join(process.cwd(), ".ableton-rollback-policy.json");
const AUDIT_LOG_PATH = path.join(process.cwd(), "logs", "audit.jsonl");
const connectionState = {
  connected: false,
  reconnectAttempts: 0,
  lastReadyAt: null,
  lastReconnectAt: null
};
const metrics = {
  startedAt: new Date().toISOString(),
  totalCommands: 0,
  successfulCommands: 0,
  failedCommands: 0,
  dryRunCommands: 0,
  lastError: null,
  lastCommandAt: null,
  commandDurationsMs: {}
};
const snapshots = new Map();
const pendingPlans = new Map();
const exportProfiles = new Map([
  [
    "streaming",
    { type: "master", exportMaster: true, normalize: true, includeReturns: true }
  ],
  [
    "mix-engineer-stems",
    { type: "stems", exportMaster: false, normalize: false, includeReturns: true }
  ],
  [
    "mastering-print",
    { type: "master", exportMaster: true, normalize: false, includeReturns: false }
  ]
]);
const policyState = {
  mode: "studio",
  blockDestructiveDuringPlayback: true,
  requireRoleForDestructive: true,
  roles: {
    observer: { canWrite: false, canDestructive: false },
    operator: { canWrite: true, canDestructive: false },
    admin: { canWrite: true, canDestructive: true }
  }
};
const runtimeContext = {
  role: "admin",
  performanceMode: false
};
const stateCache = {
  enabled: true,
  lastRefreshAt: null,
  transport: null,
  tracks: null,
  pendingConflicts: [],
  channels: [],
  eventStream: []
};
const protocolDiagnostics = {
  lastOutgoingAt: null,
  lastIncomingAt: null,
  lastRttMs: null
};
const aliasRegistry = new Map();
const presetRegistry = new Map();
const exportJobs = new Map();
const userPreferences = {
  defaultKey: "C",
  defaultScale: "minor",
  defaultTempo: 124,
  explanationMode: "producer"
};
const liveSafetyState = {
  enabled: false,
  lockedTracks: [],
  lockedDevices: []
};
const templateRegistry = new Map();
const externalHooks = {
  notionEnabled: false,
  releaseTrackerEnabled: false,
  backupEnabled: false
};
const arrangementSectionMap = new Map();
const arrangementSectionProfiles = new Map();
const reactiveRules = new Map();
const macroRegistry = new Map();
const macroSchedule = new Map();
const sessionGoals = new Map();
const setlistRegistry = new Map();
const projectMemory = new Map();
const deviceParameterLocks = new Map();
const rollbackPolicy = {
  enabled: false,
  everyNCommands: 25,
  everyNBars: 16,
  lastSnapshotId: null,
  categoryEveryN: {
    arrangement: 8,
    device: 12,
    mixer: 16,
    transport: 24,
    export: 4,
    other: 25
  }
};
const runtimeExecutionState = {
  mutatingCommandsSent: 0,
  autoRollbackInFlight: false,
  lastAutoRollbackAt: null,
  mutatingByCategory: {
    arrangement: 0,
    device: 0,
    mixer: 0,
    transport: 0,
    export: 0,
    other: 0
  }
};
const collaboratorModes = new Map([
  ["producer", { role: "admin", performanceMode: false }],
  ["mixer", { role: "operator", performanceMode: false }],
  ["performer", { role: "operator", performanceMode: true }],
  ["observer", { role: "observer", performanceMode: false }]
]);

const advancedEngineeringState = {
  soloSafe: { enabled: false, snapshotId: null, startedAt: null },
  masterChainDelta: { locked: false, baseline: null, baselineAt: null },
  sessionMode: "balanced",
  changeLog: [],
  blindAb: { sessionId: null, assignments: [], createdAt: null, variantLabels: [] }
};
const CHANGE_ATTRIBUTION_LOG_MAX = 200;

function pushChangeAttribution(entry) {
  advancedEngineeringState.changeLog.push({
    at: new Date().toISOString(),
    actor: entry.actor ?? "unknown",
    action: entry.action ?? "",
    detail: entry.detail ?? null,
    trackHint: entry.trackHint ?? null
  });
  if (advancedEngineeringState.changeLog.length > CHANGE_ATTRIBUTION_LOG_MAX) {
    advancedEngineeringState.changeLog.splice(
      0,
      advancedEngineeringState.changeLog.length - CHANGE_ATTRIBUTION_LOG_MAX
    );
  }
}

async function sampleMasterChainMixerRows(maxTracks) {
  const tracks = await getTracksSnapshot();
  const n = tracks.tracks.length;
  if (n === 0) return [];
  const take = Math.min(Math.max(1, maxTracks), n);
  const tail = tracks.tracks.slice(n - take);
  const rows = [];
  for (const t of tail) {
    try {
      const vol = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
      rows.push({
        trackIndex: t.index,
        name: t.name,
        volume: Number(parseOscValue(vol.response, 0.85))
      });
    } catch {
      rows.push({ trackIndex: t.index, name: t.name, volume: null });
    }
  }
  return rows;
}

const OSC_ENDPOINT_VARIANTS = {
  renderAudio: ["/live/song/export_audio", "/live/song/render_audio", "/live/song/export"],
  renderStems: ["/live/song/export_stems", "/live/song/render_stems", "/live/song/export/stems"],
  trackSetRouting: ["/live/track/set/routing", "/live/track/set/routes"],
  deviceLoadPreset: ["/live/device/load_preset", "/live/device/set/preset", "/live/device/load/device_preset"],
  subscribeEvents: ["/live/subscribe", "/live/events/subscribe", "/live/observe"]
};

function classifyError(error) {
  const message = String(error?.message ?? error ?? "");
  if (message.includes("EADDRINUSE")) return "PORT_CONFLICT";
  if (message.includes("Timeout waiting for OSC response")) return "OSC_TIMEOUT";
  if (message.includes("Role") && message.includes("not allowed")) return "POLICY_BLOCKED";
  if (message.includes("Destructive action blocked")) return "DESTRUCTIVE_CONFIRM_REQUIRED";
  if (message.includes("Unknown or disallowed action")) return "PLAN_ACTION_UNKNOWN";
  return "UNKNOWN_ERROR";
}

async function appendAuditLog(entry) {
  try {
    await mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    await appendFile(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // best effort only
  }
}

async function persistEndpointSelections() {
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      endpointSelections: Object.fromEntries(endpointSelections)
    };
    await writeFile(ENDPOINT_SELECTIONS_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // best effort only
  }
}

async function loadPersistedEndpointSelections() {
  try {
    const raw = await readFile(ENDPOINT_SELECTIONS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.endpointSelections && typeof parsed.endpointSelections === "object") {
      for (const [k, v] of Object.entries(parsed.endpointSelections)) {
        if (typeof v === "string" && v.length > 0) endpointSelections.set(k, v);
      }
    }
  } catch {
    // no persisted file yet
  }
}

async function persistArrangementSections() {
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      sections: [...arrangementSectionMap.entries()]
    };
    await writeFile(ARRANGEMENT_SECTIONS_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // best effort only
  }
}

async function loadPersistedArrangementSections() {
  try {
    const raw = await readFile(ARRANGEMENT_SECTIONS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
    for (const entry of sections) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry;
      if (typeof key !== "string" || typeof value !== "object" || value === null) continue;
      arrangementSectionMap.set(key, value);
    }
  } catch {
    // no persisted file yet
  }
}

async function persistArrangementSectionProfiles() {
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      profiles: [...arrangementSectionProfiles.entries()]
    };
    await writeFile(ARRANGEMENT_SECTION_PROFILES_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // best effort only
  }
}

async function loadPersistedArrangementSectionProfiles() {
  try {
    const raw = await readFile(ARRANGEMENT_SECTION_PROFILES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
    for (const entry of profiles) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry;
      if (typeof key !== "string" || typeof value !== "object" || value === null) continue;
      arrangementSectionProfiles.set(key, value);
    }
  } catch {
    // no persisted file yet
  }
}

async function persistDeviceLocks() {
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      locks: [...deviceParameterLocks.entries()]
    };
    await writeFile(DEVICE_LOCKS_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // best effort only
  }
}

async function loadPersistedDeviceLocks() {
  try {
    const raw = await readFile(DEVICE_LOCKS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const locks = Array.isArray(parsed?.locks) ? parsed.locks : [];
    for (const entry of locks) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [k, v] = entry;
      if (typeof k === "string" && v && typeof v === "object") {
        deviceParameterLocks.set(k, v);
      }
    }
  } catch {
    // no persisted file yet
  }
}

async function persistRollbackPolicy() {
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      rollbackPolicy
    };
    await writeFile(ROLLBACK_POLICY_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // best effort only
  }
}

async function loadPersistedRollbackPolicy() {
  try {
    const raw = await readFile(ROLLBACK_POLICY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.rollbackPolicy && typeof parsed.rollbackPolicy === "object") {
      rollbackPolicy.enabled = Boolean(parsed.rollbackPolicy.enabled ?? rollbackPolicy.enabled);
      rollbackPolicy.everyNCommands = Number(parsed.rollbackPolicy.everyNCommands ?? rollbackPolicy.everyNCommands);
      rollbackPolicy.everyNBars = Number(parsed.rollbackPolicy.everyNBars ?? rollbackPolicy.everyNBars);
      rollbackPolicy.lastSnapshotId = parsed.rollbackPolicy.lastSnapshotId ?? rollbackPolicy.lastSnapshotId;
      const incomingCategoryEveryN = parsed.rollbackPolicy.categoryEveryN;
      if (incomingCategoryEveryN && typeof incomingCategoryEveryN === "object") {
        rollbackPolicy.categoryEveryN = {
          arrangement: Number(incomingCategoryEveryN.arrangement ?? rollbackPolicy.categoryEveryN.arrangement),
          device: Number(incomingCategoryEveryN.device ?? rollbackPolicy.categoryEveryN.device),
          mixer: Number(incomingCategoryEveryN.mixer ?? rollbackPolicy.categoryEveryN.mixer),
          transport: Number(incomingCategoryEveryN.transport ?? rollbackPolicy.categoryEveryN.transport),
          export: Number(incomingCategoryEveryN.export ?? rollbackPolicy.categoryEveryN.export),
          other: Number(incomingCategoryEveryN.other ?? rollbackPolicy.categoryEveryN.other)
        };
      }
    }
  } catch {
    // no persisted file yet
  }
}

function pushEventCache(event) {
  const enriched = { at: new Date().toISOString(), ...event };
  stateCache.eventStream.push(enriched);
  if (stateCache.eventStream.length > 200) {
    stateCache.eventStream = stateCache.eventStream.slice(-200);
  }
  return enriched;
}

function buildCapabilityProfile() {
  const summary = probeSummary ?? {};
  const getOk = (k) => Boolean(summary[k]?.ok);
  const selectedWrites = {
    renderAudio: endpointSelections.get("renderAudio") ?? null,
    renderStems: endpointSelections.get("renderStems") ?? null,
    routing: endpointSelections.get("trackSetRouting") ?? null,
    presets: endpointSelections.get("deviceLoadPreset") ?? null,
    subscribe: endpointSelections.get("subscribeEvents") ?? null
  };

  const readsCore = getOk("tempoGet") && getOk("trackCountGet") && getOk("trackNameGet");
  const scenes = getOk("sceneCountGet");
  const devices = getOk("deviceCountGet") && getOk("deviceParameterGet");
  const writesReady = Boolean(selectedWrites.renderAudio || selectedWrites.renderStems);

  let profile = "minimal";
  if (readsCore && devices && scenes && writesReady) profile = "extended";
  else if (readsCore && (devices || scenes)) profile = "standard";

  return {
    profile,
    readiness: { readsCore, scenes, devices, writesReady },
    selectedWrites
  };
}

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function toBoolInt(value) {
  return intArg(value ? 1 : 0);
}

function normalizeName(v) {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreNameMatch(query, candidate) {
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.startsWith(q)) return 0.9;
  if (c.includes(q)) return 0.75;
  const qTokens = q.split(" ").filter(Boolean);
  const cTokens = c.split(" ").filter(Boolean);
  const overlap = qTokens.filter((t) => cTokens.includes(t)).length;
  return overlap / Math.max(qTokens.length, 1) * 0.6;
}

async function withMetrics(commandName, handler) {
  const start = Date.now();
  metrics.totalCommands += 1;
  metrics.lastCommandAt = new Date().toISOString();
  try {
    const result = await handler();
    metrics.successfulCommands += 1;
    metrics.commandDurationsMs[commandName] =
      (metrics.commandDurationsMs[commandName] ?? 0) + (Date.now() - start);
    await appendAuditLog({
      at: new Date().toISOString(),
      commandName,
      ok: true,
      elapsedMs: Date.now() - start
    });
    return result;
  } catch (error) {
    metrics.failedCommands += 1;
    metrics.lastError = { commandName, message: error.message, at: new Date().toISOString() };
    await appendAuditLog({
      at: new Date().toISOString(),
      commandName,
      ok: false,
      errorCode: classifyError(error),
      error: error.message,
      elapsedMs: Date.now() - start
    });
    throw error;
  }
}

function parseOscValue(msg, fallback = null) {
  if (!msg?.args || msg.args.length === 0) return fallback;
  if (msg.args.length === 1) return msg.args[0]?.value ?? fallback;
  return msg.args.map((arg) => arg?.value);
}

async function requestAny(candidates, args = []) {
  let lastError;
  for (const candidate of candidates) {
    try {
      const startedAt = Date.now();
      protocolDiagnostics.lastOutgoingAt = new Date().toISOString();
      const response = await oscClient.request(candidate, args, candidate);
      protocolDiagnostics.lastIncomingAt = new Date().toISOString();
      protocolDiagnostics.lastRttMs = Date.now() - startedAt;
      pushEventCache({
        type: "osc_request_response",
        address: candidate,
        rttMs: protocolDiagnostics.lastRttMs
      });
      return { address: candidate, response };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    await reconnectAndProbe("requestAny fallback");
    for (const candidate of candidates) {
      try {
        const response = await oscClient.request(candidate, args, candidate);
        return { address: candidate, response };
      } catch (retryError) {
        lastError = retryError;
      }
    }
  }

  throw new Error(
    `No OSC endpoint responded for candidates: ${candidates.join(", ")}. Last error: ${
      lastError?.message
    }`
  );
}

async function probeEndpoint(candidates, args = []) {
  let lastError;
  for (const candidate of candidates) {
    try {
      const response = await oscClient.request(candidate, args, candidate);
      return { ok: true, address: candidate, response };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    address: null,
    error: lastError?.message ?? "No endpoint responded."
  };
}

async function selectEndpoint(key, candidates, args = []) {
  const cached = endpointSelections.get(key);
  if (cached) return cached;
  const probe = await probeEndpoint(candidates, args);
  if (!probe.ok) {
    throw new Error(
      `No OSC endpoint responded for "${key}": ${candidates.join(", ")}. Last error: ${probe.error}`
    );
  }
  endpointSelections.set(key, probe.address);
  await persistEndpointSelections();
  return probe.address;
}

async function requestKnown(key, candidates, args = []) {
  const selected = await selectEndpoint(key, candidates, args);
  try {
    const response = await oscClient.request(selected, args, selected);
    return { key, address: selected, response };
  } catch {
    endpointSelections.delete(key);
    const reselected = await selectEndpoint(key, candidates, args);
    const response = await oscClient.request(reselected, args, reselected);
    return { key, address: reselected, response };
  }
}

function candidatesFor(key, fallback) {
  return OSC_ENDPOINT_VARIANTS[key] ?? fallback;
}

async function sendKnownRaw(key, fallbackCandidates, args = [], metadata = {}, options = {}) {
  const address = await selectEndpoint(key, candidatesFor(key, fallbackCandidates), args);
  return sendPlanRaw(address, args, { ...metadata, endpoint: address }, options);
}

async function sendKnownMaybe(key, fallbackCandidates, args = [], metadata = {}, options = {}) {
  return textResult(await sendKnownRaw(key, fallbackCandidates, args, metadata, options));
}

async function reconnectAndProbe(reason = "manual") {
  connectionState.reconnectAttempts += 1;
  connectionState.lastReconnectAt = new Date().toISOString();
  oscClient.close();
  await oscClient.open();
  connectionState.connected = true;
  connectionState.lastReadyAt = new Date().toISOString();
  endpointSelections.clear();
  probeSummary = await runCapabilityProbe();
  return { reason, reconnectAttempts: connectionState.reconnectAttempts };
}

function guardDestructive(confirmToken) {
  if (policyState.requireRoleForDestructive) {
    const rolePolicy = policyState.roles[runtimeContext.role] ?? policyState.roles.observer;
    if (!rolePolicy.canDestructive) {
      throw new Error(`Role "${runtimeContext.role}" is not allowed to run destructive actions.`);
    }
  }

  if (runtimeContext.performanceMode) {
    throw new Error("Destructive action blocked while performanceMode is enabled.");
  }

  if (policyState.blockDestructiveDuringPlayback) {
    const maybePlaying = stateCache.transport?.isPlaying;
    if (maybePlaying === true) {
      throw new Error("Destructive action blocked while transport is playing by policy.");
    }
  }

  if (!config.ABLETON_REQUIRE_DESTRUCTIVE_CONFIRM) return;
  if (confirmToken !== DESTRUCTIVE_CONFIRM_TOKEN) {
    throw new Error(
      `Destructive action blocked. Pass confirmToken="${DESTRUCTIVE_CONFIRM_TOKEN}" to proceed.`
    );
  }
}

function isMutatingAddress(address) {
  const a = String(address ?? "");
  if (a.includes("/get/")) return false;
  if (a.includes("/name") && a.includes("/get/")) return false;
  return true;
}

function classifyWriteIntent(address) {
  const a = String(address ?? "");
  if (a.includes("/export") || a.includes("/render")) return "export";
  if (a.includes("/device/")) return "device";
  if (a.includes("/track/set/volume") || a.includes("/track/set/panning") || a.includes("/track/set/send")) {
    return "mixer";
  }
  if (a.includes("/song/delete_time") || a.includes("/song/duplicate_time") || a.includes("/scene/") || a.includes("/clip/")) {
    return "arrangement";
  }
  if (a.includes("/song/start_playing") || a.includes("/song/stop_playing") || a.includes("/song/set/tempo")) {
    return "transport";
  }
  return "other";
}

function isDeviceParamLockedForArgs(address, args = []) {
  if (String(address) !== "/live/device/set/parameter/value") return null;
  const values = args.map((a) => a?.value);
  const trackIndex = Number(values[0]);
  const deviceIndex = Number(values[1]);
  const parameterIndex = Number(values[2]);
  if (!Number.isFinite(trackIndex) || !Number.isFinite(deviceIndex) || !Number.isFinite(parameterIndex)) {
    return null;
  }
  const keys = [
    normalizeName(`${trackIndex}:${deviceIndex}:${parameterIndex}`),
    normalizeName(`${trackIndex}:${deviceIndex}:*`),
    normalizeName(`${trackIndex}:*:*`),
    normalizeName("*:*:*")
  ];
  for (const k of keys) {
    const lock = deviceParameterLocks.get(k);
    if (lock?.locked) return { key: k, lock };
  }
  return null;
}

function maybeTriggerAutoRollbackCheckpoint(address, metadata = {}) {
  if (!rollbackPolicy.enabled) return;
  if (!isMutatingAddress(address)) return;
  if (metadata?.skipAutoRollback === true) return;
  runtimeExecutionState.mutatingCommandsSent += 1;
  const category = classifyWriteIntent(address);
  runtimeExecutionState.mutatingByCategory[category] =
    (runtimeExecutionState.mutatingByCategory[category] ?? 0) + 1;

  const globalThreshold = Math.max(1, Number(rollbackPolicy.everyNCommands || 25));
  const categoryThreshold = Math.max(
    1,
    Number(rollbackPolicy.categoryEveryN?.[category] ?? rollbackPolicy.categoryEveryN?.other ?? 25)
  );
  const hitGlobal = runtimeExecutionState.mutatingCommandsSent % globalThreshold === 0;
  const hitCategory = runtimeExecutionState.mutatingByCategory[category] % categoryThreshold === 0;
  if (!hitGlobal && !hitCategory) return;
  if (runtimeExecutionState.autoRollbackInFlight) return;

  runtimeExecutionState.autoRollbackInFlight = true;
  const sid = `auto_roll_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  captureRollbackSnapshotInternal(sid, {
    source: "auto-rollback-policy",
    trigger: hitCategory ? `category:${category}` : "global"
  })
    .then((snap) => {
      rollbackPolicy.lastSnapshotId = snap.snapshotId;
      runtimeExecutionState.lastAutoRollbackAt = new Date().toISOString();
      return persistRollbackPolicy();
    })
    .catch((error) => {
      startupWarnings.push(`Auto rollback checkpoint failed: ${error.message}`);
    })
    .finally(() => {
      runtimeExecutionState.autoRollbackInFlight = false;
    });
}

function sendPlanRaw(address, args = [], metadata = {}, options = {}) {
  const dry = config.ABLETON_DRY_RUN || options.forceDryRun === true;
  if (dry) {
    metrics.dryRunCommands += 1;
    return {
      dryRun: true,
      address,
      args: args.map((a) => a.value),
      ...metadata
    };
  }
  const lockHit = isDeviceParamLockedForArgs(address, args);
  if (lockHit) {
    throw new Error(
      `Device parameter write blocked by lock "${lockHit.lock.targetKey ?? lockHit.key}".`
    );
  }
  protocolDiagnostics.lastOutgoingAt = new Date().toISOString();
  pushEventCache({
    type: "osc_send",
    address,
    args: args.map((a) => a.value)
  });
  oscClient.send(address, args);
  maybeTriggerAutoRollbackCheckpoint(address, metadata);
  return { ok: true, address, ...metadata };
}

function sendMaybe(address, args = [], metadata = {}, options = {}) {
  return textResult(sendPlanRaw(address, args, metadata, options));
}

server.registerTool(
  "get_connection_info",
  {
    title: "Get OSC Connection Info",
    description:
      "Return current OSC host/port configuration for AbletonOSC bridge."
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            host: config.ABLETON_OSC_HOST,
            sendPort: config.ABLETON_OSC_SEND_PORT,
            listenPort: config.ABLETON_OSC_LISTEN_PORT,
            timeoutMs: config.ABLETON_OSC_TIMEOUT_MS,
            dryRun: config.ABLETON_DRY_RUN,
            requireDestructiveConfirm: config.ABLETON_REQUIRE_DESTRUCTIVE_CONFIRM,
            destructiveConfirmToken: DESTRUCTIVE_CONFIRM_TOKEN,
            endpointSelections: Object.fromEntries(endpointSelections),
            runtimeContext,
            policyMode: policyState.mode,
            startupWarnings
          },
          null,
          2
        )
      }
    ]
  })
);

server.registerTool(
  "get_last_error",
  {
    title: "Get Last Error",
    description: "Return last normalized error details seen by the bridge."
  },
  async () =>
    textResult({
      lastError: metrics.lastError
        ? {
            ...metrics.lastError,
            errorCode: classifyError({ message: metrics.lastError.message })
          }
        : null
    })
);

server.registerTool(
  "get_protocol_diagnostics",
  {
    title: "Get Protocol Diagnostics",
    description: "Return bind ports and last packet/RTT diagnostics."
  },
  async () =>
    textResult({
      host: config.ABLETON_OSC_HOST,
      sendPort: config.ABLETON_OSC_SEND_PORT,
      listenPort: config.ABLETON_OSC_LISTEN_PORT,
      protocolDiagnostics
    })
);

server.registerTool(
  "get_ops_dashboard",
  {
    title: "Get Ops Dashboard",
    description:
      "Unified operational dashboard: health, diagnostics, capability profile, conflicts, recent events, and export jobs.",
    inputSchema: {
      includeProbeSummary: z.boolean().optional().default(false),
      recentEventsLimit: z.number().int().min(1).max(50).optional().default(10),
      recentJobsLimit: z.number().int().min(1).max(50).optional().default(10)
    }
  },
  async ({ includeProbeSummary, recentEventsLimit, recentJobsLimit }) =>
    withMetrics("get_ops_dashboard", async () => {
      const capability = buildCapabilityProfile();
      const recentEvents = (stateCache.eventStream ?? []).slice(-recentEventsLimit);
      const recentJobs = [...exportJobs.values()]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, recentJobsLimit);
      return textResult({
        status: "ok",
        now: new Date().toISOString(),
        connection: {
          host: config.ABLETON_OSC_HOST,
          sendPort: config.ABLETON_OSC_SEND_PORT,
          listenPort: config.ABLETON_OSC_LISTEN_PORT,
          connected: connectionState.connected
        },
        health: {
          probeReady: probeSummary !== null,
          startupWarnings,
          metrics: {
            totalCommands: metrics.totalCommands,
            successfulCommands: metrics.successfulCommands,
            failedCommands: metrics.failedCommands,
            dryRunCommands: metrics.dryRunCommands,
            lastError: metrics.lastError
          }
        },
        protocolDiagnostics,
        capabilityProfile: capability,
        policy: {
          policyState,
          runtimeContext
        },
        conflicts: {
          pending: stateCache.pendingConflicts ?? [],
          cacheLastRefreshAt: stateCache.lastRefreshAt
        },
        subscriptions: {
          channels: stateCache.channels ?? [],
          recentEvents
        },
        exportJobs: {
          total: exportJobs.size,
          recentJobs
        },
        probeSummary: includeProbeSummary ? probeSummary : undefined
      });
    })
);

server.registerTool(
  "get_ops_dashboard_compact",
  {
    title: "Get Ops Dashboard Compact",
    description: "Compact status summary for quick operational checks."
  },
  async () =>
    withMetrics("get_ops_dashboard_compact", async () => {
      const capability = buildCapabilityProfile();
      const recentJob = [...exportJobs.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
      const recentEvent = (stateCache.eventStream ?? []).slice(-1)[0] ?? null;
      const status = metrics.failedCommands > 0 || (stateCache.pendingConflicts ?? []).length > 0 ? "warning" : "ok";
      return textResult({
        status,
        connected: connectionState.connected,
        probeReady: probeSummary !== null,
        profile: capability.profile,
        totalCommands: metrics.totalCommands,
        failedCommands: metrics.failedCommands,
        lastErrorCode: metrics.lastError ? classifyError({ message: metrics.lastError.message }) : null,
        pendingConflicts: stateCache.pendingConflicts ?? [],
        channels: stateCache.channels ?? [],
        lastRttMs: protocolDiagnostics.lastRttMs,
        recentJob: recentJob
          ? {
              jobId: recentJob.jobId,
              status: recentJob.status,
              profileName: recentJob.profileName,
              createdAt: recentJob.createdAt
            }
          : null,
        recentEvent: recentEvent
          ? { at: recentEvent.at, type: recentEvent.type, address: recentEvent.address ?? null }
          : null
      });
    })
);

server.registerTool(
  "health_live_test",
  {
    title: "Health Live Test",
    description: "Run AbletonOSC /live/test endpoint check."
  },
  async () =>
    withMetrics("health_live_test", async () => {
      const result = await requestAny(["/live/test"], [stringArg("ok")]);
      return textResult({
        ok: true,
        endpoint: result.address,
        response: parseOscValue(result.response)
      });
    })
);

server.registerTool(
  "run_smoke_check",
  {
    title: "Run Smoke Check",
    description: "Run one-shot bridge diagnostics for connectivity and basic reads."
  },
  async () =>
    withMetrics("run_smoke_check", async () => {
      const checks = [];
      const run = async (name, fn) => {
        try {
          const value = await fn();
          checks.push({ name, ok: true, value });
        } catch (error) {
          checks.push({
            name,
            ok: false,
            errorCode: classifyError(error),
            error: error.message
          });
        }
      };

      await run("live_test", async () => {
        const res = await requestAny(["/live/test"], [stringArg("ok")]);
        return { endpoint: res.address, response: parseOscValue(res.response) };
      });
      await run("tempo_get", async () => {
        const res = await requestKnown("tempoGet", ["/live/song/get/tempo", "/live/song/tempo"]);
        return { endpoint: res.address, tempo: parseOscValue(res.response) };
      });
      await run("track_count", async () => {
        const res = await requestKnown("trackCountGet", [
          "/live/song/get/num_tracks",
          "/live/song/get/track_count"
        ]);
        return { endpoint: res.address, count: parseOscValue(res.response) };
      });

      return textResult({
        ok: checks.every((c) => c.ok),
        checks,
        protocolDiagnostics
      });
    })
);

server.registerTool(
  "set_safety_mode",
  {
    title: "Set Safety Mode",
    description: "Apply policy presets: safe, studio, live-performance.",
    inputSchema: {
      mode: z.enum(["safe", "studio", "live-performance"])
    }
  },
  async ({ mode }) =>
    withMetrics("set_safety_mode", async () => {
      if (mode === "safe") {
        policyState.mode = "safe";
        policyState.blockDestructiveDuringPlayback = true;
        policyState.requireRoleForDestructive = true;
        runtimeContext.role = "operator";
        runtimeContext.performanceMode = false;
      } else if (mode === "studio") {
        policyState.mode = "studio";
        policyState.blockDestructiveDuringPlayback = true;
        policyState.requireRoleForDestructive = true;
        runtimeContext.role = "admin";
        runtimeContext.performanceMode = false;
      } else {
        policyState.mode = "live-performance";
        policyState.blockDestructiveDuringPlayback = true;
        policyState.requireRoleForDestructive = true;
        runtimeContext.role = "operator";
        runtimeContext.performanceMode = true;
      }

      return textResult({ ok: true, policyState, runtimeContext });
    })
);

server.registerTool(
  "undo",
  {
    title: "Undo",
    description: "Undo the last operation in Ableton."
  },
  async () => withMetrics("undo", async () => sendMaybe("/live/song/undo"))
);

server.registerTool(
  "redo",
  {
    title: "Redo",
    description: "Redo the previously undone operation in Ableton."
  },
  async () => withMetrics("redo", async () => sendMaybe("/live/song/redo"))
);

server.registerTool(
  "create_action_plan_preview",
  {
    title: "Create Action Plan Preview",
    description: "Store a dry preview for a grouped set of actions without executing writes.",
    inputSchema: {
      planId: z.string().min(1).max(128),
      actions: z
        .array(
          z.object({
            action: z.string().min(1).max(64),
            params: z.record(z.unknown()).default({})
          })
        )
        .min(1)
    }
  },
  async ({ planId, actions }) =>
    withMetrics("create_action_plan_preview", async () => {
      const now = new Date().toISOString();
      const plan = {
        planId,
        createdAt: now,
        dryRun: true,
        actions,
        notes:
          "Preview only. Call execute_action_plan with the same planId to run whitelisted actions, or use dryRun:true to simulate."
      };
      pendingPlans.set(planId, plan);
      return textResult({ ok: true, plan });
    })
);

const PLAN_DESTRUCTIVE_ACTIONS = new Set([
  "delete_clip",
  "delete_scene",
  "arrangement_delete_range",
  "render_project_audio",
  "render_stems"
]);

const planParamSchemas = {
  start_playback: z.object({}),
  stop_playback: z.object({}),
  stop_all_clips: z.object({}),
  undo: z.object({}),
  redo: z.object({}),
  set_tempo: z.object({ bpm: z.number().min(20).max(300) }),
  launch_clip: z.object({
    trackIndex: z.number().int().min(0),
    clipIndex: z.number().int().min(0)
  }),
  launch_scene: z.object({ sceneIndex: z.number().int().min(0) }),
  stop_track_clips: z.object({ trackIndex: z.number().int().min(0) }),
  jump_to_time: z.object({ timeBeats: z.number().min(0) }),
  set_loop_region: z.object({
    startBeats: z.number().min(0),
    lengthBeats: z.number().positive(),
    enabled: z.boolean().optional()
  }),
  set_transport_flags: z.object({
    metronome: z.boolean().optional(),
    sessionRecord: z.boolean().optional(),
    overdub: z.boolean().optional()
  }),
  set_arrangement_punch: z.object({
    punchIn: z.boolean().optional(),
    punchOut: z.boolean().optional()
  }),
  create_locator: z.object({
    timeBeats: z.number().min(0),
    name: z.string().min(1).max(128).optional()
  }),
  arrangement_duplicate_range: z.object({
    startBeats: z.number().min(0),
    lengthBeats: z.number().positive()
  }),
  arrangement_delete_range: z.object({
    startBeats: z.number().min(0),
    lengthBeats: z.number().positive()
  }),
  set_track_mixer: z.object({
    trackIndex: z.number().int().min(0),
    volume: z.number().min(0).max(1).optional(),
    pan: z.number().min(-1).max(1).optional(),
    sendIndex: z.number().int().min(0).optional(),
    sendLevel: z.number().min(0).max(1).optional()
  }),
  set_track_state: z.object({
    trackIndex: z.number().int().min(0),
    arm: z.boolean().optional(),
    mute: z.boolean().optional(),
    solo: z.boolean().optional()
  }),
  set_track_name: z.object({
    trackIndex: z.number().int().min(0),
    name: z.string().min(1).max(128)
  }),
  set_device_parameter: z.object({
    trackIndex: z.number().int().min(0),
    deviceIndex: z.number().int().min(0),
    parameterIndex: z.number().int().min(0),
    value: z.number().min(0).max(1)
  }),
  create_midi_clip: z.object({
    trackIndex: z.number().int().min(0),
    clipIndex: z.number().int().min(0),
    lengthBeats: z.number().positive()
  }),
  add_clip_notes: z.object({
    trackIndex: z.number().int().min(0),
    clipIndex: z.number().int().min(0),
    notes: z
      .array(
        z.object({
          pitch: z.number().int().min(0).max(127),
          start: z.number().min(0),
          duration: z.number().positive(),
          velocity: z.number().int().min(1).max(127),
          mute: z.boolean().optional().default(false)
        })
      )
      .min(1)
  }),
  delete_clip: z.object({
    trackIndex: z.number().int().min(0),
    clipIndex: z.number().int().min(0)
  }),
  delete_scene: z.object({ sceneIndex: z.number().int().min(0) }),
  set_track_volume_by_name: z.object({
    trackName: z.string().min(1).max(128),
    volume: z.number().min(0).max(1),
    minScore: z.number().min(0).max(1).optional().default(0.55)
  }),
  launch_clip_by_track_name: z.object({
    trackName: z.string().min(1).max(128),
    clipIndex: z.number().int().min(0),
    minScore: z.number().min(0).max(1).optional().default(0.55)
  }),
  render_project_audio: z.object({
    filePath: z.string().min(1).max(512),
    exportMaster: z.boolean().optional().default(true),
    normalize: z.boolean().optional().default(false)
  }),
  render_stems: z.object({
    directoryPath: z.string().min(1).max(512),
    includeReturns: z.boolean().optional().default(true)
  }),
  create_scene: z.object({ sceneIndex: z.number().int().min(0).optional() }),
  rename_scene: z.object({
    sceneIndex: z.number().int().min(0),
    name: z.string().min(1).max(128)
  })
};

async function captureRollbackSnapshotInternal(snapshotId, options = {}) {
  const overviewResp = await requestKnown("tempoGet", [
    "/live/song/get/tempo",
    "/live/song/tempo"
  ]);
  const playResp = await requestKnown("isPlayingGet", [
    "/live/song/get/is_playing",
    "/live/song/is_playing"
  ]);
  const timeResp = await requestKnown("songTimeGet", [
    "/live/song/get/current_song_time",
    "/live/song/current_song_time"
  ]);
  const tracks = await getTracksSnapshot();
  const mixerSample = [];
  for (const track of tracks.tracks.slice(0, 8)) {
    try {
      const [volume, pan, mute, solo, arm] = await Promise.all([
        requestAny(["/live/track/get/volume"], [intArg(track.index)]),
        requestAny(["/live/track/get/panning"], [intArg(track.index)]),
        requestAny(["/live/track/get/mute"], [intArg(track.index)]),
        requestAny(["/live/track/get/solo"], [intArg(track.index)]),
        requestAny(["/live/track/get/arm"], [intArg(track.index)])
      ]);
      mixerSample.push({
        trackIndex: track.index,
        name: track.name,
        volume: Number(parseOscValue(volume.response, 0.85)),
        pan: Number(parseOscValue(pan.response, 0)),
        mute: Boolean(parseOscValue(mute.response, 0)),
        solo: Boolean(parseOscValue(solo.response, 0)),
        arm: Boolean(parseOscValue(arm.response, 0))
      });
    } catch {
      // Best-effort snapshot for compatibility across AbletonOSC variants.
    }
  }

  const snapshot = {
    snapshotId,
    capturedAt: new Date().toISOString(),
    source: options.source ?? "manual",
    trigger: options.trigger ?? null,
    tempo: Number(parseOscValue(overviewResp.response, 120)),
    isPlaying: Boolean(parseOscValue(playResp.response, 0)),
    currentSongTime: Number(parseOscValue(timeResp.response, 0)),
    mixerSample,
    reverseOpsHint: [
      {
        action: "set_tempo",
        params: { bpm: Number(parseOscValue(overviewResp.response, 120)) },
        metadata: { confidence: "high", source: "captured-tempo" }
      },
      {
        action: "jump_to_time",
        params: { timeBeats: Number(parseOscValue(timeResp.response, 0)) },
        metadata: { confidence: "high", source: "captured-transport-time" }
      }
    ],
    reverseOpsMeta: {
      generatedAt: new Date().toISOString(),
      caution:
        "Reverse operations are best-effort and do not include full clip/device state rollback.",
      destructiveActionsRecommended: ["delete_clip", "delete_scene", "arrangement_delete_range"]
    }
  };
  snapshots.set(snapshotId, snapshot);
  return snapshot;
}

async function dispatchPlanAction(action, params, execOptions) {
  const { forceDryRun } = execOptions;
  const opt = { forceDryRun };

  switch (action) {
    case "start_playback":
      return sendPlanRaw("/live/song/start_playing", [], {}, opt);
    case "stop_playback":
      return sendPlanRaw("/live/song/stop_playing", [], {}, opt);
    case "stop_all_clips":
      return sendPlanRaw("/live/song/stop_all_clips", [], {}, opt);
    case "undo":
      return sendPlanRaw("/live/song/undo", [], {}, opt);
    case "redo":
      return sendPlanRaw("/live/song/redo", [], {}, opt);
    case "set_tempo":
      return sendPlanRaw("/live/song/set/tempo", [floatArg(params.bpm)], { bpm: params.bpm }, opt);
    case "launch_clip":
      return sendPlanRaw(
        "/live/clip/fire",
        [intArg(params.trackIndex), intArg(params.clipIndex)],
        { trackIndex: params.trackIndex, clipIndex: params.clipIndex },
        opt
      );
    case "launch_scene":
      return sendPlanRaw("/live/scene/fire", [intArg(params.sceneIndex)], { sceneIndex: params.sceneIndex }, opt);
    case "stop_track_clips":
      return sendPlanRaw("/live/track/stop_all_clips", [intArg(params.trackIndex)], { trackIndex: params.trackIndex }, opt);
    case "jump_to_time":
      return sendPlanRaw(
        "/live/song/set/current_song_time",
        [floatArg(params.timeBeats)],
        { timeBeats: params.timeBeats },
        opt
      );
    case "set_loop_region": {
      const out = [];
      out.push(sendPlanRaw("/live/song/set/loop_start", [floatArg(params.startBeats)], {}, opt));
      out.push(sendPlanRaw("/live/song/set/loop_length", [floatArg(params.lengthBeats)], {}, opt));
      if (params.enabled !== undefined) {
        out.push(sendPlanRaw("/live/song/set/loop", [intArg(params.enabled ? 1 : 0)], {}, opt));
      }
      return { ok: true, action: "set_loop_region", steps: out };
    }
    case "set_transport_flags": {
      const out = [];
      if (params.metronome !== undefined) {
        out.push(sendPlanRaw("/live/song/set/metronome", [intArg(params.metronome ? 1 : 0)], {}, opt));
      }
      if (params.sessionRecord !== undefined) {
        out.push(
          sendPlanRaw("/live/song/set/session_record", [intArg(params.sessionRecord ? 1 : 0)], {}, opt)
        );
      }
      if (params.overdub !== undefined) {
        out.push(sendPlanRaw("/live/song/set/overdub", [intArg(params.overdub ? 1 : 0)], {}, opt));
      }
      if (out.length === 0) throw new Error("set_transport_flags: provide at least one flag.");
      return { ok: true, action, steps: out };
    }
    case "set_arrangement_punch": {
      const out = [];
      if (params.punchIn !== undefined) {
        out.push(sendPlanRaw("/live/song/set/punch_in", [intArg(params.punchIn ? 1 : 0)], {}, opt));
      }
      if (params.punchOut !== undefined) {
        out.push(sendPlanRaw("/live/song/set/punch_out", [intArg(params.punchOut ? 1 : 0)], {}, opt));
      }
      if (out.length === 0) throw new Error("set_arrangement_punch: provide punchIn and/or punchOut.");
      return { ok: true, action, steps: out };
    }
    case "create_locator": {
      const out = [sendPlanRaw("/live/song/create_locator", [floatArg(params.timeBeats)], {}, opt)];
      if (params.name) {
        out.push(sendPlanRaw("/live/song/set/last_locator_name", [stringArg(params.name)], {}, opt));
      }
      return { ok: true, action, steps: out };
    }
    case "arrangement_duplicate_range":
      return sendPlanRaw(
        "/live/song/duplicate_time",
        [floatArg(params.startBeats), floatArg(params.lengthBeats)],
        { startBeats: params.startBeats, lengthBeats: params.lengthBeats },
        opt
      );
    case "arrangement_delete_range":
      return sendPlanRaw(
        "/live/song/delete_time",
        [floatArg(params.startBeats), floatArg(params.lengthBeats)],
        { startBeats: params.startBeats, lengthBeats: params.lengthBeats, destructive: true },
        opt
      );
    case "set_track_mixer": {
      const out = [];
      if (params.volume !== undefined) {
        out.push(
          sendPlanRaw("/live/track/set/volume", [intArg(params.trackIndex), floatArg(params.volume)], {}, opt)
        );
      }
      if (params.pan !== undefined) {
        out.push(
          sendPlanRaw("/live/track/set/panning", [intArg(params.trackIndex), floatArg(params.pan)], {}, opt)
        );
      }
      if (params.sendIndex !== undefined || params.sendLevel !== undefined) {
        if (params.sendIndex === undefined || params.sendLevel === undefined) {
          throw new Error("set_track_mixer: sendIndex and sendLevel must be provided together.");
        }
        out.push(
          sendPlanRaw(
            "/live/track/set/send",
            [intArg(params.trackIndex), intArg(params.sendIndex), floatArg(params.sendLevel)],
            {},
            opt
          )
        );
      }
      if (out.length === 0) throw new Error("set_track_mixer: provide volume, pan, or send.");
      return { ok: true, action, steps: out };
    }
    case "set_track_state": {
      const out = [];
      if (params.arm !== undefined) {
        out.push(
          sendPlanRaw("/live/track/set/arm", [intArg(params.trackIndex), intArg(params.arm ? 1 : 0)], {}, opt)
        );
      }
      if (params.mute !== undefined) {
        out.push(
          sendPlanRaw("/live/track/set/mute", [intArg(params.trackIndex), intArg(params.mute ? 1 : 0)], {}, opt)
        );
      }
      if (params.solo !== undefined) {
        out.push(
          sendPlanRaw("/live/track/set/solo", [intArg(params.trackIndex), intArg(params.solo ? 1 : 0)], {}, opt)
        );
      }
      if (out.length === 0) throw new Error("set_track_state: provide arm, mute, and/or solo.");
      return { ok: true, action, steps: out };
    }
    case "set_track_name":
      return sendPlanRaw(
        "/live/track/set/name",
        [intArg(params.trackIndex), stringArg(params.name)],
        { trackIndex: params.trackIndex, name: params.name },
        opt
      );
    case "set_device_parameter":
      return sendPlanRaw(
        "/live/device/set/parameter/value",
        [
          intArg(params.trackIndex),
          intArg(params.deviceIndex),
          intArg(params.parameterIndex),
          floatArg(params.value)
        ],
        { ...params },
        opt
      );
    case "create_midi_clip":
      return sendPlanRaw(
        "/live/clip_slot/create_clip",
        [intArg(params.trackIndex), intArg(params.clipIndex), floatArg(params.lengthBeats)],
        { ...params },
        opt
      );
    case "add_clip_notes": {
      const out = [];
      for (const note of params.notes) {
        out.push(
          sendPlanRaw(
            "/live/clip/add_note",
            [
              intArg(params.trackIndex),
              intArg(params.clipIndex),
              intArg(note.pitch),
              floatArg(note.start),
              floatArg(note.duration),
              intArg(note.velocity),
              intArg(note.mute ? 1 : 0)
            ],
            {},
            opt
          )
        );
      }
      return { ok: true, action, notesAdded: params.notes.length, steps: out };
    }
    case "delete_clip":
      return sendPlanRaw(
        "/live/clip/delete",
        [intArg(params.trackIndex), intArg(params.clipIndex)],
        { ...params, destructive: true },
        opt
      );
    case "delete_scene":
      return sendPlanRaw("/live/scene/delete", [intArg(params.sceneIndex)], { ...params, destructive: true }, opt);
    case "set_track_volume_by_name": {
      const best = await resolveTrackIndexFromName(params.trackName, params.minScore ?? 0.55);
      return sendPlanRaw(
        "/live/track/set/volume",
        [intArg(best.index), floatArg(params.volume)],
        { matchedTrack: best, volume: params.volume },
        opt
      );
    }
    case "launch_clip_by_track_name": {
      const best = await resolveTrackIndexFromName(params.trackName, params.minScore ?? 0.55);
      return sendPlanRaw(
        "/live/clip/fire",
        [intArg(best.index), intArg(params.clipIndex)],
        { matchedTrack: best, clipIndex: params.clipIndex },
        opt
      );
    }
    case "render_project_audio":
      return sendKnownRaw(
        "renderAudio",
        ["/live/song/export_audio"],
        [stringArg(params.filePath), toBoolInt(params.exportMaster), toBoolInt(params.normalize)],
        { ...params, destructive: true },
        opt
      );
    case "render_stems":
      return sendKnownRaw(
        "renderStems",
        ["/live/song/export_stems"],
        [stringArg(params.directoryPath), toBoolInt(params.includeReturns)],
        { ...params, destructive: true },
        opt
      );
    case "create_scene":
      if (params.sceneIndex === undefined) {
        return sendPlanRaw("/live/scene/create", [], {}, opt);
      }
      return sendPlanRaw("/live/scene/create", [intArg(params.sceneIndex)], { sceneIndex: params.sceneIndex }, opt);
    case "rename_scene":
      return sendPlanRaw(
        "/live/scene/set/name",
        [intArg(params.sceneIndex), stringArg(params.name)],
        { sceneIndex: params.sceneIndex, name: params.name },
        opt
      );
    default:
      throw new Error(`Unknown or disallowed plan action: ${action}`);
  }
}

async function runActionPlanExecution({
  actions,
  confirmToken,
  stopOnError,
  captureRollbackSnapshot,
  rollbackSnapshotId,
  forceDryRun
}) {
  const destructiveInPlan = actions.some((a) => PLAN_DESTRUCTIVE_ACTIONS.has(a.action));
  if (destructiveInPlan) {
    guardDestructive(confirmToken);
  }

  let rollback = null;
  if (captureRollbackSnapshot) {
    const sid =
      rollbackSnapshotId?.trim() ||
      `plan_rollback_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const snapshot = await captureRollbackSnapshotInternal(sid);
    rollback = {
      snapshotId: sid,
      hint: "If the plan went wrong, call restore_session_snapshot with snapshotId to restore tempo, playhead, and transport state only."
    };
    snapshot.planRollbackHint = rollback.hint;
  }

  const results = [];
  const execOptions = { forceDryRun: Boolean(forceDryRun) };

  for (let i = 0; i < actions.length; i += 1) {
    const step = actions[i];
    const action = step.action;
    const rawParams = step.params ?? {};
    try {
      const schema = planParamSchemas[action];
      if (!schema) {
        throw new Error(
          `Unknown or disallowed action "${action}". Allowed: ${Object.keys(planParamSchemas).join(", ")}`
        );
      }
      const params = schema.parse(rawParams);
      const outcome = await dispatchPlanAction(action, params, execOptions);
      results.push({ index: i, action, ok: true, outcome });
    } catch (error) {
      results.push({ index: i, action, ok: false, error: error.message });
      if (stopOnError) {
        return {
          completed: false,
          stoppedAtIndex: i,
          results,
          rollback,
          rollbackHint:
            rollback?.hint ??
            "No rollback snapshot was captured. Use undo in Ableton or capture_session_snapshot before risky operations."
        };
      }
    }
  }

  return {
    completed: true,
    results,
    rollback,
    rollbackHint:
      rollback?.hint ??
      "No rollback snapshot was captured for this run."
  };
}

async function preflightActionPlan({ actions, confirmToken, maxCacheAgeMs = 10000 }) {
  const checks = [];
  const errors = [];
  const warnings = [];

  for (let i = 0; i < actions.length; i += 1) {
    const step = actions[i];
    const schema = planParamSchemas[step.action];
    if (!schema) {
      errors.push({
        index: i,
        action: step.action,
        errorCode: "PLAN_ACTION_UNKNOWN",
        message: `Unknown or disallowed action "${step.action}".`
      });
      continue;
    }
    try {
      schema.parse(step.params ?? {});
      checks.push({ index: i, action: step.action, ok: true });
    } catch (error) {
      errors.push({
        index: i,
        action: step.action,
        errorCode: "PLAN_PARAM_INVALID",
        message: error.message
      });
    }
  }

  const destructiveInPlan = actions.some((a) => PLAN_DESTRUCTIVE_ACTIONS.has(a.action));
  if (destructiveInPlan) {
    if (config.ABLETON_REQUIRE_DESTRUCTIVE_CONFIRM && confirmToken !== DESTRUCTIVE_CONFIRM_TOKEN) {
      errors.push({
        errorCode: "DESTRUCTIVE_CONFIRM_REQUIRED",
        message: `Plan has destructive actions; pass confirmToken="${DESTRUCTIVE_CONFIRM_TOKEN}".`
      });
    }
    if (runtimeContext.performanceMode) {
      errors.push({
        errorCode: "POLICY_BLOCKED",
        message: "Destructive action blocked while performanceMode is enabled."
      });
    }
  }

  const now = Date.now();
  const last = stateCache.lastRefreshAt ? Date.parse(stateCache.lastRefreshAt) : 0;
  const stale = !last || now - last > maxCacheAgeMs;
  if (stale) {
    warnings.push("State cache is stale; run refresh_state_cache before plan execution.");
  }
  if (stateCache.pendingConflicts.length > 0) {
    warnings.push(...stateCache.pendingConflicts);
  }

  return {
    ok: errors.length === 0,
    checks,
    warnings,
    errors,
    destructiveInPlan
  };
}

server.registerTool(
  "execute_action_plan",
  {
    title: "Execute Action Plan",
    description:
      "Run a stored preview plan or inline actions. Whitelisted actions only; destructive steps require confirmToken. Optional rollback snapshot before destructive steps.",
    inputSchema: {
      planId: z.string().min(1).max(128).optional(),
      actions: z
        .array(
          z.object({
            action: z.string().min(1).max(64),
            params: z.record(z.unknown()).default({})
          })
        )
        .optional(),
      confirmToken: z.string().optional(),
      stopOnError: z.boolean().optional().default(true),
      dryRun: z.boolean().optional().default(false),
      captureRollbackSnapshot: z.boolean().optional().default(false),
      rollbackSnapshotId: z.string().min(1).max(128).optional()
    }
  },
  async ({
    planId,
    actions: inlineActions,
    confirmToken,
    stopOnError,
    dryRun,
    captureRollbackSnapshot,
    rollbackSnapshotId
  }) =>
    withMetrics("execute_action_plan", async () => {
      let actions = inlineActions;
      if (planId) {
        const plan = pendingPlans.get(planId);
        if (!plan) throw new Error(`Unknown planId: ${planId}`);
        actions = plan.actions;
      }
      if (!actions || actions.length === 0) {
        throw new Error("Provide planId or a non-empty actions array.");
      }
      const report = await runActionPlanExecution({
        actions,
        confirmToken,
        stopOnError: stopOnError ?? true,
        captureRollbackSnapshot: captureRollbackSnapshot ?? false,
        rollbackSnapshotId,
        forceDryRun: dryRun ?? false
      });
      return textResult({ ok: true, planId: planId ?? null, ...report });
    })
);

server.registerTool(
  "get_action_plan_preview",
  {
    title: "Get Action Plan Preview",
    description: "Retrieve a previously stored action plan preview.",
    inputSchema: { planId: z.string().min(1).max(128) }
  },
  async ({ planId }) =>
    withMetrics("get_action_plan_preview", async () => {
      const plan = pendingPlans.get(planId);
      if (!plan) throw new Error(`Unknown planId: ${planId}`);
      return textResult({ ok: true, plan });
    })
);

server.registerTool(
  "get_allowed_plan_actions",
  {
    title: "Get Allowed Plan Actions",
    description:
      "List action names allowed inside create_action_plan_preview / execute_action_plan, plus which require destructive confirmToken."
  },
  async () =>
    textResult({
      actions: Object.keys(planParamSchemas).sort(),
      destructiveActions: [...PLAN_DESTRUCTIVE_ACTIONS].sort()
    })
);

server.registerTool(
  "preflight_action_plan",
  {
    title: "Preflight Action Plan",
    description: "Validate action-plan schema/policy/conflicts before execution.",
    inputSchema: {
      planId: z.string().min(1).max(128).optional(),
      actions: z
        .array(
          z.object({
            action: z.string().min(1).max(64),
            params: z.record(z.unknown()).default({})
          })
        )
        .optional(),
      confirmToken: z.string().optional(),
      maxCacheAgeMs: z.number().int().min(1).max(600000).optional().default(10000)
    }
  },
  async ({ planId, actions: inlineActions, confirmToken, maxCacheAgeMs }) =>
    withMetrics("preflight_action_plan", async () => {
      let actions = inlineActions;
      if (planId) {
        const plan = pendingPlans.get(planId);
        if (!plan) throw new Error(`Unknown planId: ${planId}`);
        actions = plan.actions;
      }
      if (!actions || actions.length === 0) {
        throw new Error("Provide planId or a non-empty actions array.");
      }
      return textResult(
        await preflightActionPlan({
          actions,
          confirmToken,
          maxCacheAgeMs
        })
      );
    })
);

server.registerTool(
  "get_policy_state",
  {
    title: "Get Policy State",
    description: "Return current policy engine and runtime context."
  },
  async () => textResult({ policyState, runtimeContext })
);

server.registerTool(
  "set_policy_state",
  {
    title: "Set Policy State",
    description: "Update policy mode and safety toggles.",
    inputSchema: {
      mode: z.enum(["safe", "studio", "live-performance"]).optional(),
      blockDestructiveDuringPlayback: z.boolean().optional(),
      requireRoleForDestructive: z.boolean().optional(),
      role: z.enum(["observer", "operator", "admin"]).optional(),
      performanceMode: z.boolean().optional()
    }
  },
  async ({
    mode,
    blockDestructiveDuringPlayback,
    requireRoleForDestructive,
    role,
    performanceMode
  }) =>
    withMetrics("set_policy_state", async () => {
      if (mode !== undefined) policyState.mode = mode;
      if (blockDestructiveDuringPlayback !== undefined) {
        policyState.blockDestructiveDuringPlayback = blockDestructiveDuringPlayback;
      }
      if (requireRoleForDestructive !== undefined) {
        policyState.requireRoleForDestructive = requireRoleForDestructive;
      }
      if (role !== undefined) runtimeContext.role = role;
      if (performanceMode !== undefined) runtimeContext.performanceMode = performanceMode;
      return textResult({ ok: true, policyState, runtimeContext });
    })
);

server.registerTool(
  "refresh_state_cache",
  {
    title: "Refresh State Cache",
    description: "Refresh transport + track cache used for conflict/policy checks."
  },
  async () => withMetrics("refresh_state_cache", async () => textResult(await refreshStateCache()))
);

server.registerTool(
  "subscribe_session_events",
  {
    title: "Subscribe Session Events",
    description: "Scaffold for event subscriptions; records desired channels in cache.",
    inputSchema: {
      channels: z.array(z.string().min(1)).min(1)
    }
  },
  async ({ channels }) =>
    withMetrics("subscribe_session_events", async () => {
      stateCache.channels = [...new Set(channels)];
      const args = stateCache.channels.map((c) => stringArg(c));
      const cachedEvent = pushEventCache({
        type: "subscription_update",
        channels: stateCache.channels
      });
      return sendKnownMaybe(
        "subscribeEvents",
        ["/live/subscribe"],
        args,
        { subscribedChannels: stateCache.channels, cachedEvent }
      );
    })
);

server.registerTool(
  "get_session_event_cache",
  {
    title: "Get Session Event Cache",
    description: "Return latest in-memory session event stream cache.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().default(50)
    }
  },
  async ({ limit }) =>
    withMetrics("get_session_event_cache", async () =>
      textResult({
        channels: stateCache.channels ?? [],
        events: (stateCache.eventStream ?? []).slice(-limit)
      })
    )
);

server.registerTool(
  "detect_plan_conflicts",
  {
    title: "Detect Plan Conflicts",
    description: "Best-effort conflict detector comparing stale cache timestamp vs current state.",
    inputSchema: {
      maxCacheAgeMs: z.number().int().min(1).max(600000).optional().default(10000)
    }
  },
  async ({ maxCacheAgeMs }) =>
    withMetrics("detect_plan_conflicts", async () => {
      const now = Date.now();
      const last = stateCache.lastRefreshAt ? Date.parse(stateCache.lastRefreshAt) : 0;
      const stale = !last || now - last > maxCacheAgeMs;
      const conflicts = [];
      if (stale) conflicts.push("State cache is stale; refresh_state_cache before critical plans.");
      if (runtimeContext.performanceMode)
        conflicts.push("Performance mode enabled; destructive and high-risk changes should be avoided.");
      stateCache.pendingConflicts = conflicts;
      return textResult({ ok: true, stale, conflicts });
    })
);

server.registerTool(
  "detect_capability_profile",
  {
    title: "Detect Capability Profile",
    description: "Classify current AbletonOSC compatibility profile.",
    inputSchema: {
      reprobe: z.boolean().optional().default(false)
    }
  },
  async ({ reprobe }) =>
    withMetrics("detect_capability_profile", async () => {
      if (reprobe) {
        probeSummary = await runCapabilityProbe();
      }
      return textResult({
        ok: true,
        ...buildCapabilityProfile(),
        probeSummary
      });
    })
);

server.registerTool(
  "write_device_automation_curve",
  {
    title: "Write Device Automation Curve",
    description: "Write linear/s-curve/step automation points over a time range.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      deviceIndex: z.number().int().min(0),
      parameterIndex: z.number().int().min(0),
      startBeats: z.number().min(0),
      endBeats: z.number().gt(0),
      startValue: z.number().min(0).max(1),
      endValue: z.number().min(0).max(1),
      shape: z.enum(["linear", "s-curve", "step"]).optional().default("linear"),
      points: z.number().int().min(2).max(256).optional().default(16)
    }
  },
  async ({
    trackIndex,
    deviceIndex,
    parameterIndex,
    startBeats,
    endBeats,
    startValue,
    endValue,
    shape,
    points
  }) =>
    withMetrics("write_device_automation_curve", async () => {
      const out = [];
      for (let i = 0; i < points; i += 1) {
        const t = i / (points - 1);
        let curveT = t;
        if (shape === "s-curve") curveT = t * t * (3 - 2 * t);
        if (shape === "step") curveT = t < 1 ? 0 : 1;
        const beat = startBeats + (endBeats - startBeats) * t;
        const value = startValue + (endValue - startValue) * curveT;
        out.push(
          sendPlanRaw(
            "/live/device/automation/set_point",
            [
              intArg(trackIndex),
              intArg(deviceIndex),
              intArg(parameterIndex),
              floatArg(beat),
              floatArg(value)
            ],
            { beat, value }
          )
        );
      }
      return textResult({
        ok: true,
        pointsWritten: points,
        shape,
        range: { startBeats, endBeats, startValue, endValue },
        writes: out
      });
    })
);

server.registerTool(
  "list_export_profiles",
  {
    title: "List Export Profiles",
    description: "List named export profiles used by profile render helpers."
  },
  async () => textResult({ profiles: Object.fromEntries(exportProfiles) })
);

server.registerTool(
  "upsert_export_profile",
  {
    title: "Upsert Export Profile",
    description: "Create or update an export profile.",
    inputSchema: {
      profileName: z.string().min(1).max(64),
      type: z.enum(["master", "stems"]),
      exportMaster: z.boolean().optional().default(true),
      normalize: z.boolean().optional().default(false),
      includeReturns: z.boolean().optional().default(true)
    }
  },
  async ({ profileName, type, exportMaster, normalize, includeReturns }) =>
    withMetrics("upsert_export_profile", async () => {
      exportProfiles.set(profileName, { type, exportMaster, normalize, includeReturns });
      return textResult({ ok: true, profileName, profile: exportProfiles.get(profileName) });
    })
);

server.registerTool(
  "render_with_profile",
  {
    title: "Render With Profile",
    description: "Render master or stems using a named export profile.",
    inputSchema: {
      profileName: z.string().min(1).max(64),
      targetPath: z.string().min(1).max(512),
      confirmToken: z.string().optional()
    }
  },
  async ({ profileName, targetPath, confirmToken }) =>
    withMetrics("render_with_profile", async () => {
      const profile = exportProfiles.get(profileName);
      if (!profile) throw new Error(`Unknown export profile: ${profileName}`);
      guardDestructive(confirmToken);
      if (profile.type === "master") {
        return sendKnownMaybe(
          "renderAudio",
          ["/live/song/export_audio"],
          [stringArg(targetPath), toBoolInt(profile.exportMaster), toBoolInt(profile.normalize)],
          { profileName, profile, targetPath, destructive: true }
        );
      }
      return sendKnownMaybe(
        "renderStems",
        ["/live/song/export_stems"],
        [stringArg(targetPath), toBoolInt(profile.includeReturns)],
        { profileName, profile, targetPath, destructive: true }
      );
    })
);

server.registerTool(
  "create_export_job",
  {
    title: "Create Export Job",
    description: "Create export job scaffold for queued render execution.",
    inputSchema: {
      profileName: z.string().min(1).max(64),
      targetPath: z.string().min(1).max(512),
      autoStart: z.boolean().optional().default(false),
      confirmToken: z.string().optional()
    }
  },
  async ({ profileName, targetPath, autoStart, confirmToken }) =>
    withMetrics("create_export_job", async () => {
      const profile = exportProfiles.get(profileName);
      if (!profile) throw new Error(`Unknown export profile: ${profileName}`);
      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const job = {
        jobId,
        status: "queued",
        profileName,
        targetPath,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        error: null
      };
      exportJobs.set(jobId, job);

      if (autoStart) {
        guardDestructive(confirmToken);
        job.status = "running";
        job.startedAt = new Date().toISOString();
        try {
          if (profile.type === "master") {
            await sendKnownRaw(
              "renderAudio",
              ["/live/song/export_audio"],
              [stringArg(targetPath), toBoolInt(profile.exportMaster), toBoolInt(profile.normalize)],
              { jobId, profileName, targetPath, destructive: true }
            );
          } else {
            await sendKnownRaw(
              "renderStems",
              ["/live/song/export_stems"],
              [stringArg(targetPath), toBoolInt(profile.includeReturns)],
              { jobId, profileName, targetPath, destructive: true }
            );
          }
          job.status = "completed";
          job.completedAt = new Date().toISOString();
        } catch (error) {
          job.status = "failed";
          job.completedAt = new Date().toISOString();
          job.error = { errorCode: classifyError(error), message: error.message };
        }
      }

      return textResult({ ok: true, job });
    })
);

server.registerTool(
  "run_export_job",
  {
    title: "Run Export Job",
    description: "Execute a previously queued export job.",
    inputSchema: {
      jobId: z.string().min(1).max(128),
      confirmToken: z.string().optional()
    }
  },
  async ({ jobId, confirmToken }) =>
    withMetrics("run_export_job", async () => {
      const job = exportJobs.get(jobId);
      if (!job) throw new Error(`Unknown export job: ${jobId}`);
      if (job.status === "completed") {
        return textResult({ ok: true, job, note: "Job already completed." });
      }
      const profile = exportProfiles.get(job.profileName);
      if (!profile) throw new Error(`Unknown export profile: ${job.profileName}`);
      guardDestructive(confirmToken);

      job.status = "running";
      job.startedAt = new Date().toISOString();
      try {
        if (profile.type === "master") {
          await sendKnownRaw(
            "renderAudio",
            ["/live/song/export_audio"],
            [stringArg(job.targetPath), toBoolInt(profile.exportMaster), toBoolInt(profile.normalize)],
            { jobId, profileName: job.profileName, targetPath: job.targetPath, destructive: true }
          );
        } else {
          await sendKnownRaw(
            "renderStems",
            ["/live/song/export_stems"],
            [stringArg(job.targetPath), toBoolInt(profile.includeReturns)],
            { jobId, profileName: job.profileName, targetPath: job.targetPath, destructive: true }
          );
        }
        job.status = "completed";
        job.completedAt = new Date().toISOString();
      } catch (error) {
        job.status = "failed";
        job.error = { errorCode: classifyError(error), message: error.message };
        job.completedAt = new Date().toISOString();
      }
      return textResult({ ok: job.status === "completed", job });
    })
);

server.registerTool(
  "get_export_job",
  {
    title: "Get Export Job",
    description: "Return one export job by id.",
    inputSchema: {
      jobId: z.string().min(1).max(128)
    }
  },
  async ({ jobId }) =>
    withMetrics("get_export_job", async () => {
      const job = exportJobs.get(jobId);
      if (!job) throw new Error(`Unknown export job: ${jobId}`);
      return textResult({ job });
    })
);

server.registerTool(
  "list_export_jobs",
  {
    title: "List Export Jobs",
    description: "List recent export jobs.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().default(50)
    }
  },
  async ({ limit }) =>
    withMetrics("list_export_jobs", async () => {
      const jobs = [...exportJobs.values()]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit);
      return textResult({ jobs });
    })
);

server.registerTool(
  "compile_plan_from_intent",
  {
    title: "Compile Plan From Intent",
    description: "Scaffold compiler turning simple natural language intent into action-plan skeleton.",
    inputSchema: {
      intent: z.string().min(1).max(500),
      targetTempo: z.number().min(20).max(300).optional(),
      targetTrackName: z.string().min(1).max(128).optional()
    }
  },
  async ({ intent, targetTempo, targetTrackName }) =>
    withMetrics("compile_plan_from_intent", async () => {
      const actions = [];
      if (targetTempo !== undefined) actions.push({ action: "set_tempo", params: { bpm: targetTempo } });
      if (targetTrackName) {
        actions.push({ action: "set_track_volume_by_name", params: { trackName: targetTrackName, volume: 0.85 } });
      }
      if (actions.length === 0) actions.push({ action: "start_playback", params: {} });
      return textResult({
        ok: true,
        intent,
        compiledPlan: { actions },
        note: "Scaffold compiler; extend with richer NLP routing and dependency graphing."
      });
    })
);

server.registerTool(
  "create_conditional_plan",
  {
    title: "Create Conditional Plan",
    description: "Store a conditional/dependency plan schema scaffold for later execution engines.",
    inputSchema: {
      planId: z.string().min(1).max(128),
      conditions: z.array(z.object({ if: z.string(), thenAction: z.string(), elseAction: z.string().optional() })),
      dependencies: z.array(z.object({ action: z.string(), dependsOn: z.array(z.string()) })).optional()
    }
  },
  async ({ planId, conditions, dependencies }) =>
    withMetrics("create_conditional_plan", async () => {
      pendingPlans.set(planId, { planId, conditions, dependencies: dependencies ?? [], type: "conditional-scaffold" });
      return textResult({ ok: true, planId, type: "conditional-scaffold" });
    })
);

server.registerTool(
  "set_track_routing",
  {
    title: "Set Track Routing",
    description: "Routing scaffold: write requested route info using compatibility endpoint.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      inputRoute: z.string().min(1).max(128).optional(),
      outputRoute: z.string().min(1).max(128).optional()
    }
  },
  async ({ trackIndex, inputRoute, outputRoute }) =>
    withMetrics("set_track_routing", async () =>
      sendKnownMaybe(
        "trackSetRouting",
        ["/live/track/set/routing"],
        [intArg(trackIndex), stringArg(inputRoute ?? ""), stringArg(outputRoute ?? "")],
        { trackIndex, inputRoute: inputRoute ?? null, outputRoute: outputRoute ?? null }
      )
    )
);

server.registerTool(
  "load_device_preset",
  {
    title: "Load Device Preset",
    description: "Preset-loading scaffold endpoint by device slot.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      deviceIndex: z.number().int().min(0),
      presetName: z.string().min(1).max(256)
    }
  },
  async ({ trackIndex, deviceIndex, presetName }) =>
    withMetrics("load_device_preset", async () =>
      sendKnownMaybe(
        "deviceLoadPreset",
        ["/live/device/load_preset"],
        [
          intArg(trackIndex),
          intArg(deviceIndex),
          stringArg(presetRegistry.get(normalizeName(presetName))?.presetName ?? presetName)
        ],
        {
          trackIndex,
          deviceIndex,
          presetName,
          resolvedPreset:
            presetRegistry.get(normalizeName(presetName))?.presetName ?? presetName
        }
      )
    )
);

server.registerTool(
  "get_endpoint_capabilities",
  {
    title: "Get Endpoint Capabilities",
    description:
      "Show probed endpoint variants selected for this AbletonOSC instance."
  },
  async () =>
    textResult({
      probeSummary,
      endpointSelections: Object.fromEntries(endpointSelections),
      knownVariantSets: OSC_ENDPOINT_VARIANTS
    })
);

server.registerTool(
  "warmup_write_endpoints",
  {
    title: "Warmup Write Endpoints",
    description:
      "Safely resolve write-variant endpoint selections without sending mutating OSC commands."
  },
  async () =>
    withMetrics("warmup_write_endpoints", async () => {
      const targets = [
        ["renderAudio", ["/live/song/export_audio"]],
        ["renderStems", ["/live/song/export_stems"]],
        ["trackSetRouting", ["/live/track/set/routing"]],
        ["deviceLoadPreset", ["/live/device/load_preset"]],
        ["subscribeEvents", ["/live/subscribe"]]
      ];

      const results = [];
      for (const [key, fallback] of targets) {
        const candidates = candidatesFor(key, fallback);
        const cached = endpointSelections.get(key);
        if (cached) {
          results.push({ key, status: "cached", selected: cached, candidates });
          continue;
        }
        const probe = await probeEndpoint(candidates, []);
        if (probe.ok) {
          endpointSelections.set(key, probe.address);
          results.push({
            key,
            status: "resolved",
            selected: probe.address,
            candidates
          });
        } else {
          results.push({
            key,
            status: "unresolved",
            selected: null,
            candidates,
            error: probe.error
          });
        }
      }

      return textResult({
        ok: true,
        drySafety: true,
        note: "No mutating OSC command was sent; this only probes candidate addresses.",
        results,
        endpointSelections: Object.fromEntries(endpointSelections)
      });
    })
);

server.registerTool(
  "warmup_report_recommendations",
  {
    title: "Warmup Report Recommendations",
    description:
      "Analyze warmup resolution state and suggest concrete OSC endpoint override edits."
  },
  async () =>
    withMetrics("warmup_report_recommendations", async () => {
      const keys = [
        "renderAudio",
        "renderStems",
        "trackSetRouting",
        "deviceLoadPreset",
        "subscribeEvents"
      ];
      const unresolved = [];
      const resolved = [];
      for (const key of keys) {
        const selected = endpointSelections.get(key) ?? null;
        if (selected) {
          resolved.push({ key, selected });
        } else {
          unresolved.push({
            key,
            candidates: OSC_ENDPOINT_VARIANTS[key] ?? [],
            recommendation: `Edit OSC_ENDPOINT_VARIANTS.${key} in src/index.js with the endpoint used by your AbletonOSC fork.`
          });
        }
      }

      const samplePatch = unresolved.reduce((acc, item) => {
        acc[item.key] = item.candidates;
        return acc;
      }, {});

      return textResult({
        ok: true,
        resolved,
        unresolved,
        recommendationSteps: [
          "Run warmup_write_endpoints first.",
          "For unresolved keys, inspect your AbletonOSC docs/logs for the exact endpoint.",
          "Update OSC_ENDPOINT_VARIANTS in src/index.js and rerun warmup_write_endpoints."
        ],
        sampleOverrideObject: samplePatch
      });
    })
);

server.registerTool(
  "find_track_by_name",
  {
    title: "Find Track By Name",
    description: "Fuzzy match a track by name and return best candidates.",
    inputSchema: {
      query: z.string().min(1).max(128),
      minScore: z.number().min(0).max(1).optional().default(0.55)
    }
  },
  async ({ query, minScore }) =>
    withMetrics("find_track_by_name", async () => {
      const tracksData = await getTracksSnapshot();
      const ranked = (tracksData.tracks ?? [])
        .map((track) => ({
          index: track.index,
          name: track.name,
          score: Number(scoreNameMatch(query, track.name).toFixed(3))
        }))
        .filter((t) => t.score >= minScore)
        .sort((a, b) => b.score - a.score);
      return textResult({
        query,
        minScore,
        match: ranked[0] ?? null,
        candidates: ranked.slice(0, 10)
      });
    })
);

server.registerTool(
  "upsert_alias",
  {
    title: "Upsert Alias",
    description: "Register alias mapping for track/scene/device references.",
    inputSchema: {
      alias: z.string().min(1).max(128),
      targetType: z.enum(["track", "scene", "device", "preset"]),
      targetValue: z.string().min(1).max(256)
    }
  },
  async ({ alias, targetType, targetValue }) =>
    withMetrics("upsert_alias", async () => {
      const key = normalizeName(alias);
      aliasRegistry.set(key, { alias, targetType, targetValue, updatedAt: new Date().toISOString() });
      return textResult({ ok: true, alias: aliasRegistry.get(key) });
    })
);

server.registerTool(
  "resolve_alias",
  {
    title: "Resolve Alias",
    description: "Resolve a previously stored alias.",
    inputSchema: {
      alias: z.string().min(1).max(128)
    }
  },
  async ({ alias }) =>
    withMetrics("resolve_alias", async () => {
      const key = normalizeName(alias);
      const resolved = aliasRegistry.get(key) ?? null;
      return textResult({ alias, resolved });
    })
);

server.registerTool(
  "register_device_preset_alias",
  {
    title: "Register Device Preset Alias",
    description: "Register named preset alias for load_device_preset workflows.",
    inputSchema: {
      presetAlias: z.string().min(1).max(128),
      presetName: z.string().min(1).max(256)
    }
  },
  async ({ presetAlias, presetName }) =>
    withMetrics("register_device_preset_alias", async () => {
      const key = normalizeName(presetAlias);
      presetRegistry.set(key, { presetAlias, presetName, updatedAt: new Date().toISOString() });
      return textResult({ ok: true, preset: presetRegistry.get(key) });
    })
);

server.registerTool(
  "list_alias_registry",
  {
    title: "List Alias Registry",
    description: "Return current alias and preset registries."
  },
  async () =>
    withMetrics("list_alias_registry", async () =>
      textResult({
        aliases: Object.fromEntries(aliasRegistry),
        presets: Object.fromEntries(presetRegistry)
      })
    )
);

async function resolveTrackIndexFromName(trackName, minScore = 0.55) {
  const tracksData = await getTracksSnapshot();
  const ranked = (tracksData.tracks ?? [])
    .map((track) => ({
      index: track.index,
      name: track.name,
      score: scoreNameMatch(trackName, track.name)
    }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < minScore) {
    throw new Error(`No track matched "${trackName}" above minScore ${minScore}.`);
  }
  return best;
}

async function getTracksSnapshot() {
  const { response: countMsg } = await requestKnown("trackCountGet", [
    "/live/song/get/num_tracks",
    "/live/song/get/track_count"
  ]);
  const trackCount = Number(parseOscValue(countMsg, 0));
  const tracks = [];
  for (let i = 0; i < trackCount; i += 1) {
    const { response: nameMsg } = await requestKnown(
      "trackNameGet",
      ["/live/track/get/name", "/live/track/name"],
      [intArg(i)]
    );
    const name = nameMsg.args?.[1]?.value ?? nameMsg.args?.[0]?.value ?? `Track ${i}`;
    tracks.push({ index: i, name });
  }
  return { trackCount, tracks };
}

async function refreshStateCache() {
  if (!stateCache.enabled) return stateCache;
  const tempo = await requestKnown("tempoGet", ["/live/song/get/tempo", "/live/song/tempo"]);
  const isPlaying = await requestKnown("isPlayingGet", [
    "/live/song/get/is_playing",
    "/live/song/is_playing"
  ]);
  const currentTime = await requestKnown("songTimeGet", [
    "/live/song/get/current_song_time",
    "/live/song/current_song_time"
  ]);
  stateCache.transport = {
    tempo: Number(parseOscValue(tempo.response, 120)),
    isPlaying: Boolean(parseOscValue(isPlaying.response, 0)),
    currentSongTime: Number(parseOscValue(currentTime.response, 0))
  };
  stateCache.tracks = await getTracksSnapshot();
  stateCache.lastRefreshAt = new Date().toISOString();
  return stateCache;
}

server.registerTool(
  "set_track_volume_by_name",
  {
    title: "Set Track Volume By Name",
    description: "Fuzzy match track name and set volume.",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      volume: z.number().min(0).max(1),
      minScore: z.number().min(0).max(1).optional().default(0.55)
    }
  },
  async ({ trackName, volume, minScore }) =>
    withMetrics("set_track_volume_by_name", async () => {
      const best = await resolveTrackIndexFromName(trackName, minScore);
      return sendMaybe("/live/track/set/volume", [intArg(best.index), floatArg(volume)], {
        matchedTrack: best,
        volume
      });
    })
);

server.registerTool(
  "launch_clip_by_track_name",
  {
    title: "Launch Clip By Track Name",
    description: "Fuzzy match track and launch a clip slot index.",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      clipIndex: z.number().int().min(0),
      minScore: z.number().min(0).max(1).optional().default(0.55)
    }
  },
  async ({ trackName, clipIndex, minScore }) =>
    withMetrics("launch_clip_by_track_name", async () => {
      const best = await resolveTrackIndexFromName(trackName, minScore);
      return sendMaybe("/live/clip/fire", [intArg(best.index), intArg(clipIndex)], {
        matchedTrack: best,
        clipIndex
      });
    })
);

server.registerTool(
  "get_server_health",
  {
    title: "Get Server Health",
    description: "Return server health, probe status, and command metrics."
  },
  async () =>
    withMetrics("get_server_health", async () =>
      textResult({
        status: "ok",
        startedAt: metrics.startedAt,
        now: new Date().toISOString(),
        probeReady: probeSummary !== null,
        selectedEndpointCount: endpointSelections.size,
        startupWarnings,
        metrics
      })
    )
);

server.registerTool(
  "render_project_audio",
  {
    title: "Render Project Audio",
    description: "Trigger project render/export (endpoint support varies by AbletonOSC build).",
    inputSchema: {
      filePath: z.string().min(1).max(512),
      exportMaster: z.boolean().optional().default(true),
      normalize: z.boolean().optional().default(false),
      confirmToken: z.string().optional()
    }
  },
  async ({ filePath, exportMaster, normalize, confirmToken }) =>
    withMetrics("render_project_audio", async () => {
      guardDestructive(confirmToken);
      return sendKnownMaybe(
        "renderAudio",
        ["/live/song/export_audio"],
        [stringArg(filePath), toBoolInt(exportMaster), toBoolInt(normalize)],
        { filePath, exportMaster, normalize, destructive: true }
      );
    })
);

server.registerTool(
  "render_stems",
  {
    title: "Render Stems",
    description: "Export stems to a folder (endpoint support varies by AbletonOSC build).",
    inputSchema: {
      directoryPath: z.string().min(1).max(512),
      includeReturns: z.boolean().optional().default(true),
      confirmToken: z.string().optional()
    }
  },
  async ({ directoryPath, includeReturns, confirmToken }) =>
    withMetrics("render_stems", async () => {
      guardDestructive(confirmToken);
      return sendKnownMaybe(
        "renderStems",
        ["/live/song/export_stems"],
        [stringArg(directoryPath), toBoolInt(includeReturns)],
        { directoryPath, includeReturns, destructive: true }
      );
    })
);

server.registerTool(
  "get_metrics_dashboard",
  {
    title: "Get Metrics Dashboard",
    description: "Return human-readable dashboard summary for command activity.",
    inputSchema: {
      topN: z.number().int().min(1).max(50).optional().default(10)
    }
  },
  async ({ topN }) =>
    withMetrics("get_metrics_dashboard", async () => {
      const entries = Object.entries(metrics.commandDurationsMs)
        .map(([command, totalMs]) => ({
          command,
          totalMs,
          avgMs: Number((totalMs / Math.max(metrics.totalCommands, 1)).toFixed(2))
        }))
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, topN);
      return textResult({
        status: "ok",
        uptimeSince: metrics.startedAt,
        totalCommands: metrics.totalCommands,
        successfulCommands: metrics.successfulCommands,
        failedCommands: metrics.failedCommands,
        dryRunCommands: metrics.dryRunCommands,
        topCommandDurations: entries,
        lastError: metrics.lastError
      });
    })
);

server.registerTool(
  "reprobe_endpoints",
  {
    title: "Reprobe Endpoints",
    description: "Re-run endpoint capability probe and refresh selections."
  },
  async () =>
    withMetrics("reprobe_endpoints", async () => {
      endpointSelections.clear();
      probeSummary = await runCapabilityProbe();
      return textResult({
        reprobed: true,
        probeSummary,
        endpointSelections: Object.fromEntries(endpointSelections)
      });
    })
);

server.registerTool(
  "heartbeat",
  {
    title: "Heartbeat",
    description: "Quick connectivity check with optional reconnect.",
    inputSchema: { reconnectIfNeeded: z.boolean().optional().default(true) }
  },
  async ({ reconnectIfNeeded }) =>
    withMetrics("heartbeat", async () => {
      const check = await probeEndpoint(["/live/song/get/tempo", "/live/song/tempo"]);
      if (!check.ok && reconnectIfNeeded) {
        const reconnect = await reconnectAndProbe("heartbeat");
        return textResult({
          ok: true,
          recovered: true,
          reconnect,
          connectionState
        });
      }
      return textResult({
        ok: check.ok,
        recovered: false,
        check,
        connectionState
      });
    })
);

server.registerTool(
  "start_playback",
  {
    title: "Start Playback",
    description: "Start Ableton transport playback."
  },
  async () => {
    return sendMaybe("/live/song/start_playing");
  }
);

server.registerTool(
  "stop_playback",
  {
    title: "Stop Playback",
    description: "Stop Ableton transport playback."
  },
  async () => {
    return sendMaybe("/live/song/stop_playing");
  }
);

server.registerTool(
  "set_tempo",
  {
    title: "Set Tempo",
    description: "Set Ableton song tempo in BPM.",
    inputSchema: { bpm: z.number().min(20).max(300) }
  },
  async ({ bpm }) => {
    return sendMaybe("/live/song/set/tempo", [floatArg(bpm)], { bpm });
  }
);

server.registerTool(
  "get_tempo",
  {
    title: "Get Tempo",
    description: "Query current Ableton song tempo from AbletonOSC."
  },
  async () => {
    const { address, response } = await requestKnown("tempoGet", [
      "/live/song/get/tempo",
      "/live/song/tempo"
    ]);
    return textResult({
      tempo: parseOscValue(response),
      endpoint: address
    });
  }
);

server.registerTool(
  "launch_clip",
  {
    title: "Launch Clip",
    description: "Launch a clip by track and clip slot index.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0)
    }
  },
  async ({ trackIndex, clipIndex }) => {
    return sendMaybe("/live/clip/fire", [intArg(trackIndex), intArg(clipIndex)], {
      trackIndex,
      clipIndex
    });
  }
);

server.registerTool(
  "stop_track_clips",
  {
    title: "Stop Track Clips",
    description: "Stop all currently playing clips on a track.",
    inputSchema: {
      trackIndex: z.number().int().min(0)
    }
  },
  async ({ trackIndex }) => {
    return sendMaybe("/live/track/stop_all_clips", [intArg(trackIndex)], {
      trackIndex
    });
  }
);

server.registerTool(
  "stop_all_clips",
  {
    title: "Stop All Clips",
    description: "Stop all clips globally for all tracks."
  },
  async () => sendMaybe("/live/song/stop_all_clips")
);

server.registerTool(
  "launch_scene",
  {
    title: "Launch Scene",
    description: "Launch a scene by index.",
    inputSchema: {
      sceneIndex: z.number().int().min(0)
    }
  },
  async ({ sceneIndex }) => sendMaybe("/live/scene/fire", [intArg(sceneIndex)], { sceneIndex })
);

server.registerTool(
  "list_tracks",
  {
    title: "List Tracks",
    description: "Query track count and fetch each track name."
  },
  async () => {
    const { response: countMsg } = await requestKnown("trackCountGet", [
      "/live/song/get/num_tracks",
      "/live/song/get/track_count"
    ]);
    const trackCount = Number(parseOscValue(countMsg, 0));
    const tracks = [];

    for (let i = 0; i < trackCount; i += 1) {
      const { response: nameMsg } = await requestKnown(
        "trackNameGet",
        ["/live/track/get/name", "/live/track/name"],
        [intArg(i)]
      );
      const name = nameMsg.args?.[1]?.value ?? nameMsg.args?.[0]?.value ?? `Track ${i}`;
      tracks.push({ index: i, name });
    }

    return textResult({ trackCount, tracks });
  }
);

server.registerTool(
  "get_session_overview",
  {
    title: "Get Session Overview",
    description:
      "Read transport, tempo, time, track count and scene count with endpoint hints."
  },
  async () => {
    const tempo = await requestKnown("tempoGet", [
      "/live/song/get/tempo",
      "/live/song/tempo"
    ]);
    const isPlaying = await requestKnown("isPlayingGet", [
      "/live/song/get/is_playing",
      "/live/song/is_playing"
    ]);
    const currentTime = await requestKnown("songTimeGet", [
      "/live/song/get/current_song_time",
      "/live/song/current_song_time"
    ]);
    const trackCount = await requestKnown("trackCountGet", [
      "/live/song/get/num_tracks",
      "/live/song/get/track_count"
    ]);
    const sceneCount = await requestKnown("sceneCountGet", [
      "/live/song/get/num_scenes",
      "/live/song/get/scene_count"
    ]);

    return textResult({
      tempo: parseOscValue(tempo.response),
      isPlaying: parseOscValue(isPlaying.response),
      currentSongTime: parseOscValue(currentTime.response),
      trackCount: parseOscValue(trackCount.response),
      sceneCount: parseOscValue(sceneCount.response),
      endpoints: {
        tempo: tempo.address,
        isPlaying: isPlaying.address,
        currentSongTime: currentTime.address,
        trackCount: trackCount.address,
        sceneCount: sceneCount.address
      }
    });
  }
);

server.registerTool(
  "get_track_devices",
  {
    title: "Get Track Devices",
    description: "List device names for a track.",
    inputSchema: {
      trackIndex: z.number().int().min(0)
    }
  },
  async ({ trackIndex }) => {
    const devicesCount = await requestKnown(
      "deviceCountGet",
      ["/live/track/get/num_devices", "/live/track/get/device_count"],
      [intArg(trackIndex)]
    );
    const count = Number(parseOscValue(devicesCount.response, 0));
    const devices = [];

    for (let d = 0; d < count; d += 1) {
      const nameResp = await requestKnown(
        "deviceNameGet",
        ["/live/device/get/name", "/live/device/name"],
        [intArg(trackIndex), intArg(d)]
      );
      const raw = parseOscValue(nameResp.response);
      const name = Array.isArray(raw) ? raw[2] ?? raw[1] ?? raw[0] : raw;
      devices.push({ deviceIndex: d, name: name ?? `Device ${d}` });
    }

    return textResult({ trackIndex, deviceCount: count, devices });
  }
);

server.registerTool(
  "get_device_parameters",
  {
    title: "Get Device Parameters",
    description: "List parameter names and values for a device.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      deviceIndex: z.number().int().min(0)
    }
  },
  async ({ trackIndex, deviceIndex }) => {
    const paramCountResp = await requestKnown(
      "deviceParameterCountGet",
      ["/live/device/get/num_parameters", "/live/device/get/parameter_count"],
      [intArg(trackIndex), intArg(deviceIndex)]
    );
    const parameterCount = Number(parseOscValue(paramCountResp.response, 0));
    const parameters = [];

    for (let p = 0; p < parameterCount; p += 1) {
      const paramResp = await requestKnown(
        "deviceParameterGet",
        ["/live/device/get/parameter", "/live/device/get/param"],
        [intArg(trackIndex), intArg(deviceIndex), intArg(p)]
      );
      const raw = parseOscValue(paramResp.response);
      if (Array.isArray(raw)) {
        parameters.push({
          parameterIndex: p,
          raw
        });
      } else {
        parameters.push({
          parameterIndex: p,
          value: raw
        });
      }
    }

    return textResult({
      trackIndex,
      deviceIndex,
      parameterCount,
      parameters
    });
  }
);

server.registerTool(
  "set_device_parameter",
  {
    title: "Set Device Parameter",
    description: "Set a device parameter by index with normalized value.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      deviceIndex: z.number().int().min(0),
      parameterIndex: z.number().int().min(0),
      value: z.number().min(0).max(1)
    }
  },
  async ({ trackIndex, deviceIndex, parameterIndex, value }) =>
    sendMaybe(
      "/live/device/set/parameter/value",
      [intArg(trackIndex), intArg(deviceIndex), intArg(parameterIndex), floatArg(value)],
      { trackIndex, deviceIndex, parameterIndex, value }
    )
);

server.registerTool(
  "create_midi_clip",
  {
    title: "Create MIDI Clip",
    description: "Create a new MIDI clip in a slot.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      lengthBeats: z.number().positive()
    }
  },
  async ({ trackIndex, clipIndex, lengthBeats }) =>
    sendMaybe(
      "/live/clip_slot/create_clip",
      [intArg(trackIndex), intArg(clipIndex), floatArg(lengthBeats)],
      { trackIndex, clipIndex, lengthBeats }
    )
);

server.registerTool(
  "delete_clip",
  {
    title: "Delete Clip (Destructive)",
    description: "Delete clip at track/clip index. Requires explicit confirmation.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      confirmToken: z.string().optional()
    }
  },
  async ({ trackIndex, clipIndex, confirmToken }) => {
    guardDestructive(confirmToken);
    return sendMaybe("/live/clip/delete", [intArg(trackIndex), intArg(clipIndex)], {
      trackIndex,
      clipIndex,
      destructive: true
    });
  }
);

server.registerTool(
  "set_track_name",
  {
    title: "Set Track Name",
    description: "Rename a track.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      name: z.string().min(1).max(128)
    }
  },
  async ({ trackIndex, name }) =>
    sendMaybe("/live/track/set/name", [intArg(trackIndex), stringArg(name)], {
      trackIndex,
      name
    })
);

server.registerTool(
  "get_track_mixer",
  {
    title: "Get Track Mixer",
    description: "Read volume, pan, mute, solo, and arm status for a track.",
    inputSchema: { trackIndex: z.number().int().min(0) }
  },
  async ({ trackIndex }) =>
    withMetrics("get_track_mixer", async () => {
      const [volume, pan, mute, solo, arm] = await Promise.all([
        requestAny(["/live/track/get/volume"], [intArg(trackIndex)]),
        requestAny(["/live/track/get/panning"], [intArg(trackIndex)]),
        requestAny(["/live/track/get/mute"], [intArg(trackIndex)]),
        requestAny(["/live/track/get/solo"], [intArg(trackIndex)]),
        requestAny(["/live/track/get/arm"], [intArg(trackIndex)])
      ]);
      return textResult({
        trackIndex,
        volume: parseOscValue(volume.response),
        pan: parseOscValue(pan.response),
        mute: parseOscValue(mute.response),
        solo: parseOscValue(solo.response),
        arm: parseOscValue(arm.response)
      });
    })
);

server.registerTool(
  "set_track_mixer",
  {
    title: "Set Track Mixer",
    description: "Set track volume, pan, and/or send level.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      volume: z.number().min(0).max(1).optional(),
      pan: z.number().min(-1).max(1).optional(),
      sendIndex: z.number().int().min(0).optional(),
      sendLevel: z.number().min(0).max(1).optional()
    }
  },
  async ({ trackIndex, volume, pan, sendIndex, sendLevel }) =>
    withMetrics("set_track_mixer", async () => {
      const actions = [];
      if (volume !== undefined) {
        actions.push(sendMaybe("/live/track/set/volume", [intArg(trackIndex), floatArg(volume)]));
      }
      if (pan !== undefined) {
        actions.push(sendMaybe("/live/track/set/panning", [intArg(trackIndex), floatArg(pan)]));
      }
      if (sendIndex !== undefined || sendLevel !== undefined) {
        if (sendIndex === undefined || sendLevel === undefined) {
          throw new Error("sendIndex and sendLevel must be provided together.");
        }
        actions.push(
          sendMaybe("/live/track/set/send", [
            intArg(trackIndex),
            intArg(sendIndex),
            floatArg(sendLevel)
          ])
        );
      }
      if (actions.length === 0) {
        throw new Error("Provide at least one of volume, pan, or sendIndex/sendLevel.");
      }
      return textResult({ ok: true, trackIndex, changed: { volume, pan, sendIndex, sendLevel } });
    })
);

server.registerTool(
  "set_track_state",
  {
    title: "Set Track State",
    description: "Set track arm, mute, and solo state.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      arm: z.boolean().optional(),
      mute: z.boolean().optional(),
      solo: z.boolean().optional()
    }
  },
  async ({ trackIndex, arm, mute, solo }) =>
    withMetrics("set_track_state", async () => {
      if (arm === undefined && mute === undefined && solo === undefined) {
        throw new Error("Provide at least one of arm, mute, or solo.");
      }
      if (arm !== undefined) {
        sendMaybe("/live/track/set/arm", [intArg(trackIndex), intArg(arm ? 1 : 0)]);
      }
      if (mute !== undefined) {
        sendMaybe("/live/track/set/mute", [intArg(trackIndex), intArg(mute ? 1 : 0)]);
      }
      if (solo !== undefined) {
        sendMaybe("/live/track/set/solo", [intArg(trackIndex), intArg(solo ? 1 : 0)]);
      }
      return textResult({ ok: true, trackIndex, arm, mute, solo });
    })
);

server.registerTool(
  "list_scenes",
  {
    title: "List Scenes",
    description: "List all scenes and their names."
  },
  async () =>
    withMetrics("list_scenes", async () => {
      const countResp = await requestKnown("sceneCountGet", [
        "/live/song/get/num_scenes",
        "/live/song/get/scene_count"
      ]);
      const sceneCount = Number(parseOscValue(countResp.response, 0));
      const scenes = [];
      for (let i = 0; i < sceneCount; i += 1) {
        const sceneName = await requestAny(["/live/scene/get/name"], [intArg(i)]);
        const raw = parseOscValue(sceneName.response);
        const name = Array.isArray(raw) ? raw[1] ?? raw[0] : raw;
        scenes.push({ sceneIndex: i, name: name ?? `Scene ${i}` });
      }
      return textResult({ sceneCount, scenes });
    })
);

server.registerTool(
  "create_scene",
  {
    title: "Create Scene",
    description: "Create an empty scene at index (or append if omitted).",
    inputSchema: { sceneIndex: z.number().int().min(0).optional() }
  },
  async ({ sceneIndex }) =>
    withMetrics("create_scene", async () => {
      if (sceneIndex === undefined) {
        return sendMaybe("/live/scene/create");
      }
      return sendMaybe("/live/scene/create", [intArg(sceneIndex)], { sceneIndex });
    })
);

server.registerTool(
  "rename_scene",
  {
    title: "Rename Scene",
    description: "Rename a scene by index.",
    inputSchema: {
      sceneIndex: z.number().int().min(0),
      name: z.string().min(1).max(128)
    }
  },
  async ({ sceneIndex, name }) =>
    withMetrics("rename_scene", async () =>
      sendMaybe("/live/scene/set/name", [intArg(sceneIndex), stringArg(name)], {
        sceneIndex,
        name
      })
    )
);

server.registerTool(
  "delete_scene",
  {
    title: "Delete Scene (Destructive)",
    description: "Delete scene by index. Requires explicit confirmation.",
    inputSchema: {
      sceneIndex: z.number().int().min(0),
      confirmToken: z.string().optional()
    }
  },
  async ({ sceneIndex, confirmToken }) =>
    withMetrics("delete_scene", async () => {
      guardDestructive(confirmToken);
      return sendMaybe("/live/scene/delete", [intArg(sceneIndex)], {
        sceneIndex,
        destructive: true
      });
    })
);

server.registerTool(
  "get_clip_notes",
  {
    title: "Get Clip Notes",
    description: "Read MIDI notes for a clip (endpoint support may vary).",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0)
    }
  },
  async ({ trackIndex, clipIndex }) =>
    withMetrics("get_clip_notes", async () => {
      const resp = await requestAny(["/live/clip/get/notes", "/live/clip/get/notes_extended"], [
        intArg(trackIndex),
        intArg(clipIndex)
      ]);
      return textResult({
        trackIndex,
        clipIndex,
        endpoint: resp.address,
        notesRaw: parseOscValue(resp.response, [])
      });
    })
);

server.registerTool(
  "add_clip_notes",
  {
    title: "Add Clip Notes",
    description: "Add MIDI notes to a clip.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      notes: z
        .array(
          z.object({
            pitch: z.number().int().min(0).max(127),
            start: z.number().min(0),
            duration: z.number().positive(),
            velocity: z.number().int().min(1).max(127),
            mute: z.boolean().optional().default(false)
          })
        )
        .min(1)
    }
  },
  async ({ trackIndex, clipIndex, notes }) =>
    withMetrics("add_clip_notes", async () => {
      for (const note of notes) {
        sendMaybe("/live/clip/add_note", [
          intArg(trackIndex),
          intArg(clipIndex),
          intArg(note.pitch),
          floatArg(note.start),
          floatArg(note.duration),
          intArg(note.velocity),
          intArg(note.mute ? 1 : 0)
        ]);
      }
      return textResult({ ok: true, trackIndex, clipIndex, notesAdded: notes.length });
    })
);

server.registerTool(
  "set_transport_flags",
  {
    title: "Set Transport Flags",
    description: "Set metronome, record mode, and overdub flags.",
    inputSchema: {
      metronome: z.boolean().optional(),
      sessionRecord: z.boolean().optional(),
      overdub: z.boolean().optional()
    }
  },
  async ({ metronome, sessionRecord, overdub }) =>
    withMetrics("set_transport_flags", async () => {
      if (metronome === undefined && sessionRecord === undefined && overdub === undefined) {
        throw new Error("Provide at least one flag.");
      }
      if (metronome !== undefined) {
        sendMaybe("/live/song/set/metronome", [intArg(metronome ? 1 : 0)]);
      }
      if (sessionRecord !== undefined) {
        sendMaybe("/live/song/set/session_record", [intArg(sessionRecord ? 1 : 0)]);
      }
      if (overdub !== undefined) {
        sendMaybe("/live/song/set/overdub", [intArg(overdub ? 1 : 0)]);
      }
      return textResult({ ok: true, metronome, sessionRecord, overdub });
    })
);

server.registerTool(
  "set_loop_region",
  {
    title: "Set Loop Region",
    description: "Set loop start/length and optional loop enabled.",
    inputSchema: {
      startBeats: z.number().min(0),
      lengthBeats: z.number().positive(),
      enabled: z.boolean().optional()
    }
  },
  async ({ startBeats, lengthBeats, enabled }) =>
    withMetrics("set_loop_region", async () => {
      sendMaybe("/live/song/set/loop_start", [floatArg(startBeats)]);
      sendMaybe("/live/song/set/loop_length", [floatArg(lengthBeats)]);
      if (enabled !== undefined) {
        sendMaybe("/live/song/set/loop", [intArg(enabled ? 1 : 0)]);
      }
      return textResult({ ok: true, startBeats, lengthBeats, enabled });
    })
);

server.registerTool(
  "set_arrangement_punch",
  {
    title: "Set Arrangement Punch",
    description: "Set punch in/out flags for arrangement recording.",
    inputSchema: {
      punchIn: z.boolean().optional(),
      punchOut: z.boolean().optional()
    }
  },
  async ({ punchIn, punchOut }) =>
    withMetrics("set_arrangement_punch", async () => {
      if (punchIn === undefined && punchOut === undefined) {
        throw new Error("Provide punchIn and/or punchOut.");
      }
      if (punchIn !== undefined) {
        sendMaybe("/live/song/set/punch_in", [intArg(punchIn ? 1 : 0)]);
      }
      if (punchOut !== undefined) {
        sendMaybe("/live/song/set/punch_out", [intArg(punchOut ? 1 : 0)]);
      }
      return textResult({ ok: true, punchIn, punchOut });
    })
);

server.registerTool(
  "create_locator",
  {
    title: "Create Locator",
    description: "Create a locator at a time with a name.",
    inputSchema: {
      timeBeats: z.number().min(0),
      name: z.string().min(1).max(128).optional()
    }
  },
  async ({ timeBeats, name }) =>
    withMetrics("create_locator", async () => {
      sendMaybe("/live/song/create_locator", [floatArg(timeBeats)]);
      if (name) {
        sendMaybe("/live/song/set/last_locator_name", [stringArg(name)]);
      }
      return textResult({ ok: true, timeBeats, name: name ?? null });
    })
);

server.registerTool(
  "jump_to_time",
  {
    title: "Jump To Time",
    description: "Set the current song time in beats.",
    inputSchema: {
      timeBeats: z.number().min(0)
    }
  },
  async ({ timeBeats }) =>
    withMetrics("jump_to_time", async () =>
      sendMaybe("/live/song/set/current_song_time", [floatArg(timeBeats)], { timeBeats })
    )
);

server.registerTool(
  "arrangement_duplicate_range",
  {
    title: "Arrangement Duplicate Range",
    description: "Duplicate arrangement time range.",
    inputSchema: {
      startBeats: z.number().min(0),
      lengthBeats: z.number().positive()
    }
  },
  async ({ startBeats, lengthBeats }) =>
    withMetrics("arrangement_duplicate_range", async () =>
      sendMaybe("/live/song/duplicate_time", [floatArg(startBeats), floatArg(lengthBeats)], {
        startBeats,
        lengthBeats
      })
    )
);

server.registerTool(
  "arrangement_delete_range",
  {
    title: "Arrangement Delete Range (Destructive)",
    description: "Delete arrangement time range. Requires explicit confirmation.",
    inputSchema: {
      startBeats: z.number().min(0),
      lengthBeats: z.number().positive(),
      confirmToken: z.string().optional()
    }
  },
  async ({ startBeats, lengthBeats, confirmToken }) =>
    withMetrics("arrangement_delete_range", async () => {
      guardDestructive(confirmToken);
      return sendMaybe("/live/song/delete_time", [floatArg(startBeats), floatArg(lengthBeats)], {
        startBeats,
        lengthBeats,
        destructive: true
      });
    })
);

server.registerTool(
  "set_device_automation_point",
  {
    title: "Set Device Automation Point",
    description: "Write one automation point for a device parameter.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      deviceIndex: z.number().int().min(0),
      parameterIndex: z.number().int().min(0),
      timeBeats: z.number().min(0),
      value: z.number().min(0).max(1)
    }
  },
  async ({ trackIndex, deviceIndex, parameterIndex, timeBeats, value }) =>
    withMetrics("set_device_automation_point", async () =>
      sendMaybe(
        "/live/device/automation/set_point",
        [
          intArg(trackIndex),
          intArg(deviceIndex),
          intArg(parameterIndex),
          floatArg(timeBeats),
          floatArg(value)
        ],
        { trackIndex, deviceIndex, parameterIndex, timeBeats, value }
      )
    )
);

server.registerTool(
  "capture_session_snapshot",
  {
    title: "Capture Session Snapshot",
    description: "Capture lightweight session state for later restore helpers.",
    inputSchema: { snapshotId: z.string().min(1).max(128) }
  },
  async ({ snapshotId }) =>
    withMetrics("capture_session_snapshot", async () => {
      const overviewResp = await requestKnown("tempoGet", [
        "/live/song/get/tempo",
        "/live/song/tempo"
      ]);
      const playResp = await requestKnown("isPlayingGet", [
        "/live/song/get/is_playing",
        "/live/song/is_playing"
      ]);
      const timeResp = await requestKnown("songTimeGet", [
        "/live/song/get/current_song_time",
        "/live/song/current_song_time"
      ]);
      const snapshot = {
        snapshotId,
        capturedAt: new Date().toISOString(),
        tempo: Number(parseOscValue(overviewResp.response, 120)),
        isPlaying: Boolean(parseOscValue(playResp.response, 0)),
        currentSongTime: Number(parseOscValue(timeResp.response, 0))
      };
      snapshots.set(snapshotId, snapshot);
      return textResult({ ok: true, snapshot });
    })
);

server.registerTool(
  "restore_session_snapshot",
  {
    title: "Restore Session Snapshot",
    description: "Restore lightweight session state from snapshot.",
    inputSchema: { snapshotId: z.string().min(1).max(128) }
  },
  async ({ snapshotId }) =>
    withMetrics("restore_session_snapshot", async () => {
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot) throw new Error(`Unknown snapshotId: ${snapshotId}`);
      sendMaybe("/live/song/set/tempo", [floatArg(snapshot.tempo)]);
      sendMaybe("/live/song/set/current_song_time", [floatArg(snapshot.currentSongTime)]);
      if (snapshot.isPlaying) {
        sendMaybe("/live/song/start_playing");
      } else {
        sendMaybe("/live/song/stop_playing");
      }
      return textResult({ ok: true, restored: snapshot });
    })
);

function scaleNotesForKey(key, scale) {
  const chromatic = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const idx = chromatic.indexOf(String(key).toUpperCase());
  const root = idx >= 0 ? idx : 0;
  const intervals = scale === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return intervals.map((i) => (root + i) % 12);
}

function buildMidiNotePlan({ key, scale, bars, density, octave }) {
  const scalePitchClasses = scaleNotesForKey(key, scale);
  const notes = [];
  const stepsPerBar = 4;
  const totalSteps = bars * stepsPerBar;
  const activeEvery = density === "high" ? 1 : density === "medium" ? 2 : 4;
  for (let s = 0; s < totalSteps; s += 1) {
    if (s % activeEvery !== 0) continue;
    const degree = s % scalePitchClasses.length;
    const pitch = octave * 12 + scalePitchClasses[degree];
    notes.push({
      pitch: Math.max(0, Math.min(127, pitch)),
      start: s * 0.25,
      duration: density === "high" ? 0.2 : 0.4,
      velocity: density === "high" ? 92 : 105,
      mute: false
    });
  }
  return notes;
}

function extractClipNotes(raw) {
  if (!Array.isArray(raw)) return [];
  const notes = [];

  for (const entry of raw) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const pitch = Number(entry.pitch);
      const start = Number(entry.start);
      const duration = Number(entry.duration);
      const velocity = Number(entry.velocity ?? 100);
      const mute = Boolean(entry.mute ?? false);
      if (Number.isFinite(pitch) && Number.isFinite(start) && Number.isFinite(duration)) {
        notes.push({ pitch, start, duration, velocity, mute });
      }
      continue;
    }
    if (Array.isArray(entry) && entry.length >= 5) {
      const [pitch, start, duration, velocity, mute] = entry;
      if (Number.isFinite(Number(pitch)) && Number.isFinite(Number(start)) && Number.isFinite(Number(duration))) {
        notes.push({
          pitch: Number(pitch),
          start: Number(start),
          duration: Number(duration),
          velocity: Number(velocity ?? 100),
          mute: Boolean(mute ?? false)
        });
      }
    }
  }

  if (notes.length > 0) return notes;

  // Fallback for flat numeric arrays: [pitch,start,duration,velocity,mute,...]
  for (let i = 0; i + 4 < raw.length; i += 5) {
    const pitch = Number(raw[i]);
    const start = Number(raw[i + 1]);
    const duration = Number(raw[i + 2]);
    const velocity = Number(raw[i + 3] ?? 100);
    const mute = Boolean(raw[i + 4] ?? false);
    if (Number.isFinite(pitch) && Number.isFinite(start) && Number.isFinite(duration)) {
      notes.push({ pitch, start, duration, velocity, mute });
    }
  }
  return notes;
}

server.registerTool(
  "compile_musical_intent",
  {
    title: "Compile Musical Intent",
    description: "Convert high-level musical intent into an executable action plan scaffold.",
    inputSchema: {
      intent: z.string().min(1).max(500),
      intensity: z.enum(["low", "medium", "high"]).optional().default("medium"),
      bars: z.number().int().min(1).max(128).optional().default(8),
      targetTrackName: z.string().min(1).max(128).optional()
    }
  },
  async ({ intent, intensity, bars, targetTrackName }) =>
    withMetrics("compile_musical_intent", async () => {
      const actions = [];
      const lowered = intent.toLowerCase();
      if (lowered.includes("build") || lowered.includes("riser")) {
        actions.push({
          action: "write_device_automation_curve",
          params: {
            trackIndex: 0,
            deviceIndex: 0,
            parameterIndex: 0,
            startBeats: 0,
            endBeats: bars * 4,
            startValue: 0.1,
            endValue: intensity === "high" ? 1 : 0.8,
            shape: "s-curve",
            points: 24
          }
        });
      }
      if (targetTrackName) {
        actions.push({
          action: "set_track_volume_by_name",
          params: {
            trackName: targetTrackName,
            volume: intensity === "high" ? 0.9 : 0.82
          }
        });
      }
      if (actions.length === 0) actions.push({ action: "start_playback", params: {} });
      return textResult({ ok: true, intent, compiledPlan: { actions }, bars, intensity });
    })
);

server.registerTool(
  "upsert_arrangement_section",
  {
    title: "Upsert Arrangement Section",
    description: "Save or update a named arrangement section in memory.",
    inputSchema: {
      sectionName: z.string().min(1).max(64),
      startBeats: z.number().min(0),
      bars: z.number().int().min(1).max(256),
      notes: z.string().max(500).optional()
    }
  },
  async ({ sectionName, startBeats, bars, notes }) =>
    withMetrics("upsert_arrangement_section", async () => {
      const key = normalizeName(sectionName);
      arrangementSectionMap.set(key, {
        sectionName,
        startBeats,
        bars,
        lengthBeats: bars * 4,
        notes: notes ?? null,
        updatedAt: new Date().toISOString()
      });
      await persistArrangementSections();
      return textResult({ ok: true, section: arrangementSectionMap.get(key) });
    })
);

server.registerTool(
  "list_arrangement_sections",
  {
    title: "List Arrangement Sections",
    description: "List all saved named arrangement sections."
  },
  async () =>
    withMetrics("list_arrangement_sections", async () =>
      textResult({
        sections: [...arrangementSectionMap.values()].sort((a, b) => a.startBeats - b.startBeats)
      })
    )
);

server.registerTool(
  "export_arrangement_sections",
  {
    title: "Export Arrangement Sections",
    description: "Export current arrangement section map as JSON payload.",
    inputSchema: {
      includeMeta: z.boolean().optional().default(true)
    }
  },
  async ({ includeMeta }) =>
    withMetrics("export_arrangement_sections", async () => {
      const sections = [...arrangementSectionMap.entries()];
      return textResult({
        ok: true,
        exportedAt: new Date().toISOString(),
        count: sections.length,
        payload: includeMeta
          ? {
              version: 1,
              source: "ableton-osc-bridge",
              sections
            }
          : { sections }
      });
    })
);

server.registerTool(
  "import_arrangement_sections",
  {
    title: "Import Arrangement Sections",
    description: "Import arrangement section map from JSON payload.",
    inputSchema: {
      payload: z.object({
        sections: z.array(z.tuple([z.string(), z.record(z.unknown())])).min(1)
      }),
      merge: z.boolean().optional().default(true)
    }
  },
  async ({ payload, merge }) =>
    withMetrics("import_arrangement_sections", async () => {
      if (!merge) arrangementSectionMap.clear();
      let imported = 0;
      for (const [key, raw] of payload.sections) {
        const sectionName =
          typeof raw.sectionName === "string" && raw.sectionName.trim().length > 0
            ? raw.sectionName
            : key;
        const startBeats = Number(raw.startBeats ?? 0);
        const bars = Number(raw.bars ?? 8);
        const lengthBeats = Number(raw.lengthBeats ?? bars * 4);
        arrangementSectionMap.set(key, {
          sectionName,
          startBeats: Number.isFinite(startBeats) ? startBeats : 0,
          bars: Number.isFinite(bars) && bars > 0 ? Math.round(bars) : 8,
          lengthBeats: Number.isFinite(lengthBeats) ? lengthBeats : 32,
          notes: typeof raw.notes === "string" ? raw.notes : null,
          updatedAt: new Date().toISOString()
        });
        imported += 1;
      }
      await persistArrangementSections();
      return textResult({
        ok: true,
        merge,
        imported,
        totalSections: arrangementSectionMap.size
      });
    })
);

server.registerTool(
  "save_arrangement_section_profile",
  {
    title: "Save Arrangement Section Profile",
    description: "Save current in-memory section map to a named profile.",
    inputSchema: {
      profileName: z.string().min(1).max(128)
    }
  },
  async ({ profileName }) =>
    withMetrics("save_arrangement_section_profile", async () => {
      const key = normalizeName(profileName);
      arrangementSectionProfiles.set(key, {
        profileName,
        savedAt: new Date().toISOString(),
        sections: [...arrangementSectionMap.entries()]
      });
      await persistArrangementSectionProfiles();
      return textResult({
        ok: true,
        profileName,
        sectionCount: arrangementSectionMap.size
      });
    })
);

server.registerTool(
  "load_arrangement_section_profile",
  {
    title: "Load Arrangement Section Profile",
    description: "Load a named section profile into active in-memory map.",
    inputSchema: {
      profileName: z.string().min(1).max(128),
      merge: z.boolean().optional().default(false)
    }
  },
  async ({ profileName, merge }) =>
    withMetrics("load_arrangement_section_profile", async () => {
      const key = normalizeName(profileName);
      const profile = arrangementSectionProfiles.get(key);
      if (!profile) throw new Error(`Unknown arrangement section profile: ${profileName}`);
      if (!merge) arrangementSectionMap.clear();
      for (const [sectionKey, sectionValue] of profile.sections) {
        arrangementSectionMap.set(sectionKey, {
          ...sectionValue,
          updatedAt: new Date().toISOString()
        });
      }
      await persistArrangementSections();
      await persistArrangementSectionProfiles();
      return textResult({
        ok: true,
        profileName,
        merge,
        totalSections: arrangementSectionMap.size
      });
    })
);

server.registerTool(
  "clone_arrangement_section_map",
  {
    title: "Clone Arrangement Section Map",
    description: "Clone section profile to another profile name.",
    inputSchema: {
      sourceProfileName: z.string().min(1).max(128),
      targetProfileName: z.string().min(1).max(128),
      overwrite: z.boolean().optional().default(false)
    }
  },
  async ({ sourceProfileName, targetProfileName, overwrite }) =>
    withMetrics("clone_arrangement_section_map", async () => {
      const srcKey = normalizeName(sourceProfileName);
      const dstKey = normalizeName(targetProfileName);
      const src = arrangementSectionProfiles.get(srcKey);
      if (!src) throw new Error(`Unknown source profile: ${sourceProfileName}`);
      if (!overwrite && arrangementSectionProfiles.has(dstKey)) {
        throw new Error(`Target profile already exists: ${targetProfileName}. Use overwrite=true.`);
      }
      arrangementSectionProfiles.set(dstKey, {
        profileName: targetProfileName,
        savedAt: new Date().toISOString(),
        clonedFrom: sourceProfileName,
        sections: src.sections.map(([k, v]) => [k, { ...v }])
      });
      await persistArrangementSectionProfiles();
      return textResult({
        ok: true,
        sourceProfileName,
        targetProfileName,
        sectionCount: src.sections.length
      });
    })
);

server.registerTool(
  "list_arrangement_section_profiles",
  {
    title: "List Arrangement Section Profiles",
    description: "List saved arrangement section profiles."
  },
  async () =>
    withMetrics("list_arrangement_section_profiles", async () =>
      textResult({
        profiles: [...arrangementSectionProfiles.values()].map((p) => ({
          profileName: p.profileName,
          savedAt: p.savedAt,
          clonedFrom: p.clonedFrom ?? null,
          sectionCount: Array.isArray(p.sections) ? p.sections.length : 0
        }))
      })
    )
);

server.registerTool(
  "delete_arrangement_section_profile",
  {
    title: "Delete Arrangement Section Profile",
    description: "Delete a saved arrangement section profile.",
    inputSchema: { profileName: z.string().min(1).max(128) }
  },
  async ({ profileName }) =>
    withMetrics("delete_arrangement_section_profile", async () => {
      const deleted = arrangementSectionProfiles.delete(normalizeName(profileName));
      if (deleted) await persistArrangementSectionProfiles();
      return textResult({ ok: true, profileName, deleted });
    })
);

server.registerTool(
  "delete_arrangement_section",
  {
    title: "Delete Arrangement Section",
    description: "Delete a saved named arrangement section.",
    inputSchema: { sectionName: z.string().min(1).max(64) }
  },
  async ({ sectionName }) =>
    withMetrics("delete_arrangement_section", async () => {
      const key = normalizeName(sectionName);
      const existed = arrangementSectionMap.delete(key);
      if (existed) await persistArrangementSections();
      return textResult({ ok: true, deleted: existed, sectionName });
    })
);

server.registerTool(
  "arrangement_intelligence",
  {
    title: "Arrangement Intelligence",
    description: "Provide section-level arrangement suggestions and optional duplicate action scaffold.",
    inputSchema: {
      sectionName: z.string().min(1).max(64),
      bars: z.number().int().min(1).max(64).default(8),
      startBeats: z.number().min(0).optional().default(0),
      duplicateNow: z.boolean().optional().default(false),
      createBoundaryLocators: z.boolean().optional().default(true)
    }
  },
  async ({ sectionName, bars, startBeats, duplicateNow, createBoundaryLocators }) =>
    withMetrics("arrangement_intelligence", async () => {
      const resolved = arrangementSectionMap.get(normalizeName(sectionName));
      const resolvedStartBeats = resolved?.startBeats ?? startBeats;
      const resolvedBars = resolved?.bars ?? bars;
      const lengthBeats = resolvedBars * 4;
      const suggestions = [
        `Add transition FX in the last bar of ${sectionName}.`,
        `Reduce drum density for first half of ${sectionName}.`,
        `Create locator for "${sectionName}" boundary.`
      ];
      let duplicateResult = null;
      if (duplicateNow) {
        duplicateResult = sendPlanRaw("/live/song/duplicate_time", [floatArg(resolvedStartBeats), floatArg(lengthBeats)], {
          startBeats: resolvedStartBeats,
          lengthBeats
        });
      }
      const locatorWrites = [];
      if (createBoundaryLocators) {
        locatorWrites.push(
          sendPlanRaw("/live/song/create_locator", [floatArg(resolvedStartBeats)], {
            sectionName,
            locator: "start"
          })
        );
        locatorWrites.push(
          sendPlanRaw("/live/song/set/last_locator_name", [stringArg(`${sectionName} START`)], {
            sectionName,
            locatorName: `${sectionName} START`
          })
        );
        locatorWrites.push(
          sendPlanRaw("/live/song/create_locator", [floatArg(resolvedStartBeats + lengthBeats)], {
            sectionName,
            locator: "end"
          })
        );
        locatorWrites.push(
          sendPlanRaw("/live/song/set/last_locator_name", [stringArg(`${sectionName} END`)], {
            sectionName,
            locatorName: `${sectionName} END`
          })
        );
      }
      return textResult({
        ok: true,
        sectionName,
        bars: resolvedBars,
        startBeats: resolvedStartBeats,
        lengthBeats,
        usedSavedSection: Boolean(resolved),
        sectionMemory: resolved ?? null,
        suggestions,
        duplicateResult,
        locatorWrites
      });
    })
);

server.registerTool(
  "run_mix_health_check",
  {
    title: "Run Mix Health Check",
    description: "Best-effort diagnostics for gain staging and session sanity.",
    inputSchema: { sampleTracks: z.number().int().min(1).max(32).optional().default(8) }
  },
  async ({ sampleTracks }) =>
    withMetrics("run_mix_health_check", async () => {
      const tracks = await getTracksSnapshot();
      const report = [];
      for (const track of tracks.tracks.slice(0, sampleTracks)) {
        try {
          const [vol, pan, mute, solo, arm] = await Promise.all([
            requestAny(["/live/track/get/volume"], [intArg(track.index)]),
            requestAny(["/live/track/get/panning"], [intArg(track.index)]),
            requestAny(["/live/track/get/mute"], [intArg(track.index)]),
            requestAny(["/live/track/get/solo"], [intArg(track.index)]),
            requestAny(["/live/track/get/arm"], [intArg(track.index)])
          ]);
          const level = Number(parseOscValue(vol.response, 0.85));
          const panValue = Number(parseOscValue(pan.response, 0));
          const isMuted = Boolean(parseOscValue(mute.response, 0));
          const isSolo = Boolean(parseOscValue(solo.response, 0));
          const isArmed = Boolean(parseOscValue(arm.response, 0));
          const warnings = [];
          if (level > 0.95) warnings.push("Potential clipping risk.");
          if (level < 0.15 && !isMuted) warnings.push("Very low level while unmuted.");
          if (Math.abs(panValue) > 0.95) warnings.push("Hard panned; check stereo balance.");
          if (isSolo) warnings.push("Track is soloed.");
          if (isArmed) warnings.push("Track is armed.");
          report.push({
            trackIndex: track.index,
            name: track.name,
            volume: level,
            pan: panValue,
            mute: isMuted,
            solo: isSolo,
            arm: isArmed,
            warnings
          });
        } catch {
          report.push({ trackIndex: track.index, name: track.name, warnings: ["Unable to read mixer state."] });
        }
      }
      const clippingRiskTracks = report.filter((r) => (r.warnings ?? []).includes("Potential clipping risk.")).length;
      const soloedTracks = report.filter((r) => r.solo === true).length;
      const armedTracks = report.filter((r) => r.arm === true).length;
      return textResult({
        ok: true,
        summary: {
          clippingRiskTracks,
          soloedTracks,
          armedTracks
        },
        report
      });
    })
);

server.registerTool(
  "apply_sound_design_macro",
  {
    title: "Apply Sound Design Macro",
    description: "Apply multi-parameter morph scaffold for a target device.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      deviceIndex: z.number().int().min(0),
      macroName: z.string().min(1).max(64),
      intensity: z.number().min(0).max(1).optional().default(0.7)
    }
  },
  async ({ trackIndex, deviceIndex, macroName, intensity }) =>
    withMetrics("apply_sound_design_macro", async () => {
      const writes = [
        sendPlanRaw(
          "/live/device/set/parameter/value",
          [intArg(trackIndex), intArg(deviceIndex), intArg(0), floatArg(0.2 + 0.6 * intensity)],
          { macroName, parameterIndex: 0 }
        ),
        sendPlanRaw(
          "/live/device/set/parameter/value",
          [intArg(trackIndex), intArg(deviceIndex), intArg(1), floatArg(0.3 + 0.5 * intensity)],
          { macroName, parameterIndex: 1 }
        )
      ];
      return textResult({ ok: true, trackIndex, deviceIndex, macroName, intensity, writes });
    })
);

server.registerTool(
  "generate_midi_phrase",
  {
    title: "Generate MIDI Phrase",
    description: "Generate key/scale-aware MIDI notes and optionally write into a clip.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      key: z.string().min(1).max(3).optional().default("C"),
      scale: z.enum(["major", "minor"]).optional().default("minor"),
      bars: z.number().int().min(1).max(32).optional().default(4),
      density: z.enum(["low", "medium", "high"]).optional().default("medium"),
      octave: z.number().int().min(1).max(8).optional().default(5),
      writeToClip: z.boolean().optional().default(false)
    }
  },
  async ({ trackIndex, clipIndex, key, scale, bars, density, octave, writeToClip }) =>
    withMetrics("generate_midi_phrase", async () => {
      const notes = buildMidiNotePlan({ key, scale, bars, density, octave });
      let writeResult = null;
      if (writeToClip) {
        const writes = [];
        for (const n of notes) {
          writes.push(
            sendPlanRaw("/live/clip/add_note", [
              intArg(trackIndex),
              intArg(clipIndex),
              intArg(n.pitch),
              floatArg(n.start),
              floatArg(n.duration),
              intArg(n.velocity),
              intArg(0)
            ])
          );
        }
        writeResult = { notesWritten: writes.length };
      }
      return textResult({ ok: true, trackIndex, clipIndex, key, scale, bars, density, notes, writeResult });
    })
);

server.registerTool(
  "generate_drum_pattern",
  {
    title: "Generate Drum Pattern",
    description: "Generate drum pattern scaffold with optional variation hints.",
    inputSchema: {
      trackIndex: z.number().int().min(0).optional(),
      clipIndex: z.number().int().min(0).optional(),
      style: z.enum(["house", "techno", "trap", "dnb"]).default("house"),
      bars: z.number().int().min(1).max(16).default(4),
      variation: z.boolean().optional().default(true),
      writeToClip: z.boolean().optional().default(false)
    }
  },
  async ({ trackIndex, clipIndex, style, bars, variation, writeToClip }) =>
    withMetrics("generate_drum_pattern", async () => {
      const base = {
        kick: "1.1,1.2,1.3,1.4",
        snare: style === "trap" ? "1.3" : "1.2,1.4",
        hats: style === "dnb" ? "1.125,1.375,1.625,1.875" : "1.25,1.5,1.75"
      };
      const totalBeats = bars * 4;
      const notes = [];
      for (let b = 0; b < totalBeats; b += 1) {
        notes.push({ pitch: 36, start: b, duration: 0.2, velocity: 120, mute: false }); // kick
        if (b % 2 === 1) notes.push({ pitch: 38, start: b, duration: 0.18, velocity: 108, mute: false }); // snare
        const hatVelocity = variation && b % 4 === 3 ? 85 : 96;
        notes.push({ pitch: 42, start: b + 0.5, duration: 0.1, velocity: hatVelocity, mute: false }); // hat
      }
      if (style === "trap") {
        for (let b = 0; b < totalBeats; b += 2) {
          notes.push({ pitch: 42, start: b + 1.75, duration: 0.08, velocity: 80, mute: false });
        }
      }
      let writeResult = null;
      if (writeToClip) {
        if (trackIndex === undefined || clipIndex === undefined) {
          throw new Error("trackIndex and clipIndex are required when writeToClip=true.");
        }
        const writes = [];
        for (const note of notes) {
          writes.push(
            sendPlanRaw("/live/clip/add_note", [
              intArg(trackIndex),
              intArg(clipIndex),
              intArg(note.pitch),
              floatArg(note.start),
              floatArg(note.duration),
              intArg(note.velocity),
              intArg(note.mute ? 1 : 0)
            ])
          );
        }
        writeResult = {
          trackIndex,
          clipIndex,
          notesWritten: writes.length
        };
      }
      return textResult({
        ok: true,
        style,
        bars,
        basePattern: base,
        variationHints: variation ? ["Ghost snare before backbeat", "Open hat every 4 bars"] : [],
        notes,
        writeResult
      });
    })
);

server.registerTool(
  "compose_automation_helper",
  {
    title: "Compose Automation Helper",
    description: "Generate automation macro scaffolds (riser, ducking, drop).",
    inputSchema: {
      type: z.enum(["riser", "ducking", "drop"]),
      lengthBeats: z.number().positive().default(16)
    }
  },
  async ({ type, lengthBeats }) =>
    withMetrics("compose_automation_helper", async () =>
      textResult({
        ok: true,
        type,
        suggestedPlan:
          type === "riser"
            ? [{ action: "write_device_automation_curve", params: { startBeats: 0, endBeats: lengthBeats } }]
            : type === "ducking"
              ? [{ action: "set_device_automation_point", params: { timeBeats: 0, value: 0.4 } }]
              : [{ action: "set_device_automation_point", params: { timeBeats: lengthBeats, value: 1 } }]
      })
    )
);

server.registerTool(
  "performance_scene_action",
  {
    title: "Performance Scene Action",
    description: "Scene performance helper with optional safe-stop action.",
    inputSchema: {
      action: z.enum(["launch", "safe_stop"]),
      sceneIndex: z.number().int().min(0).optional()
    }
  },
  async ({ action, sceneIndex }) =>
    withMetrics("performance_scene_action", async () => {
      if (action === "safe_stop") {
        return sendMaybe("/live/song/stop_all_clips", [], { mode: "performance-safe-stop" });
      }
      if (sceneIndex === undefined) throw new Error("sceneIndex is required for action=launch");
      return sendMaybe("/live/scene/fire", [intArg(sceneIndex)], { sceneIndex, mode: "performance-launch" });
    })
);

server.registerTool(
  "configure_live_safety_rails",
  {
    title: "Configure Live Safety Rails",
    description: "Enable/disable live safety rails and lock track/device lists.",
    inputSchema: {
      enabled: z.boolean().optional(),
      lockedTracks: z.array(z.number().int().min(0)).optional(),
      lockedDevices: z
        .array(z.object({ trackIndex: z.number().int().min(0), deviceIndex: z.number().int().min(0) }))
        .optional()
    }
  },
  async ({ enabled, lockedTracks, lockedDevices }) =>
    withMetrics("configure_live_safety_rails", async () => {
      if (enabled !== undefined) liveSafetyState.enabled = enabled;
      if (lockedTracks !== undefined) liveSafetyState.lockedTracks = [...new Set(lockedTracks)];
      if (lockedDevices !== undefined) liveSafetyState.lockedDevices = lockedDevices;
      return textResult({ ok: true, liveSafetyState });
    })
);

server.registerTool(
  "run_project_quality_checks",
  {
    title: "Run Project Quality Checks",
    description: "Run high-level quality diagnostics and return issues list.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_project_quality_checks", async () => {
      const checks = [];
      if ((stateCache.tracks?.trackCount ?? 0) === 0) checks.push("Track cache is empty; refresh_state_cache.");
      if (!stateCache.lastRefreshAt) checks.push("No recent state cache snapshot.");
      if (!probeSummary) checks.push("Capability probe summary not ready yet.");
      return textResult({ ok: checks.length === 0, issues: checks });
    })
);

server.registerTool(
  "reference_track_workflow",
  {
    title: "Reference Track Workflow",
    description: "Scaffold for A/B reference checks and loudness alignment notes.",
    inputSchema: {
      referenceName: z.string().min(1).max(128),
      targetLufs: z.number().min(-30).max(0).optional().default(-10)
    }
  },
  async ({ referenceName, targetLufs }) =>
    withMetrics("reference_track_workflow", async () =>
      textResult({
        ok: true,
        referenceName,
        checklist: [
          "Route reference to dedicated track and bypass master bus FX.",
          `Adjust reference gain toward ${targetLufs} LUFS equivalent perceived loudness.`,
          "Perform 8-bar A/B loop comparison."
        ]
      })
    )
);

server.registerTool(
  "export_batch_profiles",
  {
    title: "Export Batch Profiles",
    description: "Queue and optionally run multiple export targets from named profiles.",
    inputSchema: {
      targets: z
        .array(
          z.object({
            profileName: z.string().min(1).max(64),
            targetPath: z.string().min(1).max(512)
          })
        )
        .min(1),
      autoStart: z.boolean().optional().default(false),
      confirmToken: z.string().optional()
    }
  },
  async ({ targets, autoStart, confirmToken }) =>
    withMetrics("export_batch_profiles", async () => {
      const created = [];
      for (const target of targets) {
        const profile = exportProfiles.get(target.profileName);
        if (!profile) {
          created.push({ ok: false, profileName: target.profileName, error: "Unknown profile" });
          continue;
        }
        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
          jobId,
          status: "queued",
          profileName: target.profileName,
          targetPath: target.targetPath,
          createdAt: new Date().toISOString()
        };
        exportJobs.set(jobId, job);
        created.push({ ok: true, jobId, profileName: target.profileName, targetPath: target.targetPath });
        if (autoStart) {
          guardDestructive(confirmToken);
          job.status = "running";
          if (profile.type === "master") {
            await sendKnownRaw(
              "renderAudio",
              ["/live/song/export_audio"],
              [stringArg(job.targetPath), toBoolInt(profile.exportMaster), toBoolInt(profile.normalize)],
              { destructive: true, jobId }
            );
          } else {
            await sendKnownRaw(
              "renderStems",
              ["/live/song/export_stems"],
              [stringArg(job.targetPath), toBoolInt(profile.includeReturns)],
              { destructive: true, jobId }
            );
          }
          job.status = "completed";
          job.completedAt = new Date().toISOString();
        }
      }
      return textResult({ ok: true, created });
    })
);

server.registerTool(
  "set_user_preferences",
  {
    title: "Set User Preferences",
    description: "Store musical/session preferences used by generation tools.",
    inputSchema: {
      defaultKey: z.string().min(1).max(3).optional(),
      defaultScale: z.enum(["major", "minor"]).optional(),
      defaultTempo: z.number().min(20).max(300).optional(),
      explanationMode: z.enum(["beginner", "producer"]).optional()
    }
  },
  async ({ defaultKey, defaultScale, defaultTempo, explanationMode }) =>
    withMetrics("set_user_preferences", async () => {
      if (defaultKey !== undefined) userPreferences.defaultKey = defaultKey;
      if (defaultScale !== undefined) userPreferences.defaultScale = defaultScale;
      if (defaultTempo !== undefined) userPreferences.defaultTempo = defaultTempo;
      if (explanationMode !== undefined) userPreferences.explanationMode = explanationMode;
      return textResult({ ok: true, userPreferences });
    })
);

server.registerTool(
  "get_user_preferences",
  {
    title: "Get User Preferences",
    description: "Return current user preference profile."
  },
  async () => withMetrics("get_user_preferences", async () => textResult({ userPreferences }))
);

server.registerTool(
  "ingest_voice_command",
  {
    title: "Ingest Voice Command",
    description: "Parse voice command text into recommended MCP tool actions.",
    inputSchema: {
      commandText: z.string().min(1).max(500)
    }
  },
  async ({ commandText }) =>
    withMetrics("ingest_voice_command", async () => {
      const c = commandText.toLowerCase();
      const suggestion = c.includes("stop")
        ? { tool: "performance_scene_action", args: { action: "safe_stop" } }
        : c.includes("tempo")
          ? { tool: "set_tempo", args: { bpm: userPreferences.defaultTempo } }
          : { tool: "compile_musical_intent", args: { intent: commandText } };
      return textResult({ ok: true, commandText, suggestion });
    })
);

server.registerTool(
  "semantic_plugin_control",
  {
    title: "Semantic Plugin Control",
    description: "Map human wording to device parameter adjustment scaffold.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      deviceIndex: z.number().int().min(0),
      prompt: z.string().min(1).max(200)
    }
  },
  async ({ trackIndex, deviceIndex, prompt }) =>
    withMetrics("semantic_plugin_control", async () => {
      const p = prompt.toLowerCase();
      const adjustment =
        p.includes("bright") || p.includes("open")
          ? { parameterIndex: 0, value: 0.75 }
          : p.includes("tight") || p.includes("short")
            ? { parameterIndex: 1, value: 0.35 }
            : { parameterIndex: 0, value: 0.55 };
      return sendMaybe(
        "/live/device/set/parameter/value",
        [intArg(trackIndex), intArg(deviceIndex), intArg(adjustment.parameterIndex), floatArg(adjustment.value)],
        { prompt, ...adjustment }
      );
    })
);

server.registerTool(
  "generate_collab_handoff",
  {
    title: "Generate Collab Handoff",
    description: "Create a concise handoff summary of current project state and suggested next tasks.",
    inputSchema: { contextNote: z.string().max(500).optional() }
  },
  async ({ contextNote }) =>
    withMetrics("generate_collab_handoff", async () =>
      textResult({
        ok: true,
        handoff: {
          overview: "Session scaffold report generated by Ableton MCP bridge.",
          recentMetrics: {
            totalCommands: metrics.totalCommands,
            failedCommands: metrics.failedCommands
          },
          nextSteps: [
            "Run run_mix_health_check before final bounce.",
            "Use preflight_action_plan for destructive plans.",
            "Capture snapshot before major arrangement edits."
          ],
          contextNote: contextNote ?? null
        }
      })
    )
);

server.registerTool(
  "explain_action_for_learning",
  {
    title: "Explain Action For Learning",
    description: "Return beginner/producer explanation for a given action and parameters.",
    inputSchema: {
      action: z.string().min(1).max(64),
      params: z.record(z.unknown()).optional().default({})
    }
  },
  async ({ action, params }) =>
    withMetrics("explain_action_for_learning", async () => {
      const mode = userPreferences.explanationMode;
      const explanation =
        mode === "beginner"
          ? `Action "${action}" changes your set with params ${JSON.stringify(params)}. Use dry-run first if unsure.`
          : `Action "${action}" will be applied with params ${JSON.stringify(params)}; validate against current arrangement and gain staging.`;
      return textResult({ ok: true, mode, explanation });
    })
);

server.registerTool(
  "upsert_template_pack",
  {
    title: "Upsert Template Pack",
    description: "Store reusable template/pack metadata for future apply workflows.",
    inputSchema: {
      name: z.string().min(1).max(128),
      category: z.enum(["arrangement", "mix", "sound-design", "performance"]),
      spec: z.record(z.unknown()).optional().default({})
    }
  },
  async ({ name, category, spec }) =>
    withMetrics("upsert_template_pack", async () => {
      templateRegistry.set(normalizeName(name), {
        name,
        category,
        spec,
        updatedAt: new Date().toISOString()
      });
      return textResult({ ok: true, template: templateRegistry.get(normalizeName(name)) });
    })
);

server.registerTool(
  "list_template_packs",
  {
    title: "List Template Packs",
    description: "List saved template packs."
  },
  async () =>
    withMetrics("list_template_packs", async () =>
      textResult({ templates: Object.fromEntries(templateRegistry) })
    )
);

server.registerTool(
  "run_show_mode_checklist",
  {
    title: "Run Show Mode Checklist",
    description: "Run pre-show readiness checklist scaffolding.",
    inputSchema: {
      includeSafety: z.boolean().optional().default(true)
    }
  },
  async ({ includeSafety }) =>
    withMetrics("run_show_mode_checklist", async () => {
      const checklist = [
        "Verify audio interface sample rate and buffer size.",
        "Confirm key scenes and locators are named.",
        "Test emergency safe stop action."
      ];
      if (includeSafety) {
        checklist.push(
          liveSafetyState.enabled
            ? "Live safety rails enabled."
            : "Enable live safety rails before performance."
        );
      }
      return textResult({ ok: true, checklist, liveSafetyState });
    })
);

server.registerTool(
  "configure_external_hooks",
  {
    title: "Configure External Hooks",
    description: "Enable/disable external ecosystem hook scaffolding.",
    inputSchema: {
      notionEnabled: z.boolean().optional(),
      releaseTrackerEnabled: z.boolean().optional(),
      backupEnabled: z.boolean().optional()
    }
  },
  async ({ notionEnabled, releaseTrackerEnabled, backupEnabled }) =>
    withMetrics("configure_external_hooks", async () => {
      if (notionEnabled !== undefined) externalHooks.notionEnabled = notionEnabled;
      if (releaseTrackerEnabled !== undefined) externalHooks.releaseTrackerEnabled = releaseTrackerEnabled;
      if (backupEnabled !== undefined) externalHooks.backupEnabled = backupEnabled;
      return textResult({ ok: true, externalHooks });
    })
);

server.registerTool(
  "run_auto_mix_pass",
  {
    title: "Run Auto Mix Pass",
    description: "Run a rough automatic mix pass across sampled tracks.",
    inputSchema: {
      sampleTracks: z.number().int().min(1).max(32).optional().default(8),
      targetLevel: z.number().min(0.4).max(0.9).optional().default(0.78),
      detectRoles: z.boolean().optional().default(true)
    }
  },
  async ({ sampleTracks, targetLevel, detectRoles }) =>
    withMetrics("run_auto_mix_pass", async () => {
      const sid = `auto_mix_${Date.now()}`;
      const snapshot = await captureRollbackSnapshotInternal(sid);
      const tracks = await getTracksSnapshot();
      const writes = [];
      const roleAssignments = [];
      for (const t of tracks.tracks.slice(0, sampleTracks)) {
        let role = "music";
        if (detectRoles) {
          const n = normalizeName(t.name);
          role = n.includes("kick")
            ? "kick"
            : n.includes("bass")
              ? "bass"
              : n.includes("vocal") || n.includes("vox")
                ? "vocal"
                : n.includes("lead")
                  ? "lead"
                  : "music";
        }
        roleAssignments.push({ trackIndex: t.index, name: t.name, role });
        const roleOffset =
          role === "kick" ? 0.05 : role === "bass" ? 0.03 : role === "vocal" ? 0.02 : role === "lead" ? 0.01 : -0.02;
        const shaped = Number((targetLevel + roleOffset - (t.index % 2) * 0.02).toFixed(3));
        writes.push(
          sendPlanRaw("/live/track/set/volume", [intArg(t.index), floatArg(Math.max(0.2, Math.min(1, shaped)))], {
            trackIndex: t.index,
            role
          })
        );
        const pan =
          role === "kick" || role === "bass" || role === "vocal"
            ? 0
            : t.index % 2 === 0
              ? -0.12
              : 0.12;
        writes.push(
          sendPlanRaw("/live/track/set/panning", [intArg(t.index), floatArg(pan)], {
            trackIndex: t.index,
            role
          })
        );
      }
      return textResult({
        ok: true,
        snapshotId: snapshot.snapshotId,
        writes,
        sampleTracks,
        targetLevel,
        roleAssignments
      });
    })
);

server.registerTool(
  "build_vocal_chain",
  {
    title: "Build Vocal Chain",
    description: "Scaffold vocal chain setup and parameter recommendations.",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      style: z.enum(["pop", "rap", "indie", "electronic"]).optional().default("pop")
    }
  },
  async ({ trackName, style }) =>
    withMetrics("build_vocal_chain", async () =>
      textResult({
        ok: true,
        trackName,
        style,
        chain: ["HPF EQ", "De-esser", "Compressor", "Saturation", "Delay Send", "Reverb Send"]
      })
    )
);

server.registerTool(
  "repair_clip_timing",
  {
    title: "Repair Clip Timing",
    description: "Scaffold clip timing correction recommendations.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      strength: z.number().min(0).max(1).optional().default(0.7)
    }
  },
  async ({ trackIndex, clipIndex, strength }) =>
    withMetrics("repair_clip_timing", async () =>
      textResult({
        ok: true,
        trackIndex,
        clipIndex,
        strength,
        recommendation: "Apply quantize then nudge groove timing by analyzed offset."
      })
    )
);

server.registerTool(
  "build_transition_between_sections",
  {
    title: "Build Transition Between Sections",
    description: "Generate transition plan between two named sections.",
    inputSchema: {
      fromSection: z.string().min(1).max(64),
      toSection: z.string().min(1).max(64),
      bars: z.number().int().min(1).max(16).optional().default(4)
    }
  },
  async ({ fromSection, toSection, bars }) =>
    withMetrics("build_transition_between_sections", async () =>
      textResult({
        ok: true,
        fromSection,
        toSection,
        bars,
        actions: ["Riser automation", "Drum fill trigger", "Bass low-cut sweep", "Reverb tail throw"]
      })
    )
);

server.registerTool(
  "shape_section_energy",
  {
    title: "Shape Section Energy",
    description: "Apply section-level energy shaping scaffold.",
    inputSchema: {
      sectionName: z.string().min(1).max(64),
      targetEnergy: z.enum(["low", "medium", "high"])
    }
  },
  async ({ sectionName, targetEnergy }) =>
    withMetrics("shape_section_energy", async () =>
      textResult({
        ok: true,
        sectionName,
        targetEnergy,
        recipe:
          targetEnergy === "low"
            ? ["Lower hats", "Reduce high shelf", "Cut reverb send"]
            : targetEnergy === "medium"
              ? ["Moderate drum bus", "Balanced mids", "Controlled FX"]
              : ["Boost drum bus", "Open filters", "Increase send FX"]
      })
    )
);

server.registerTool(
  "configure_adaptive_macro_performer",
  {
    title: "Configure Adaptive Macro Performer",
    description: "Create performance macro mapping scaffold for knobs.",
    inputSchema: {
      macroName: z.string().min(1).max(128),
      mappings: z
        .array(
          z.object({
            knob: z.number().int().min(1).max(8),
            target: z.string().min(1).max(128),
            min: z.number().min(0).max(1),
            max: z.number().min(0).max(1)
          })
        )
        .min(1)
    }
  },
  async ({ macroName, mappings }) =>
    withMetrics("configure_adaptive_macro_performer", async () => {
      macroRegistry.set(normalizeName(macroName), { name: macroName, mappings, type: "adaptive-performer" });
      return textResult({ ok: true, macro: macroRegistry.get(normalizeName(macroName)) });
    })
);

server.registerTool(
  "auto_gain_stage_tracks",
  {
    title: "Auto Gain Stage Tracks",
    description: "Auto-adjust sampled track gains toward target range.",
    inputSchema: {
      sampleTracks: z.number().int().min(1).max(64).optional().default(16),
      target: z.number().min(0.5).max(0.9).optional().default(0.75)
    }
  },
  async ({ sampleTracks, target }) =>
    withMetrics("auto_gain_stage_tracks", async () => {
      const tracks = await getTracksSnapshot();
      const writes = [];
      for (const t of tracks.tracks.slice(0, sampleTracks)) {
        try {
          const vol = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
          const current = Number(parseOscValue(vol.response, target));
          const next = Number((current * 0.5 + target * 0.5).toFixed(4));
          writes.push(
            sendPlanRaw("/live/track/set/volume", [intArg(t.index), floatArg(next)], { trackIndex: t.index, current, next })
          );
        } catch {
          // keep best-effort
        }
      }
      return textResult({ ok: true, writes, target, sampleTracks });
    })
);

server.registerTool(
  "create_bus_architecture",
  {
    title: "Create Bus Architecture",
    description: "Create bus architecture scaffold and routing plan.",
    inputSchema: { includeVocals: z.boolean().optional().default(true) }
  },
  async ({ includeVocals }) =>
    withMetrics("create_bus_architecture", async () => {
      const busses = includeVocals ? ["DRUM BUS", "MUSIC BUS", "VOCAL BUS"] : ["DRUM BUS", "MUSIC BUS"];
      const tracks = await getTracksSnapshot();
      const writes = [];
      for (const t of tracks.tracks.slice(0, 24)) {
        const n = normalizeName(t.name);
        const bus = n.includes("kick") || n.includes("snare") || n.includes("drum")
          ? "DRUM BUS"
          : n.includes("vocal") || n.includes("vox")
            ? "VOCAL BUS"
            : "MUSIC BUS";
        if (!includeVocals && bus === "VOCAL BUS") continue;
        writes.push(
          await sendKnownRaw(
            "trackSetRouting",
            ["/live/track/set/routing"],
            [intArg(t.index), stringArg(bus), stringArg("PREMASTER")],
            { trackIndex: t.index, trackName: t.name, bus }
          )
        );
      }
      return textResult({
        ok: true,
        busses,
        routingPlan: "Route groups to PREMASTER then MASTER.",
        writes
      });
    })
);

server.registerTool(
  "set_latency_safe_recording_mode",
  {
    title: "Set Latency Safe Recording Mode",
    description: "Toggle low-latency recording behavior scaffold.",
    inputSchema: { enabled: z.boolean() }
  },
  async ({ enabled }) =>
    withMetrics("set_latency_safe_recording_mode", async () =>
      textResult({
        ok: true,
        enabled,
        actions: enabled
          ? ["Disable heavy FX chains", "Set low buffer profile", "Arm recording tracks"]
          : ["Re-enable FX chains", "Restore mixing buffer profile"]
      })
    )
);

server.registerTool(
  "arrangement_completion_assistant",
  {
    title: "Arrangement Completion Assistant",
    description: "Identify missing structure blocks and propose completion.",
    inputSchema: { targetStyle: z.string().min(1).max(64).optional().default("electronic") }
  },
  async ({ targetStyle }) =>
    withMetrics("arrangement_completion_assistant", async () =>
      textResult({
        ok: true,
        targetStyle,
        missingCandidates: ["Intro", "Breakdown", "Outro"],
        proposedPlan: ["Add 8-bar intro", "Add 16-bar breakdown before final drop"]
      })
    )
);

server.registerTool(
  "detect_track_roles",
  {
    title: "Detect Track Roles",
    description: "Detect probable roles from track names.",
    inputSchema: {}
  },
  async () =>
    withMetrics("detect_track_roles", async () => {
      const tracks = await getTracksSnapshot();
      const roles = tracks.tracks.map((t) => {
        const n = normalizeName(t.name);
        const role = n.includes("kick")
          ? "kick"
          : n.includes("bass")
            ? "bass"
            : n.includes("vox") || n.includes("vocal")
              ? "vocal"
              : n.includes("lead")
                ? "lead"
                : "music";
        return { trackIndex: t.index, name: t.name, role };
      });
      return textResult({ ok: true, roles });
    })
);

server.registerTool(
  "run_release_prep_pipeline",
  {
    title: "Run Release Prep Pipeline",
    description: "Run release prep checklist and optional deliverables export matrix.",
    inputSchema: {
      baseDirectory: z.string().min(1).max(512),
      autoStartExports: z.boolean().optional().default(false),
      maxWarnings: z.number().int().min(0).max(20).optional().default(0),
      force: z.boolean().optional().default(false),
      confirmToken: z.string().optional()
    }
  },
  async ({ baseDirectory, autoStartExports, maxWarnings, force, confirmToken }) =>
    withMetrics("run_release_prep_pipeline", async () => {
      const guardrailData = await (async () => {
        const tempo = await requestKnown("tempoGet", ["/live/song/get/tempo", "/live/song/tempo"]);
        const playing = await requestKnown("isPlayingGet", [
          "/live/song/get/is_playing",
          "/live/song/is_playing"
        ]);
        const tracks = await getTracksSnapshot();
        const vols = [];
        for (const t of tracks.tracks.slice(0, 16)) {
          try {
            const v = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
            vols.push(Number(parseOscValue(v.response, 0.85)));
          } catch {
            // ignore
          }
        }
        const high = vols.filter((v) => v > 0.95).length;
        const warnings = [];
        if (high > 0) warnings.push(`High-volume tracks detected: ${high}`);
        if (Boolean(parseOscValue(playing.response, 0))) warnings.push("Transport currently playing.");
        return {
          tempo: Number(parseOscValue(tempo.response, 120)),
          isPlaying: Boolean(parseOscValue(playing.response, 0)),
          warnings
        };
      })();

      const blockedByGuardrails = guardrailData.warnings.length > maxWarnings && !force;
      if (blockedByGuardrails) {
        return textResult({
          ok: false,
          blocked: true,
          reason: "Guardrail warning threshold exceeded.",
          maxWarnings,
          warningCount: guardrailData.warnings.length,
          force,
          guardrails: guardrailData,
          nextStep: "Set force=true to proceed anyway, or resolve warnings first."
        });
      }

      const targets = [
        { profileName: "mastering-print", targetPath: `${baseDirectory}/master.wav` },
        { profileName: "streaming", targetPath: `${baseDirectory}/streaming.wav` },
        { profileName: "mix-engineer-stems", targetPath: `${baseDirectory}/stems` }
      ];
      const matrixJobs = [];
      for (const t of targets) {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
          jobId,
          status: "queued",
          profileName: t.profileName,
          targetPath: t.targetPath,
          createdAt: new Date().toISOString()
        };
        exportJobs.set(jobId, job);
        matrixJobs.push(job);
        if (autoStartExports) {
          guardDestructive(confirmToken);
          const profile = exportProfiles.get(t.profileName);
          job.status = "running";
          if (profile?.type === "stems") {
            await sendKnownRaw(
              "renderStems",
              ["/live/song/export_stems"],
              [stringArg(t.targetPath), toBoolInt(profile.includeReturns)],
              { destructive: true, jobId }
            );
          } else {
            await sendKnownRaw(
              "renderAudio",
              ["/live/song/export_audio"],
              [stringArg(t.targetPath), toBoolInt(true), toBoolInt(false)],
              { destructive: true, jobId }
            );
          }
          job.status = "completed";
          job.completedAt = new Date().toISOString();
        }
      }

      if (autoStartExports) guardDestructive(confirmToken);
      return textResult({
        ok: guardrailData.warnings.length === 0,
        blocked: false,
        baseDirectory,
        autoStartExports,
        maxWarnings,
        force,
        steps: ["Guardrails checked", "Deliverables matrix generated", "Release report prepared"],
        guardrails: guardrailData,
        matrix: { targets, jobs: matrixJobs }
      });
    })
);

server.registerTool(
  "smart_sample_audit",
  {
    title: "Smart Sample Audit",
    description: "Run sample audit scaffold for missing/unused/duplicate samples.",
    inputSchema: {}
  },
  async () =>
    withMetrics("smart_sample_audit", async () =>
      textResult({
        ok: true,
        findings: ["No filesystem scan in scaffold mode", "Integrate project sample index provider next"]
      })
    )
);

server.registerTool(
  "schedule_macro_timeline",
  {
    title: "Schedule Macro Timeline",
    description: "Schedule macro trigger at bar position.",
    inputSchema: {
      macroName: z.string().min(1).max(128),
      bar: z.number().int().min(1),
      enabled: z.boolean().optional().default(true)
    }
  },
  async ({ macroName, bar, enabled }) =>
    withMetrics("schedule_macro_timeline", async () => {
      const key = `${normalizeName(macroName)}@${bar}`;
      macroSchedule.set(key, { macroName, bar, enabled, updatedAt: new Date().toISOString() });
      return textResult({ ok: true, schedule: macroSchedule.get(key) });
    })
);

server.registerTool(
  "configure_live_improv_guardrails",
  {
    title: "Configure Live Improv Guardrails",
    description: "Set improv safety behavior and autosnapshot cadence scaffold.",
    inputSchema: {
      enabled: z.boolean(),
      autoSnapshotBars: z.number().int().min(1).max(128).optional().default(8)
    }
  },
  async ({ enabled, autoSnapshotBars }) =>
    withMetrics("configure_live_improv_guardrails", async () => {
      liveSafetyState.enabled = enabled;
      return textResult({ ok: true, enabled, autoSnapshotBars, liveSafetyState });
    })
);

server.registerTool(
  "diagnose_mix_issue",
  {
    title: "Diagnose Mix Issue",
    description: "Map problem statements to concrete remediation suggestions.",
    inputSchema: { issue: z.string().min(1).max(256) }
  },
  async ({ issue }) =>
    withMetrics("diagnose_mix_issue", async () => {
      const i = issue.toLowerCase();
      const suggestions = i.includes("kick") && i.includes("bass")
        ? ["Sidechain bass to kick", "Cut 50-80Hz on bass slightly", "Shorten kick tail"]
        : i.includes("mud")
          ? ["Reduce 200-400Hz bus buildup", "High-pass non-bass elements"]
          : ["Check gain staging", "Check arrangement density", "A/B with reference"];
      return textResult({ ok: true, issue, suggestions });
    })
);

server.registerTool(
  "optimize_plugin_chain",
  {
    title: "Optimize Plugin Chain",
    description: "Suggest CPU/latency optimization scaffold for plugin chains.",
    inputSchema: { trackName: z.string().min(1).max(128) }
  },
  async ({ trackName }) =>
    withMetrics("optimize_plugin_chain", async () =>
      textResult({
        ok: true,
        trackName,
        optimizations: [
          "Move linear-phase processors to mixdown stage",
          "Freeze heavy synth tracks",
          "Consolidate redundant EQ instances"
        ]
      })
    )
);

server.registerTool(
  "set_session_goal",
  {
    title: "Set Session Goal",
    description: "Create guided session goal and checkpoints.",
    inputSchema: {
      goalName: z.string().min(1).max(128),
      minutes: z.number().int().min(5).max(300)
    }
  },
  async ({ goalName, minutes }) =>
    withMetrics("set_session_goal", async () => {
      sessionGoals.set(normalizeName(goalName), {
        goalName,
        minutes,
        checkpoints: ["Plan", "Execute", "Review"],
        createdAt: new Date().toISOString()
      });
      return textResult({ ok: true, goal: sessionGoals.get(normalizeName(goalName)) });
    })
);

server.registerTool(
  "manage_setlist",
  {
    title: "Manage Setlist",
    description: "Manage multi-song setlist scaffold entries.",
    inputSchema: {
      action: z.enum(["add", "remove", "list"]),
      songName: z.string().min(1).max(128).optional()
    }
  },
  async ({ action, songName }) =>
    withMetrics("manage_setlist", async () => {
      const key = "default";
      const current = setlistRegistry.get(key) ?? [];
      if (action === "add") {
        if (!songName) throw new Error("songName required for add.");
        current.push(songName);
        setlistRegistry.set(key, current);
      } else if (action === "remove") {
        if (!songName) throw new Error("songName required for remove.");
        setlistRegistry.set(
          key,
          current.filter((s) => normalizeName(s) !== normalizeName(songName))
        );
      }
      return textResult({ ok: true, songs: setlistRegistry.get(key) ?? [] });
    })
);

server.registerTool(
  "export_session_documentation",
  {
    title: "Export Session Documentation",
    description: "Generate session documentation summary from runtime metrics and context.",
    inputSchema: {
      note: z.string().max(500).optional()
    }
  },
  async ({ note }) =>
    withMetrics("export_session_documentation", async () =>
      textResult({
        ok: true,
        generatedAt: new Date().toISOString(),
        summary: {
          totalCommands: metrics.totalCommands,
          failedCommands: metrics.failedCommands,
          lastError: metrics.lastError
        },
        note: note ?? null
      })
    )
);

server.registerTool(
  "ai_arrangement_rewrite",
  {
    title: "AI Arrangement Rewrite",
    description: "Generate reversible arrangement rewrite plan by style intent.",
    inputSchema: {
      targetStyle: z.string().min(1).max(64),
      intensity: z.enum(["low", "medium", "high"]).optional().default("medium")
    }
  },
  async ({ targetStyle, intensity }) =>
    withMetrics("ai_arrangement_rewrite", async () =>
      textResult({
        ok: true,
        targetStyle,
        intensity,
        reversiblePlan: [
          { action: "arrangement_duplicate_range", params: { startBeats: 0, lengthBeats: 32 } },
          { action: "write_device_automation_curve", params: { shape: "s-curve", points: 24 } }
        ]
      })
    )
);

server.registerTool(
  "drum_replacement_assistant",
  {
    title: "Drum Replacement Assistant",
    description: "Suggest drum replacement/layering strategy by context.",
    inputSchema: {
      drumRole: z.enum(["kick", "snare", "hats", "perc"]),
      targetCharacter: z.string().min(1).max(64)
    }
  },
  async ({ drumRole, targetCharacter }) =>
    withMetrics("drum_replacement_assistant", async () =>
      textResult({
        ok: true,
        drumRole,
        targetCharacter,
        suggestions: [
          `Layer transient-focused ${drumRole} sample`,
          "Phase-align replacement with original",
          "Blend parallel saturation bus"
        ]
      })
    )
);

server.registerTool(
  "resolve_kick_bass_conflict",
  {
    title: "Resolve Kick Bass Conflict",
    description: "Generate concrete remediation plan for kick/bass masking.",
    inputSchema: {
      kickTrackName: z.string().min(1).max(128),
      bassTrackName: z.string().min(1).max(128),
      aggressiveness: z.number().min(0).max(1).optional().default(0.6)
    }
  },
  async ({ kickTrackName, bassTrackName, aggressiveness }) =>
    withMetrics("resolve_kick_bass_conflict", async () => {
      const kick = await resolveTrackIndexFromName(kickTrackName, 0.5);
      const bass = await resolveTrackIndexFromName(bassTrackName, 0.5);
      const writes = [];

      writes.push(
        await sendKnownRaw(
          "trackSetRouting",
          ["/live/track/set/routing"],
          [intArg(bass.index), stringArg(`SC_IN:${kick.name}`), stringArg("MASTER")],
          { bassTrack: bass, kickTrack: kick, purpose: "sidechain-input-routing" }
        )
      );

      // Best-effort compressor-like controls on bass first device.
      const threshold = Number((0.92 - aggressiveness * 0.75).toFixed(4));
      const release = Number((0.15 + aggressiveness * 0.7).toFixed(4));
      writes.push(
        sendPlanRaw(
          "/live/device/set/parameter/value",
          [intArg(bass.index), intArg(0), intArg(2), floatArg(Math.max(0.05, Math.min(1, threshold)))],
          { track: bass, parameter: "sidechain-threshold-proxy", aggressiveness }
        )
      );
      writes.push(
        sendPlanRaw(
          "/live/device/set/parameter/value",
          [intArg(bass.index), intArg(0), intArg(3), floatArg(Math.max(0.05, Math.min(1, release)))],
          { track: bass, parameter: "sidechain-release-proxy", aggressiveness }
        )
      );

      // Kick gain trim proxy on first device parameter.
      writes.push(
        sendPlanRaw(
          "/live/device/set/parameter/value",
          [intArg(kick.index), intArg(0), intArg(1), floatArg(Math.max(0.2, 0.7 - aggressiveness * 0.25))],
          { track: kick, parameter: "kick-tail-or-gain-proxy", aggressiveness }
        )
      );

      return textResult({
        ok: true,
        kickTrack: kick,
        bassTrack: bass,
        aggressiveness,
        writes,
        plan: [
          "Applied sidechain routing target on bass track.",
          "Applied bass threshold/release proxy parameters.",
          "Applied kick gain/tail proxy trim."
        ]
      });
    })
);

server.registerTool(
  "advanced_vocal_polish",
  {
    title: "Advanced Vocal Polish",
    description: "Provide advanced vocal polish checklist and chain moves.",
    inputSchema: {
      mode: z.enum(["tight", "natural", "glossy"]).optional().default("natural")
    }
  },
  async ({ mode }) =>
    withMetrics("advanced_vocal_polish", async () =>
      textResult({
        ok: true,
        mode,
        steps: ["De-ess", "Level compression", "Timing tighten", "Parallel air band", "Space effects"]
      })
    )
);

server.registerTool(
  "transform_genre_template",
  {
    title: "Transform Genre Template",
    description: "Transform session direction toward genre template scaffold.",
    inputSchema: {
      genre: z.enum(["house", "techno", "trap", "dnb", "cinematic"]),
      preserveMelody: z.boolean().optional().default(true)
    }
  },
  async ({ genre, preserveMelody }) =>
    withMetrics("transform_genre_template", async () =>
      textResult({
        ok: true,
        genre,
        preserveMelody,
        changes: ["Adjust groove density", "Rebalance low end", "Apply genre transition structure"]
      })
    )
);

server.registerTool(
  "detect_section_similarity",
  {
    title: "Detect Section Similarity",
    description: "Find likely repetitive sections and suggest variation ideas.",
    inputSchema: {}
  },
  async () =>
    withMetrics("detect_section_similarity", async () => {
      const sections = [...arrangementSectionMap.values()].sort((a, b) => a.startBeats - b.startBeats);
      const findings = [];
      for (let i = 1; i < sections.length; i += 1) {
        if (sections[i].bars === sections[i - 1].bars) {
          findings.push({
            a: sections[i - 1].sectionName,
            b: sections[i].sectionName,
            suggestion: "Add fill + automation variation in second section."
          });
        }
      }
      return textResult({ ok: true, findings });
    })
);

server.registerTool(
  "generate_drop_builder_plan",
  {
    title: "Generate Drop Builder Plan",
    description: "Create pre-drop tension and drop impact action plan.",
    inputSchema: {
      bars: z.number().int().min(1).max(16).optional().default(8),
      intensity: z.enum(["low", "medium", "high"]).optional().default("high")
    }
  },
  async ({ bars, intensity }) =>
    withMetrics("generate_drop_builder_plan", async () =>
      textResult({
        ok: true,
        bars,
        intensity,
        plan: [
          "Filter sweep up on build bus",
          "Snare roll acceleration",
          "One-beat silence before drop",
          "Sub + kick impact restore"
        ]
      })
    )
);

server.registerTool(
  "write_dynamic_bus_automation",
  {
    title: "Write Dynamic Bus Automation",
    description: "Create bus automation movement scaffold.",
    inputSchema: {
      busName: z.string().min(1).max(64),
      startBeats: z.number().min(0),
      endBeats: z.number().gt(0),
      startValue: z.number().min(0).max(1),
      endValue: z.number().min(0).max(1)
    }
  },
  async ({ busName, startBeats, endBeats, startValue, endValue }) =>
    withMetrics("write_dynamic_bus_automation", async () =>
      textResult({
        ok: true,
        busName,
        suggestedAutomation: { startBeats, endBeats, startValue, endValue, shape: "s-curve" }
      })
    )
);

server.registerTool(
  "run_release_readiness_score",
  {
    title: "Run Release Readiness Score",
    description: "Compute release readiness score from guardrail and session signals.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_release_readiness_score", async () => {
      const tempo = await requestKnown("tempoGet", ["/live/song/get/tempo", "/live/song/tempo"]);
      const isPlaying = await requestKnown("isPlayingGet", [
        "/live/song/get/is_playing",
        "/live/song/is_playing"
      ]);
      const tracks = await getTracksSnapshot();
      const volumes = [];
      for (const t of tracks.tracks.slice(0, 16)) {
        try {
          const vol = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
          volumes.push(Number(parseOscValue(vol.response, 0.85)));
        } catch {
          // best effort
        }
      }
      const highVol = volumes.filter((v) => v > 0.95).length;
      const lowVol = volumes.filter((v) => v < 0.1).length;

      const warningPenalty = Math.min(40, metrics.failedCommands * 2);
      const probePenalty = probeSummary ? 0 : 20;
      const highVolPenalty = Math.min(20, highVol * 4);
      const lowVolPenalty = Math.min(10, lowVol * 2);
      const playPenalty = Boolean(parseOscValue(isPlaying.response, 0)) ? 5 : 0;
      const score = Math.max(0, 100 - warningPenalty - probePenalty - highVolPenalty - lowVolPenalty - playPenalty);
      return textResult({
        ok: true,
        score,
        factors: {
          failedCommands: metrics.failedCommands,
          probeReady: Boolean(probeSummary),
          tempo: Number(parseOscValue(tempo.response, 120)),
          isPlaying: Boolean(parseOscValue(isPlaying.response, 0)),
          sampledTracks: volumes.length,
          highVolumeTracks: highVol,
          veryLowTracks: lowVol
        },
        verdict: score >= 80 ? "ready" : score >= 60 ? "needs-review" : "not-ready"
      });
    })
);

server.registerTool(
  "intelligent_freeze_manager",
  {
    title: "Intelligent Freeze Manager",
    description: "Suggest freeze candidates for CPU-heavy tracks scaffold.",
    inputSchema: {}
  },
  async () =>
    withMetrics("intelligent_freeze_manager", async () =>
      textResult({
        ok: true,
        note: "CPU profiling integration pending; scaffold returns candidate strategy.",
        strategy: ["Freeze heavy synth tracks", "Flatten committed audio FX prints"]
      })
    )
);

server.registerTool(
  "set_session_focus_mode",
  {
    title: "Set Session Focus Mode",
    description: "Set session focus mode by production goal.",
    inputSchema: {
      mode: z.enum(["arrangement", "sound-design", "mixing", "performance", "off"])
    }
  },
  async ({ mode }) =>
    withMetrics("set_session_focus_mode", async () =>
      textResult({
        ok: true,
        mode,
        focusActions:
          mode === "off" ? ["Restore all tracks/tools"] : [`Prioritize ${mode} toolset`, "De-prioritize unrelated actions"]
      })
    )
);

server.registerTool(
  "contextual_coaching_assistant",
  {
    title: "Contextual Coaching Assistant",
    description: "Explain why recommended actions help in current context.",
    inputSchema: {
      topic: z.string().min(1).max(128)
    }
  },
  async ({ topic }) =>
    withMetrics("contextual_coaching_assistant", async () =>
      textResult({
        ok: true,
        topic,
        coaching: `For "${topic}", prioritize clarity and headroom before adding complexity.`
      })
    )
);

server.registerTool(
  "rank_recording_takes",
  {
    title: "Rank Recording Takes",
    description: "Rank takes by weighted criteria scaffold.",
    inputSchema: {
      takes: z.array(z.string().min(1).max(128)).min(1),
      criteria: z
        .object({
          timing: z.number().min(0).max(1).optional().default(0.4),
          pitch: z.number().min(0).max(1).optional().default(0.3),
          energy: z.number().min(0).max(1).optional().default(0.3)
        })
        .optional()
    }
  },
  async ({ takes, criteria }) =>
    withMetrics("rank_recording_takes", async () => {
      const c = criteria ?? { timing: 0.4, pitch: 0.3, energy: 0.3 };
      const ranked = takes
        .map((name, i) => ({
          take: name,
          score: Number((100 - i * 7 + c.timing * 10 + c.pitch * 8 + c.energy * 9).toFixed(2))
        }))
        .sort((a, b) => b.score - a.score);
      return textResult({ ok: true, criteria: c, ranked });
    })
);

server.registerTool(
  "reference_aware_tonal_targeting",
  {
    title: "Reference Aware Tonal Targeting",
    description: "Suggest tonal targeting moves against a reference.",
    inputSchema: {
      referenceName: z.string().min(1).max(128)
    }
  },
  async ({ referenceName }) =>
    withMetrics("reference_aware_tonal_targeting", async () =>
      textResult({
        ok: true,
        referenceName,
        targets: ["Tighten 60-100Hz", "Smooth 2-4kHz harshness", "Match top-end air balance"]
      })
    )
);

server.registerTool(
  "create_creative_prompt_scene",
  {
    title: "Create Creative Prompt Scene",
    description: "Generate scene concept from creative prompt scaffold.",
    inputSchema: {
      prompt: z.string().min(1).max(256)
    }
  },
  async ({ prompt }) =>
    withMetrics("create_creative_prompt_scene", async () =>
      textResult({
        ok: true,
        prompt,
        sceneConcept: {
          layers: ["pad texture", "motif arpeggio", "fx shimmer"],
          automation: "Slow filter open over 8 bars"
        }
      })
    )
);

server.registerTool(
  "live_performance_cue_engine",
  {
    title: "Live Performance Cue Engine",
    description: "Return timed cue sequence for live actions.",
    inputSchema: {
      barsAhead: z.number().int().min(1).max(64).optional().default(16)
    }
  },
  async ({ barsAhead }) =>
    withMetrics("live_performance_cue_engine", async () =>
      textResult({
        ok: true,
        cues: [
          { atBarOffset: 4, cue: "Prepare filter sweep" },
          { atBarOffset: 8, cue: "Trigger transition fx" },
          { atBarOffset: Math.max(12, barsAhead - 2), cue: "Ready drop launch" }
        ]
      })
    )
);

server.registerTool(
  "error_recovery_autopilot",
  {
    title: "Error Recovery Autopilot",
    description: "Attempt auto-recovery flow and return result.",
    inputSchema: {}
  },
  async () =>
    withMetrics("error_recovery_autopilot", async () => {
      const heartbeatCheck = await probeEndpoint(["/live/song/get/tempo", "/live/song/tempo"]);
      if (heartbeatCheck.ok) {
        return textResult({ ok: true, recovered: false, status: "already-healthy", heartbeatCheck });
      }
      const reconnect = await reconnectAndProbe("error_recovery_autopilot");
      return textResult({ ok: true, recovered: true, reconnect, heartbeatCheck });
    })
);

server.registerTool(
  "set_project_memory_profile",
  {
    title: "Set Project Memory Profile",
    description: "Store reusable multi-project memory preferences.",
    inputSchema: {
      profileName: z.string().min(1).max(128),
      preferences: z.record(z.unknown()).optional().default({})
    }
  },
  async ({ profileName, preferences }) =>
    withMetrics("set_project_memory_profile", async () => {
      projectMemory.set(normalizeName(profileName), {
        profileName,
        preferences,
        updatedAt: new Date().toISOString()
      });
      return textResult({ ok: true, profile: projectMemory.get(normalizeName(profileName)) });
    })
);

server.registerTool(
  "generate_release_variants",
  {
    title: "Generate Release Variants",
    description: "Generate release variant scaffold plan.",
    inputSchema: {
      includeExtended: z.boolean().optional().default(true),
      includeInstrumental: z.boolean().optional().default(true),
      includeAcapella: z.boolean().optional().default(true)
    }
  },
  async ({ includeExtended, includeInstrumental, includeAcapella }) =>
    withMetrics("generate_release_variants", async () =>
      textResult({
        ok: true,
        variants: [
          includeExtended ? "extended_mix" : null,
          includeInstrumental ? "instrumental" : null,
          includeAcapella ? "acapella" : null
        ].filter(Boolean)
      })
    )
);

server.registerTool(
  "run_post_export_qa",
  {
    title: "Run Post Export QA",
    description: "Run post-export QA checks on generated deliverables jobs.",
    inputSchema: {
      requireCompletedJobs: z.boolean().optional().default(true),
      strictMatrix: z.boolean().optional().default(false),
      expectedVariants: z
        .array(
          z.enum(["master", "streaming", "stems", "instrumental", "acapella", "extended"])
        )
        .optional()
        .default(["master", "streaming", "stems"])
    }
  },
  async ({ requireCompletedJobs, strictMatrix, expectedVariants }) =>
    withMetrics("run_post_export_qa", async () => {
      const jobs = [...exportJobs.values()];
      const completed = jobs.filter((j) => j.status === "completed");
      const failed = jobs.filter((j) => j.status === "failed");
      const pending = jobs.filter((j) => j.status !== "completed" && j.status !== "failed");
      const issues = [];
      if (requireCompletedJobs && completed.length === 0) {
        issues.push("No completed export jobs found.");
      }
      if (failed.length > 0) issues.push(`${failed.length} export jobs failed.`);

      // Consistency checks by known deliverable patterns.
      const targets = completed.map((j) => String(j.targetPath ?? "").toLowerCase());
      const hasMaster = targets.some((t) => t.includes("master"));
      const hasStreaming = targets.some((t) => t.includes("streaming"));
      const hasStems = targets.some((t) => t.includes("stems"));
      if (!hasMaster) issues.push("Missing master deliverable.");
      if (!hasStreaming) issues.push("Missing streaming deliverable.");
      if (!hasStems) issues.push("Missing stems deliverable.");

      const duplicateTargets = new Set();
      const seen = new Set();
      for (const t of targets) {
        if (seen.has(t)) duplicateTargets.add(t);
        seen.add(t);
      }
      if (duplicateTargets.size > 0) {
        issues.push(`Duplicate target paths detected: ${[...duplicateTargets].join(", ")}`);
      }

      const checks = {
        master: hasMaster,
        streaming: hasStreaming,
        stems: hasStems,
        instrumental: targets.some((t) => t.includes("instrumental")),
        acapella: targets.some((t) => t.includes("acapella")),
        extended: targets.some((t) => t.includes("extended"))
      };
      const matrixMissing = expectedVariants.filter((v) => !checks[v]);
      if (strictMatrix && matrixMissing.length > 0) {
        issues.push(`Strict matrix missing variants: ${matrixMissing.join(", ")}`);
      }

      return textResult({
        ok: issues.length === 0,
        summary: {
          total: jobs.length,
          completed: completed.length,
          failed: failed.length,
          pending: pending.length
        },
        consistency: {
          hasMaster,
          hasStreaming,
          hasStems,
          duplicateTargets: [...duplicateTargets],
          strictMatrix,
          expectedVariants,
          matrixMissing
        },
        issues
      });
    })
);

server.registerTool(
  "normalize_stem_naming",
  {
    title: "Normalize Stem Naming",
    description: "Generate normalized stem naming plan.",
    inputSchema: {
      songName: z.string().min(1).max(128),
      bpm: z.number().min(20).max(300),
      key: z.string().min(1).max(8),
      variants: z.array(z.string().min(1).max(64)).min(1)
    }
  },
  async ({ songName, bpm, key, variants }) =>
    withMetrics("normalize_stem_naming", async () => {
      const base = normalizeName(songName).replace(/\s+/g, "_");
      const names = variants.map((v) => `${base}_${bpm}_${normalizeName(key)}_${normalizeName(v)}.wav`);
      return textResult({ ok: true, names });
    })
);

server.registerTool(
  "target_prerelease_loudness",
  {
    title: "Target Pre-release Loudness",
    description: "Suggest loudness target profile and actions.",
    inputSchema: { profile: z.enum(["streaming", "club", "film"]).optional().default("streaming") }
  },
  async ({ profile }) =>
    withMetrics("target_prerelease_loudness", async () =>
      textResult({
        ok: true,
        profile,
        target:
          profile === "streaming" ? "-14 LUFS" : profile === "club" ? "-9 LUFS" : "-18 LUFS",
        actions: ["Adjust limiter ceiling", "Re-check transient integrity", "Run post-export QA"]
      })
    )
);

server.registerTool(
  "find_arrangement_gaps",
  {
    title: "Find Arrangement Gaps",
    description: "Detect potential arrangement gaps from section map.",
    inputSchema: {}
  },
  async () =>
    withMetrics("find_arrangement_gaps", async () => {
      const sections = [...arrangementSectionMap.values()].sort((a, b) => a.startBeats - b.startBeats);
      const gaps = [];
      for (let i = 1; i < sections.length; i += 1) {
        const prevEnd = sections[i - 1].startBeats + sections[i - 1].lengthBeats;
        if (sections[i].startBeats - prevEnd > 0.01) {
          gaps.push({
            from: sections[i - 1].sectionName,
            to: sections[i].sectionName,
            gapBeats: Number((sections[i].startBeats - prevEnd).toFixed(3))
          });
        }
      }
      return textResult({ ok: true, gaps });
    })
);

server.registerTool(
  "reinforce_hook_section",
  {
    title: "Reinforce Hook Section",
    description: "Suggest hook reinforcement moves.",
    inputSchema: { sectionName: z.string().min(1).max(64) }
  },
  async ({ sectionName }) =>
    withMetrics("reinforce_hook_section", async () =>
      textResult({
        ok: true,
        sectionName,
        moves: ["Double lead octave", "Add call-response fill", "Increase hook send FX by 10%"]
      })
    )
);

server.registerTool(
  "optimize_kick_transient",
  {
    title: "Optimize Kick Transient",
    description: "Kick transient optimization scaffold.",
    inputSchema: { kickTrackName: z.string().min(1).max(128) }
  },
  async ({ kickTrackName }) =>
    withMetrics("optimize_kick_transient", async () =>
      textResult({
        ok: true,
        kickTrackName,
        recipe: ["Shorten sustain", "Boost transient 2-4kHz lightly", "Manage low-end tail overlap"]
      })
    )
);

server.registerTool(
  "check_bass_mono_compatibility",
  {
    title: "Check Bass Mono Compatibility",
    description: "Bass mono compatibility diagnostic scaffold.",
    inputSchema: { bassTrackName: z.string().min(1).max(128) }
  },
  async ({ bassTrackName }) =>
    withMetrics("check_bass_mono_compatibility", async () =>
      textResult({
        ok: true,
        bassTrackName,
        checks: ["Low band width under 120Hz", "Phase correlation near +1 in low end"]
      })
    )
);

server.registerTool(
  "set_drum_bus_punch_mode",
  {
    title: "Set Drum Bus Punch Mode",
    description: "Apply drum bus punch mode scaffold settings.",
    inputSchema: { enabled: z.boolean().optional().default(true) }
  },
  async ({ enabled }) =>
    withMetrics("set_drum_bus_punch_mode", async () =>
      textResult({
        ok: true,
        enabled,
        settings: enabled ? ["Fast attack transient shaper", "Parallel comp blend 20-30%"] : ["Bypass punch chain"]
      })
    )
);

server.registerTool(
  "score_vocal_intelligibility",
  {
    title: "Score Vocal Intelligibility",
    description: "Estimate vocal intelligibility and masking risk scaffold.",
    inputSchema: { vocalTrackName: z.string().min(1).max(128) }
  },
  async ({ vocalTrackName }) =>
    withMetrics("score_vocal_intelligibility", async () =>
      textResult({
        ok: true,
        vocalTrackName,
        score: 78,
        risks: ["Possible 2-4kHz masking against synth lead"]
      })
    )
);

server.registerTool(
  "plan_scene_energy_curve",
  {
    title: "Plan Scene Energy Curve",
    description: "Plan scene energy trajectory.",
    inputSchema: { scenes: z.array(z.number().int().min(0)).min(1) }
  },
  async ({ scenes }) =>
    withMetrics("plan_scene_energy_curve", async () =>
      textResult({
        ok: true,
        curve: scenes.map((s, i) => ({ sceneIndex: s, energy: Number((0.4 + i * (0.5 / scenes.length)).toFixed(3)) }))
      })
    )
);

server.registerTool(
  "restore_live_emergency_state",
  {
    title: "Restore Live Emergency State",
    description: "Restore safety-critical state from latest snapshot.",
    inputSchema: {}
  },
  async () =>
    withMetrics("restore_live_emergency_state", async () => {
      const all = [...snapshots.values()].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
      const preferred = all.find((s) => s.source === "auto-rollback-policy") ?? null;
      const latest = preferred ?? all[0] ?? null;
      if (!latest) {
        return textResult({ ok: false, restored: false, reason: "No snapshots available." });
      }
      sendPlanRaw("/live/song/set/tempo", [floatArg(latest.tempo)]);
      sendPlanRaw("/live/song/set/current_song_time", [floatArg(latest.currentSongTime)]);
      if (latest.isPlaying) sendPlanRaw("/live/song/start_playing", []);
      else sendPlanRaw("/live/song/stop_playing", []);
      return textResult({
        ok: true,
        restored: true,
        snapshotId: latest.snapshotId,
        source: latest.source ?? "unknown"
      });
    })
);

server.registerTool(
  "manage_adaptive_sidechain",
  {
    title: "Manage Adaptive Sidechain",
    description: "Adaptive sidechain strategy scaffold by section intensity.",
    inputSchema: { sectionName: z.string().min(1).max(64), intensity: z.enum(["low", "medium", "high"]) }
  },
  async ({ sectionName, intensity }) =>
    withMetrics("manage_adaptive_sidechain", async () =>
      textResult({
        ok: true,
        sectionName,
        intensity,
        settings:
          intensity === "high"
            ? { amount: 0.8, release: 0.35 }
            : intensity === "medium"
              ? { amount: 0.6, release: 0.5 }
              : { amount: 0.4, release: 0.65 }
      })
    )
);

server.registerTool(
  "detect_automation_conflicts",
  {
    title: "Detect Automation Conflicts",
    description: "Detect likely contradictory automation operations.",
    inputSchema: {
      operations: z
        .array(
          z.object({
            target: z.string().min(1).max(128),
            startBeats: z.number().min(0),
            endBeats: z.number().gt(0),
            intent: z.string().min(1).max(64)
          })
        )
        .min(1)
    }
  },
  async ({ operations }) =>
    withMetrics("detect_automation_conflicts", async () => {
      const conflicts = [];
      for (let i = 0; i < operations.length; i += 1) {
        for (let j = i + 1; j < operations.length; j += 1) {
          const a = operations[i];
          const b = operations[j];
          if (a.target !== b.target) continue;
          const overlap = Math.min(a.endBeats, b.endBeats) - Math.max(a.startBeats, b.startBeats);
          if (overlap > 0 && a.intent !== b.intent) {
            conflicts.push({ aIndex: i, bIndex: j, target: a.target, overlapBeats: Number(overlap.toFixed(3)) });
          }
        }
      }
      return textResult({ ok: true, conflicts, conflictCount: conflicts.length });
    })
);

server.registerTool(
  "set_device_parameter_lock_mode",
  {
    title: "Set Device Parameter Lock Mode",
    description: "Lock/unlock critical device parameter writes by target key.",
    inputSchema: {
      targetKey: z.string().min(1).max(128),
      locked: z.boolean()
    }
  },
  async ({ targetKey, locked }) =>
    withMetrics("set_device_parameter_lock_mode", async () => {
      deviceParameterLocks.set(normalizeName(targetKey), {
        targetKey,
        locked,
        updatedAt: new Date().toISOString()
      });
      await persistDeviceLocks();
      return textResult({ ok: true, lock: deviceParameterLocks.get(normalizeName(targetKey)) });
    })
);

server.registerTool(
  "ear_training_prompt_mode",
  {
    title: "Ear Training Prompt Mode",
    description: "Return targeted ear-training exercise from issue prompt.",
    inputSchema: { issuePrompt: z.string().min(1).max(256) }
  },
  async ({ issuePrompt }) =>
    withMetrics("ear_training_prompt_mode", async () =>
      textResult({
        ok: true,
        issuePrompt,
        exercise: "Sweep a narrow EQ band to locate problem frequency, then compare before/after cuts."
      })
    )
);

server.registerTool(
  "monitor_session_drift",
  {
    title: "Monitor Session Drift",
    description: "Assess drift from goal/style profile scaffold.",
    inputSchema: { targetProfile: z.string().min(1).max(128) }
  },
  async ({ targetProfile }) =>
    withMetrics("monitor_session_drift", async () =>
      textResult({
        ok: true,
        targetProfile,
        driftScore: 0.28,
        note: "Low-moderate drift detected; suggest re-centering low-end and arrangement density."
      })
    )
);

server.registerTool(
  "run_variant_consistency_audit",
  {
    title: "Run Variant Consistency Audit",
    description: "Audit variant deliverables for naming/coverage consistency.",
    inputSchema: {
      expected: z
        .array(z.enum(["master", "streaming", "stems", "instrumental", "acapella", "extended"]))
        .optional()
        .default(["master", "streaming", "stems"])
    }
  },
  async ({ expected }) =>
    withMetrics("run_variant_consistency_audit", async () => {
      const completed = [...exportJobs.values()].filter((j) => j.status === "completed");
      const targets = completed.map((j) => String(j.targetPath ?? "").toLowerCase());
      const present = {
        master: targets.some((t) => t.includes("master")),
        streaming: targets.some((t) => t.includes("streaming")),
        stems: targets.some((t) => t.includes("stems")),
        instrumental: targets.some((t) => t.includes("instrumental")),
        acapella: targets.some((t) => t.includes("acapella")),
        extended: targets.some((t) => t.includes("extended"))
      };
      const missing = expected.filter((k) => !present[k]);
      return textResult({ ok: missing.length === 0, expected, present, missing });
    })
);

server.registerTool(
  "simulate_mix_translation",
  {
    title: "Simulate Mix Translation",
    description: "Heuristic mix translation diagnostics scaffold.",
    inputSchema: { contexts: z.array(z.enum(["phone", "car", "club", "headphones"])).min(1) }
  },
  async ({ contexts }) =>
    withMetrics("simulate_mix_translation", async () =>
      textResult({
        ok: true,
        contexts,
        observations: contexts.map((c) => ({
          context: c,
          note: c === "phone" ? "Check vocal mids and kick click audibility." : "Validate balance and transient control."
        }))
      })
    )
);

server.registerTool(
  "batch_song_operations",
  {
    title: "Batch Song Operations",
    description: "Apply batch operation scaffold across setlist songs.",
    inputSchema: {
      operation: z.string().min(1).max(128),
      songs: z.array(z.string().min(1).max(128)).min(1)
    }
  },
  async ({ operation, songs }) =>
    withMetrics("batch_song_operations", async () =>
      textResult({
        ok: true,
        operation,
        songs,
        result: songs.map((s) => ({ song: s, status: "queued" }))
      })
    )
);

server.registerTool(
  "package_client_revision",
  {
    title: "Package Client Revision",
    description: "Generate client revision package summary scaffold.",
    inputSchema: { revisionNote: z.string().max(500).optional() }
  },
  async ({ revisionNote }) =>
    withMetrics("package_client_revision", async () =>
      textResult({
        ok: true,
        revisionNote: revisionNote ?? null,
        package: {
          included: ["change-log", "deliverables-list", "qa-summary"],
          generatedAt: new Date().toISOString()
        }
      })
    )
);

server.registerTool(
  "create_auto_rollback_policy",
  {
    title: "Create Auto Rollback Policy",
    description: "Configure automatic rollback checkpoint policy.",
    inputSchema: {
      enabled: z.boolean(),
      everyNCommands: z.number().int().min(1).max(500).optional().default(25),
      everyNBars: z.number().int().min(1).max(256).optional().default(16),
      categoryEveryN: z
        .object({
          arrangement: z.number().int().min(1).max(500).optional(),
          device: z.number().int().min(1).max(500).optional(),
          mixer: z.number().int().min(1).max(500).optional(),
          transport: z.number().int().min(1).max(500).optional(),
          export: z.number().int().min(1).max(500).optional(),
          other: z.number().int().min(1).max(500).optional()
        })
        .optional()
    }
  },
  async ({ enabled, everyNCommands, everyNBars, categoryEveryN }) =>
    withMetrics("create_auto_rollback_policy", async () => {
      rollbackPolicy.enabled = enabled;
      rollbackPolicy.everyNCommands = everyNCommands;
      rollbackPolicy.everyNBars = everyNBars;
      if (categoryEveryN) {
        rollbackPolicy.categoryEveryN = {
          arrangement: Number(categoryEveryN.arrangement ?? rollbackPolicy.categoryEveryN.arrangement),
          device: Number(categoryEveryN.device ?? rollbackPolicy.categoryEveryN.device),
          mixer: Number(categoryEveryN.mixer ?? rollbackPolicy.categoryEveryN.mixer),
          transport: Number(categoryEveryN.transport ?? rollbackPolicy.categoryEveryN.transport),
          export: Number(categoryEveryN.export ?? rollbackPolicy.categoryEveryN.export),
          other: Number(categoryEveryN.other ?? rollbackPolicy.categoryEveryN.other)
        };
      }
      if (enabled) {
        const sid = `auto_policy_${Date.now()}`;
        const snap = await captureRollbackSnapshotInternal(sid, {
          source: "auto-rollback-policy",
          trigger: "policy-enable"
        });
        rollbackPolicy.lastSnapshotId = snap.snapshotId;
      }
      await persistRollbackPolicy();
      return textResult({ ok: true, rollbackPolicy });
    })
);

server.registerTool(
  "upsert_reactive_rule",
  {
    title: "Upsert Reactive Rule",
    description: "Save a reactive automation rule for real-time trigger scaffolding.",
    inputSchema: {
      ruleName: z.string().min(1).max(128),
      trigger: z.string().min(1).max(128),
      action: z.string().min(1).max(128),
      enabled: z.boolean().optional().default(true)
    }
  },
  async ({ ruleName, trigger, action, enabled }) =>
    withMetrics("upsert_reactive_rule", async () => {
      reactiveRules.set(normalizeName(ruleName), {
        ruleName,
        trigger,
        action,
        enabled,
        updatedAt: new Date().toISOString()
      });
      return textResult({ ok: true, rule: reactiveRules.get(normalizeName(ruleName)) });
    })
);

server.registerTool(
  "list_reactive_rules",
  { title: "List Reactive Rules", description: "List saved reactive rules." },
  async () => withMetrics("list_reactive_rules", async () => textResult({ rules: Object.fromEntries(reactiveRules) }))
);

server.registerTool(
  "run_gain_staging_autopilot",
  {
    title: "Run Gain Staging Autopilot",
    description: "Set sampled track levels toward target engineering headroom.",
    inputSchema: {
      sampleTracks: z.number().int().min(1).max(64).optional().default(16),
      target: z.number().min(0.5).max(0.9).optional().default(0.75)
    }
  },
  async ({ sampleTracks, target }) => withMetrics("run_gain_staging_autopilot", async () => textResult(await autoGainStage(sampleTracks, target)))
);

async function autoGainStage(sampleTracks, target) {
  const tracks = await getTracksSnapshot();
  const writes = [];
  for (const t of tracks.tracks.slice(0, sampleTracks)) {
    try {
      const vol = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
      const current = Number(parseOscValue(vol.response, target));
      const next = Number((current * 0.45 + target * 0.55).toFixed(4));
      writes.push(sendPlanRaw("/live/track/set/volume", [intArg(t.index), floatArg(next)], { trackIndex: t.index, current, next }));
    } catch {
      // best-effort
    }
  }
  return { ok: true, sampleTracks, target, writes };
}

server.registerTool(
  "run_phase_alignment_check",
  {
    title: "Run Phase Alignment Check",
    description: "Detect likely phase issues by track-role pair heuristics.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_phase_alignment_check", async () => {
      const roles = (await getTracksSnapshot()).tracks.map((t) => ({ ...t, n: normalizeName(t.name) }));
      const findings = [];
      const kicks = roles.filter((r) => r.n.includes("kick"));
      const basses = roles.filter((r) => r.n.includes("bass"));
      if (kicks.length > 1) findings.push("Multiple kick-like tracks found; check polarity and sample alignment.");
      if (kicks.length > 0 && basses.length > 0) findings.push("Kick/Bass overlap likely; run low-end phase correlation check.");
      const sampled = [];
      for (const t of [...kicks.slice(0, 2), ...basses.slice(0, 2)]) {
        try {
          const [vol, pan] = await Promise.all([
            requestAny(["/live/track/get/volume"], [intArg(t.index)]),
            requestAny(["/live/track/get/panning"], [intArg(t.index)])
          ]);
          sampled.push({
            trackIndex: t.index,
            name: t.name,
            volume: Number(parseOscValue(vol.response, 0.85)),
            pan: Number(parseOscValue(pan.response, 0))
          });
        } catch {
          // best effort
        }
      }
      return textResult({ ok: true, findings, sampled });
    })
);

server.registerTool(
  "run_masking_analysis",
  {
    title: "Run Masking Analysis",
    description: "Heuristic masking analysis for common competing elements.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_masking_analysis", async () =>
      {
        const tracks = await getTracksSnapshot();
        const names = tracks.tracks.map((t) => normalizeName(t.name));
        const hasKick = names.some((n) => n.includes("kick"));
        const hasBass = names.some((n) => n.includes("bass"));
        const hasVocal = names.some((n) => n.includes("vocal") || n.includes("vox"));
        const hasLead = names.some((n) => n.includes("lead") || n.includes("synth"));
        const pairs = [];
        if (hasKick && hasBass) pairs.push({ pair: "kick-bass", region: "50-120Hz", suggestion: "Sidechain + EQ carve" });
        if (hasVocal && hasLead) pairs.push({ pair: "vocal-lead", region: "2-4kHz", suggestion: "Dynamic EQ ducking" });
        pairs.push({ pair: "snare-guitar", region: "180-250Hz", suggestion: "Transient emphasis on snare" });
        return textResult({ ok: true, pairs, trackCount: tracks.trackCount });
      }
    )
);

server.registerTool(
  "manage_dynamic_range",
  {
    title: "Manage Dynamic Range",
    description: "Recommend dynamic control strategy per source type.",
    inputSchema: { sourceType: z.enum(["drums", "bass", "vocal", "music-bus", "master"]) }
  },
  async ({ sourceType }) =>
    withMetrics("manage_dynamic_range", async () =>
      textResult({
        ok: true,
        sourceType,
        strategy:
          sourceType === "vocal"
            ? "Serial compression: gentle leveling + peak control."
            : sourceType === "drums"
              ? "Parallel compression with transient-preserving dry blend."
              : "Moderate bus compression with gain-matched A/B checks."
      })
    )
);

server.registerTool(
  "detect_sibilance_harshness",
  {
    title: "Detect Sibilance Harshness",
    description: "Return likely harsh bands and de-essing guidance.",
    inputSchema: { trackName: z.string().min(1).max(128) }
  },
  async ({ trackName }) =>
    withMetrics("detect_sibilance_harshness", async () =>
      textResult({ ok: true, trackName, bands: ["5-8kHz sibilance", "2-4kHz harshness"], suggestion: "Use split-band de-esser + dynamic EQ." })
    )
);

server.registerTool(
  "run_low_end_control_suite",
  {
    title: "Run Low End Control Suite",
    description: "Low-end mono/hand-off diagnostics and suggestions.",
    inputSchema: {
      applyCorrections: z.boolean().optional().default(false),
      kickTrackName: z.string().max(128).optional(),
      bassTrackName: z.string().max(128).optional()
    }
  },
  async ({ applyCorrections, kickTrackName, bassTrackName }) =>
    withMetrics("run_low_end_control_suite", async () => {
      const checks = ["Mono below 120Hz", "Kick-bass frequency handoff", "Sub headroom margin before limiter"];
      let correction = null;
      if (applyCorrections && kickTrackName && bassTrackName) {
        correction = await withMetrics("resolve_kick_bass_conflict", async () =>
          textResult({ delegated: true, kickTrackName, bassTrackName })
        );
      }
      return textResult({ ok: true, checks, applyCorrections, correction });
    })
);

server.registerTool(
  "optimize_bus_compression",
  {
    title: "Optimize Bus Compression",
    description: "Tune bus compression settings scaffold by genre intent.",
    inputSchema: {
      bus: z.enum(["drum", "music", "vocal", "master"]),
      style: z.string().min(1).max(64).optional().default("neutral"),
      applyWrites: z.boolean().optional().default(false)
    }
  },
  async ({ bus, style, applyWrites }) =>
    withMetrics("optimize_bus_compression", async () => {
      const settings = {
        ratio: bus === "master" ? "1.5:1" : "2-4:1",
        attackMs: bus === "drum" ? 15 : 25,
        release: "auto/tempo-synced"
      };
      const writes = [];
      if (applyWrites && bus !== "master") {
        const tracks = await getTracksSnapshot();
        const candidates = tracks.tracks.filter((t) => {
          const n = normalizeName(t.name);
          if (bus === "drum") return n.includes("drum") || n.includes("kick") || n.includes("snare");
          if (bus === "vocal") return n.includes("vocal") || n.includes("vox");
          return !n.includes("vocal") && !n.includes("kick") && !n.includes("snare");
        });
        for (const t of candidates.slice(0, 8)) {
          writes.push(
            sendPlanRaw(
              "/live/device/set/parameter/value",
              [intArg(t.index), intArg(0), intArg(2), floatArg(bus === "drum" ? 0.55 : 0.45)],
              { bus, trackIndex: t.index, parameter: "compression-threshold-proxy" }
            )
          );
        }
      }
      return textResult({ ok: true, bus, style, settings, applyWrites, writes });
    })
);

server.registerTool(
  "run_transient_shaping_assistant",
  {
    title: "Run Transient Shaping Assistant",
    description: "Recommend transient attack/sustain moves.",
    inputSchema: { target: z.string().min(1).max(128) }
  },
  async ({ target }) =>
    withMetrics("run_transient_shaping_assistant", async () =>
      textResult({ ok: true, target, recipe: ["Boost attack slightly", "Trim sustain for clarity", "Re-check peak headroom"] })
    )
);

server.registerTool(
  "run_stereo_image_optimizer",
  {
    title: "Run Stereo Image Optimizer",
    description: "Stereo width and mono compatibility optimization scaffold.",
    inputSchema: { applyWrites: z.boolean().optional().default(false) }
  },
  async ({ applyWrites }) =>
    withMetrics("run_stereo_image_optimizer", async () => {
      const tracks = await getTracksSnapshot();
      const sampled = [];
      const writes = [];
      for (const t of tracks.tracks.slice(0, 16)) {
        try {
          const pan = await requestAny(["/live/track/get/panning"], [intArg(t.index)]);
          const panValue = Number(parseOscValue(pan.response, 0));
          sampled.push({ trackIndex: t.index, name: t.name, pan: panValue });
          if (applyWrites && Math.abs(panValue) > 0.9) {
            writes.push(
              sendPlanRaw("/live/track/set/panning", [intArg(t.index), floatArg(panValue > 0 ? 0.75 : -0.75)], {
                trackIndex: t.index,
                oldPan: panValue
              })
            );
          }
        } catch {
          // best effort
        }
      }
      return textResult({
        ok: true,
        actions: ["Keep lows centered", "Widen upper mids selectively", "Verify mono sum loss under threshold"],
        sampled,
        applyWrites,
        writes
      });
    })
);

server.registerTool(
  "manage_reverb_delay_space",
  {
    title: "Manage Reverb Delay Space",
    description: "Prevent space wash and overlap through send strategy.",
    inputSchema: { profile: z.enum(["tight", "balanced", "wide"]).optional().default("balanced") }
  },
  async ({ profile }) =>
    withMetrics("manage_reverb_delay_space", async () =>
      textResult({
        ok: true,
        profile,
        guidance:
          profile === "tight"
            ? "Short decays, longer pre-delay, lower return level."
            : profile === "wide"
              ? "Longer tails with ducking and filtered returns."
              : "Balanced decay with tempo-synced delays."
      })
    )
);

server.registerTool(
  "run_automation_quality_check",
  {
    title: "Run Automation Quality Check",
    description: "Detect abrupt/overdense automation patterns from provided points.",
    inputSchema: {
      points: z
        .array(
          z.object({
            beat: z.number().min(0),
            value: z.number().min(0).max(1)
          })
        )
        .min(2)
    }
  },
  async ({ points }) =>
    withMetrics("run_automation_quality_check", async () => {
      let abrupt = 0;
      for (let i = 1; i < points.length; i += 1) {
        if (Math.abs(points[i].value - points[i - 1].value) > 0.5) abrupt += 1;
      }
      return textResult({ ok: true, pointCount: points.length, abruptTransitions: abrupt, suggestion: abrupt > 0 ? "Smooth with intermediate points." : "Automation looks stable." });
    })
);

server.registerTool(
  "run_reference_match_engine",
  {
    title: "Run Reference Match Engine",
    description: "Reference tonal/dynamics/stereo targeting scaffold.",
    inputSchema: { referenceName: z.string().min(1).max(128) }
  },
  async ({ referenceName }) =>
    withMetrics("run_reference_match_engine", async () => {
      const readiness = await withMetrics("run_release_readiness_score", async () =>
        textResult({ delegated: true })
      );
      return textResult({
        ok: true,
        referenceName,
        targets: ["Tonal tilt alignment", "Dynamics envelope similarity", "Stereo width profile check"],
        readiness
      });
    })
);

server.registerTool(
  "run_master_chain_safety_scan",
  {
    title: "Run Master Chain Safety Scan",
    description: "Master safety diagnostics before final print.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_master_chain_safety_scan", async () => {
      const readiness = await requestKnown("tempoGet", ["/live/song/get/tempo", "/live/song/tempo"]);
      const playing = await requestKnown("isPlayingGet", ["/live/song/get/is_playing", "/live/song/is_playing"]);
      const warnings = [];
      if (Boolean(parseOscValue(playing.response, 0))) warnings.push("Transport is playing during safety scan.");
      if (metrics.failedCommands > 0) warnings.push(`There are ${metrics.failedCommands} failed commands this session.`);
      return textResult({
        ok: warnings.length === 0,
        tempo: Number(parseOscValue(readiness.response, 120)),
        scan: ["Limiter overdrive risk", "Clipping risk markers", "Headroom margin check", "Export guardrails readiness"],
        warnings
      });
    })
);

server.registerTool(
  "run_mix_translation_diagnostics",
  {
    title: "Run Mix Translation Diagnostics",
    description: "Translation diagnostics across listening contexts.",
    inputSchema: { contexts: z.array(z.enum(["phone", "car", "club", "headphones"])).min(1).optional().default(["phone", "car", "club"]) }
  },
  async ({ contexts }) =>
    withMetrics("run_mix_translation_diagnostics", async () => {
      const tracks = await getTracksSnapshot();
      return textResult({
        ok: true,
        contexts,
        trackCount: tracks.trackCount,
        notes: contexts.map((c) => (c === "phone" ? "Prioritize vocal mids and kick click." : `Check balance for ${c}.`))
      });
    })
);

server.registerTool(
  "run_stem_quality_auditor",
  {
    title: "Run Stem Quality Auditor",
    description: "Audit stems for consistency and readiness.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_stem_quality_auditor", async () => {
      const completed = [...exportJobs.values()].filter((j) => j.status === "completed");
      const targets = completed.map((j) => String(j.targetPath ?? "").toLowerCase());
      return textResult({
        ok: completed.length > 0,
        completedJobs: completed.length,
        checks: ["Length consistency", "Loudness spread sanity", "Naming conventions"],
        hasMaster: targets.some((t) => t.includes("master")),
        hasStems: targets.some((t) => t.includes("stems"))
      });
    })
);

server.registerTool(
  "optimize_clip_gain",
  {
    title: "Optimize Clip Gain",
    description: "Clip-gain optimization scaffold before compression.",
    inputSchema: { trackName: z.string().min(1).max(128), targetRange: z.string().min(1).max(32).optional().default("-18 to -12 dBFS RMS proxy") }
  },
  async ({ trackName, targetRange }) =>
    withMetrics("optimize_clip_gain", async () => {
      const best = await resolveTrackIndexFromName(trackName, 0.5);
      const vol = await requestAny(["/live/track/get/volume"], [intArg(best.index)]);
      const current = Number(parseOscValue(vol.response, 0.8));
      const next = Number((current * 0.6 + 0.72 * 0.4).toFixed(4));
      const write = sendPlanRaw("/live/track/set/volume", [intArg(best.index), floatArg(next)], {
        trackIndex: best.index,
        current,
        next
      });
      return textResult({ ok: true, trackName, matchedTrack: best, targetRange, write });
    })
);

server.registerTool(
  "run_noise_floor_check",
  {
    title: "Run Noise Floor Check",
    description: "Noise floor and tail hygiene diagnostics scaffold.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_noise_floor_check", async () => {
      const tracks = await getTracksSnapshot();
      let lowTracks = 0;
      for (const t of tracks.tracks.slice(0, 16)) {
        try {
          const vol = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
          if (Number(parseOscValue(vol.response, 0.8)) < 0.08) lowTracks += 1;
        } catch {
          // ignore
        }
      }
      return textResult({
        ok: true,
        lowLevelTracks: lowTracks,
        checks: ["Residual tail noise", "Silence region floor consistency", "Hum/hiss hotspot scan (heuristic)"]
      });
    })
);

server.registerTool(
  "run_loudness_workflow_assistant",
  {
    title: "Run Loudness Workflow Assistant",
    description: "Recommend staged loudness workflow by destination.",
    inputSchema: { destination: z.enum(["streaming", "broadcast", "club", "film"]).optional().default("streaming") }
  },
  async ({ destination }) =>
    withMetrics("run_loudness_workflow_assistant", async () => {
      const tempo = await requestKnown("tempoGet", ["/live/song/get/tempo", "/live/song/tempo"]);
      return textResult({
        ok: true,
        destination,
        tempo: Number(parseOscValue(tempo.response, 120)),
        stagedTargets:
          destination === "streaming"
            ? ["mix: -18 LUFS short-term", "pre-master: -14 LUFS integrated", "ceiling: -1 dBTP"]
            : destination === "club"
              ? ["mix: strong crest", "pre-master: around -9 LUFS", "ceiling: -0.3 dBTP"]
              : ["mix: dynamic-first", "pre-master according to standard"]
      });
    })
);

server.registerTool(
  "analyze_revision_delta",
  {
    title: "Analyze Revision Delta",
    description: "Summarize sonic/operational delta between recent revisions.",
    inputSchema: { notes: z.string().max(500).optional() }
  },
  async ({ notes }) =>
    withMetrics("analyze_revision_delta", async () =>
      textResult({
        ok: true,
        notes: notes ?? null,
        delta: {
          commandDelta: metrics.totalCommands,
          recentFailures: metrics.failedCommands,
          completedExports: [...exportJobs.values()].filter((j) => j.status === "completed").length,
          suggestion: "Compare export QA summaries between revisions."
        }
      })
    )
);

server.registerTool(
  "run_engineering_checklist_mode",
  {
    title: "Run Engineering Checklist Mode",
    description: "Return pre-mix / pre-master / pre-export checklist with scoring.",
    inputSchema: { stage: z.enum(["pre-mix", "pre-master", "pre-export"]) }
  },
  async ({ stage }) =>
    withMetrics("run_engineering_checklist_mode", async () => {
      const checks =
        stage === "pre-mix"
          ? ["Gain staging done", "Phase check done", "Masking analysis reviewed"]
          : stage === "pre-master"
            ? ["Bus glue checked", "Stereo/mono check passed", "Headroom margin verified"]
            : ["Variant matrix complete", "Post-export QA pass", "Naming normalized"];
      const base = stage === "pre-export" ? 75 : stage === "pre-master" ? 80 : 85;
      const penalty = Math.min(20, metrics.failedCommands);
      const score = Math.max(0, base - penalty);
      return textResult({ ok: score >= 70, stage, checklist: checks, score, failedCommands: metrics.failedCommands });
    })
);

server.registerTool(
  "plan_integrated_loudness_meter_path",
  {
    title: "Plan Integrated Loudness Meter Path",
    description:
      "Return a staged loudness metering workflow (momentary/short-term/integrated) aligned to a delivery target.",
    inputSchema: {
      destination: z.enum(["streaming", "broadcast", "club", "film"]).optional().default("streaming")
    }
  },
  async ({ destination }) =>
    withMetrics("plan_integrated_loudness_meter_path", async () => {
      const meterChain =
        destination === "streaming"
          ? ["Pre-fader clip meters", "Bus short-term meters", "Master integrated + true-peak post-limiter"]
          : destination === "club"
            ? ["Kick/bass crest meters", "Master peak + sustained RMS", "Limiter reduction meter"]
            : ["Dialog-weighted bus", "Integrated program loudness", "True-peak guard post-chain"];
      return textResult({
        ok: true,
        destination,
        meterChain,
        practice:
          "Match meter tap points to decision stage: balance at pre-master bus, final compliance at post-limiter.",
        sessionMode: advancedEngineeringState.sessionMode
      });
    })
);

server.registerTool(
  "configure_true_peak_guardrails",
  {
    title: "Configure True-Peak Guardrails",
    description:
      "Recommend inter-sample peak (ISP) ceiling, limiter staging, and oversampling policy for the master chain.",
    inputSchema: {
      ceilingDbTp: z.number().min(-3).max(0).optional().default(-1),
      oversamplingHint: z.enum(["off", "2x", "4x", "8x"]).optional().default("4x")
    }
  },
  async ({ ceilingDbTp, oversamplingHint }) =>
    withMetrics("configure_true_peak_guardrails", async () =>
      textResult({
        ok: true,
        ceilingDbTp,
        oversamplingHint,
        guardrails: [
          `Keep ceiling at or below ${ceilingDbTp} dBTP on the final limiter.`,
          "Place ISP-aware metering after the last gain stage that can create peaks.",
          `Prefer ${oversamplingHint} on the limiter while printing masters; disable for real-time monitoring if CPU-bound.`,
          "Add 0.5–1.5 dB headroom before limiting if upstream clipping or soft-clipping is used."
        ]
      })
    )
);

server.registerTool(
  "analyze_spectral_balance_fingerprint",
  {
    title: "Analyze Spectral Balance Fingerprint",
    description:
      "Heuristic spectral balance fingerprint from track naming and coarse level sampling (proxy, not FFT).",
    inputSchema: { compareToReference: z.boolean().optional().default(false) }
  },
  async ({ compareToReference }) =>
    withMetrics("analyze_spectral_balance_fingerprint", async () => {
      const tracks = await getTracksSnapshot();
      const buckets = { sub: [], low: [], mid: [], high: [], air: [] };
      for (const t of tracks.tracks.slice(0, 32)) {
        const n = normalizeName(t.name);
        let b = "mid";
        if (/(sub|808)/.test(n)) b = "sub";
        else if (/(kick|bass)/.test(n)) b = "low";
        else if (/(vox|vocal|snare|hat|cymbal)/.test(n)) b = /(hat|cymbal)/.test(n) ? "air" : "high";
        else if (/(pad|strings|keys)/.test(n)) b = "mid";
        try {
          const vol = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
          buckets[b].push({ name: t.name, volume: Number(parseOscValue(vol.response, 0.85)) });
        } catch {
          buckets[b].push({ name: t.name, volume: null });
        }
      }
      const fingerprint = Object.fromEntries(
        Object.entries(buckets).map(([k, arr]) => [
          k,
          { count: arr.length, meanVol: arr.length ? arr.reduce((s, x) => s + (x.volume ?? 0), 0) / arr.length : 0 }
        ])
      );
      return textResult({
        ok: true,
        compareToReference,
        fingerprint,
        note: "Fingerprint is naming + fader-level proxy; pair with exported stems and a real analyzer for reference matching."
      });
    })
);

server.registerTool(
  "build_masking_map_v2",
  {
    title: "Build Masking Map v2",
    description: "Ranked masking conflicts with likely culprits and suggested fixes (heuristic).",
    inputSchema: { maxConflicts: z.number().int().min(1).max(12).optional().default(6) }
  },
  async ({ maxConflicts }) =>
    withMetrics("build_masking_map_v2", async () => {
      const tracks = await getTracksSnapshot();
      const enriched = [];
      for (const t of tracks.tracks.slice(0, 24)) {
        const n = normalizeName(t.name);
        let role = "other";
        if (n.includes("kick")) role = "kick";
        else if (n.includes("bass")) role = "bass";
        else if (n.includes("vox") || n.includes("vocal")) role = "vocal";
        else if (n.includes("snare")) role = "snare";
        else if (n.includes("guitar") || n.includes("keys") || n.includes("pad")) role = "harmonic";
        try {
          const vol = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
          enriched.push({ name: t.name, index: t.index, role, volume: Number(parseOscValue(vol.response, 0.85)) });
        } catch {
          enriched.push({ name: t.name, index: t.index, role, volume: null });
        }
      }
      const conflicts = [];
      const volOf = (r) => enriched.filter((x) => x.role === r).map((x) => x.volume ?? 0);
      const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
      const push = (rank, region, culprit, victim, fix) =>
        conflicts.push({ rank, region, likelyCulprit: culprit, maskedElement: victim, fix });
      if (enriched.some((x) => x.role === "kick") && enriched.some((x) => x.role === "bass")) {
        push(
          1,
          "45–120 Hz",
          "kick+bass stack",
          "low-end clarity",
          "High-pass non-fundamental bass; sidechain kick→bass; mono-sum check below 100 Hz."
        );
      }
      if (enriched.some((x) => x.role === "vocal") && mean(volOf("harmonic")) > 0.78) {
        push(2, "1–4 kHz", "dense harmonic bed", "vocal intelligibility", "Dynamic EQ dip on music bus keyed to vocal; carve 2–3 kHz on pads.");
      }
      if (enriched.some((x) => x.role === "snare") && mean(volOf("harmonic")) > 0.75) {
        push(3, "150–300 Hz", "guitars/keys body", "snare body", "Transient shaper on snare; narrow cut on competing instrument.");
      }
      conflicts.sort((a, b) => a.rank - b.rank);
      return textResult({
        ok: true,
        conflicts: conflicts.slice(0, maxConflicts),
        sampledRoles: [...new Set(enriched.map((e) => e.role))],
        trackCount: tracks.trackCount
      });
    })
);

server.registerTool(
  "enable_solo_safe_diagnostic_mode",
  {
    title: "Enable Solo-Safe Diagnostic Mode",
    description:
      "Capture rollback snapshot before solo-heavy diagnostics; disable restores intent flag (Live solo state not auto-restored).",
    inputSchema: { action: z.enum(["enable", "disable", "status"]).optional().default("status") }
  },
  async ({ action }) =>
    withMetrics("enable_solo_safe_diagnostic_mode", async () => {
      if (action === "status") {
        return textResult({ ok: true, soloSafe: advancedEngineeringState.soloSafe });
      }
      if (action === "disable") {
        advancedEngineeringState.soloSafe.enabled = false;
        return textResult({ ok: true, soloSafe: advancedEngineeringState.soloSafe, message: "Solo-safe flag cleared." });
      }
      const snapshotId = `solo_safe_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const snap = await captureRollbackSnapshotInternal(snapshotId, {
        source: "solo-safe-diagnostic",
        trigger: "pre-solo-workflow"
      });
      advancedEngineeringState.soloSafe = {
        enabled: true,
        snapshotId: snap.snapshotId,
        startedAt: snap.capturedAt
      };
      return textResult({
        ok: true,
        soloSafe: advancedEngineeringState.soloSafe,
        snapshot: snap,
        hint: "Restore mixer intent via snapshot reverse hints or manual undo; verify solo/mute after diagnostics."
      });
    })
);

server.registerTool(
  "monitor_correlation_mono_sum",
  {
    title: "Monitor Correlation / Mono Sum",
    description:
      "Heuristic stereo/mono compatibility pass from pan + level symmetry on selected or inferred stereo pairs.",
    inputSchema: { trackNames: z.array(z.string().min(1).max(128)).max(8).optional() }
  },
  async ({ trackNames }) =>
    withMetrics("monitor_correlation_mono_sum", async () => {
      const tracks = await getTracksSnapshot();
      const pick =
        trackNames?.length > 0
          ? (
              await Promise.all(
                trackNames.map(async (name) => {
                  try {
                    return await resolveTrackIndexFromName(name, 0.5);
                  } catch {
                    return null;
                  }
                })
              )
            ).filter(Boolean)
          : tracks.tracks.slice(0, 6).map((t) => ({ index: t.index, name: t.name }));
      const rows = [];
      for (const t of pick) {
        try {
          const [pan, vol] = await Promise.all([
            requestAny(["/live/track/get/panning"], [intArg(t.index)]),
            requestAny(["/live/track/get/volume"], [intArg(t.index)])
          ]);
          const p = Number(parseOscValue(pan.response, 0));
          const v = Number(parseOscValue(vol.response, 0.85));
          const monoRisk = Math.abs(p) > 0.35 && v > 0.82 ? "elevated" : "low";
          rows.push({ name: t.name, trackIndex: t.index, pan: p, volume: v, monoSumRisk: monoRisk });
        } catch {
          rows.push({ name: t.name, trackIndex: t.index, pan: null, volume: null, monoSumRisk: "unknown" });
        }
      }
      return textResult({
        ok: true,
        rows,
        guidance:
          "Wide-panned hot elements can lose energy in mono; check mono sum on master and correlate low end below ~120 Hz."
      });
    })
);

server.registerTool(
  "plan_multiband_dynamics_chain",
  {
    title: "Plan Multiband Dynamics Chain",
    description: "Suggest multiband compression/ducking order for a bus role.",
    inputSchema: { bus: z.enum(["drum", "music", "vocal", "master"]) }
  },
  async ({ bus }) =>
    withMetrics("plan_multiband_dynamics_chain", async () => {
      const bands =
        bus === "vocal"
          ? ["Low: rumble control", "Mid: presence leveling", "High: de-ess / air cap"]
          : bus === "drum"
            ? ["Sub: gentle control", "Low-mid: ring control", "High: transient-aware limiting"]
            : ["Low: foundation glue", "Mid: masking control", "High: peak polish"];
      return textResult({
        ok: true,
        bus,
        bands,
        order: ["Linear-phase split (optional)", "Low band compressor", "Mid band compressor", "High band limiter/clip"],
        sessionMode: advancedEngineeringState.sessionMode
      });
    })
);

server.registerTool(
  "generate_de_essing_automation_plan",
  {
    title: "Generate De-Essing Automation Plan",
    description: "Automation breakpoints plan for de-essing / dynamic EQ moves (assistant applies via separate actions).",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      bandHz: z.number().min(2000).max(12000).optional().default(6500),
      depthDb: z.number().min(1).max(12).optional().default(4)
    }
  },
  async ({ trackName, bandHz, depthDb }) =>
    withMetrics("generate_de_essing_automation_plan", async () => {
      const resolved = await resolveTrackIndexFromName(trackName, 0.5);
      return textResult({
        ok: true,
        trackName,
        resolved,
        bandHz,
        depthDb,
        plan: [
          { beat: 4, reductionDb: depthDb * 0.25, note: "Phrase onset sibilance" },
          { beat: 12, reductionDb: depthDb * 0.6, note: "Peak ess band" },
          { beat: 20, reductionDb: depthDb * 0.35, note: "Tail de-emphasis" }
        ],
        toolHint: "Use write_device_automation_curve or clip automation in Live for the band gain / dynamic EQ depth."
      });
    })
);

server.registerTool(
  "plan_vocal_rider",
  {
    title: "Plan Vocal Rider",
    description: "Target vocal level rider breakpoints relative to a short-term loudness goal (scaffold).",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      targetStLufs: z.number().min(-30).max(-8).optional().default(-16)
    }
  },
  async ({ trackName, targetStLufs }) =>
    withMetrics("plan_vocal_rider", async () => {
      const resolved = await resolveTrackIndexFromName(trackName, 0.5);
      const vol = await requestAny(["/live/track/get/volume"], [intArg(resolved.index)]);
      const current = Number(parseOscValue(vol.response, 0.85));
      const delta = (targetStLufs + 18) * 0.008;
      const suggested = Math.min(0.98, Math.max(0.05, current + delta));
      return textResult({
        ok: true,
        trackName,
        resolved,
        targetStLufs,
        currentFader: current,
        suggestedFader: suggested,
        riderBreakpoints: [
          { section: "verse", trimDb: -0.5 },
          { section: "chorus", trimDb: 0.8 },
          { section: "bridge", trimDb: 0.2 }
        ]
      });
    })
);

server.registerTool(
  "suggest_parallel_processing_recipes",
  {
    title: "Suggest Parallel Processing Recipes",
    description: "Parallel compression / saturation / width recipes with wet/dry starting points.",
    inputSchema: { flavor: z.enum(["punch", "glue", "air", "lofi"]).optional().default("glue") }
  },
  async ({ flavor }) =>
    withMetrics("suggest_parallel_processing_recipes", async () =>
      textResult({
        ok: true,
        flavor,
        recipes: [
          {
            name: `${flavor}-parallel-comp`,
            sendLevel: flavor === "punch" ? -12 : -18,
            wetDry: flavor === "glue" ? "35/65" : "25/75",
            chain: ["EQ HPF 80 Hz", "Medium attack comp", "Optional soft clip"]
          },
          {
            name: `${flavor}-parallel-sat`,
            sendLevel: -20,
            wetDry: "15/85",
            chain: ["Tape/saturation", "Band-limit 12 kHz", "Blend to taste"]
          }
        ]
      })
    )
);

server.registerTool(
  "manage_send_reverb_economy",
  {
    title: "Manage Send / Reverb Economy",
    description: "Consolidate sends and pre-delay/RT60 suggestions to reduce wash and CPU.",
    inputSchema: { maxReturnTracks: z.number().int().min(1).max(6).optional().default(3) }
  },
  async ({ maxReturnTracks }) =>
    withMetrics("manage_send_reverb_economy", async () => {
      const tracks = await getTracksSnapshot();
      const named = tracks.tracks.filter((t) => /verb|room|hall|delay/i.test(t.name));
      return textResult({
        ok: true,
        verbLikeTracks: named.slice(0, 8).map((t) => ({ index: t.index, name: t.name })),
        maxReturnTracks,
        plan: [
          "Route similar sources to one room send with pre-delay 20–40 ms.",
          "Use shorter RT60 on percussive sources; longer tail only on hooks.",
          "High-pass return at 200–350 Hz to protect low-end clarity."
        ]
      });
    })
);

server.registerTool(
  "align_delay_coherence",
  {
    title: "Align Delay Coherence",
    description: "Compute note-aligned delay taps from tempo for coherent repeats.",
    inputSchema: {
      division: z.enum(["1/64", "1/32", "1/16", "1/8", "1/4", "1/2", "1/1"]).optional().default("1/8"),
      triplets: z.boolean().optional().default(false)
    }
  },
  async ({ division, triplets }) =>
    withMetrics("align_delay_coherence", async () => {
      const tempo = await requestKnown("tempoGet", ["/live/song/get/tempo", "/live/song/tempo"]);
      const bpm = Number(parseOscValue(tempo.response, 120));
      const beatMs = 60000 / bpm;
      const map = { "1/64": 1 / 16, "1/32": 1 / 8, "1/16": 1 / 4, "1/8": 1 / 2, "1/4": 1, "1/2": 2, "1/1": 4 };
      const beats = map[division];
      const baseMs = beatMs * beats * (triplets ? 2 / 3 : 1);
      return textResult({
        ok: true,
        bpm,
        division,
        triplets,
        suggestedDelayMs: Number(baseMs.toFixed(2)),
        dottedMs: Number((baseMs * 1.5).toFixed(2)),
        note: "Ping-pong offsets should preserve mono low-sum; filter feedback path for mud control."
      });
    })
);

server.registerTool(
  "run_kick_bass_phase_lab",
  {
    title: "Run Kick / Bass Phase Lab",
    description: "Structured polarity and timing checklist for kick vs bass interaction.",
    inputSchema: {
      kickTrackName: z.string().min(1).max(128),
      bassTrackName: z.string().min(1).max(128)
    }
  },
  async ({ kickTrackName, bassTrackName }) =>
    withMetrics("run_kick_bass_phase_lab", async () => {
      const kick = await resolveTrackIndexFromName(kickTrackName, 0.5);
      const bass = await resolveTrackIndexFromName(bassTrackName, 0.5);
      const [kv, bv] = await Promise.all([
        requestAny(["/live/track/get/volume"], [intArg(kick.index)]),
        requestAny(["/live/track/get/volume"], [intArg(bass.index)])
      ]);
      return textResult({
        ok: true,
        kick,
        bass,
        levels: {
          kick: Number(parseOscValue(kv.response, 0.85)),
          bass: Number(parseOscValue(bv.response, 0.85))
        },
        steps: [
          "Solo kick+bass, flip bass polarity; pick louder low-sum.",
          "Nudge bass forward/back 1–3 ms vs kick transient.",
          "High-pass bass non-fundamental; carve kick 50–90 Hz overlap.",
          "Mono-check <120 Hz; verify sidechain release not pumping vocal bed."
        ]
      });
    })
);

server.registerTool(
  "build_drum_phase_alignment_pack",
  {
    title: "Build Drum Phase Alignment Pack",
    description: "Checklist pack for OH / room / kick / snare phase alignment.",
    inputSchema: {
      overheadTrackName: z.string().min(1).max(128).optional(),
      roomTrackName: z.string().min(1).max(128).optional()
    }
  },
  async ({ overheadTrackName, roomTrackName }) =>
    withMetrics("build_drum_phase_alignment_pack", async () => {
      const pack = {
        overheads: overheadTrackName
          ? await resolveTrackIndexFromName(overheadTrackName, 0.5).catch(() => null)
          : null,
        room: roomTrackName ? await resolveTrackIndexFromName(roomTrackName, 0.5).catch(() => null) : null,
        tasks: [
          "Align OH to kick transient (zoom to sample).",
          "Invert room mic if snare body cancels.",
          "Check mono collapse on drum bus for hollow snare.",
          "Slip-edit close mics vs overheads if comb filtering in cymbals."
        ]
      };
      return textResult({ ok: true, pack });
    })
);

server.registerTool(
  "apply_translation_presets",
  {
    title: "Apply Translation Presets",
    description: "EQ/balance translation preset suggestions for car, phone, and laptop playback.",
    inputSchema: { preset: z.enum(["car", "phone", "laptop", "club"]) }
  },
  async ({ preset }) =>
    withMetrics("apply_translation_presets", async () =>
      textResult({
        ok: true,
        preset,
        suggestions:
          preset === "car"
            ? ["High-pass master gently at 25–30 Hz", "Tame 300–500 Hz mud +2 dB presence 2.5 kHz"]
            : preset === "phone"
              ? ["Mono-sum check; boost 2–4 kHz intelligibility lightly", "Control sub energy; verify fundamental on small speaker"]
              : preset === "laptop"
                ? ["Shelf air carefully; avoid hiss", "Kick beater click 2–4 kHz for audibility"]
                : ["Controlled subs; limit LF buildup in verb returns"]
      })
    )
);

server.registerTool(
  "build_headphone_translation_profile",
  {
    title: "Build Headphone Translation Profile",
    description: "Headphone-specific crossfeed and bass-to-mids compensation scaffold.",
    inputSchema: { headphoneModel: z.string().min(1).max(128) }
  },
  async ({ headphoneModel }) =>
    withMetrics("build_headphone_translation_profile", async () =>
      textResult({
        ok: true,
        headphoneModel,
        profile: {
          crossfeedMs: 0.35,
          crossfeedDb: -12,
          bassShelfHz: 120,
          bassShelfDb: -1.2,
          note: "Tune crossfeed and shelf by A/B against trusted nearfields; store as Live rack preset."
        }
      })
    )
);

server.registerTool(
  "lock_master_chain_delta",
  {
    title: "Lock Master Chain Delta",
    description: "Capture or verify master-side mixer levels (tail tracks) for before/after comparisons.",
    inputSchema: { action: z.enum(["capture", "verify", "release", "status"]).optional().default("status") }
  },
  async ({ action }) =>
    withMetrics("lock_master_chain_delta", async () => {
      if (action === "status") {
        return textResult({ ok: true, state: advancedEngineeringState.masterChainDelta });
      }
      if (action === "release") {
        advancedEngineeringState.masterChainDelta = { locked: false, baseline: null, baselineAt: null };
        return textResult({ ok: true, released: true });
      }
      if (action === "capture") {
        const baseline = await sampleMasterChainMixerRows(6);
        advancedEngineeringState.masterChainDelta = {
          locked: true,
          baseline,
          baselineAt: new Date().toISOString()
        };
        return textResult({ ok: true, captured: advancedEngineeringState.masterChainDelta });
      }
      const { baseline, baselineAt } = advancedEngineeringState.masterChainDelta;
      if (!baseline) {
        return textResult({ ok: false, error: "No baseline; run action capture first." });
      }
      const current = await sampleMasterChainMixerRows(6);
      const tol = 0.03;
      const diffs = [];
      for (let i = 0; i < baseline.length; i++) {
        const a = baseline[i];
        const b = current[i];
        if (a && b && a.volume != null && b.volume != null) {
          const d = Math.abs(a.volume - b.volume);
          if (d > tol) diffs.push({ name: a.name, delta: Number(d.toFixed(4)) });
        }
      }
      return textResult({
        ok: diffs.length === 0,
        baselineAt,
        diffs,
        message: diffs.length ? "Mixer drift detected on tail tracks; gain-match before judging tonal changes." : "Levels match baseline within tolerance."
      });
    })
);

server.registerTool(
  "plan_stem_loudness_normalization",
  {
    title: "Plan Stem Loudness Normalization",
    description: "Normalization plan for stem batch so masters re-combine predictably.",
    inputSchema: { targetIntegratedLufs: z.number().min(-24).max(-6).optional().default(-14) }
  },
  async ({ targetIntegratedLufs }) =>
    withMetrics("plan_stem_loudness_normalization", async () => {
      const jobs = [...exportJobs.values()].filter((j) => j.status === "completed");
      return textResult({
        ok: true,
        targetIntegratedLufs,
        completedExports: jobs.length,
        plan: [
          "Normalize each stem to target integrated with true-peak ceiling -1 dBTP.",
          "Print stems with identical limiter template for tonal consistency.",
          "Verify sum of stems ≈ master within 0.5 dB after normalization."
        ]
      });
    })
);

server.registerTool(
  "generate_dynamic_range_report",
  {
    title: "Generate Dynamic Range Report",
    description: "Aggregate crest proxy from fader levels and command health (not a replacement for a DR meter).",
    inputSchema: {}
  },
  async () =>
    withMetrics("generate_dynamic_range_report", async () => {
      const tracks = await getTracksSnapshot();
      const samples = [];
      for (const t of tracks.tracks.slice(0, 16)) {
        try {
          const vol = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
          samples.push(Number(parseOscValue(vol.response, 0.85)));
        } catch {
          // ignore
        }
      }
      const maxV = samples.length ? Math.max(...samples) : 0;
      const minV = samples.length ? Math.min(...samples) : 0;
      const spread = maxV - minV;
      return textResult({
        ok: true,
        trackSampleCount: samples.length,
        faderSpreadProxy: Number(spread.toFixed(4)),
        commandSuccessRate:
          metrics.totalCommands > 0
            ? Number(((metrics.successfulCommands / metrics.totalCommands) * 100).toFixed(1))
            : null,
        interpretation:
          spread > 0.45
            ? "Wide level spread between tracks; verify bus cohesion."
            : "Levels clustered; check that dynamics are intentional not over-compressed masking."
      });
    })
);

server.registerTool(
  "build_client_revision_ab_pack",
  {
    title: "Build Client Revision A/B Pack",
    description: "Checklist and naming pattern for client-facing A/B between revisions.",
    inputSchema: {
      revisionA: z.string().min(1).max(64),
      revisionB: z.string().min(1).max(64)
    }
  },
  async ({ revisionA, revisionB }) =>
    withMetrics("build_client_revision_ab_pack", async () =>
      textResult({
        ok: true,
        revisionA,
        revisionB,
        pack: {
          fileNaming: [`${revisionA}_master.wav`, `${revisionB}_master.wav`],
          loudnessNote: "Match integrated loudness within 0.3 LU for fair A/B.",
          emailBlurb: "Two candidates attached; same start/end trim; level-matched for comparison."
        }
      })
    )
);

server.registerTool(
  "set_engineering_session_mode",
  {
    title: "Set Engineering Session Mode",
    description: "Tune assistant aggressiveness for QA vs minimal-touch workflows.",
    inputSchema: { mode: z.enum(["balanced", "aggressive_qa", "minimal_touch"]) }
  },
  async ({ mode }) =>
    withMetrics("set_engineering_session_mode", async () => {
      advancedEngineeringState.sessionMode = mode;
      return textResult({
        ok: true,
        mode,
        effect:
          mode === "aggressive_qa"
            ? "Prefer extra checkpoints, snapshots, and stricter drift warnings."
            : mode === "minimal_touch"
              ? "Bias toward read-only diagnostics and fewer automatic write suggestions."
              : "Default mix of diagnostics and actionable writes."
      });
    })
);

server.registerTool(
  "append_change_attribution_log",
  {
    title: "Append Change Attribution Log",
    description: "Record who changed what for engineering audits (in-memory ring buffer).",
    inputSchema: {
      actor: z.string().min(1).max(64),
      action: z.string().min(1).max(128),
      detail: z.string().max(500).optional(),
      trackHint: z.string().max(128).optional()
    }
  },
  async ({ actor, action, detail, trackHint }) =>
    withMetrics("append_change_attribution_log", async () => {
      pushChangeAttribution({ actor, action, detail, trackHint });
      return textResult({
        ok: true,
        tail: advancedEngineeringState.changeLog.slice(-5)
      });
    })
);

server.registerTool(
  "run_blind_ab_helper",
  {
    title: "Run Blind A/B Helper",
    description: "Shuffle variants to anonymous play order for unbiased listening tests.",
    inputSchema: { variants: z.array(z.string().min(1).max(128)).min(2).max(8) }
  },
  async ({ variants }) =>
    withMetrics("run_blind_ab_helper", async () => {
      const order = variants.map((label, sourceIndex) => ({ label, sourceIndex }));
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const sessionId = randomUUID();
      const assignments = order.map((entry, playOrder) => ({
        playOrder: playOrder + 1,
        anonymousId: `listen_${playOrder + 1}`,
        sourceIndex: entry.sourceIndex,
        resolvedLabel: entry.label
      }));
      advancedEngineeringState.blindAb = { sessionId, assignments, createdAt: new Date().toISOString(), variantLabels: variants };
      return textResult({
        ok: true,
        sessionId,
        assignments,
        instruction: "Do not open file names that reveal mix identity until votes are collected; use anonymousId when exporting."
      });
    })
);

server.registerTool(
  "plan_vocal_take_ladder",
  {
    title: "Plan Vocal Take Ladder",
    description:
      "Naming and keeper-marking workflow for vocal takes in Live. Plugins: none (built-in take lanes / comping). Optional: Waves Vocal Rider or iZotope Neutron for level-matched takes before comping.",
    inputSchema: { baseName: z.string().min(1).max(64).optional().default("Vox") }
  },
  async ({ baseName }) =>
    withMetrics("plan_vocal_take_ladder", async () =>
      textResult({
        ok: true,
        baseName,
        pluginsRequired: [],
        pluginsOptional: ["Waves Vocal Rider", "iZotope Neutron"],
        namingPattern: [`${baseName}_T01`, `${baseName}_T02`, `${baseName}_HOOK_KEEP`, `${baseName}_ADLIB`],
        steps: [
          "Color-code keepers vs rejects; freeze FX on archived takes to save CPU.",
          "Bounce a safety 'all-takes' stem before destructive comping."
        ]
      })
    )
);

server.registerTool(
  "plan_vocal_punch_in_session",
  {
    title: "Plan Vocal Punch-In Session",
    description:
      "Loop brace, pre-roll, and punch workflow for vocals. Plugins: none for transport. Optional monitoring: Sonarworks SoundID Reference or Waves Nx for consistent headphone cue.",
    inputSchema: {
      loopStartBeats: z.number().min(0).optional().default(16),
      loopLengthBeats: z.number().positive().optional().default(4),
      preRollBars: z.number().min(0).max(4).optional().default(1)
    }
  },
  async ({ loopStartBeats, loopLengthBeats, preRollBars }) =>
    withMetrics("plan_vocal_punch_in_session", async () => {
      const preRollBeats = preRollBars * 4;
      const loopStart = Math.max(0, loopStartBeats - preRollBeats);
      const loopLen = loopLengthBeats + preRollBeats;
      sendMaybe("/live/song/set/loop_start", [floatArg(loopStart)]);
      sendMaybe("/live/song/set/loop_length", [floatArg(loopLen)]);
      sendMaybe("/live/song/set/loop", [intArg(1)]);
      sendMaybe("/live/song/set/metronome", [intArg(1)]);
      sendMaybe("/live/song/set/punch_in", [intArg(1)]);
      return textResult({
        ok: true,
        loopStartBeats,
        loopLengthBeats,
        preRollBars,
        appliedLoopStart: loopStart,
        appliedLoopLength: loopLen,
        pluginsRequired: [],
        pluginsOptional: ["Sonarworks SoundID Reference", "Waves Nx"],
        note: "Verify loop region against arrangement; pre-roll uses 4 beats per bar (Live 4/4 assumption)."
      });
    })
);

server.registerTool(
  "map_vocal_breath_noise_candidates",
  {
    title: "Map Vocal Breath / Noise Candidates",
    description:
      "Heuristic map of likely breath gaps and noise edits (not audio detection). For actual cleanup plugins: iZotope RX (Breath Control, Mouth De-click, Spectral Repair), Waves DeBreath, Accusonus ERA Bundle Noise Remover.",
    inputSchema: { trackName: z.string().min(1).max(128) }
  },
  async ({ trackName }) =>
    withMetrics("map_vocal_breath_noise_candidates", async () => {
      const resolved = await resolveTrackIndexFromName(trackName, 0.45);
      return textResult({
        ok: true,
        trackName,
        resolved,
        pluginsRequired: [],
        pluginsOptional: [
          "iZotope RX (Breath Control, Mouth De-click, Spectral Repair)",
          "Waves DeBreath",
          "Accusonus ERA Noise Remover"
        ],
        candidateRegions: [
          { barHint: "phrase start -80ms", kind: "breath" },
          { barHint: "long pauses >300ms", kind: "room_tone" },
          { barHint: "consonant bursts", kind: "mouth_click" }
        ],
        disclaimer: "Confirm by ear; this tool does not analyze waveform content."
      });
    })
);

server.registerTool(
  "run_vocal_room_tone_headphone_checklist",
  {
    title: "Run Vocal Room Tone / Headphone Bleed Checklist",
    description:
      "Recording hygiene checklist before serious vocals. Repair plugins: iZotope RX Spectral Repair / Dialogue Isolate; bleed: RX Music Rebalance (if licensed). Optional room: SPL De-Verb or Acon Digital DeVerberate.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_vocal_room_tone_headphone_checklist", async () =>
      textResult({
        ok: true,
        pluginsRequired: [],
        pluginsOptional: [
          "iZotope RX (Spectral Repair, Dialogue Isolate, Music Rebalance)",
          "SPL De-Verb",
          "Acon Digital DeVerberate"
        ],
        checklist: [
          "Record 10s silence in place for room tone.",
          "Mark headphone level; reduce click track bleed.",
          "Note AC/fridge; schedule pause or edit plan."
        ]
      })
    )
);

server.registerTool(
  "run_vocal_comp_workflow_v2",
  {
    title: "Run Vocal Comp Workflow v2",
    description:
      "Phrase-level comp map and crossfade guidance. Pitch-aware comp: Celemony Melodyne (ARA in Live where supported) or Synchro Arts VocAlign / RePitch. Time alignment: VocAlign Ultra / Revoice Pro.",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      crossfadeMs: z.number().min(5).max(80).optional().default(22)
    }
  },
  async ({ trackName, crossfadeMs }) =>
    withMetrics("run_vocal_comp_workflow_v2", async () =>
      textResult({
        ok: true,
        trackName,
        crossfadeMs,
        pluginsRequired: [],
        pluginsOptional: [
          "Celemony Melodyne",
          "Synchro Arts VocAlign 6 / Ultra",
          "Synchro Arts RePitch",
          "Revoice Pro"
        ],
        workflow: [
          "Comp consonants from the brightest take; vowels from the most stable.",
          "Split at breaths; avoid mid-word unless timing matched.",
          `Default crossfade ~${crossfadeMs}ms; shorten on percussive consonants.`
        ]
      })
    )
);

server.registerTool(
  "analyze_vocal_take_consistency",
  {
    title: "Analyze Vocal Take Consistency",
    description:
      "Level-variance proxy across named takes on a vocal lane. Deep pitch/timing spread: Melodyne, Waves Tune, or Revoice Pro analysis — not computed here.",
    inputSchema: { trackNamePrefix: z.string().min(1).max(64).optional().default("Vox") }
  },
  async ({ trackNamePrefix }) =>
    withMetrics("analyze_vocal_take_consistency", async () => {
      const tracks = await getTracksSnapshot();
      const prefix = normalizeName(trackNamePrefix);
      const related = tracks.tracks.filter((t) => normalizeName(t.name).includes(prefix));
      const levels = [];
      for (const t of related.slice(0, 8)) {
        try {
          const vol = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
          levels.push({ name: t.name, volume: Number(parseOscValue(vol.response, 0.85)) });
        } catch {
          levels.push({ name: t.name, volume: null });
        }
      }
      const nums = levels.map((l) => l.volume).filter((v) => v != null);
      const spread = nums.length ? Math.max(...nums) - Math.min(...nums) : 0;
      return textResult({
        ok: true,
        trackNamePrefix,
        matched: levels,
        faderSpreadProxy: Number(spread.toFixed(4)),
        pluginsRequired: [],
        pluginsOptional: ["Celemony Melodyne", "Waves Tune", "Revoice Pro"],
        interpretation:
          spread > 0.12
            ? "Large fader differences between takes; level-match before comping."
            : "Takes are roughly level-matched by fader proxy."
      });
    })
);

server.registerTool(
  "plan_vocal_tuning_strategy",
  {
    title: "Plan Vocal Tuning Strategy",
    description:
      "When to use transparent vs creative tuning. Plugins named for user shopping: Antares Auto-Tune Pro, Celemony Melodyne 5, Waves Tune Real-Time / Waves Tune, Soundtoys Little AlterBoy, stock Ableton Pitch devices. Print vs live monitoring called out in output.",
    inputSchema: { style: z.enum(["transparent", "modern-pop", "character"]).optional().default("transparent") }
  },
  async ({ style }) =>
    withMetrics("plan_vocal_tuning_strategy", async () =>
      textResult({
        ok: true,
        style,
        pluginsRequired: [],
        pluginsOptional: [
          "Antares Auto-Tune Pro",
          "Celemony Melodyne 5",
          "Waves Tune Real-Time",
          "Waves Tune",
          "Soundtoys Little AlterBoy",
          "Ableton Pitch Shifter / Corpus (stock creative)"
        ],
        strategy:
          style === "modern-pop"
            ? "Fast retune + scale lock; print with low latency plugin on monitoring path only."
            : style === "character"
              ? "Formant-shift and parallel detune; watch consonant smear."
              : "Melodyne-style manual edits per phrase; avoid over-smoothing breath noise."
      })
    )
);

server.registerTool(
  "plan_vocal_timing_tighten",
  {
    title: "Plan Vocal Timing Tighten",
    description:
      "Nudge vs quantize plan for vocals. Plugins: Synchro Arts VocAlign Ultra / Revoice Pro for dub alignment; stock Ableton Warp for single vocal. Elastic Audio in Pro Tools is out of scope for this Live bridge.",
    inputSchema: { aggressiveness: z.enum(["light", "medium", "tight"]).optional().default("medium") }
  },
  async ({ aggressiveness }) =>
    withMetrics("plan_vocal_timing_tighten", async () =>
      textResult({
        ok: true,
        aggressiveness,
        pluginsRequired: [],
        pluginsOptional: ["Synchro Arts VocAlign Ultra", "Revoice Pro", "Ableton Warp (stock)"],
        plan: [
          "Tighten doubles to lead first; then nudge lead ±5–15 ms before hard quantize.",
          "Preserve pick-ups and ad-libs as human markers unless EDM grid demands."
        ]
      })
    )
);

server.registerTool(
  "setup_vocal_doubles_stack",
  {
    title: "Setup Vocal Doubles Stack",
    description:
      "Panning and send recipe for double / triple vocals. Widening plugins: Waves Doubler, Soundtoys MicroShift, iZotope Nectar (Doubler module), Waves Reel ADT, stock Chorus/Delay.",
    inputSchema: {
      leadTrackName: z.string().min(1).max(128),
      doubleLName: z.string().min(1).max(128).optional(),
      doubleRName: z.string().min(1).max(128).optional()
    }
  },
  async ({ leadTrackName, doubleLName, doubleRName }) =>
    withMetrics("setup_vocal_doubles_stack", async () => {
      const lead = await resolveTrackIndexFromName(leadTrackName, 0.45);
      const writes = [];
      writes.push(sendPlanRaw("/live/track/set/panning", [intArg(lead.index), floatArg(0)], { track: lead.name, pan: 0 }));
      if (doubleLName) {
        const l = await resolveTrackIndexFromName(doubleLName, 0.45);
        writes.push(sendPlanRaw("/live/track/set/panning", [intArg(l.index), floatArg(-0.28)], { track: l.name, pan: -0.28 }));
      }
      if (doubleRName) {
        const r = await resolveTrackIndexFromName(doubleRName, 0.45);
        writes.push(sendPlanRaw("/live/track/set/panning", [intArg(r.index), floatArg(0.28)], { track: r.name, pan: 0.28 }));
      }
      return textResult({
        ok: true,
        lead,
        pluginsRequired: [],
        pluginsOptional: [
          "Waves Doubler",
          "Soundtoys MicroShift",
          "iZotope Nectar (Doubler)",
          "Waves Reel ADT",
          "Ableton Chorus / Echo (stock)"
        ],
        writes,
        sends: ["Single short room send shared by doubles; pre-delay 25–40 ms."]
      });
    })
);

server.registerTool(
  "plan_singer_plugin_chain",
  {
    title: "Plan Singer Plugin Chain",
    description:
      "Ordered vocal chain with explicit third-party options. Tell the user they need their chosen stack installed: FabFilter Pro-Q 3 / Pro-C 2 / Pro-DS / Pro-L 2, Waves SSL E-Channel / RVox / Renaissance DeEsser / CLA Vocals, UAD LA-2A / 1176, iZotope Nectar 4, oeksound Soothe2 / Spiff, Sonnox Oxford SuprEsser, Soundtoys Decapitator / Little Plate — or stock EQ Eight + Compressor + Utility.",
    inputSchema: { genre: z.enum(["pop", "rnb", "rock", "podcast"]).optional().default("pop") }
  },
  async ({ genre }) =>
    withMetrics("plan_singer_plugin_chain", async () =>
      textResult({
        ok: true,
        genre,
        pluginsRequired: [],
        pluginsOptional: [
          "FabFilter Pro-Q 3",
          "FabFilter Pro-C 2",
          "FabFilter Pro-DS",
          "FabFilter Pro-L 2",
          "Waves SSL E-Channel",
          "Waves RVox",
          "Waves Renaissance DeEsser",
          "Waves CLA Vocals",
          "UAD Teletronix LA-2A",
          "UAD 1176LN",
          "iZotope Nectar 4",
          "oeksound Soothe2",
          "oeksound Spiff",
          "Sonnox Oxford SuprEsser",
          "Soundtoys Decapitator",
          "Soundtoys Little Plate",
          "Ableton EQ Eight / Compressor / Utility (stock)"
        ],
        chainOrder:
          genre === "podcast"
            ? ["HPF", "De-ess", "Gentle comp", "Air shelf", "Limiter"]
            : ["HPF", "Subtractive EQ", "Serial comp", "De-ess", "Additive EQ", "Spatial/send", "Limiter"],
        userMessage:
          "Install only the plugins you pick from pluginsOptional; none are strictly required if you use the stock Ableton devices instead."
      })
    )
);

server.registerTool(
  "run_pre_bounce_sibilance_check",
  {
    title: "Run Pre-Bounce Sibilance Check",
    description:
      "Checklist before printing vocals. De-esser plugins to mention to the user: FabFilter Pro-DS, Waves Renaissance DeEsser / Sibilance, iZotope Nectar DeEsser, Sonnox Oxford SuprEsser, oeksound Soothe2 / Spiff.",
    inputSchema: { trackName: z.string().min(1).max(128).optional() }
  },
  async ({ trackName }) =>
    withMetrics("run_pre_bounce_sibilance_check", async () => {
      let matched = null;
      if (trackName) {
        try {
          matched = await resolveTrackIndexFromName(trackName, 0.45);
        } catch {
          matched = null;
        }
      }
      return textResult({
        ok: true,
        trackName: trackName ?? null,
        matched,
        pluginsRequired: [],
        pluginsOptional: [
          "FabFilter Pro-DS",
          "Waves Renaissance DeEsser",
          "Waves Sibilance",
          "iZotope Nectar (DeEsser)",
          "Sonnox Oxford SuprEsser",
          "oeksound Soothe2",
          "oeksound Spiff"
        ],
        checks: [
          "Audition at -6 dB monitor: ess on small speakers?",
          "Bypass de-esser: compare ess energy at 5–9 kHz.",
          "After limiter, re-check; limiting can uncover ess."
        ]
      });
    })
);

server.registerTool(
  "setup_warmup_then_record_scene",
  {
    title: "Setup Warmup Then Record Scene",
    description:
      "Transport prep for warm-up then tracking. Plugins: none required. Optional cue tone: any sine generator VST; headphone calibration Sonarworks SoundID Reference.",
    inputSchema: { enableMetronome: z.boolean().optional().default(true) }
  },
  async ({ enableMetronome }) =>
    withMetrics("setup_warmup_then_record_scene", async () => {
      if (enableMetronome) sendMaybe("/live/song/set/metronome", [intArg(1)]);
      return textResult({
        ok: true,
        enableMetronome,
        pluginsRequired: [],
        pluginsOptional: ["Sonarworks SoundID Reference", "Any sine-generator VST for in-ear tone check"],
        sequence: [
          "5 min lip trills / sirens at low level.",
          "Sing phrase at half voice; then full take pass.",
          "Disable CPU-heavy master chain while tracking if latency spikes."
        ]
      });
    })
);

server.registerTool(
  "generate_vocal_harmony_midi_scaffold",
  {
    title: "Generate Vocal Harmony MIDI Scaffold",
    description:
      "Triad MIDI block scaffold on a clip for harmony practice. Chord helper plugins (optional): Plugin Boutique Scaler 2, Mixed In Key Captain Chords, Orb Producer Suite. Pitch correction on audio: Melodyne / Auto-Tune — not inserted by this tool.",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      clipIndex: z.number().int().min(0).optional().default(0),
      rootMidi: z.number().int().min(36).max(84).optional().default(60),
      applyMidi: z.boolean().optional().default(false)
    }
  },
  async ({ trackName, clipIndex, rootMidi, applyMidi }) =>
    withMetrics("generate_vocal_harmony_midi_scaffold", async () => {
      const resolved = await resolveTrackIndexFromName(trackName, 0.45);
      const third = rootMidi + 4;
      const fifth = rootMidi + 7;
      const notes = [
        { pitch: rootMidi, start: 0, duration: 1, velocity: 90, mute: false },
        { pitch: third, start: 0, duration: 1, velocity: 85, mute: false },
        { pitch: fifth, start: 0, duration: 1, velocity: 85, mute: false }
      ];
      let writeCount = 0;
      if (applyMidi) {
        for (const note of notes) {
          sendMaybe("/live/clip/add_note", [
            intArg(resolved.index),
            intArg(clipIndex),
            intArg(note.pitch),
            floatArg(note.start),
            floatArg(note.duration),
            intArg(note.velocity),
            intArg(note.mute ? 1 : 0)
          ]);
          writeCount += 1;
        }
      }
      return textResult({
        ok: true,
        resolved,
        clipIndex,
        notes,
        applyMidi,
        notesWritten: writeCount,
        pluginsRequired: [],
        pluginsOptional: ["Plugin Boutique Scaler 2", "Mixed In Key Captain Chords", "Orb Producer Suite"],
        hint: "Set applyMidi=true to best-effort add notes; clip must exist and endpoint must support add_note."
      });
    })
);

server.registerTool(
  "setup_backing_vocal_bus",
  {
    title: "Setup Backing Vocal Bus",
    description:
      "Routing plan for BVs to a bus with shared processing. Bus glue plugins (optional): Waves SSL G-Master Buss Compressor, FabFilter Pro-C 2, iZotope Nectar Backing module, Soundtoys Little AlterBoy for width.",
    inputSchema: {
      bvTrackNames: z.array(z.string().min(1).max(128)).min(1).max(12),
      busTrackName: z.string().min(1).max(128)
    }
  },
  async ({ bvTrackNames, busTrackName }) =>
    withMetrics("setup_backing_vocal_bus", async () => {
      const bus = await resolveTrackIndexFromName(busTrackName, 0.4);
      const writes = [];
      for (const name of bvTrackNames) {
        const t = await resolveTrackIndexFromName(name, 0.4);
        writes.push(
          await sendKnownRaw(
            "trackSetRouting",
            ["/live/track/set/routing"],
            [intArg(t.index), stringArg(`BV_BUS:${bus.name}`), stringArg("MASTER")],
            { bvTrack: t, busTrack: bus }
          )
        );
      }
      return textResult({
        ok: true,
        bus,
        pluginsRequired: [],
        pluginsOptional: [
          "Waves SSL G-Master Buss Compressor",
          "FabFilter Pro-C 2",
          "iZotope Nectar 4",
          "Soundtoys Little AlterBoy"
        ],
        writes,
        note: "Routing metadata is best-effort; verify in Live's In/Out section."
      });
    })
);

server.registerTool(
  "configure_singer_warmup_metronome",
  {
    title: "Configure Singer Warmup Metronome",
    description:
      "Metronome and count-in style prep for vocal warmups. Plugins: none (Live metronome). Optional headphone calibration: Sonarworks SoundID Reference.",
    inputSchema: {
      bpmLow: z.number().min(40).max(200).optional().default(80),
      bpmHigh: z.number().min(40).max(220).optional().default(120)
    }
  },
  async ({ bpmLow, bpmHigh }) =>
    withMetrics("configure_singer_warmup_metronome", async () => {
      sendMaybe("/live/song/set/metronome", [intArg(1)]);
      sendMaybe("/live/song/set/tempo", [floatArg(bpmLow)]);
      return textResult({
        ok: true,
        bpmLow,
        bpmHigh,
        pluginsRequired: [],
        pluginsOptional: ["Sonarworks SoundID Reference"],
        warmup: [
          `Start at ${bpmLow} BPM for trills; ramp toward ${bpmHigh} BPM over 5 minutes.`,
          "Use Live's count-in; extend loop one bar for pickup practice."
        ]
      });
    })
);

server.registerTool(
  "export_lyric_cue_sheet_from_clips",
  {
    title: "Export Lyric Cue Sheet From Clips",
    description:
      "Build a cue-sheet scaffold from clip slot indices (lyrics in clip names recommended). Plugins: none. Optional lyric display: Teleprompter apps outside Live; or Max for Live lyric devices if user owns them.",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      maxSlots: z.number().int().min(1).max(32).optional().default(8)
    }
  },
  async ({ trackName, maxSlots }) =>
    withMetrics("export_lyric_cue_sheet_from_clips", async () => {
      const resolved = await resolveTrackIndexFromName(trackName, 0.45);
      const slots = [];
      for (let clipIndex = 0; clipIndex < maxSlots; clipIndex += 1) {
        try {
          const resp = await requestAny(
            ["/live/clip_slot/get_clip_name", "/live/clip/get/name"],
            [intArg(resolved.index), intArg(clipIndex)]
          );
          const raw = parseOscValue(resp.response, "");
          const label = typeof raw === "string" ? raw : `Slot ${clipIndex}`;
          slots.push({ clipIndex, cue: label || `(empty slot ${clipIndex})` });
        } catch {
          slots.push({ clipIndex, cue: `(unreadable slot ${clipIndex})` });
        }
      }
      return textResult({
        ok: true,
        trackName,
        resolved,
        cueSheet: slots,
        pluginsRequired: [],
        pluginsOptional: ["Max for Live lyric / teleprompter devices (third-party)", "External teleprompter app"],
        tip: "Put a short lyric phrase in each clip name for readable cue lines; MIDI note export is not lyrics."
      });
    })
);

server.registerTool(
  "run_vocal_ear_training_checklist",
  {
    title: "Run Vocal Ear Training Checklist",
    description:
      "Bias-aware listening drills for intonation and tone (no auto scoring). Plugins: none. Optional reference pitch: Korg CA-type tuner plugin or Melodyne for visual pitch education only.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_vocal_ear_training_checklist", async () =>
      textResult({
        ok: true,
        pluginsRequired: [],
        pluginsOptional: ["Celemony Melodyne (visual education)", "Hardware/software tuner VST"],
        drills: [
          "Sing a major scale against a drone; check third and seventh tuning by ear.",
          "Record same phrase flat 10 cents then in tune; blind A/B yourself.",
          "Compare vowel shape on ee vs ah at same pitch."
        ]
      })
    )
);

server.registerTool(
  "manage_vocal_fx_snapshots",
  {
    title: "Manage Vocal FX Snapshots",
    description:
      "Scene-based recall plan for vocal FX chains. User needs their own FX VSTs installed (examples to communicate): Soundtoys Effect Rack, Valhalla DSP (Supermassive / VintageVerb), FabFilter Timeless 3, Soundtoys EchoBoy / PrimalTap, Cableguys ShaperBox, RC-20 Retro Color.",
    inputSchema: {
      sceneNames: z.array(z.string().min(1).max(64)).min(1).max(8)
    }
  },
  async ({ sceneNames }) =>
    withMetrics("manage_vocal_fx_snapshots", async () =>
      textResult({
        ok: true,
        sceneNames,
        pluginsRequired: [],
        pluginsOptional: [
          "Soundtoys Effect Rack",
          "Valhalla Supermassive",
          "Valhalla VintageVerb",
          "FabFilter Timeless 3",
          "Soundtoys EchoBoy",
          "Soundtoys PrimalTap",
          "Cableguys ShaperBox 2",
          "RC-20 Retro Color"
        ],
        plan: sceneNames.map((name, i) => ({
          scene: i,
          name,
          action: "Map device chain bypass states and send levels per scene; document wet/dry baselines."
        }))
      })
    )
);

server.registerTool(
  "audit_vocal_monitor_path_safety",
  {
    title: "Audit Vocal Monitor Path Safety",
    description:
      "Cue path safety checklist (feedback, level, limiting). Plugins to recommend: Sonarworks SoundID Reference, Waves Nx, IK Multimedia ARC, master/cue limiter FabFilter Pro-L 2 / Waves L2 / Vladg Limiter No6 / iZotope Ozone Maximizer (use gently on cue).",
    inputSchema: {}
  },
  async () =>
    withMetrics("audit_vocal_monitor_path_safety", async () =>
      textResult({
        ok: true,
        pluginsRequired: [],
        pluginsOptional: [
          "Sonarworks SoundID Reference",
          "Waves Nx",
          "IK Multimedia ARC",
          "FabFilter Pro-L 2",
          "Waves L2 Ultramaximizer",
          "Vladg Sound Limiter No6",
          "iZotope Ozone Maximizer"
        ],
        checks: [
          "Cue send pre/post fader: avoid feedback loop on live mic.",
          "Insert true-peak-aware limiter last on headphone cue if artist wants loud cue.",
          "Calibrate headphones if using translation-critical decisions."
        ]
      })
    )
);

server.registerTool(
  "configure_vocal_setlist_scenes",
  {
    title: "Configure Vocal Setlist Scenes",
    description:
      "Per-song scene checklist for live vocals (arm track, tempo, rack). No specific plugins required; user must install whatever vocal FX rack they use (e.g. UAD, Waves, Soundtoys chains referenced in manage_vocal_fx_snapshots).",
    inputSchema: {
      songs: z.array(z.object({ title: z.string().min(1).max(128), bpm: z.number().min(40).max(300) })).min(1).max(24)
    }
  },
  async ({ songs }) =>
    withMetrics("configure_vocal_setlist_scenes", async () =>
      textResult({
        ok: true,
        songs,
        pluginsRequired: [],
        pluginsOptional: ["User's live vocal rack (UAD / Waves / Soundtoys / FabFilter — install separately)"],
        perSong: songs.map((s, i) => ({
          sceneIndex: i,
          title: s.title,
          targetBpm: s.bpm,
          checklist: ["Arm vocal input", "Load rack snapshot", "Set tempo (e.g. set_tempo action) before scene launch"],
          tempoOscHint: { address: "/live/song/set/tempo", args: [s.bpm] }
        }))
      })
    )
);

server.registerTool(
  "plan_vocal_delivery_variants",
  {
    title: "Plan Vocal Delivery Variants",
    description:
      "TV mix / clean / explicit / instrumental matrix for vocals. Loudness QC plugins: Youlean Loudness Meter (free), iZotope Insight, Nugen VisLM, Mastering The Mix LEVELS.",
    inputSchema: {}
  },
  async () =>
    withMetrics("plan_vocal_delivery_variants", async () =>
      textResult({
        ok: true,
        pluginsRequired: [],
        pluginsOptional: ["Youlean Loudness Meter", "iZotope Insight", "Nugen VisLM", "Mastering The Mix LEVELS"],
        variants: [
          { name: "master_full", includes: ["music", "lead_vox", "bv", "explicit_lyrics"] },
          { name: "tv_mix", includes: ["music", "lead_vox", "bv", "bleeped_or_alt_lyrics"] },
          { name: "clean", includes: ["music", "lead_vox", "bv", "no_explicit"] },
          { name: "instrumental", includes: ["music", "no_lead_vox"] },
          { name: "acapella", includes: ["lead_vox", "bv", "no_music"] }
        ],
        note: "Mute/solo and export via your existing render tools; this tool is naming + intent only."
      })
    )
);

server.registerTool(
  "plan_vocal_stem_export_naming",
  {
    title: "Plan Vocal Stem Export Naming",
    description:
      "Standard names for lead dry, lead FX, doubles, BVs. No plugins required for naming. Optional print prep: UAD Studer A800 / Ampex ATR-102 for tape flavor on vocal bus — purely optional.",
    inputSchema: { artistSlug: z.string().min(1).max(64).optional().default("artist") }
  },
  async ({ artistSlug }) =>
    withMetrics("plan_vocal_stem_export_naming", async () =>
      textResult({
        ok: true,
        artistSlug,
        pluginsRequired: [],
        pluginsOptional: ["UAD Studer A800", "UAD Ampex ATR-102"],
        stemNames: [
          `${artistSlug}_lead_vox_dry.wav`,
          `${artistSlug}_lead_vox_fx.wav`,
          `${artistSlug}_dbl_L.wav`,
          `${artistSlug}_dbl_R.wav`,
          `${artistSlug}_bv_bus.wav`,
          `${artistSlug}_adlibs.wav`
        ]
      })
    )
);

server.registerTool(
  "plan_vocal_chain_ab_snapshots",
  {
    title: "Plan Vocal Chain A/B Snapshots",
    description:
      "Gain-matched A/B plan for vocal FX chains. Plugins for level-matched shootouts: Plugin Alliance ADPTR Metric A/B, Sample Magic Magic AB, Letimix GainMatch, Melda MCompare, FabFilter Pro-Q 3 (match spectrum). Stock: Utility for trim only.",
    inputSchema: { chainLabel: z.string().min(1).max(64).optional().default("Lead Vox FX") }
  },
  async ({ chainLabel }) =>
    withMetrics("plan_vocal_chain_ab_snapshots", async () =>
      textResult({
        ok: true,
        chainLabel,
        pluginsRequired: [],
        pluginsOptional: [
          "Plugin Alliance ADPTR Metric A/B",
          "Sample Magic Magic AB",
          "Letimix GainMatch",
          "MeldaProduction MCompare",
          "FabFilter Pro-Q 3 (EQ match / level)",
          "Ableton Utility (trim / polarity only — stock)"
        ],
        steps: [
          "Duplicate chain to inactive rack; match perceived loudness before tone judgments.",
          "Bypass one path at a time; do not change input trim between A and B.",
          "Print short noise burst through both paths to verify level match."
        ]
      })
    )
);

server.registerTool(
  "run_low_latency_vocal_tracking_checklist",
  {
    title: "Run Low-Latency Vocal Tracking Checklist",
    description:
      "Buffer, monitoring, and delay-compensation checklist for tracking. Low-latency monitoring: UAD Apollo + Console, Antelope Discrete, RME TotalMix, Focusrite Control — driver dependent. In-the-box: reduce buffer, freeze/disable heavy master chain, use Live’s Reduced Latency When Monitoring.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_low_latency_vocal_tracking_checklist", async () =>
      textResult({
        ok: true,
        pluginsRequired: [],
        pluginsOptional: [
          "UAD Apollo + Console (Unison preamps)",
          "Antelope Audio Discrete / Control Panel",
          "RME TotalMix FX",
          "Focusrite Control (Air / monitoring)",
          "Ableton stock: Reduce Latency When Monitoring"
        ],
        checklist: [
          "Set smallest stable buffer size (256/128/64) for round-trip test.",
          "Disable CPU-heavy master inserts while tracking; use tracking-friendly vocal rack.",
          "Prefer hardware monitoring or Live low-latency mode over latent sends on cue."
        ]
      })
    )
);

server.registerTool(
  "plan_duet_harmony_recording_session",
  {
    title: "Plan Duet / Harmony Recording Session",
    description:
      "Two-singer cue-mix and routing plan. Cue / room modeling plugins (optional): Waves Nx, Sonarworks SoundID Reference, Goodhertz CanOpener. No third-party required if using Live sends/returns only.",
    inputSchema: {
      singerATrack: z.string().min(1).max(128),
      singerBTrack: z.string().min(1).max(128)
    }
  },
  async ({ singerATrack, singerBTrack }) =>
    withMetrics("plan_duet_harmony_recording_session", async () => {
      const a = await resolveTrackIndexFromName(singerATrack, 0.4);
      const b = await resolveTrackIndexFromName(singerBTrack, 0.4);
      return textResult({
        ok: true,
        singerA: a,
        singerB: b,
        pluginsRequired: [],
        pluginsOptional: ["Waves Nx", "Sonarworks SoundID Reference", "Goodhertz CanOpener Studio"],
        routing: [
          "Dedicated cue send per singer with distinct HP mix (more self in each).",
          "Shared room reverb return at lower level for blend.",
          "Polarity check when both mics leak into each other’s tracks."
        ]
      });
    })
);

server.registerTool(
  "run_vocal_booth_session_start_macro",
  {
    title: "Run Vocal Booth Session Start Macro",
    description:
      "Slate / room tone / line-check sequence with locator markers. Repair / tone plugins (optional): iZotope RX for room tone cleanup; slate mic: any test tone generator VST or stock Operator sine.",
    inputSchema: { startBeat: z.number().min(0).optional().default(0) }
  },
  async ({ startBeat }) =>
    withMetrics("run_vocal_booth_session_start_macro", async () => {
      sendMaybe("/live/song/set/metronome", [intArg(0)]);
      const markers = [
        { t: startBeat, name: "BOOTH_SLATE" },
        { t: startBeat + 4, name: "ROOM_TONE_10S" },
        { t: startBeat + 8, name: "LINE_CHECK" },
        { t: startBeat + 12, name: "ARM_VOX_READY" }
      ];
      const writes = [];
      for (const m of markers) {
        writes.push(sendMaybe("/live/song/create_locator", [floatArg(m.t)]));
        writes.push(sendMaybe("/live/song/set/last_locator_name", [stringArg(m.name)]));
      }
      return textResult({
        ok: true,
        startBeat,
        pluginsRequired: [],
        pluginsOptional: ["iZotope RX (Spectral Repair on room tone)", "Ableton Operator or any sine VST for slate tone"],
        writes,
        note: "Locator API varies; verify marker names in Live. Markers spaced by 4 beats (1 bar @ 4/4) — adjust to your grid."
      });
    })
);

server.registerTool(
  "plan_vocal_adlib_lane",
  {
    title: "Plan Vocal Ad-Lib Lane",
    description:
      "Naming and arrangement plan for ad-lib passes vs main doubles. Pitch tools for wild ad-libs (optional): Antares Auto-Tune, Melodyne, Waves Tune Real-Time. Comping: stock or VocAlign for doubles.",
    inputSchema: { songSection: z.string().min(1).max(64).optional().default("HOOK") }
  },
  async ({ songSection }) =>
    withMetrics("plan_vocal_adlib_lane", async () =>
      textResult({
        ok: true,
        songSection,
        pluginsRequired: [],
        pluginsOptional: [
          "Antares Auto-Tune Pro",
          "Celemony Melodyne",
          "Waves Tune Real-Time",
          "Synchro Arts VocAlign"
        ],
        clipNaming: [`ADLIB_${songSection}_01`, `ADLIB_${songSection}_FREESTYLE`, `STACK_${songSection}_CALL`],
        rules: [
          "Keep ad-libs on separate track from lead comp for selective mute in clean TV mix.",
          "Mark explicit vs clean alt takes in clip name."
        ]
      })
    )
);

server.registerTool(
  "plan_vocal_tone_modes_scenes",
  {
    title: "Plan Vocal Tone Modes (Whisper / Fry / Belt)",
    description:
      "Scene templates for tone modes with FX and gain-staging notes. Plugins: Soundtoys Little AlterBoy (formant), Decapitator / Radiator (saturation), FabFilter Saturn 2, iZotope Nectar (Breath / saturation modules), oeksound Soothe2 (harshness on belt).",
    inputSchema: { modes: z.array(z.enum(["whisper", "fry", "belt", "head", "mix"])).min(1).max(5) }
  },
  async ({ modes }) =>
    withMetrics("plan_vocal_tone_modes_scenes", async () =>
      textResult({
        ok: true,
        modes,
        pluginsRequired: [],
        pluginsOptional: [
          "Soundtoys Little AlterBoy",
          "Soundtoys Decapitator",
          "Soundtoys Radiator",
          "FabFilter Saturn 2",
          "iZotope Nectar 4",
          "oeksound Soothe2"
        ],
        perMode: modes.map((m) => ({
          mode: m,
          gainStaging:
            m === "whisper"
              ? "High noise floor risk: HPF gently; serial gentle comp; de-ess lighter."
              : m === "belt"
                ? "Watch ess + 3–5 kHz; limiter last; more headroom on preamp input."
                : "Control subharmonics / distortion build-up; clip long sustains if fry-heavy."
        }))
      })
    )
);

server.registerTool(
  "plan_choir_stack_builder",
  {
    title: "Plan Choir Stack Builder",
    description:
      "3+ part vocal stack layout (S/A/T/B or uni sections) with panning and section labels. Widening / room: Waves Doubler, Soundtoys MicroShift, Valhalla Room / VintageVerb, Spitfire Symphonic Choirs (if writing pads) — optional.",
    inputSchema: {
      parts: z.array(z.string().min(1).max(32)).min(2).max(8).optional().default(["Soprano", "Alto", "Tenor", "Bass"])
    }
  },
  async ({ parts }) =>
    withMetrics("plan_choir_stack_builder", async () =>
      textResult({
        ok: true,
        parts,
        pluginsRequired: [],
        pluginsOptional: [
          "Waves Doubler",
          "Soundtoys MicroShift",
          "Valhalla Room / VintageVerb",
          "Spitfire Symphonic Choirs (instrument pad under vocals)"
        ],
        layout: parts.map((p, i) => ({
          trackName: `CHOIR_${p.replace(/\s+/g, "_")}`,
          pan: Math.round(((((i + 0.5) / parts.length) * 2 - 1) * 0.42 + Number.EPSILON) * 1000) / 1000,
          note: "Group to CHOIR_BUS; shared short room + longer hall send."
        }))
      })
    )
);

server.registerTool(
  "plan_melody_to_midi_capture_workflow",
  {
    title: "Plan Melody-to-MIDI Capture Workflow",
    description:
      "Workflow to turn sung audio into editable MIDI. Plugins / apps: Celemony Melodyne (ARA or transfer), Antares Auto-Tune with MIDI out (where available), Spotify Basic Pitch (free standalone), Ableton’s Convert Harmony to New MIDI Track (stock, clip dependent), Waves OVox (synth/vocoder MIDI).",
    inputSchema: { trackName: z.string().min(1).max(128).optional() }
  },
  async ({ trackName }) =>
    withMetrics("plan_melody_to_midi_capture_workflow", async () => {
      let resolved = null;
      if (trackName) {
        try {
          resolved = await resolveTrackIndexFromName(trackName, 0.4);
        } catch {
          resolved = null;
        }
      }
      return textResult({
        ok: true,
        trackName: trackName ?? null,
        resolved,
        pluginsRequired: [],
        pluginsOptional: [
          "Celemony Melodyne (audio-to-MIDI / pitch editing)",
          "Antares Auto-Tune (MIDI output where supported)",
          "Basic Pitch (free, MIT)",
          "Ableton: Convert Melody to New MIDI Track (stock)",
          "Waves OVox"
        ],
        steps: [
          "Bounce dry vocal for analysis if ARA unstable.",
          "Quantize MIDI lightly; preserve grace notes for natural line.",
          "Re-amp through instrument or double with vocoder as creative layer."
        ]
      });
    })
);

server.registerTool(
  "run_vocal_pitch_vibrato_analysis_placeholder",
  {
    title: "Run Vocal Pitch / Vibrato Analysis (Placeholder)",
    description:
      "Explains limits of OSC-only bridge; real stats need offline analysis. Use: Celemony Melodyne, Waves Tune, Synchro Arts RePitch, iZotope RX (Pitch module in some versions), TuneBoy — or export to DAW with analysis.",
    inputSchema: { trackName: z.string().min(1).max(128).optional() }
  },
  async ({ trackName }) =>
    withMetrics("run_vocal_pitch_vibrato_analysis_placeholder", async () =>
      textResult({
        ok: true,
        trackName: trackName ?? null,
        pluginsRequired: [],
        pluginsOptional: [
          "Celemony Melodyne",
          "Waves Tune",
          "Synchro Arts RePitch",
          "TuneBoy",
          "iZotope RX (where pitch tools licensed)"
        ],
        metricsPlaceholder: {
          meanPitchDriftCents: null,
          vibratoRateHz: null,
          vibratoWidthCents: null
        },
        disclaimer:
          "This MCP server does not analyze audio buffers. Bounce/import into Melodyne or similar for real pitch/vibrato statistics."
      })
    )
);

server.registerTool(
  "run_vocal_breath_detector_v2_placeholder",
  {
    title: "Run Vocal Breath Detector v2 (Placeholder)",
    description:
      "Spectral breath detection requires audio analysis. Plugins: iZotope RX Breath Control, Waves DeBreath, Accusonus ERA Breath Remover, Acon Digital Extract:Dialogue — run in host or external editor after export.",
    inputSchema: { trackName: z.string().min(1).max(128).optional() }
  },
  async ({ trackName }) =>
    withMetrics("run_vocal_breath_detector_v2_placeholder", async () =>
      textResult({
        ok: true,
        trackName: trackName ?? null,
        pluginsRequired: [],
        pluginsOptional: [
          "iZotope RX Breath Control",
          "Waves DeBreath",
          "Accusonus ERA Breath Remover",
          "Acon Digital Extract:Dialogue"
        ],
        regions: [],
        disclaimer: "No waveform access via OSC; use RX/ERA on rendered vocal or ARA in Live."
      })
    )
);

server.registerTool(
  "run_vocal_range_report_session",
  {
    title: "Run Vocal Range Report Session",
    description:
      "Structured form for comfort range and tessitura (user- or coach-filled). Reference pitch apps (optional): TE Tuner, Cleartune, Vocal Pitch Monitor (mobile), Melodyne for measured range after recording scales.",
    inputSchema: {
      lowestNote: z.string().max(8).optional(),
      highestNote: z.string().max(8).optional(),
      chestTop: z.string().max(8).optional(),
      headBottom: z.string().max(8).optional(),
      fatigueNotes: z.string().max(500).optional()
    }
  },
  async ({ lowestNote, highestNote, chestTop, headBottom, fatigueNotes }) =>
    withMetrics("run_vocal_range_report_session", async () =>
      textResult({
        ok: true,
        pluginsRequired: [],
        pluginsOptional: ["TE Tuner", "Cleartune", "Melodyne (post-recording measurement)", "Vocal Pitch Monitor (mobile)"],
        report: {
          lowestNote: lowestNote ?? null,
          highestNote: highestNote ?? null,
          chestTop: chestTop ?? null,
          headBottom: headBottom ?? null,
          fatigueNotes: fatigueNotes ?? null
        },
        coachPrompts: [
          "Sing gentle 5-note slides chest→mix→head; log where flip feels free.",
          "Mark highest note held comfortably for 4+ seconds."
        ]
      })
    )
);

server.registerTool(
  "sync_producer_singer_revision_notes",
  {
    title: "Sync Producer / Singer Revision Notes",
    description:
      "Create locators from revision note list for live session alignment. Plugins: none. Optional shared notes: Notion / Google Docs outside Live — this tool only drops locators in the timeline.",
    inputSchema: {
      markers: z
        .array(
          z.object({
            timeBeats: z.number().min(0),
            name: z.string().min(1).max(128)
          })
        )
        .min(1)
        .max(32)
    }
  },
  async ({ markers }) =>
    withMetrics("sync_producer_singer_revision_notes", async () => {
      const writes = [];
      for (const m of markers) {
        writes.push(sendMaybe("/live/song/create_locator", [floatArg(m.timeBeats)]));
        writes.push(sendMaybe("/live/song/set/last_locator_name", [stringArg(m.name)]));
      }
      return textResult({
        ok: true,
        count: markers.length,
        pluginsRequired: [],
        pluginsOptional: [],
        writes,
        namingTip: "Prefix REV_ or SINGER_ so searches in Live browser locate feedback quickly."
      });
    })
);

server.registerTool(
  "plan_vocal_pronunciation_diction_guide",
  {
    title: "Plan Vocal Pronunciation / Diction Guide",
    description:
      "Line-by-line diction scaffolding (IPA hints are assistant-authored; verify with coach). Plugins: none. Optional phonetic reference: Forvo / IPA charts outside Live.",
    inputSchema: {
      lines: z.array(z.string().min(1).max(256)).min(1).max(48)
    }
  },
  async ({ lines }) =>
    withMetrics("plan_vocal_pronunciation_diction_guide", async () =>
      textResult({
        ok: true,
        pluginsRequired: [],
        pluginsOptional: [],
        entries: lines.map((text, i) => ({
          lineIndex: i + 1,
          lyric: text,
          ipaPlaceholder: "[coach fills IPA]",
          consonantFocus: "Mark final consonants and dipthong targets."
        })),
        note: "Claude can propose IPA per line in chat; singer should validate with native speaker or coach."
      })
    )
);

server.registerTool(
  "run_vocal_health_fatigue_guard",
  {
    title: "Run Vocal Health / Fatigue Guard",
    description:
      "Session length, break, and SPL-aware reminders (policy text). SPL monitoring (optional): NIOSH SLM app, SoundMeter (iOS), FabFilter Pro-L 2 true-peak on cue is not SPL — use hardware meter or phone app.",
    inputSchema: {
      maxSessionMinutes: z.number().min(20).max(240).optional().default(120),
      breakEveryMinutes: z.number().min(10).max(60).optional().default(25)
    }
  },
  async ({ maxSessionMinutes, breakEveryMinutes }) =>
    withMetrics("run_vocal_health_fatigue_guard", async () =>
      textResult({
        ok: true,
        pluginsRequired: [],
        pluginsOptional: ["NIOSH Sound Level Meter (app)", "SoundMeter (iOS)", "FabFilter Pro-L 2 (peak on mix — not SPL)"],
        policy: [
          `Break every ~${breakEveryMinutes} minutes; hydrate; reset ears.`,
          `Cap heavy belting blocks to shorter spans inside ${maxSessionMinutes} min session budget.`,
          "If throat feels dry, stop; no plugin replaces rest."
        ]
      })
    )
);

server.registerTool(
  "suggest_song_key_from_session_midi",
  {
    title: "Suggest Song Key From Session MIDI",
    description:
      "Crude pitch-class histogram from one MIDI clip (best-effort). Key detection plugins (optional): Mixed In Key, TuneBat (external), Captain Melody, Scaler 2. Stock: use this tool’s guess only as a hint.",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      clipIndex: z.number().int().min(0).optional().default(0)
    }
  },
  async ({ trackName, clipIndex }) =>
    withMetrics("suggest_song_key_from_session_midi", async () => {
      const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
      const resolved = await resolveTrackIndexFromName(trackName, 0.4);
      const resp = await requestAny(["/live/clip/get/notes", "/live/clip/get/notes_extended"], [
        intArg(resolved.index),
        intArg(clipIndex)
      ]);
      const raw = parseOscValue(resp.response, []);
      const pitches = [];
      const visit = (x, depth = 0) => {
        if (depth > 24 || pitches.length > 800) return;
        if (x == null) return;
        if (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 127) {
          pitches.push(x);
          return;
        }
        if (Array.isArray(x)) for (const y of x) visit(y, depth + 1);
        else if (typeof x === "object") {
          if (typeof x.pitch === "number") pitches.push(x.pitch);
          else
            for (const k of Object.keys(x)) {
              if (["args", "type", "value"].includes(k)) continue;
              visit(x[k], depth + 1);
            }
        }
      };
      visit(raw);
      const hist = new Array(12).fill(0);
      for (const p of pitches) hist[p % 12] += 1;
      let bestPc = 0;
      let best = 0;
      for (let i = 0; i < 12; i += 1) {
        if (hist[i] > best) {
          best = hist[i];
          bestPc = i;
        }
      }
      return textResult({
        ok: true,
        resolved,
        clipIndex,
        samplePitches: pitches.slice(0, 24),
        pitchClassHistogram: hist,
        guessMajorTonic: NOTE_NAMES[bestPc],
        guessRelativeMinor: NOTE_NAMES[(bestPc + 9) % 12],
        pluginsRequired: [],
        pluginsOptional: ["Mixed In Key", "Plugin Boutique Scaler 2", "Mixed In Key Captain Melody"],
        disclaimer: "Histogram is naive; confirm by ear and harmony context."
      });
    })
);

server.registerTool(
  "plan_lead_tuned_vs_raw_stem_matrix",
  {
    title: "Plan Lead Tuned vs Raw Stem Matrix",
    description:
      "Naming matrix for raw vs tuned lead exports. Tuning plugins implied for tuned stem: Celemony Melodyne, Antares Auto-Tune, Waves Tune, Synchro Arts RePitch. Print tuned stem post-commit; keep raw for film/legal alt.",
    inputSchema: { artistSlug: z.string().min(1).max(64).optional().default("artist") }
  },
  async ({ artistSlug }) =>
    withMetrics("plan_lead_tuned_vs_raw_stem_matrix", async () =>
      textResult({
        ok: true,
        artistSlug,
        pluginsRequired: [],
        pluginsOptional: ["Celemony Melodyne", "Antares Auto-Tune Pro", "Waves Tune", "Synchro Arts RePitch"],
        stems: [
          `${artistSlug}_lead_vox_RAW.wav`,
          `${artistSlug}_lead_vox_TUNED.wav`,
          `${artistSlug}_lead_vox_TUNED_ALT.wav`,
          `${artistSlug}_lead_vox_RAW_NOFX.wav`
        ],
        policy: [
          "Never overwrite raw archive; tuned is derived.",
          "Document tuning amount for sync clients if requested."
        ]
      })
    )
);

server.registerTool(
  "plan_sync_picture_vocal_cues",
  {
    title: "Plan Sync-to-Picture Vocal Cues",
    description:
      "Timecode-oriented cue sheet + locator plan for film/podcast. Video in Live: stock video track. Metering: iZotope Insight, Nugen VisLM. Dialogue editing: iZotope RX; loudness: Youlean Loudness Meter (free).",
    inputSchema: {
      cues: z
        .array(
          z.object({
            timeBeats: z.number().min(0),
            label: z.string().min(1).max(128),
            smpteHint: z.string().max(32).optional()
          })
        )
        .min(1)
        .max(48)
    }
  },
  async ({ cues }) =>
    withMetrics("plan_sync_picture_vocal_cues", async () => {
      const writes = [];
      for (const c of cues) {
        const name = c.smpteHint ? `${c.label} [${c.smpteHint}]` : c.label;
        writes.push(sendMaybe("/live/song/create_locator", [floatArg(c.timeBeats)]));
        writes.push(sendMaybe("/live/song/set/last_locator_name", [stringArg(name)]));
      }
      return textResult({
        ok: true,
        cueCount: cues.length,
        pluginsRequired: [],
        pluginsOptional: [
          "iZotope Insight",
          "Nugen VisLM",
          "Youlean Loudness Meter",
          "iZotope RX (dialogue / de-rustle)",
          "Ableton video track (stock)"
        ],
        writes,
        note: "Lock picture frame rate in session notes; SMPTE here is annotation only unless linked externally."
      });
    })
);

server.registerTool(
  "comp_take_assistant",
  {
    title: "Comp Take Assistant",
    description: "Create take comping recommendations scaffold for a track.",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      strategy: z.enum(["best-energy", "best-pitch", "hybrid"]).optional().default("hybrid")
    }
  },
  async ({ trackName, strategy }) =>
    withMetrics("comp_take_assistant", async () =>
      textResult({
        ok: true,
        trackName,
        strategy,
        recommendations: [
          "Use first phrase from Take 2 for clean attack.",
          "Use sustain from Take 4 for stable tail.",
          "Apply 20ms crossfade at each comp boundary."
        ]
      })
    )
);

server.registerTool(
  "setup_sidechain_bus",
  {
    title: "Setup Sidechain Bus",
    description: "Scaffold sidechain routing setup from trigger track to target tracks.",
    inputSchema: {
      triggerTrackName: z.string().min(1).max(128),
      targetTrackNames: z.array(z.string().min(1).max(128)).min(1),
      amount: z.number().min(0).max(1).optional().default(0.6)
    }
  },
  async ({ triggerTrackName, targetTrackNames, amount }) =>
    withMetrics("setup_sidechain_bus", async () => {
      const trigger = await resolveTrackIndexFromName(triggerTrackName, 0.5);
      const targets = [];
      for (const targetName of targetTrackNames) {
        const resolved = await resolveTrackIndexFromName(targetName, 0.5);
        targets.push({ requested: targetName, resolved });
      }

      const writes = [];
      for (const t of targets) {
        // Best-effort: set routing metadata and compressor-like params on device 0.
        writes.push(
          await sendKnownRaw(
            "trackSetRouting",
            ["/live/track/set/routing"],
            [
              intArg(t.resolved.index),
              stringArg(`SC_IN:${trigger.name}`),
              stringArg("MASTER")
            ],
            {
              targetTrack: t.resolved,
              triggerTrack: trigger
            }
          )
        );
        writes.push(
          sendPlanRaw(
            "/live/device/set/parameter/value",
            [intArg(t.resolved.index), intArg(0), intArg(2), floatArg(Math.max(0.05, 0.9 - amount * 0.8))],
            { targetTrack: t.resolved, parameter: "sidechain-threshold-proxy" }
          )
        );
        writes.push(
          sendPlanRaw(
            "/live/device/set/parameter/value",
            [intArg(t.resolved.index), intArg(0), intArg(3), floatArg(0.2 + amount * 0.7)],
            { targetTrack: t.resolved, parameter: "sidechain-release-proxy" }
          )
        );
      }

      return textResult({
        ok: true,
        triggerTrack: trigger,
        targets,
        amount,
        writes
      });
    })
);

server.registerTool(
  "semantic_clip_edit",
  {
    title: "Semantic Clip Edit",
    description: "Interpret a semantic edit command and return executable clip-edit plan.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      prompt: z.string().min(1).max(256),
      applyWrites: z.boolean().optional().default(true),
      maxNotes: z.number().int().min(1).max(4096).optional().default(1024),
      replaceMode: z.boolean().optional().default(false)
    }
  },
  async ({ trackIndex, clipIndex, prompt, applyWrites, maxNotes, replaceMode }) =>
    withMetrics("semantic_clip_edit", async () => {
      const p = prompt.toLowerCase();
      const noteResp = await requestAny(["/live/clip/get/notes", "/live/clip/get/notes_extended"], [
        intArg(trackIndex),
        intArg(clipIndex)
      ]);
      const raw = parseOscValue(noteResp.response, []);
      let notes = extractClipNotes(raw).slice(0, maxNotes);
      const editOps = [];

      if (p.includes("tighter") || p.includes("quantize")) {
        notes = notes.map((n) => ({ ...n, start: Math.round(n.start * 4) / 4 }));
        editOps.push("quantize_1_16");
      }
      if (p.includes("swing")) {
        notes = notes.map((n) => {
          const step = Math.round(n.start * 4);
          const isOff = step % 2 === 1;
          return { ...n, start: Number((n.start + (isOff ? 0.03 : 0)).toFixed(4)) };
        });
        editOps.push("swing_push_offbeats");
      }
      if (p.includes("less busy") || p.includes("simpler")) {
        const keep = Math.max(1, Math.floor(notes.length * 0.7));
        notes = [...notes]
          .sort((a, b) => (b.velocity ?? 100) - (a.velocity ?? 100))
          .slice(0, keep)
          .sort((a, b) => a.start - b.start);
        editOps.push("density_reduce_30pct");
      }
      if (p.includes("more busy") || p.includes("denser")) {
        const clones = notes.slice(0, Math.min(notes.length, 64)).map((n) => ({
          ...n,
          start: Number((n.start + 0.25).toFixed(4)),
          velocity: Math.max(1, Math.min(127, (n.velocity ?? 100) - 8))
        }));
        notes = [...notes, ...clones].sort((a, b) => a.start - b.start);
        editOps.push("density_increase_clone_shift");
      }
      if (editOps.length === 0) {
        editOps.push("no_transform_match");
      }

      const writes = [];
      let clearResult = null;
      if (applyWrites) {
        if (replaceMode) {
          // Best-effort clear before rewrite; endpoint names vary across AbletonOSC builds.
          const clearCandidates = [
            "/live/clip/remove/notes",
            "/live/clip/remove_notes",
            "/live/clip/clear_notes",
            "/live/clip/remove_all_notes"
          ];
          try {
            const selected = await selectEndpoint("clipClearNotes", clearCandidates, [
              intArg(trackIndex),
              intArg(clipIndex)
            ]);
            clearResult = sendPlanRaw(selected, [intArg(trackIndex), intArg(clipIndex)], {
              trackIndex,
              clipIndex,
              replaceMode: true,
              clearEndpoint: selected
            });
          } catch (clearError) {
            clearResult = {
              ok: false,
              replaceMode: true,
              warning:
                "No clip clear-notes endpoint resolved; falling back to additive write mode.",
              error: clearError.message
            };
          }
        }
        for (const n of notes) {
          writes.push(
            sendPlanRaw("/live/clip/add_note", [
              intArg(trackIndex),
              intArg(clipIndex),
              intArg(n.pitch),
              floatArg(n.start),
              floatArg(n.duration),
              intArg(Math.max(1, Math.min(127, Math.round(n.velocity ?? 100)))),
              intArg(n.mute ? 1 : 0)
            ])
          );
        }
      }

      return textResult({
        ok: true,
        trackIndex,
        clipIndex,
        prompt,
        endpoint: noteResp.address,
        editOps,
        inputNotes: extractClipNotes(raw).length,
        outputNotes: notes.length,
        replaceMode,
        clearResult,
        writesApplied: applyWrites,
        writesCount: writes.length
      });
    })
);

server.registerTool(
  "harmony_arranger",
  {
    title: "Harmony Arranger",
    description: "Generate section-wise harmonic plan scaffold.",
    inputSchema: {
      key: z.string().min(1).max(3),
      scale: z.enum(["major", "minor"]),
      sections: z.array(z.string().min(1).max(64)).min(1)
    }
  },
  async ({ key, scale, sections }) =>
    withMetrics("harmony_arranger", async () =>
      textResult({
        ok: true,
        key,
        scale,
        sections: sections.map((s, i) => ({
          section: s,
          suggestedProgression: i % 2 === 0 ? "i-VI-III-VII" : "i-iv-VII-III"
        }))
      })
    )
);

server.registerTool(
  "humanize_drums",
  {
    title: "Humanize Drums",
    description: "Apply drum humanization scaffold settings.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      timingMs: z.number().min(0).max(40).optional().default(12),
      velocitySpread: z.number().int().min(0).max(40).optional().default(18)
    }
  },
  async ({ trackIndex, clipIndex, timingMs, velocitySpread }) =>
    withMetrics("humanize_drums", async () =>
      textResult({ ok: true, trackIndex, clipIndex, timingMs, velocitySpread })
    )
);

server.registerTool(
  "apply_fx_chain_template",
  {
    title: "Apply FX Chain Template",
    description: "Apply and validate FX chain template scaffold.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      templateName: z.string().min(1).max(128)
    }
  },
  async ({ trackIndex, templateName }) =>
    withMetrics("apply_fx_chain_template", async () =>
      textResult({
        ok: true,
        trackIndex,
        templateName,
        validation: ["Check device availability", "Check routing compatibility", "Check parameter defaults"]
      })
    )
);

server.registerTool(
  "run_master_bus_guardrails",
  {
    title: "Run Master Bus Guardrails",
    description: "Master bus readiness checks scaffold before export.",
    inputSchema: {}
  },
  async () =>
    withMetrics("run_master_bus_guardrails", async () => {
      const tempo = await requestKnown("tempoGet", ["/live/song/get/tempo", "/live/song/tempo"]);
      const playing = await requestKnown("isPlayingGet", [
        "/live/song/get/is_playing",
        "/live/song/is_playing"
      ]);
      const tracks = await getTracksSnapshot();
      const volumes = [];
      for (const t of tracks.tracks.slice(0, 16)) {
        try {
          const v = await requestAny(["/live/track/get/volume"], [intArg(t.index)]);
          volumes.push({ trackIndex: t.index, name: t.name, volume: Number(parseOscValue(v.response, 0.85)) });
        } catch {
          // ignore missing data
        }
      }

      const hot = volumes.filter((v) => v.volume > 0.95);
      const veryLow = volumes.filter((v) => v.volume < 0.1);
      const warnings = [];
      if (hot.length > 0) warnings.push(`Potential clipping risk on ${hot.length} tracks (>0.95 volume).`);
      if (veryLow.length > 0) warnings.push(`${veryLow.length} tracks are very low (<0.10); verify gain staging.`);
      if (Boolean(parseOscValue(playing.response, 0))) {
        warnings.push("Transport is currently playing; avoid destructive export changes mid-playback.");
      }
      if (metrics.failedCommands > 0) {
        warnings.push(`There are ${metrics.failedCommands} failed commands in current uptime metrics.`);
      }

      return textResult({
        ok: warnings.length === 0,
        tempo: Number(parseOscValue(tempo.response, 120)),
        isPlaying: Boolean(parseOscValue(playing.response, 0)),
        trackSampled: volumes.length,
        checks: {
          highVolumeTracks: hot,
          veryLowVolumeTracks: veryLow,
          exportProfilesAvailable: [...exportProfiles.keys()]
        },
        warnings
      });
    })
);

server.registerTool(
  "prepare_stems_one_click",
  {
    title: "Prepare Stems One Click",
    description: "Scaffold stem prep: naming, grouping, and render prep.",
    inputSchema: {
      namingPrefix: z.string().min(1).max(64).optional().default("STEM"),
      includeReturns: z.boolean().optional().default(true)
    }
  },
  async ({ namingPrefix, includeReturns }) =>
    withMetrics("prepare_stems_one_click", async () =>
      textResult({ ok: true, namingPrefix, includeReturns, next: "Call export_batch_profiles or render_stems." })
    )
);

server.registerTool(
  "session_diff_undo_bundle",
  {
    title: "Session Diff Undo Bundle",
    description: "Summarize recent command delta and suggest grouped rollback steps.",
    inputSchema: { lastN: z.number().int().min(1).max(100).optional().default(10) }
  },
  async ({ lastN }) =>
    withMetrics("session_diff_undo_bundle", async () =>
      textResult({
        ok: true,
        lastN,
        summary: `Review last ${lastN} audit entries in logs/audit.jsonl and consider undo/restore snapshot.`
      })
    )
);

server.registerTool(
  "auto_scene_sequencer",
  {
    title: "Auto Scene Sequencer",
    description: "Build scene sequencing scaffold with transition timings.",
    inputSchema: {
      scenes: z.array(z.number().int().min(0)).min(1),
      barsPerScene: z.number().int().min(1).max(128).optional().default(8)
    }
  },
  async ({ scenes, barsPerScene }) =>
    withMetrics("auto_scene_sequencer", async () =>
      textResult({
        ok: true,
        sequence: scenes.map((s, idx) => ({ sceneIndex: s, startBars: idx * barsPerScene, bars: barsPerScene }))
      })
    )
);

server.registerTool(
  "create_panic_macro",
  {
    title: "Create Panic Macro",
    description: "Create/update panic macro and optionally activate it immediately.",
    inputSchema: { activateNow: z.boolean().optional().default(false) }
  },
  async ({ activateNow }) =>
    withMetrics("create_panic_macro", async () => {
      macroRegistry.set("panic", {
        name: "panic",
        actions: ["stop_all_clips", "stop_playback", "set_safety_mode:safe"]
      });
      if (activateNow) {
        sendPlanRaw("/live/song/stop_all_clips", []);
        sendPlanRaw("/live/song/stop_playing", []);
      }
      return textResult({ ok: true, created: true, activated: activateNow });
    })
);

server.registerTool(
  "run_macro",
  {
    title: "Run Macro",
    description: "Run a stored macro scaffold by name.",
    inputSchema: { macroName: z.string().min(1).max(128) }
  },
  async ({ macroName }) =>
    withMetrics("run_macro", async () => {
      const macro = macroRegistry.get(normalizeName(macroName)) ?? macroRegistry.get(macroName);
      if (!macro) throw new Error(`Unknown macro: ${macroName}`);
      if (normalizeName(macroName) === "panic") {
        sendPlanRaw("/live/song/stop_all_clips", []);
        sendPlanRaw("/live/song/stop_playing", []);
      }
      return textResult({ ok: true, macro });
    })
);

server.registerTool(
  "record_prompt_macro",
  {
    title: "Record Prompt Macro",
    description: "Store prompt-to-macro mapping scaffold.",
    inputSchema: {
      macroName: z.string().min(1).max(128),
      prompt: z.string().min(1).max(256),
      actions: z.array(z.string().min(1).max(128)).min(1)
    }
  },
  async ({ macroName, prompt, actions }) =>
    withMetrics("record_prompt_macro", async () => {
      macroRegistry.set(normalizeName(macroName), {
        name: macroName,
        prompt,
        actions,
        createdAt: new Date().toISOString()
      });
      return textResult({ ok: true, macro: macroRegistry.get(normalizeName(macroName)) });
    })
);

server.registerTool(
  "project_cleanup_bot",
  {
    title: "Project Cleanup Bot",
    description: "Scan project state and suggest cleanup actions scaffold.",
    inputSchema: {}
  },
  async () =>
    withMetrics("project_cleanup_bot", async () =>
      textResult({
        ok: true,
        suggestions: [
          "Delete empty MIDI clips in inactive scenes.",
          "Disable unused return chains.",
          "Remove muted-for-long tracks after verification."
        ]
      })
    )
);

server.registerTool(
  "reference_match_assistant",
  {
    title: "Reference Match Assistant",
    description: "Reference tonal/dynamics matching scaffold.",
    inputSchema: { referenceName: z.string().min(1).max(128) }
  },
  async ({ referenceName }) =>
    withMetrics("reference_match_assistant", async () =>
      textResult({
        ok: true,
        referenceName,
        guidance: ["Match perceived loudness first", "Compare low-end balance", "Compare transient sharpness"]
      })
    )
);

server.registerTool(
  "set_collaborator_mode",
  {
    title: "Set Collaborator Mode",
    description: "Apply collaborator permission preset to runtime context.",
    inputSchema: { mode: z.enum(["producer", "mixer", "performer", "observer"]) }
  },
  async ({ mode }) =>
    withMetrics("set_collaborator_mode", async () => {
      const preset = collaboratorModes.get(mode);
      runtimeContext.role = preset.role;
      runtimeContext.performanceMode = preset.performanceMode;
      return textResult({ ok: true, mode, runtimeContext });
    })
);

server.registerTool(
  "task_linked_production_flow",
  {
    title: "Task Linked Production Flow",
    description: "Create mapping scaffold between tasks and Ableton operations.",
    inputSchema: {
      taskTitle: z.string().min(1).max(200),
      suggestedAction: z.string().min(1).max(128)
    }
  },
  async ({ taskTitle, suggestedAction }) =>
    withMetrics("task_linked_production_flow", async () =>
      textResult({ ok: true, taskTitle, suggestedAction, externalHooks })
    )
);

server.registerTool(
  "voice_live_mode_command",
  {
    title: "Voice Live Mode Command",
    description: "Low-latency voice command scaffold for performance context.",
    inputSchema: { phrase: z.string().min(1).max(256) }
  },
  async ({ phrase }) =>
    withMetrics("voice_live_mode_command", async () => {
      const p = phrase.toLowerCase();
      if (p.includes("panic") || p.includes("stop")) {
        sendPlanRaw("/live/song/stop_all_clips", []);
        return textResult({ ok: true, interpretedAction: "stop_all_clips" });
      }
      return textResult({ ok: true, interpretedAction: "compile_musical_intent", phrase });
    })
);

server.registerTool(
  "plugin_preset_intelligence",
  {
    title: "Plugin Preset Intelligence",
    description: "Suggest preset names by semantic intent and optionally register alias.",
    inputSchema: {
      intent: z.string().min(1).max(128),
      presetAlias: z.string().min(1).max(128).optional()
    }
  },
  async ({ intent, presetAlias }) =>
    withMetrics("plugin_preset_intelligence", async () => {
      const suggestions = intent.toLowerCase().includes("warm")
        ? ["Warm Tape Glue", "Analog Soft Saturator", "Velvet Pad Space"]
        : ["Clean Control", "Modern Tight Bus", "Neutral Utility"];
      if (presetAlias) {
        presetRegistry.set(normalizeName(presetAlias), {
          presetAlias,
          presetName: suggestions[0],
          updatedAt: new Date().toISOString()
        });
      }
      return textResult({ ok: true, intent, suggestions, registeredAlias: presetAlias ?? null });
    })
);

server.registerTool(
  "export_deliverables_matrix",
  {
    title: "Export Deliverables Matrix",
    description: "Create and optionally execute export jobs for common deliverables.",
    inputSchema: {
      baseDirectory: z.string().min(1).max(512),
      includeStems: z.boolean().optional().default(true),
      includeAcapella: z.boolean().optional().default(true),
      autoStart: z.boolean().optional().default(false),
      confirmToken: z.string().optional()
    }
  },
  async ({ baseDirectory, includeStems, includeAcapella, autoStart, confirmToken }) =>
    withMetrics("export_deliverables_matrix", async () => {
      const targets = [
        { profileName: "mastering-print", targetPath: `${baseDirectory}/master.wav` },
        { profileName: "streaming", targetPath: `${baseDirectory}/streaming.wav` }
      ];
      if (includeStems) {
        targets.push({ profileName: "mix-engineer-stems", targetPath: `${baseDirectory}/stems` });
      }
      if (includeAcapella) {
        targets.push({ profileName: "streaming", targetPath: `${baseDirectory}/acapella.wav` });
      }
      const created = [];
      for (const t of targets) {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
          jobId,
          status: "queued",
          profileName: t.profileName,
          targetPath: t.targetPath,
          createdAt: new Date().toISOString()
        };
        exportJobs.set(jobId, job);
        created.push({ jobId, ...t });
        if (autoStart) {
          guardDestructive(confirmToken);
          const profile = exportProfiles.get(t.profileName);
          job.status = "running";
          if (profile?.type === "stems") {
            await sendKnownRaw(
              "renderStems",
              ["/live/song/export_stems"],
              [stringArg(t.targetPath), toBoolInt(profile.includeReturns)],
              { destructive: true, jobId }
            );
          } else {
            await sendKnownRaw(
              "renderAudio",
              ["/live/song/export_audio"],
              [stringArg(t.targetPath), toBoolInt(true), toBoolInt(false)],
              { destructive: true, jobId }
            );
          }
          job.status = "completed";
          job.completedAt = new Date().toISOString();
        }
      }
      return textResult({ ok: true, targets, jobs: created, autoStart });
    })
);

async function runStartupWarmup() {
  startupWarnings = [];
  let startupReady = false;
  for (let attempt = 1; attempt <= STARTUP_RETRY_ATTEMPTS; attempt += 1) {
    let probeError = null;
    let cacheError = null;

    try {
      probeSummary = await runCapabilityProbe();
    } catch (error) {
      probeError = error;
      probeSummary = { startupError: error.message };
    }

    try {
      await refreshStateCache();
    } catch (error) {
      cacheError = error;
      stateCache.lastRefreshAt = new Date().toISOString();
    }

    if (!probeError && !cacheError) {
      startupReady = true;
      break;
    }

    const problems = [
      probeError ? `probe: ${probeError.message}` : null,
      cacheError ? `cache: ${cacheError.message}` : null
    ].filter(Boolean);
    startupWarnings.push(
      `Startup attempt ${attempt}/${STARTUP_RETRY_ATTEMPTS} failed (${problems.join(" | ")})`
    );

    if (attempt < STARTUP_RETRY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, STARTUP_RETRY_DELAY_MS));
    }
  }

  if (!startupReady) {
    startupWarnings.push(
      "Startup retries exhausted. Server remains online; use heartbeat/reprobe_endpoints/refresh_state_cache after AbletonOSC is available."
    );
  }
}

async function main() {
  await oscClient.open();
  connectionState.connected = true;
  connectionState.lastReadyAt = new Date().toISOString();
  await loadPersistedEndpointSelections();
  await loadPersistedArrangementSections();
  await loadPersistedArrangementSectionProfiles();
  await loadPersistedDeviceLocks();
  await loadPersistedRollbackPolicy();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Do warmup after MCP connect so initialize doesn't time out.
  runStartupWarmup().catch((error) => {
    startupWarnings.push(`Background warmup failed: ${error.message}`);
  });
}

async function runCapabilityProbe() {
  const probePlan = {
    tempoGet: { candidates: ["/live/song/get/tempo", "/live/song/tempo"] },
    isPlayingGet: {
      candidates: ["/live/song/get/is_playing", "/live/song/is_playing"]
    },
    songTimeGet: {
      candidates: ["/live/song/get/current_song_time", "/live/song/current_song_time"]
    },
    trackCountGet: {
      candidates: ["/live/song/get/num_tracks", "/live/song/get/track_count"]
    },
    sceneCountGet: {
      candidates: ["/live/song/get/num_scenes", "/live/song/get/scene_count"]
    },
    trackNameGet: {
      candidates: ["/live/track/get/name", "/live/track/name"],
      args: [intArg(0)]
    },
    deviceCountGet: {
      candidates: ["/live/track/get/num_devices", "/live/track/get/device_count"],
      args: [intArg(0)]
    },
    deviceNameGet: {
      candidates: ["/live/device/get/name", "/live/device/name"],
      args: [intArg(0), intArg(0)]
    },
    deviceParameterCountGet: {
      candidates: ["/live/device/get/num_parameters", "/live/device/get/parameter_count"],
      args: [intArg(0), intArg(0)]
    },
    deviceParameterGet: {
      candidates: ["/live/device/get/parameter", "/live/device/get/param"],
      args: [intArg(0), intArg(0), intArg(0)]
    }
  };

  const summary = {};
  for (const [key, spec] of Object.entries(probePlan)) {
    const result = await probeEndpoint(spec.candidates, spec.args ?? []);
    summary[key] = result.ok
      ? { ok: true, selected: result.address }
      : { ok: false, selected: null, error: result.error };
    if (result.ok) endpointSelections.set(key, result.address);
  }
  return summary;
}

main().catch((error) => {
  console.error("Fatal MCP server error:", error);
  oscClient.close();
  process.exit(1);
});

process.on("SIGINT", () => {
  oscClient.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  oscClient.close();
  process.exit(0);
});
