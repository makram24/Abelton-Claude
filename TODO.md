# Ableton MCP Roadmap

This file tracks the full implementation roadmap requested for this project.

## Phase 1 - Core reliability and observability

- [x] Endpoint capability probing and selection cache
- [ ] Health/status tool with probe visibility
- [ ] Command metrics (counts, durations, failures)
- [ ] Heartbeat and auto re-probe flow

## Phase 2 - Mixer and session control

- [ ] Track mixer reads (volume, pan, sends)
- [ ] Track mixer writes (volume, pan, send levels)
- [ ] Arm/mute/solo/monitor mode controls
- [ ] Crossfader assignment controls

## Phase 3 - Scenes and clips lifecycle

- [ ] List scenes with names
- [ ] Create scene
- [ ] Rename scene
- [ ] Delete scene (destructive confirmation)
- [ ] Clip naming/color/launch settings

## Phase 4 - MIDI note API

- [ ] Read notes from clip by time range
- [ ] Add notes to clip
- [ ] Replace/edit notes by range
- [ ] Remove notes by pitch/time filter
- [ ] Quantize/humanize helpers

## Phase 5 - Transport and arrangement power tools

- [ ] Metronome, count-in, punch in/out
- [ ] Locator list/jump/create/delete
- [ ] Loop region controls
- [ ] Move/duplicate/delete time range
- [ ] Consolidate and bounce helpers

## Phase 6 - Automation and device depth

- [ ] Read automation envelopes
- [ ] Write automation points
- [ ] Device loading/preset helpers
- [ ] Rack macro and chain controls

## Phase 7 - Safety and advanced workflow

- [ ] Session snapshot capture and restore
- [ ] Role-based policy and per-tool allowlist
- [ ] Natural language intent-to-tool planner
- [ ] Batch command execution mode
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
- [x] Rich rollback snapshots with reverse-op hints
- [x] Automation curve writer scaffolding
- [x] Export profiles with reusable wrappers
- [x] State cache + subscription scaffolding
- [x] Plan compiler and conditional/dependency schema scaffolding
- [x] Routing and preset manager scaffolding
- [x] Performance mode and conflict detection scaffolding
