# Claude Ableton MCP (AbletonOSC Bridge)

Local **MCP server** that lets Claude Desktop control **Ableton Live** through **AbletonOSC** (UDP OSC).

## What is real vs scaffold

| Tier | Count | Default | Meaning |
|------|------:|---------|---------|
| **Core** | 69 | always on | Transport, mixer, clips/scenes, MIDI writes, devices, snapshots, health/probe, export, action plans |
| **Scaffold** | 52 | **off** | Heuristic planners / checklists (mix “health”, vocal workflows, etc.) — **not** audio DSP analysis |

Enable scaffolds only if you want the experimental planners:

```powershell
$env:ABLETON_ENABLE_SCAFFOLD_TOOLS="true"
```

List tools: `npm run classify-tools`

## Architecture

```
src/
  index.js          MCP bootstrap + tool registration (core + optional scaffolds)
  abletonOsc.js     UDP OSC client (request/response + timeouts)
  config.js         Zod-validated environment
  toolTiers.js      Core vs scaffold partition
  lib/              Pure helpers (names, OSC parse, errors, MCP results)
```

## Requirements

- Node.js 18+
- Ableton Live with AbletonOSC installed and enabled as a control surface

## Install

```bash
npm install
```

### MCP `ERR_MODULE_NOT_FOUND` (`@modelcontextprotocol/sdk`)

Run the MCP client from the **project root** (where `package.json` lives) after `npm install`.

### MIDI clips “not visible” in Arrangement View

This bridge uses AbletonOSC **`clip_slot`** APIs. New clips land in **Session View**, not the Arrangement timeline. Press **Tab** to see Session slots. Empty **Drum Rack** pads stay silent even when MIDI notes exist.

## Configure

| Variable | Default | Purpose |
|----------|---------|---------|
| `ABLETON_OSC_HOST` | `127.0.0.1` | OSC host |
| `ABLETON_OSC_SEND_PORT` | `11000` | Send to AbletonOSC |
| `ABLETON_OSC_LISTEN_PORT` | `11001` | Listen for replies |
| `ABLETON_OSC_TIMEOUT_MS` | `2000` | Request timeout |
| `ABLETON_DRY_RUN` | `false` | Simulate writes |
| `ABLETON_REQUIRE_DESTRUCTIVE_CONFIRM` | `true` | Require `YES_I_UNDERSTAND` |
| `ABLETON_ENABLE_SCAFFOLD_TOOLS` | `false` | Register heuristic planners |
| `ABLETON_DEFAULT_ROLE` | `operator` | `observer` \| `operator` \| `admin` |

## Run

```bash
npm start
```

Claude Desktop launches this over stdio. On startup the server probes AbletonOSC endpoints and caches working variants.

## Action plans

1. Call `execute_action_plan` with `{ "actions": [ { "action": "<name>", "params": {} } ] }`.
2. Use `dryRun: true` to simulate.
3. Destructive actions need `confirmToken: "YES_I_UNDERSTAND"`.
4. Optional: `captureRollbackSnapshot: true`, then `restore_session_snapshot`.

## Tests

```bash
npm test
```

Includes contract checks (tool tiers), unit tests for helpers, and a live UDP OSC client test against an in-process mock.

Optional standalone mock:

```bash
node tests/mock-abletonosc.mjs
```

## License

MIT — see [LICENSE](./LICENSE).
