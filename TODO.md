# Ableton MCP Roadmap

This file tracks the full implementation roadmap requested for this project.

## Phase 1 - Core reliability and observability

- [x] Endpoint capability probing and selection cache
- [x] Health/status tool with probe visibility
- [x] Command metrics (counts, durations, failures)
- [x] Heartbeat and auto re-probe flow
- [x] `/live/test` first-class health probe tool
- [x] Structured error codes scaffold and normalized error report tool
- [x] Endpoint selection persistence across restarts
- [x] One-shot smoke check diagnostics tool
- [x] Protocol diagnostics output (ports, last packet timestamps, RTT estimate)
- [x] Audit trail JSONL logging scaffold

## Phase 2 - Mixer and session control

- [x] Track mixer reads (volume, pan, sends)
- [x] Track mixer writes (volume, pan, send levels)
- [x] Arm/mute/solo controls
- [ ] Crossfader assignment controls

## Phase 3 - Scenes and clips lifecycle

- [x] List scenes with names
- [x] Create scene
- [x] Rename scene
- [x] Delete scene (destructive confirmation)
- [ ] Clip naming/color/launch settings

## Phase 4 - MIDI note API

- [x] Read notes from clip
- [x] Add notes to clip
- [ ] Replace/edit notes by range
- [ ] Remove notes by pitch/time filter
- [ ] Quantize/humanize helpers

## Phase 5 - Transport and arrangement power tools

- [x] Metronome and punch in/out
- [x] Locator create/jump helpers
- [x] Loop region controls
- [x] Move/duplicate/delete time range
- [ ] Consolidate and bounce helpers

## Phase 6 - Automation and device depth

- [ ] Read automation envelopes
- [x] Write automation points
- [x] Device loading/preset helpers
- [ ] Rack macro and chain controls

## Phase 7 - Safety and advanced workflow

- [x] Session snapshot capture and restore
- [x] Role-based policy and per-tool allowlist scaffolding
- [x] Natural language intent-to-tool planner scaffold
- [x] Batch command execution mode
- [ ] Macro workflows (template prep, stem export, scene performance)

## Phase 8 - Productivity and operator UX

- [x] Undo/redo MCP tools
- [x] Transaction preview tool (safe dry preview payload)
- [x] Fuzzy track targeting with by-name wrappers
- [x] Render/export toolchain scaffolding
- [x] Metrics dashboard/report output
- [x] Mock AbletonOSC harness and contract tests
- [x] Batch execute_action_plan with whitelist, destructive gate, rollback snapshot

## Phase 9 - Advanced safety and orchestration

- [x] Policy engine for destructive actions and mode gating
- [x] Safety mode policy bundle presets
- [x] Rich rollback snapshots with reverse-op hints
- [x] Automation curve writer scaffolding
- [x] Export profiles with reusable wrappers
- [x] State cache + subscription scaffolding
- [x] Session event-stream cache scaffolding
- [x] Plan compiler and conditional/dependency schema scaffolding
- [x] Routing and preset manager scaffolding
- [x] Performance mode and conflict detection scaffolding
- [x] Capability profile detection scaffold
- [x] Alias/preset registry scaffold
- [x] Export job manager scaffold
- [x] Transaction preflight scaffold

## Phase 10 - Creative copilot expansion

- [x] Musical intent compiler scaffold
- [x] Arrangement intelligence scaffold
- [x] Mix health check scaffold
- [x] Sound design macro scaffold
- [x] Key-aware MIDI phrase generator scaffold
- [x] Drum pattern generator scaffold
- [x] Automation helper composer scaffold
- [x] Scene performance helper scaffold
- [x] Live safety rails locklist scaffold
- [x] Project quality check scaffold
- [x] Reference track workflow scaffold
- [x] Batch export pipeline scaffold
- [x] Session preferences memory scaffold
- [x] Voice command ingestion scaffold
- [x] Semantic plugin control scaffold
- [x] Collaboration handoff summary scaffold
- [x] Learning explanation mode scaffold
- [x] Template/pack manager scaffold
- [x] Show mode checklist scaffold
- [x] External ecosystem hooks scaffold
