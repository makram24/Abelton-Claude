# Ableton MCP Roadmap

This file tracks the implementation roadmap. Many later-phase items marked done are **scaffolds** (heuristic planners / checklists), not production DSP. They are **gated off by default** (`ABLETON_ENABLE_SCAFFOLD_TOOLS=false`). Prefer finishing open **core** gaps (Phases 2–6 unchecked items) over adding more scaffolds.

## Portfolio cleanup (done)

- [x] Core vs scaffold tool tiers + default core-only surface
- [x] Extract pure helpers (`src/lib/*`, `toolTiers.js`)
- [x] LICENSE, `.gitignore` runtime artifacts, GitHub Actions CI
- [x] Real unit + OSC client tests (not only source contracts)
- [x] Safer defaults: `operator` role, scaffolds off

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

## Phase 11 - Advanced production automation

- [x] Real-time reactive mode scaffold
- [x] Smart take comping assistant scaffold
- [x] Sidechain setup scaffold
- [x] Semantic clip edit scaffold
- [x] Harmony-aware arranger scaffold
- [x] Drum humanization scaffold
- [x] FX chain template validation scaffold
- [x] Master bus guardrails scaffold
- [x] One-click stem prep scaffold
- [x] Session diff + undo bundle scaffold
- [x] Auto scene sequencing scaffold
- [x] Panic macro + macro runner scaffolding
- [x] Prompt-to-macro recorder scaffold
- [x] Project cleanup bot scaffold
- [x] Reference match assistant scaffold
- [x] Collaborator mode presets scaffold
- [x] Task-linked production flow scaffold
- [x] Voice live mode command scaffold
- [x] Plugin preset intelligence scaffold
- [x] Deliverables matrix export scaffold

## Phase 12 - Intelligent workflow and release operations

- [x] Auto mix pass scaffold
- [x] Vocal production chain scaffold
- [x] Clip timing repair scaffold
- [x] Section transition builder scaffold
- [x] Section energy shaping scaffold
- [x] Adaptive macro performer scaffold
- [x] Auto gain staging scaffold
- [x] Bus architecture scaffold
- [x] Latency-safe recording mode scaffold
- [x] Arrangement completion assistant scaffold
- [x] Track role detection scaffold
- [x] Release prep pipeline scaffold
- [x] Smart sample audit scaffold
- [x] Macro timeline scheduler scaffold
- [x] Live improv guardrails scaffold
- [x] Mix issue diagnosis scaffold
- [x] Plugin chain optimizer scaffold
- [x] Session goals mode scaffold
- [x] Multi-song set manager scaffold
- [x] Auto documentation export scaffold

## Phase 13 - AI creative intelligence and QA

- [x] AI arrangement rewrite scaffold
- [x] Drum replacement assistant scaffold
- [x] Kick-bass conflict resolver scaffold
- [x] Advanced vocal polish scaffold
- [x] Genre template transformer scaffold
- [x] Section similarity detector scaffold
- [x] Drop builder plan scaffold
- [x] Dynamic bus automation scaffold
- [x] Release readiness scoring scaffold
- [x] Intelligent freeze manager scaffold
- [x] Session focus mode scaffold
- [x] Contextual coaching scaffold
- [x] Recording take ranking scaffold
- [x] Reference-aware tonal targeting scaffold
- [x] Creative prompt scene scaffold
- [x] Live performance cue engine scaffold
- [x] Error recovery autopilot scaffold
- [x] Multi-project memory scaffold
- [x] Release variant generator scaffold
- [x] Post-export QA scaffold

## Phase 14 - Translation, revision packaging, and safety automation

- [x] Stem naming normalizer scaffold
- [x] Pre-release loudness targeter scaffold
- [x] Arrangement gap finder scaffold
- [x] Hook reinforcement scaffold
- [x] Kick transient optimizer scaffold
- [x] Bass mono compatibility checker scaffold
- [x] Drum bus punch mode scaffold
- [x] Vocal intelligibility scoring scaffold
- [x] Scene energy curve planner scaffold
- [x] Live emergency state restore scaffold
- [x] Adaptive sidechain manager scaffold
- [x] Automation conflict detector scaffold
- [x] Device parameter lock mode scaffold
- [x] Ear training prompt mode scaffold
- [x] Session drift monitor scaffold
- [x] Variant consistency audit scaffold
- [x] Mix translation simulator scaffold
- [x] Batch song operations scaffold
- [x] Client revision packaging scaffold
- [x] Auto rollback policy scaffold

## Phase 15 - Sound engineering intelligence

- [x] Gain staging autopilot scaffold
- [x] Phase alignment assistant scaffold
- [x] Masking analyzer scaffold
- [x] Dynamic range manager scaffold
- [x] Sibilance/harshness detector scaffold
- [x] Low-end control suite scaffold
- [x] Bus compression tuner scaffold
- [x] Transient shaping assistant scaffold
- [x] Stereo image optimizer scaffold
- [x] Reverb/delay space manager scaffold
- [x] Automation quality checker scaffold
- [x] Reference match engine scaffold
- [x] Master chain safety analyzer scaffold
- [x] Mix translation diagnostics scaffold
- [x] Stem quality auditor scaffold
- [x] Clip gain optimizer scaffold
- [x] Noise/floor checker scaffold
- [x] Loudness workflow assistant scaffold
- [x] Revision delta analyzer scaffold
- [x] Engineering checklist mode scaffold
- [x] Integrated loudness meter path planner
- [x] True-peak / ISP guardrails scaffold
- [x] Spectral balance fingerprint (heuristic) scaffold
- [x] Masking map v2 (ranked conflicts) scaffold
- [x] Solo-safe diagnostic mode + rollback snapshot hook
- [x] Correlation / mono-sum monitor scaffold
- [x] Multiband dynamics chain planner
- [x] De-essing automation plan + vocal rider planner
- [x] Parallel processing recipes scaffold
- [x] Send/reverb economy + delay coherence tools
- [x] Kick/bass phase lab + drum phase alignment pack
- [x] Translation presets + headphone translation profile
- [x] Master chain delta lock + stem loudness normalization plan
- [x] Dynamic range report + client revision A/B pack
- [x] Engineering session modes + change attribution log + blind A/B helper

## Phase 16 - Singer / vocal workflows

- [x] Vocal take ladder + punch-in session planner
- [x] Breath/noise candidate map + room-tone / headphone checklist
- [x] Vocal comp workflow v2 + take consistency (level proxy)
- [x] Vocal tuning + timing tighten planners (plugin-aware)
- [x] Vocal doubles stack + singer plugin chain planner
- [x] Pre-bounce sibilance check + warmup-then-record + harmony MIDI scaffold
- [x] Backing vocal bus + warmup metronome + lyric cue sheet export
- [x] Ear-training checklist + vocal FX snapshot plan + monitor path audit
- [x] Vocal setlist scenes + delivery variants + stem naming plan

## Phase 17 - Singer / vocal extended

- [x] Vocal chain A/B snapshot plan (gain-matched shootouts)
- [x] Low-latency vocal tracking checklist
- [x] Duet / harmony recording session planner
- [x] Vocal booth session-start macro (locators)
- [x] Ad-lib lane + tone modes + choir stack planners
- [x] Melody-to-MIDI capture workflow + pitch/vibrato + breath placeholders
- [x] Vocal range report + producer/singer revision locators
- [x] Pronunciation guide + vocal health guard + key-from-MIDI hint
- [x] Lead tuned vs raw stem matrix + sync-to-picture vocal cues
