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
  - `get_ops_dashboard`
  - `get_ops_dashboard_compact`
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
  - `get_session_event_cache`
  - `detect_plan_conflicts`
  - `preflight_action_plan`
  - `detect_capability_profile`
  - `upsert_alias`
  - `resolve_alias`
  - `register_device_preset_alias`
  - `list_alias_registry`
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
  - `create_export_job`
  - `run_export_job` (destructive, confirmation required)
  - `get_export_job`
  - `list_export_jobs`
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

## Creative Copilot tools (new)

- `compile_musical_intent`
- `arrangement_intelligence`
- `upsert_arrangement_section`
- `list_arrangement_sections`
- `export_arrangement_sections`
- `import_arrangement_sections`
- `save_arrangement_section_profile`
- `load_arrangement_section_profile`
- `clone_arrangement_section_map`
- `list_arrangement_section_profiles`
- `delete_arrangement_section_profile`
- `delete_arrangement_section`
- `run_mix_health_check`
- `apply_sound_design_macro`
- `generate_midi_phrase`
- `generate_drum_pattern`
- `compose_automation_helper`
- `performance_scene_action`
- `configure_live_safety_rails`
- `run_project_quality_checks`
- `reference_track_workflow`
- `export_batch_profiles`
- `set_user_preferences`
- `get_user_preferences`
- `ingest_voice_command`
- `semantic_plugin_control`
- `generate_collab_handoff`
- `explain_action_for_learning`
- `upsert_template_pack`
- `list_template_packs`
- `run_show_mode_checklist`
- `configure_external_hooks`
- `upsert_reactive_rule`
- `list_reactive_rules`
- `comp_take_assistant`
- `setup_sidechain_bus`
- `semantic_clip_edit`
- `harmony_arranger`
- `humanize_drums`
- `apply_fx_chain_template`
- `run_master_bus_guardrails`
- `prepare_stems_one_click`
- `session_diff_undo_bundle`
- `auto_scene_sequencer`
- `create_panic_macro`
- `run_macro`
- `record_prompt_macro`
- `project_cleanup_bot`
- `reference_match_assistant`
- `set_collaborator_mode`
- `task_linked_production_flow`
- `voice_live_mode_command`
- `plugin_preset_intelligence`
- `export_deliverables_matrix`
- `run_auto_mix_pass`
- `build_vocal_chain`
- `repair_clip_timing`
- `build_transition_between_sections`
- `shape_section_energy`
- `configure_adaptive_macro_performer`
- `auto_gain_stage_tracks`
- `create_bus_architecture`
- `set_latency_safe_recording_mode`
- `arrangement_completion_assistant`
- `detect_track_roles`
- `run_release_prep_pipeline`
- `smart_sample_audit`
- `schedule_macro_timeline`
- `configure_live_improv_guardrails`
- `diagnose_mix_issue`
- `optimize_plugin_chain`
- `set_session_goal`
- `manage_setlist`
- `export_session_documentation`
- `ai_arrangement_rewrite`
- `drum_replacement_assistant`
- `resolve_kick_bass_conflict`
- `advanced_vocal_polish`
- `transform_genre_template`
- `detect_section_similarity`
- `generate_drop_builder_plan`
- `write_dynamic_bus_automation`
- `run_release_readiness_score`
- `intelligent_freeze_manager`
- `set_session_focus_mode`
- `contextual_coaching_assistant`
- `rank_recording_takes`
- `reference_aware_tonal_targeting`
- `create_creative_prompt_scene`
- `live_performance_cue_engine`
- `error_recovery_autopilot`
- `set_project_memory_profile`
- `generate_release_variants`
- `run_post_export_qa`
- `normalize_stem_naming`
- `target_prerelease_loudness`
- `find_arrangement_gaps`
- `reinforce_hook_section`
- `optimize_kick_transient`
- `check_bass_mono_compatibility`
- `set_drum_bus_punch_mode`
- `score_vocal_intelligibility`
- `plan_scene_energy_curve`
- `restore_live_emergency_state`
- `manage_adaptive_sidechain`
- `detect_automation_conflicts`
- `set_device_parameter_lock_mode`
- `ear_training_prompt_mode`
- `monitor_session_drift`
- `run_variant_consistency_audit`
- `simulate_mix_translation`
- `batch_song_operations`
- `package_client_revision`
- `create_auto_rollback_policy`
- `run_gain_staging_autopilot`
- `run_phase_alignment_check`
- `run_masking_analysis`
- `manage_dynamic_range`
- `detect_sibilance_harshness`
- `run_low_end_control_suite`
- `optimize_bus_compression`
- `run_transient_shaping_assistant`
- `run_stereo_image_optimizer`
- `manage_reverb_delay_space`
- `run_automation_quality_check`
- `run_reference_match_engine`
- `run_master_chain_safety_scan`
- `run_mix_translation_diagnostics`
- `run_stem_quality_auditor`
- `optimize_clip_gain`
- `run_noise_floor_check`
- `run_loudness_workflow_assistant`
- `analyze_revision_delta`
- `run_engineering_checklist_mode`
- `plan_integrated_loudness_meter_path`
- `configure_true_peak_guardrails`
- `analyze_spectral_balance_fingerprint`
- `build_masking_map_v2`
- `enable_solo_safe_diagnostic_mode`
- `monitor_correlation_mono_sum`
- `plan_multiband_dynamics_chain`
- `generate_de_essing_automation_plan`
- `plan_vocal_rider`
- `suggest_parallel_processing_recipes`
- `manage_send_reverb_economy`
- `align_delay_coherence`
- `run_kick_bass_phase_lab`
- `build_drum_phase_alignment_pack`
- `apply_translation_presets`
- `build_headphone_translation_profile`
- `lock_master_chain_delta`
- `plan_stem_loudness_normalization`
- `generate_dynamic_range_report`
- `build_client_revision_ab_pack`
- `set_engineering_session_mode`
- `append_change_attribution_log`
- `run_blind_ab_helper`
- `plan_vocal_take_ladder`
- `plan_vocal_punch_in_session`
- `map_vocal_breath_noise_candidates`
- `run_vocal_room_tone_headphone_checklist`
- `run_vocal_comp_workflow_v2`
- `analyze_vocal_take_consistency`
- `plan_vocal_tuning_strategy`
- `plan_vocal_timing_tighten`
- `setup_vocal_doubles_stack`
- `plan_singer_plugin_chain`
- `run_pre_bounce_sibilance_check`
- `setup_warmup_then_record_scene`
- `generate_vocal_harmony_midi_scaffold`
- `setup_backing_vocal_bus`
- `configure_singer_warmup_metronome`
- `export_lyric_cue_sheet_from_clips`
- `run_vocal_ear_training_checklist`
- `manage_vocal_fx_snapshots`
- `audit_vocal_monitor_path_safety`
- `configure_vocal_setlist_scenes`
- `plan_vocal_delivery_variants`
- `plan_vocal_stem_export_naming`
- `plan_vocal_chain_ab_snapshots`
- `run_low_latency_vocal_tracking_checklist`
- `plan_duet_harmony_recording_session`
- `run_vocal_booth_session_start_macro`
- `plan_vocal_adlib_lane`
- `plan_vocal_tone_modes_scenes`
- `plan_choir_stack_builder`
- `plan_melody_to_midi_capture_workflow`
- `run_vocal_pitch_vibrato_analysis_placeholder`
- `run_vocal_breath_detector_v2_placeholder`
- `run_vocal_range_report_session`
- `sync_producer_singer_revision_notes`
- `plan_vocal_pronunciation_diction_guide`
- `run_vocal_health_fatigue_guard`
- `suggest_song_key_from_session_midi`
- `plan_lead_tuned_vs_raw_stem_matrix`
- `plan_sync_picture_vocal_cues`

Deeper execution notes:

- `setup_sidechain_bus` now resolves trigger/target tracks by name and performs best-effort routing/parameter writes.
- `semantic_clip_edit` now reads clip notes, applies prompt-driven transformations, and can write edited notes back.
- `semantic_clip_edit` supports `replaceMode=true` for best-effort clear-and-rewrite (falls back safely if clear endpoint is unavailable).
- `run_master_bus_guardrails` now evaluates measurable session checks (tempo/play state/track volume sample/warnings).
- `run_auto_mix_pass` now supports role-aware level/pan shaping based on detected track roles.
- `create_bus_architecture` now performs concrete routing writes using endpoint variants.
- `run_release_prep_pipeline` now chains measurable guardrail checks with real queued/optional-start deliverables jobs.
- `run_release_prep_pipeline` now supports guardrail fail-fast policy (`maxWarnings`) with explicit override (`force=true`).
- `resolve_kick_bass_conflict` now resolves tracks and applies concrete sidechain routing/parameter proxy writes.
- `run_release_readiness_score` now uses measurable live signals (tempo/play-state/volume outliers/command health).
- `run_post_export_qa` now checks deliverable consistency (master/streaming/stems presence + duplicate targets).
- `run_post_export_qa` supports strict matrix validation (`strictMatrix`) with expected variants (`expectedVariants`).
- Device parameter lock mode now blocks matching writes globally at execution time.
- Auto rollback policy now creates periodic checkpoints during mutating command flow.
- Device locks and rollback policy persist across restarts (`.ableton-device-locks.json`, `.ableton-rollback-policy.json`).
- Auto rollback policy now supports write-intent categories with per-category checkpoint frequency (`categoryEveryN`).

Notes on deeper execution:

- `generate_drum_pattern` can now optionally write generated drum MIDI notes to a target clip (`writeToClip=true` with `trackIndex`/`clipIndex`).
- `arrangement_intelligence` supports section-aware duplication ranges and optional start/end boundary locator creation.
- `arrangement_intelligence` now resolves saved named sections from memory when available.
- `run_mix_health_check` now reports per-track volume/pan/mute/solo/arm diagnostics with warning aggregation.

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
- Arrangement section memory is persisted to `.ableton-sections.json` and reused on restart.
- Arrangement section profiles are persisted to `.ableton-section-profiles.json` and reused on restart.
- Audit logs are written to `logs/audit.jsonl` (best-effort, append-only).
- Session event cache is in-memory and returned by `get_session_event_cache` (recent 200 events max).
- Capability profile scaffold is available via `detect_capability_profile`.
- If a specific endpoint differs in your AbletonOSC build, update it in `src/index.js`.
