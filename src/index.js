import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
  protocolDiagnostics.lastOutgoingAt = new Date().toISOString();
  pushEventCache({
    type: "osc_send",
    address,
    args: args.map((a) => a.value)
  });
  oscClient.send(address, args);
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

async function captureRollbackSnapshotInternal(snapshotId) {
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
