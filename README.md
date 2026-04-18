# Claude Ableton MCP (AbletonOSC Bridge)

This project is a local MCP server that lets Claude control Ableton Live through AbletonOSC.

## What this project includes

- OSC connection to AbletonOSC (UDP; default send `11000`, listen `11001`)
- Safety layer: dry-run (`ABLETON_DRY_RUN=true`), destructive confirm token (`YES_I_UNDERSTAND` where required)
- **121 MCP tools**, each implemented to call **AbletonOSC** (reads/writes helpers such as `sendMaybe`, `requestKnown`, `getTracksSnapshot`, etc.). There are **no** separate “local-only” MCP tools (no dashboard/alias/policy-only tools in the registry).
- To print the current sorted tool list: `node scripts/classify-tools.mjs`

## Requirements

- Node.js 18+
- Ableton Live with AbletonOSC installed and enabled as a control surface

## Install

```bash
npm install
```

### MCP `ERR_MODULE_NOT_FOUND` (`@modelcontextprotocol/sdk`)

The MCP client must run Node from the **project root** (where `package.json` lives), after `npm install` has created `node_modules` there. If you point the server at a copy that only has `src/` or a fresh clone, run `npm install` in that folder once. Then restart the MCP server.

### MIDI clips “not visible” in Arrangement View

This bridge uses AbletonOSC **`clip_slot`** APIs. New clips land in **Session View** (the vertical clip matrix per track), **not** on the horizontal Arrangement timeline. Press **Tab** (or use Live’s Session / Arrangement switch) to see the clip in the chosen **clip slot** (scene row). Drag the Session clip into the Arrangement if you want it on the timeline. Also: an empty **Drum Rack** (no samples on pads) stays silent even when MIDI notes exist.

## Configure

Set environment variables if your AbletonOSC ports are different:

- `ABLETON_OSC_HOST` (default `127.0.0.1`)
- `ABLETON_OSC_SEND_PORT` (default `11000`)
- `ABLETON_OSC_LISTEN_PORT` (default `11001`)
- `ABLETON_OSC_TIMEOUT_MS` (default `2000`)
- `ABLETON_DRY_RUN` (default `false`; set `true` to simulate writes)
- `ABLETON_REQUIRE_DESTRUCTIVE_CONFIRM` (default `true`)

PowerShell example:

```powershell
$env:ABLETON_OSC_SEND_PORT="11000"
$env:ABLETON_OSC_LISTEN_PORT="11001"
$env:ABLETON_DRY_RUN="false"
$env:ABLETON_REQUIRE_DESTRUCTIVE_CONFIRM="true"
```

## Run

```bash
npm start
```

The server runs over stdio, so Claude Desktop can launch it as an MCP server command.

On startup, the server now performs an endpoint capability probe and selects the working endpoint variant for each key operation.

## Action plans (batch execution)

1. Call `execute_action_plan` with a non-empty `actions` array. Each element is `{ "action": "<name>", "params": { ... } }` where `action` must match a handler in `dispatchPlanAction` inside `src/index.js` (same names as `planParamSchemas` keys: transport, scenes, clips, track mixer, device parameters, MIDI clip create, `add_clip_notes`, `render_project_audio`, `render_stems`, etc.).
2. Use `dryRun: true` on `execute_action_plan` to simulate sends without mutating Live (unless global `ABLETON_DRY_RUN` is already on).
3. For destructive actions (`delete_clip`, `delete_scene`, `arrangement_delete_range`, `render_project_audio`, `render_stems`), pass `confirmToken: "YES_I_UNDERSTAND"`.
4. Optional: set `captureRollbackSnapshot: true` before risky plans, then `restore_session_snapshot` with the returned `rollback.snapshotId` for lightweight transport rollback.

## Behaviour notes (selected tools)

- **Session clips:** `create_midi_clip`, `add_clip_notes`, `generate_drum_pattern`, `generate_midi_phrase`, etc. use Session clip slots (see “MIDI clips not visible” above). `ABLETON_DRY_RUN=true` skips mutating OSC.
- **Exports:** Built-in export profiles (`streaming`, `mix-engineer-stems`, `mastering-print`) live in code; use `create_export_job` / `run_export_job`, `render_with_profile`, or `export_deliverables_matrix` for renders.
- **Endpoint variants:** Startup probes common AbletonOSC paths; use `warmup_write_endpoints` and `reprobe_endpoints` if your fork differs.

## Test harness

```bash
npm test
```

Optional local mock AbletonOSC server:

```bash
node tests/mock-abletonosc.mjs
```

## Claude Desktop MCP config example

Use your Claude Desktop MCP config file and add:

```json
{
  "mcpServers": {
    "ableton": {
      "command": "node",
      "args": ["C:/wamp64/www/Makram/Abelton + Claude/src/index.js"],
      "env": {
        "ABLETON_OSC_HOST": "127.0.0.1",
        "ABLETON_OSC_SEND_PORT": "11000",
        "ABLETON_OSC_LISTEN_PORT": "11001",
        "ABLETON_OSC_TIMEOUT_MS": "2000",
        "ABLETON_DRY_RUN": "false",
        "ABLETON_REQUIRE_DESTRUCTIVE_CONFIRM": "true"
      }
    }
  }
}
```

## Notes

- AbletonOSC endpoint names can differ by version/fork. This server uses endpoint fallbacks for several read operations.
- Endpoint variants are auto-detected at startup for reads, and lazily selected on first use for write-heavy paths (`render_*`, routing, preset load, subscriptions). Inspect `OSC_ENDPOINT_VARIANTS` and persisted `.ableton-endpoints.json` after a successful run.
- Use `warmup_write_endpoints` for a non-mutating probe of write-variant addresses before first real write.
- Startup auto-retries probe/cache initialization (10 attempts, 3 seconds apart) before falling back to warning mode; the server stays online either way.
- Destructive confirmation token: **`YES_I_UNDERSTAND`** (required where tools call `guardDestructive`).
- Endpoint selections are persisted to `.ableton-endpoints.json` and reused on restart.
- Arrangement section memory is persisted to `.ableton-sections.json` and reused on restart (internal helpers; no separate MCP tools for section CRUD).
- Arrangement section profiles are persisted to `.ableton-section-profiles.json` and reused on restart.
- Audit logs are written to `logs/audit.jsonl` (best-effort, append-only).
- If a specific endpoint differs in your AbletonOSC build, update `OSC_ENDPOINT_VARIANTS` / `src/index.js` and rerun `reprobe_endpoints` or restart the server.
