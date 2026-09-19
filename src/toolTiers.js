/**
 * Portfolio-honest tool tiers.
 * CORE = real Ableton Live control / reads / MIDI writers / health / export / plans.
 * SCAFFOLD = heuristic planners, checklists, and name-proxy "intelligence" (not DSP).
 */

export const CORE_TOOLS = Object.freeze([
  "health_live_test",
  "run_smoke_check",
  "undo",
  "redo",
  "execute_action_plan",
  "refresh_state_cache",
  "detect_capability_profile",
  "write_device_automation_curve",
  "render_with_profile",
  "create_export_job",
  "run_export_job",
  "set_track_routing",
  "load_device_preset",
  "warmup_write_endpoints",
  "find_track_by_name",
  "set_track_volume_by_name",
  "launch_clip_by_track_name",
  "render_project_audio",
  "render_stems",
  "reprobe_endpoints",
  "heartbeat",
  "start_playback",
  "stop_playback",
  "set_tempo",
  "get_tempo",
  "launch_clip",
  "stop_track_clips",
  "stop_all_clips",
  "launch_scene",
  "list_tracks",
  "get_session_overview",
  "get_track_devices",
  "get_device_parameters",
  "set_device_parameter",
  "create_midi_clip",
  "delete_clip",
  "set_track_name",
  "get_track_mixer",
  "set_track_mixer",
  "set_track_state",
  "set_track_monitoring_mode",
  "prepare_midi_track_for_clip_playback",
  "list_scenes",
  "create_scene",
  "rename_scene",
  "delete_scene",
  "get_clip_notes",
  "add_clip_notes",
  "set_transport_flags",
  "set_loop_region",
  "set_arrangement_punch",
  "create_locator",
  "jump_to_time",
  "arrangement_duplicate_range",
  "arrangement_delete_range",
  "set_device_automation_point",
  "capture_session_snapshot",
  "restore_session_snapshot",
  "generate_midi_phrase",
  "generate_drum_pattern",
  "performance_scene_action",
  "export_batch_profiles",
  "error_recovery_autopilot",
  "restore_live_emergency_state",
  "generate_vocal_harmony_midi_scaffold",
  "semantic_clip_edit",
  "humanize_drums",
  "apply_fx_chain_template",
  "export_deliverables_matrix"
]);

export const SCAFFOLD_TOOLS = Object.freeze([
  "subscribe_session_events",
  "arrangement_intelligence",
  "run_mix_health_check",
  "apply_sound_design_macro",
  "semantic_plugin_control",
  "run_auto_mix_pass",
  "auto_gain_stage_tracks",
  "create_bus_architecture",
  "detect_track_roles",
  "run_release_prep_pipeline",
  "resolve_kick_bass_conflict",
  "run_release_readiness_score",
  "set_drum_bus_punch_mode",
  "run_phase_alignment_check",
  "run_masking_analysis",
  "optimize_bus_compression",
  "run_stereo_image_optimizer",
  "run_master_chain_safety_scan",
  "run_mix_translation_diagnostics",
  "optimize_clip_gain",
  "run_noise_floor_check",
  "run_loudness_workflow_assistant",
  "analyze_spectral_balance_fingerprint",
  "build_masking_map_v2",
  "monitor_correlation_mono_sum",
  "generate_de_essing_automation_plan",
  "plan_vocal_rider",
  "manage_send_reverb_economy",
  "align_delay_coherence",
  "run_kick_bass_phase_lab",
  "build_drum_phase_alignment_pack",
  "generate_dynamic_range_report",
  "plan_vocal_punch_in_session",
  "map_vocal_breath_noise_candidates",
  "analyze_vocal_take_consistency",
  "setup_vocal_doubles_stack",
  "run_pre_bounce_sibilance_check",
  "setup_warmup_then_record_scene",
  "setup_backing_vocal_bus",
  "configure_singer_warmup_metronome",
  "export_lyric_cue_sheet_from_clips",
  "plan_duet_harmony_recording_session",
  "run_vocal_booth_session_start_macro",
  "plan_melody_to_midi_capture_workflow",
  "sync_producer_singer_revision_notes",
  "suggest_song_key_from_session_midi",
  "plan_sync_picture_vocal_cues",
  "setup_sidechain_bus",
  "run_master_bus_guardrails",
  "create_panic_macro",
  "run_macro",
  "voice_live_mode_command"
]);

const coreSet = new Set(CORE_TOOLS);
const scaffoldSet = new Set(SCAFFOLD_TOOLS);

export function isCoreTool(name) {
  return coreSet.has(name);
}

export function isScaffoldTool(name) {
  return scaffoldSet.has(name);
}

export function assertTierPartition(allToolNames) {
  const missing = [];
  const duplicate = [];
  const unknown = [];
  for (const name of allToolNames) {
    const inCore = coreSet.has(name);
    const inScaffold = scaffoldSet.has(name);
    if (inCore && inScaffold) duplicate.push(name);
    else if (!inCore && !inScaffold) unknown.push(name);
  }
  for (const name of CORE_TOOLS) {
    if (!allToolNames.includes(name)) missing.push(name);
  }
  for (const name of SCAFFOLD_TOOLS) {
    if (!allToolNames.includes(name)) missing.push(name);
  }
  return { missing, duplicate, unknown };
}
