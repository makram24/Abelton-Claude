# Claude Ableton MCP (AbletonOSC Bridge)

This project is a local MCP server that lets Claude control Ableton Live through AbletonOSC.

## What this project includes (all phases)

- OSC connection to AbletonOSC
- Safety layer:
  - Dry-run mode (`ABLETON_DRY_RUN=true`)
  - Destructive action confirmation token
- MCP tools:
  - `get_connection_info`
  - `get_last_error`
  - `get_protocol_diagnostics`
  - `health_live_test`
  - `run_smoke_check`
  - `get_endpoint_capabilities`
  - `warmup_write_endpoints`
  - `warmup_report_recommendations`
  - `get_server_health`
  - `reprobe_endpoints`
  - `heartbeat`
  - `get_metrics_dashboard`
  - `get_session_overview`
  - `undo`
  - `redo`
  - `create_action_plan_preview`
  - `get_action_plan_preview`
  - `get_allowed_plan_actions`
  - `execute_action_plan`
  - `get_policy_state`
  - `set_policy_state`
  - `set_safety_mode`
  - `refresh_state_cache`
  - `subscribe_session_events`
  - `detect_plan_conflicts`
  - `start_playback`
  - `stop_playback`
  - `stop_all_clips`
  - `set_tempo`
  - `get_tempo`
  - `list_tracks`
  - `find_track_by_name`
  - `set_track_volume_by_name`
  - `launch_clip_by_track_name`
  - `launch_scene`
  - `launch_clip`
  - `stop_track_clips`
  - `get_track_devices`
  - `get_device_parameters`
  - `set_device_parameter`
  - `create_midi_clip`
  - `set_track_name`
  - `get_track_mixer`
  - `set_track_mixer`
  - `set_track_state`
  - `list_scenes`
  - `create_scene`
  - `rename_scene`
  - `delete_scene` (destructive, confirmation required)
  - `get_clip_notes`
  - `add_clip_notes`
  - `set_transport_flags`
  - `set_loop_region`
  - `set_arrangement_punch`
  - `create_locator`
  - `jump_to_time`
  - `arrangement_duplicate_range`
  - `arrangement_delete_range` (destructive, confirmation required)
  - `set_device_automation_point`
  - `write_device_automation_curve`
  - `capture_session_snapshot`
  - `restore_session_snapshot`
  - `list_export_profiles`
  - `upsert_export_profile`
  - `render_with_profile` (destructive, confirmation required)
  - `compile_plan_from_intent`
  - `create_conditional_plan`
  - `set_track_routing`
  - `load_device_preset`
  - `render_project_audio` (destructive, confirmation required)
  - `render_stems` (destructive, confirmation required)
  - `delete_clip` (destructive, confirmation required)

## Requirements

- Node.js 18+
- Ableton Live with AbletonOSC installed and enabled as a control surface

## Install

```bash
npm install
```

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

1. Call `get_allowed_plan_actions` to see whitelisted `action` names and which need `confirmToken` (`YES_I_UNDERSTAND`).
2. Call `create_action_plan_preview` with a `planId` and `actions` array (`{ "action": "set_tempo", "params": { "bpm": 128 } }`).
3. Call `execute_action_plan` with the same `planId`, or pass `actions` inline. Use `dryRun: true` to simulate all sends without mutating Live (unless global `ABLETON_DRY_RUN` is already on).
4. For plans that include destructive actions (`delete_clip`, `render_stems`, etc.), pass `confirmToken: "YES_I_UNDERSTAND"`.
5. Optional: set `captureRollbackSnapshot: true` to save tempo/playhead/transport before running; use `restore_session_snapshot` with the returned `rollback.snapshotId` if you need to revert that lightweight state.
6. Use `set_policy_state` to switch role/mode (`observer`, `operator`, `admin`) and enable `performanceMode`; destructive actions are blocked in performance mode.

## Policy and Profiles

- `get_policy_state` and `set_policy_state` control runtime guardrails.
- `list_export_profiles`, `upsert_export_profile`, and `render_with_profile` provide named export presets.
- `write_device_automation_curve` writes linear/s-curve/step automation points over a range.
- `refresh_state_cache` and `detect_plan_conflicts` provide lightweight change/conflict detection scaffolding.

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
- Endpoint variants are auto-detected at startup for read operations, and lazily selected on first use for write-heavy compatibility tools (`render_*`, routing, preset load, subscriptions). All variant sets are exposed by `get_endpoint_capabilities`.
- Use `warmup_write_endpoints` if you want a non-mutating compatibility check for write-variant endpoint sets before first real write.
- Use `warmup_report_recommendations` to get explicit override guidance for unresolved write endpoint keys.
- Startup now auto-retries probe/cache initialization (10 attempts, 3 seconds apart) before falling back to warning mode; the server stays online either way.
- The destructive confirmation token is `YES_I_UNDERSTAND` (returned by `get_connection_info`).
- Endpoint selections are persisted to `.ableton-endpoints.json` and reused on restart.
- Audit logs are written to `logs/audit.jsonl` (best-effort, append-only).
- If a specific endpoint differs in your AbletonOSC build, update it in `src/index.js`.
