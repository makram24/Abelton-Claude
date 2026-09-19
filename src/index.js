import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AbletonOscClient, floatArg, intArg, stringArg } from "./abletonOsc.js";
import { getConfig } from "./config.js";
import { textResult } from "./lib/mcpResult.js";
import { normalizeName, scoreNameMatch } from "./lib/names.js";
import { parseOscValue } from "./lib/oscParse.js";
import { classifyError } from "./lib/errors.js";
import { isScaffoldTool } from "./toolTiers.js";

const config = getConfig();
const oscClient = new AbletonOscClient({
  host: config.ABLETON_OSC_HOST,
  sendPort: config.ABLETON_OSC_SEND_PORT,
  listenPort: config.ABLETON_OSC_LISTEN_PORT,
  timeoutMs: config.ABLETON_OSC_TIMEOUT_MS
});

const server = new McpServer({
  name: "ableton-osc-bridge",
  version: "0.2.0"
});

/** Registers core tools always; scaffolds only when ABLETON_ENABLE_SCAFFOLD_TOOLS=true. */
function registerMcpTool(name, def, handler) {
  if (isScaffoldTool(name) && !config.ABLETON_ENABLE_SCAFFOLD_TOOLS) {
    return;
  }
  if (isScaffoldTool(name) && def && typeof def.description === "string") {
    if (!def.description.startsWith("[scaffold]")) {
      def = { ...def, description: `[scaffold] ${def.description}` };
    }
  }
  return server.registerTool(name, def, handler);
}

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
  role: config.ABLETON_DEFAULT_ROLE,
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

/** Live LOM current_monitoring_state: 0 = In, 1 = Auto, 2 = Off */
function monitoringModeToInt(mode) {
  const m = String(mode ?? "auto").toLowerCase();
  if (m === "in") return 0;
  if (m === "auto") return 1;
  if (m === "off") return 2;
  return 1;
}

/** AbletonOSC clip_slot APIs write Session View clips, not Arrangement timeline clips. */
function sessionClipPlacementHint(trackIndex, clipIndex) {
  return {
    abletonUi: {
      view: "session",
      summary:
        "Clip was written to the Session View matrix (vertical slots per track), not the horizontal Arrangement timeline.",
      howToSeeIt: [
        "Press Tab or click the Session View switch (two overlapping rectangles) so you see the clip grid.",
        `Look at track index ${trackIndex}, column / scene row for clip slot ${clipIndex} (top row is often slot 0).`
      ],
      clipIndexSemantics:
        "clipIndex is the Session slot (scene row) for that track — it is not bar 1, 2, 3 on the Arrangement ruler.",
      moveToArrangement:
        "Drag the clip from Session into the Arrangement, or arm the track and MIDI-record into the timeline.",
      drumRackSound:
        "If Drum Rack pads are empty (Drop a Sample Here), load drum samples or you will hear nothing even when MIDI exists.",
      monitoringForClipPlayback:
        "If Monitor is In, Live only passes external MIDI input — Session MIDI clips are effectively silent. Set Auto (LOM 1) via set_track_monitoring_mode or prepare_midi_track_for_clip_playback.",
      playbackChecklist: [
        "Monitor = Auto (not In) on the MIDI track",
        "Track not muted; Master up; Audio To = Main",
        "Device chain has an instrument with content (Drum Rack + samples on pads)"
      ]
    }
  };
}

function toBoolInt(value) {
  return intArg(value ? 1 : 0);
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "undo",
  {
    title: "Undo",
    description: "Undo the last operation in Ableton."
  },
  async () => withMetrics("undo", async () => sendMaybe("/live/song/undo"))
);

registerMcpTool(
  "redo",
  {
    title: "Redo",
    description: "Redo the previously undone operation in Ableton."
  },
  async () => withMetrics("redo", async () => sendMaybe("/live/song/redo"))
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

registerMcpTool(
  "execute_action_plan",
  {
    title: "Execute Action Plan",
    description:
      "Run inline whitelisted actions against AbletonOSC. Destructive steps require confirmToken. Optional rollback snapshot before destructive steps. Pass a non-empty actions array (each entry: action name + params matching dispatchPlanAction).",
    inputSchema: {
      actions: z
        .array(
          z.object({
            action: z.string().min(1).max(64),
            params: z.record(z.unknown()).default({})
          })
        )
        .min(1),
      confirmToken: z.string().optional(),
      stopOnError: z.boolean().optional().default(true),
      dryRun: z.boolean().optional().default(false),
      captureRollbackSnapshot: z.boolean().optional().default(false),
      rollbackSnapshotId: z.string().min(1).max(128).optional()
    }
  },
  async ({
    actions,
    confirmToken,
    stopOnError,
    dryRun,
    captureRollbackSnapshot,
    rollbackSnapshotId
  }) =>
    withMetrics("execute_action_plan", async () => {
      const report = await runActionPlanExecution({
        actions,
        confirmToken,
        stopOnError: stopOnError ?? true,
        captureRollbackSnapshot: captureRollbackSnapshot ?? false,
        rollbackSnapshotId,
        forceDryRun: dryRun ?? false
      });
      return textResult({ ok: true, ...report });
    })
);

registerMcpTool(
  "refresh_state_cache",
  {
    title: "Refresh State Cache",
    description: "Refresh transport + track cache used for conflict/policy checks."
  },
  async () => withMetrics("refresh_state_cache", async () => textResult(await refreshStateCache()))
);

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "start_playback",
  {
    title: "Start Playback",
    description: "Start Ableton transport playback."
  },
  async () => {
    return sendMaybe("/live/song/start_playing");
  }
);

registerMcpTool(
  "stop_playback",
  {
    title: "Stop Playback",
    description: "Stop Ableton transport playback."
  },
  async () => {
    return sendMaybe("/live/song/stop_playing");
  }
);

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "stop_all_clips",
  {
    title: "Stop All Clips",
    description: "Stop all clips globally for all tracks."
  },
  async () => sendMaybe("/live/song/stop_all_clips")
);

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "create_midi_clip",
  {
    title: "Create MIDI Clip",
    description:
      "Creates a MIDI clip in a Session View slot (clip_slot), not on the Arrangement timeline. Open Session View (Tab) to see it. clipIndex = vertical scene row for that track.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      lengthBeats: z.number().positive()
    }
  },
  async ({ trackIndex, clipIndex, lengthBeats }) =>
    withMetrics("create_midi_clip", async () =>
      textResult({
        oscSend: sendPlanRaw(
          "/live/clip_slot/create_clip",
          [intArg(trackIndex), intArg(clipIndex), floatArg(lengthBeats)],
          { trackIndex, clipIndex, lengthBeats }
        ),
        ...sessionClipPlacementHint(trackIndex, clipIndex)
      })
    )
);

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "set_track_monitoring_mode",
  {
    title: "Set Track Monitoring Mode",
    description:
      "Sets Live track monitoring (LOM: 0=In, 1=Auto, 2=Off). Use Auto (default) so MIDI clips play; In only passes external input. Requires AbletonOSC track monitoring endpoints.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      mode: z.enum(["in", "auto", "off"]).optional().default("auto")
    }
  },
  async ({ trackIndex, mode }) =>
    withMetrics("set_track_monitoring_mode", async () => {
      const state = monitoringModeToInt(mode);
      const write = sendMaybe("/live/track/set/current_monitoring_state", [
        intArg(trackIndex),
        intArg(state)
      ]);
      let previous = null;
      try {
        const prevResp = await requestAny(["/live/track/get/current_monitoring_state"], [intArg(trackIndex)]);
        previous = parseOscValue(prevResp.response, null);
      } catch {
        previous = null;
      }
      return textResult({
        ok: true,
        trackIndex,
        mode,
        stateSent: state,
        stateLabels: { 0: "in", 1: "auto", 2: "off" },
        previousMonitoringRaw: previous,
        osc: write,
        note: "If this OSC address is unsupported, upgrade AbletonOSC or set Monitor to Auto manually in the track I/O strip."
      });
    })
);

registerMcpTool(
  "prepare_midi_track_for_clip_playback",
  {
    title: "Prepare MIDI Track For Clip Playback",
    description:
      "Common fixes when a Session MIDI clip runs but is silent: set monitoring to Auto, optionally disarm, and report clip MIDI note count. Does not load devices or samples — add Drum Rack/instrument in Live if the chain is empty.",
    inputSchema: {
      trackIndex: z.number().int().min(0).optional(),
      trackName: z.string().min(1).max(128).optional(),
      clipIndex: z.number().int().min(0).optional().default(0),
      monitoringMode: z.enum(["in", "auto", "off"]).optional().default("auto"),
      disarmTrack: z.boolean().optional().default(true)
    }
  },
  async ({ trackIndex, trackName, clipIndex, monitoringMode, disarmTrack }) =>
    withMetrics("prepare_midi_track_for_clip_playback", async () => {
      let resolved;
      if (trackName) {
        resolved = await resolveTrackIndexFromName(trackName, 0.4);
      } else if (trackIndex !== undefined && trackIndex !== null) {
        const snap = await getTracksSnapshot();
        const row = snap.tracks.find((t) => t.index === trackIndex);
        resolved = { index: trackIndex, name: row?.name ?? `track_${trackIndex}` };
      } else {
        throw new Error("Provide trackIndex or trackName.");
      }
      const idx = resolved.index;
      const state = monitoringModeToInt(monitoringMode);
      const monitoringWrite = sendMaybe("/live/track/set/current_monitoring_state", [intArg(idx), intArg(state)]);
      let armWrite = null;
      if (disarmTrack) {
        armWrite = sendMaybe("/live/track/set/arm", [intArg(idx), intArg(0)]);
      }
      let noteCount = null;
      let clipNotesError = null;
      try {
        const noteResp = await requestAny(["/live/clip/get/notes", "/live/clip/get/notes_extended"], [
          intArg(idx),
          intArg(clipIndex)
        ]);
        noteCount = extractClipNotes(parseOscValue(noteResp.response, [])).length;
      } catch (e) {
        clipNotesError = e.message;
      }
      return textResult({
        ok: true,
        track: resolved,
        clipIndex,
        monitoringMode,
        stateSent: state,
        monitoringOsc: monitoringWrite,
        disarmOsc: armWrite,
        clipMidiNoteCount: noteCount,
        clipNotesError,
        humanStepsIfStillSilent: [
          "In Live: confirm an instrument (e.g. Drum Rack) is on the device chain and pads have samples.",
          "Confirm Master volume up and track not muted.",
          "If clip still empty (0 notes), re-run generate_drum_pattern with the same trackIndex/clipIndex or create_midi_clip first."
        ],
        ...sessionClipPlacementHint(idx, clipIndex)
      });
    })
);

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "add_clip_notes",
  {
    title: "Add Clip Notes",
    description:
      "Add MIDI notes to a Session View clip (trackIndex + clipIndex slot). Open Session View (Tab) to see the clip; see tool response abletonUi.",
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
      return textResult({
        ok: true,
        trackIndex,
        clipIndex,
        notesAdded: notes.length,
        ...sessionClipPlacementHint(trackIndex, clipIndex)
      });
    })
);

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

async function clearClipNotesBestEffort(trackIndex, clipIndex) {
  const clearCandidates = [
    "/live/clip/remove/notes",
    "/live/clip/remove_notes",
    "/live/clip/clear_notes",
    "/live/clip/remove_all_notes"
  ];
  try {
    const selected = await selectEndpoint("clipClearNotes", clearCandidates, [intArg(trackIndex), intArg(clipIndex)]);
    return sendPlanRaw(selected, [intArg(trackIndex), intArg(clipIndex)], {
      trackIndex,
      clipIndex,
      clearEndpoint: selected
    });
  } catch (error) {
    return { ok: false, skipped: true, message: error.message };
  }
}

async function resolveDrumMidiTrack({ trackName, trackIndex, allowFirstTrackFallback = false }) {
  if (trackIndex !== undefined && trackIndex !== null) {
    const snap = await getTracksSnapshot();
    const row = snap.tracks.find((t) => t.index === trackIndex);
    return { index: trackIndex, name: row?.name ?? `track_${trackIndex}`, matchedBy: "trackIndex" };
  }
  const tryNames = trackName ? [trackName] : ["Drums", "Drum", "DRUMS", "Kit", "MIDI Drums"];
  for (const n of tryNames) {
    try {
      const r = await resolveTrackIndexFromName(n, 0.35);
      return { ...r, matchedBy: `trackName:${n}` };
    } catch {
      // continue
    }
  }
  const snap = await getTracksSnapshot();
  const drumLike = /drum|drums|kit|perc|808|snare|kick|hihat|hi-hat|oh|room|breaks/i;
  const guess = snap.tracks.find((t) => drumLike.test(normalizeName(t.name)));
  if (guess) return { index: guess.index, name: guess.name, score: 1, matchedBy: "name-heuristic" };
  if (allowFirstTrackFallback && snap.tracks[0]) {
    return {
      index: snap.tracks[0].index,
      name: snap.tracks[0].name,
      score: 0.5,
      matchedBy: "first-track-fallback-opt-in"
    };
  }
  if (!snap.tracks.length) {
    throw new Error("No tracks in the Live set to write drum MIDI.");
  }
  throw new Error(
    'No drum MIDI track could be resolved safely. Pass trackIndex (e.g. your Drum Rack track), or trackName (e.g. "Drums"), or rename a track to include drum/kit/kick/snare. To use the first session track anyway, pass allowFirstTrackFallback=true (risky if that track is not drums).'
  );
}

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "generate_midi_phrase",
  {
    title: "Generate MIDI Phrase",
    description:
      "Generate key/scale-aware MIDI notes and write into a clip by default (writeToClip=true). Uses Session clip slots (see Session View / Tab — not Arrangement timeline). createClipFirst uses clip_slot/create_clip.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      key: z.string().min(1).max(3).optional().default("C"),
      scale: z.enum(["major", "minor"]).optional().default("minor"),
      bars: z.number().int().min(1).max(32).optional().default(4),
      density: z.enum(["low", "medium", "high"]).optional().default("medium"),
      octave: z.number().int().min(1).max(8).optional().default(5),
      writeToClip: z.boolean().optional().default(true),
      createClipFirst: z.boolean().optional().default(true)
    }
  },
  async ({ trackIndex, clipIndex, key, scale, bars, density, octave, writeToClip, createClipFirst }) =>
    withMetrics("generate_midi_phrase", async () => {
      const notes = buildMidiNotePlan({ key, scale, bars, density, octave });
      let writeResult = null;
      if (!writeToClip) {
        return textResult({
          ok: true,
          trackIndex,
          clipIndex,
          key,
          scale,
          bars,
          density,
          notes,
          writeResult: null,
          dryRun: config.ABLETON_DRY_RUN,
          reminder: "writeToClip=false: no OSC writes. Defaults are now write-enabled."
        });
      }
      const totalBeats = bars * 4;
      const clipCreates = [];
      if (createClipFirst) {
        clipCreates.push(
          sendMaybe("/live/clip_slot/create_clip", [
            intArg(trackIndex),
            intArg(clipIndex),
            floatArg(totalBeats)
          ])
        );
      }
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
      writeResult = {
        notesWritten: writes.length,
        createClipFirst,
        clipSlotCreates: clipCreates.length,
        dryRun: config.ABLETON_DRY_RUN
      };
      return textResult({
        ok: true,
        trackIndex,
        clipIndex,
        key,
        scale,
        bars,
        density,
        notes,
        writeResult,
        ...sessionClipPlacementHint(trackIndex, clipIndex)
      });
    })
);

registerMcpTool(
  "generate_drum_pattern",
  {
    title: "Generate Drum Pattern",
    description:
      "GM-style MIDI drums (kick 36, snare 38, hat 42). Writes to Session View clip slots (open Session with Tab); not the Arrangement timeline unless you move the clip. Defaults writeToClip+createClipFirst. Track resolution: trackIndex / trackName / heuristics; allowFirstTrackFallback for track 0. ABLETON_DRY_RUN skips OSC.",
    inputSchema: {
      trackIndex: z.number().int().min(0).optional(),
      clipIndex: z.number().int().min(0).optional(),
      trackName: z.string().min(1).max(128).optional(),
      allowFirstTrackFallback: z.boolean().optional().default(false),
      style: z.enum(["house", "techno", "trap", "dnb"]).default("house"),
      bars: z.number().int().min(1).max(16).default(4),
      variation: z.boolean().optional().default(true),
      writeToClip: z.boolean().optional().default(true),
      createClipFirst: z.boolean().optional().default(true)
    }
  },
  async ({
    trackIndex,
    clipIndex,
    trackName,
    allowFirstTrackFallback,
    style,
    bars,
    variation,
    writeToClip,
    createClipFirst
  }) =>
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
      if (!writeToClip) {
        return textResult({
          ok: true,
          style,
          bars,
          basePattern: base,
          variationHints: variation ? ["Ghost snare before backbeat", "Open hat every 4 bars"] : [],
          notes,
          writeResult: null,
          dryRun: config.ABLETON_DRY_RUN,
          liveWrite: "off",
          reminder: "writeToClip=false: preview only. Defaults now write to Live when writeToClip is true."
        });
      }

      const matched = await resolveDrumMidiTrack({ trackName, trackIndex, allowFirstTrackFallback });
      const slot = clipIndex ?? 0;
      const clipCreates = [];
      if (createClipFirst) {
        clipCreates.push(
          sendMaybe("/live/clip_slot/create_clip", [
            intArg(matched.index),
            intArg(slot),
            floatArg(totalBeats)
          ])
        );
      }
      const writes = [];
      for (const note of notes) {
        writes.push(
          sendPlanRaw("/live/clip/add_note", [
            intArg(matched.index),
            intArg(slot),
            intArg(note.pitch),
            floatArg(note.start),
            floatArg(note.duration),
            intArg(note.velocity),
            intArg(note.mute ? 1 : 0)
          ])
        );
      }
      const writeResult = {
        trackIndex: matched.index,
        clipIndex: slot,
        matchedTrackName: matched.name,
        matchedBy: matched.matchedBy ?? "resolver",
        createClipFirst,
        clipSlotCreates: clipCreates.length,
        notesWritten: writes.length,
        dryRun: config.ABLETON_DRY_RUN
      };
      return textResult({
        ok: true,
        style,
        bars,
        basePattern: base,
        variationHints: variation ? ["Ghost snare before backbeat", "Open hat every 4 bars"] : [],
        notes,
        writeResult,
        liveWrite: "notes",
        dryRun: config.ABLETON_DRY_RUN,
        ...sessionClipPlacementHint(matched.index, slot)
      });
    })
);

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "set_drum_bus_punch_mode",
  {
    title: "Set Drum Bus Punch Mode",
    description:
      "Sends best-effort device parameter tweaks on drum-like tracks (enabled defaults true). Proxy mapping on device 0; verify device chain in Live.",
    inputSchema: { enabled: z.boolean().optional().default(true) }
  },
  async ({ enabled }) =>
    withMetrics("set_drum_bus_punch_mode", async () => {
      const tracks = await getTracksSnapshot();
      const targets = tracks.tracks
        .filter((t) => /drum|kit|kick|snare|perc|808/i.test(normalizeName(t.name)))
        .slice(0, 8);
      const writes = [];
      for (const t of targets) {
        const thresh = enabled ? 0.52 + Math.random() * 0.08 : 0.62;
        const rel = enabled ? 0.35 : 0.55;
        writes.push(
          sendPlanRaw(
            "/live/device/set/parameter/value",
            [intArg(t.index), intArg(0), intArg(2), floatArg(thresh)],
            { trackIndex: t.index, parameter: "punch-threshold-proxy", enabled }
          )
        );
        writes.push(
          sendPlanRaw(
            "/live/device/set/parameter/value",
            [intArg(t.index), intArg(0), intArg(3), floatArg(rel)],
            { trackIndex: t.index, parameter: "punch-release-proxy", enabled }
          )
        );
      }
      return textResult({
        ok: true,
        enabled,
        settings: enabled ? ["Fast attack transient shaper", "Parallel comp blend 20-30%"] : ["Bypass punch chain"],
        tracksTouched: targets.map((t) => ({ index: t.index, name: t.name })),
        writesCount: writes.length,
        dryRun: config.ABLETON_DRY_RUN
      });
    })
);

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "optimize_bus_compression",
  {
    title: "Optimize Bus Compression",
    description:
      "Tune bus compression settings by genre intent. applyWrites defaults true (sends proxy device parameter OSC on matching tracks). Set applyWrites=false for recommendations only. Skips master bus.",
    inputSchema: {
      bus: z.enum(["drum", "music", "vocal", "master"]),
      style: z.string().min(1).max(64).optional().default("neutral"),
      applyWrites: z.boolean().optional().default(true)
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

registerMcpTool(
  "run_stereo_image_optimizer",
  {
    title: "Run Stereo Image Optimizer",
    description:
      "Stereo width and mono compatibility. applyWrites defaults true (narrows extreme pans via OSC). Set false for diagnostics only.",
    inputSchema: { applyWrites: z.boolean().optional().default(true) }
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "generate_vocal_harmony_midi_scaffold",
  {
    title: "Generate Vocal Harmony MIDI Scaffold",
    description:
      "Triad MIDI block on a clip for harmony practice. Defaults: applyMidi=true and createClipFirst=true (writes to Live). Set applyMidi=false for preview only. Plugins (optional): Scaler 2, Captain Chords, Orb Producer Suite.",
    inputSchema: {
      trackName: z.string().min(1).max(128),
      clipIndex: z.number().int().min(0).optional().default(0),
      rootMidi: z.number().int().min(36).max(84).optional().default(60),
      applyMidi: z.boolean().optional().default(true),
      createClipFirst: z.boolean().optional().default(true)
    }
  },
  async ({ trackName, clipIndex, rootMidi, applyMidi, createClipFirst }) =>
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
      const clipCreates = [];
      if (applyMidi && createClipFirst) {
        clipCreates.push(
          sendMaybe("/live/clip_slot/create_clip", [
            intArg(resolved.index),
            intArg(clipIndex),
            floatArg(4)
          ])
        );
      }
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
        createClipFirst,
        notesWritten: writeCount,
        clipSlotCreates: clipCreates.length,
        pluginsRequired: [],
        pluginsOptional: ["Plugin Boutique Scaler 2", "Mixed In Key Captain Chords", "Orb Producer Suite"],
        hint: "Set applyMidi=false for JSON-only. createClipFirst=false if the clip slot already has a clip.",
        ...(applyMidi ? sessionClipPlacementHint(resolved.index, clipIndex) : {})
      });
    })
);

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
  "semantic_clip_edit",
  {
    title: "Semantic Clip Edit",
    description:
      "Semantic edits on clip MIDI in a Session slot (not Arrangement-only). applyWrites defaults true. See response abletonUi for where to look in Live.",
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
        writesCount: writes.length,
        ...(applyWrites ? sessionClipPlacementHint(trackIndex, clipIndex) : {})
      });
    })
);

registerMcpTool(
  "humanize_drums",
  {
    title: "Humanize Drums",
    description:
      "Reads clip MIDI, clears notes (best-effort), re-adds with timing/velocity jitter. writeToLive defaults true. If clear endpoint is missing, new notes may stack on old ones — use replace in Live or semantic_clip_edit replaceMode.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      clipIndex: z.number().int().min(0),
      timingMs: z.number().min(0).max(40).optional().default(12),
      velocitySpread: z.number().int().min(0).max(40).optional().default(18),
      writeToLive: z.boolean().optional().default(true)
    }
  },
  async ({ trackIndex, clipIndex, timingMs, velocitySpread, writeToLive }) =>
    withMetrics("humanize_drums", async () => {
      const tempoResp = await requestKnown("tempoGet", ["/live/song/get/tempo", "/live/song/tempo"]);
      const bpm = Number(parseOscValue(tempoResp.response, 120));
      const beatJitter = timingMs > 0 ? (timingMs / 1000) * (bpm / 60) : 0;
      const noteResp = await requestAny(["/live/clip/get/notes", "/live/clip/get/notes_extended"], [
        intArg(trackIndex),
        intArg(clipIndex)
      ]);
      const raw = parseOscValue(noteResp.response, []);
      const incoming = extractClipNotes(raw);
      if (!writeToLive) {
        return textResult({
          ok: true,
          trackIndex,
          clipIndex,
          timingMs,
          velocitySpread,
          inputNotes: incoming.length,
          writeToLive: false,
          reminder: "writeToLive=false: preview only."
        });
      }
      const clearResult = await clearClipNotesBestEffort(trackIndex, clipIndex);
      const humanized = incoming.map((n) => {
        const j = beatJitter > 0 ? (Math.random() * 2 - 1) * beatJitter * 0.5 : 0;
        const start = Math.max(0, Number((n.start + j).toFixed(4)));
        const vel = Math.max(
          1,
          Math.min(127, Math.round((n.velocity ?? 100) + (Math.random() * 2 - 1) * velocitySpread))
        );
        return { ...n, start, velocity: vel };
      });
      const writes = [];
      for (const n of humanized) {
        writes.push(
          sendPlanRaw("/live/clip/add_note", [
            intArg(trackIndex),
            intArg(clipIndex),
            intArg(n.pitch),
            floatArg(n.start),
            floatArg(n.duration),
            intArg(n.velocity),
            intArg(n.mute ? 1 : 0)
          ])
        );
      }
      return textResult({
        ok: true,
        trackIndex,
        clipIndex,
        timingMs,
        velocitySpread,
        inputNotes: incoming.length,
        outputNotes: humanized.length,
        clearResult,
        writesCount: writes.length,
        dryRun: config.ABLETON_DRY_RUN,
        ...sessionClipPlacementHint(trackIndex, clipIndex)
      });
    })
);

registerMcpTool(
  "apply_fx_chain_template",
  {
    title: "Apply FX Chain Template",
    description:
      "Best-effort load of a device preset by name on device slot 0 (OSC). templateName should match a Live preset path/name your AbletonOSC accepts. Set dryRun-style preview with applyPreset=false.",
    inputSchema: {
      trackIndex: z.number().int().min(0),
      templateName: z.string().min(1).max(128),
      applyPreset: z.boolean().optional().default(true)
    }
  },
  async ({ trackIndex, templateName, applyPreset }) =>
    withMetrics("apply_fx_chain_template", async () => {
      if (!applyPreset) {
        return textResult({
          ok: true,
          trackIndex,
          templateName,
          applyPreset: false,
          validation: ["Check device availability", "Check routing compatibility", "Set applyPreset=true to send load_preset OSC"]
        });
      }
      return sendKnownMaybe(
        "deviceLoadPreset",
        ["/live/device/load_preset", "/live/device/set/preset", "/live/device/load/device_preset"],
        [intArg(trackIndex), intArg(0), stringArg(templateName)],
        { trackIndex, deviceIndex: 0, templateName }
      );
    })
);

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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

registerMcpTool(
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
      return textResult({ ok: true, interpretedAction: "noop", phrase });
    })
);

registerMcpTool(
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
