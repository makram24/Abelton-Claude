import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexPath = new URL("../src/index.js", import.meta.url);

async function source() {
  return readFile(indexPath, "utf8");
}

test("registers undo/redo tools", async () => {
  const src = await source();
  assert.match(src, /"undo"/);
  assert.match(src, /"redo"/);
});

test("registers fuzzy track tools", async () => {
  const src = await source();
  assert.match(src, /"find_track_by_name"/);
  assert.match(src, /"set_track_volume_by_name"/);
  assert.match(src, /"launch_clip_by_track_name"/);
});

test("registers render and dashboard tools", async () => {
  const src = await source();
  assert.match(src, /"render_project_audio"/);
  assert.match(src, /"render_stems"/);
  assert.match(src, /"get_metrics_dashboard"/);
});

test("registers action plan execution tools", async () => {
  const src = await source();
  assert.match(src, /"execute_action_plan"/);
  assert.match(src, /"get_allowed_plan_actions"/);
});

test("registers policy and profile tools", async () => {
  const src = await source();
  assert.match(src, /"get_policy_state"/);
  assert.match(src, /"set_policy_state"/);
  assert.match(src, /"render_with_profile"/);
  assert.match(src, /"write_device_automation_curve"/);
  assert.match(src, /OSC_ENDPOINT_VARIANTS/);
  assert.match(src, /"warmup_write_endpoints"/);
  assert.match(src, /"warmup_report_recommendations"/);
});

test("registers health and diagnostics tools", async () => {
  const src = await source();
  assert.match(src, /"health_live_test"/);
  assert.match(src, /"run_smoke_check"/);
  assert.match(src, /"get_protocol_diagnostics"/);
  assert.match(src, /"get_last_error"/);
  assert.match(src, /"set_safety_mode"/);
});

test("registers advanced scaffold tools", async () => {
  const src = await source();
  assert.match(src, /"get_ops_dashboard"/);
  assert.match(src, /"get_ops_dashboard_compact"/);
  assert.match(src, /"get_session_event_cache"/);
  assert.match(src, /"preflight_action_plan"/);
  assert.match(src, /"detect_capability_profile"/);
  assert.match(src, /"upsert_alias"/);
  assert.match(src, /"resolve_alias"/);
  assert.match(src, /"register_device_preset_alias"/);
  assert.match(src, /"list_alias_registry"/);
  assert.match(src, /"create_export_job"/);
  assert.match(src, /"run_export_job"/);
  assert.match(src, /"get_export_job"/);
  assert.match(src, /"list_export_jobs"/);
});

test("registers creative copilot expansion tools", async () => {
  const src = await source();
  assert.match(src, /"compile_musical_intent"/);
  assert.match(src, /"arrangement_intelligence"/);
  assert.match(src, /"run_mix_health_check"/);
  assert.match(src, /"apply_sound_design_macro"/);
  assert.match(src, /"generate_midi_phrase"/);
  assert.match(src, /"generate_drum_pattern"/);
  assert.match(src, /"compose_automation_helper"/);
  assert.match(src, /"performance_scene_action"/);
  assert.match(src, /"configure_live_safety_rails"/);
  assert.match(src, /"run_project_quality_checks"/);
  assert.match(src, /"reference_track_workflow"/);
  assert.match(src, /"export_batch_profiles"/);
  assert.match(src, /"set_user_preferences"/);
  assert.match(src, /"get_user_preferences"/);
  assert.match(src, /"ingest_voice_command"/);
  assert.match(src, /"semantic_plugin_control"/);
  assert.match(src, /"generate_collab_handoff"/);
  assert.match(src, /"explain_action_for_learning"/);
  assert.match(src, /"upsert_template_pack"/);
  assert.match(src, /"list_template_packs"/);
  assert.match(src, /"run_show_mode_checklist"/);
  assert.match(src, /"configure_external_hooks"/);
  assert.match(src, /"upsert_reactive_rule"/);
  assert.match(src, /"list_reactive_rules"/);
  assert.match(src, /"comp_take_assistant"/);
  assert.match(src, /"setup_sidechain_bus"/);
  assert.match(src, /"semantic_clip_edit"/);
  assert.match(src, /"harmony_arranger"/);
  assert.match(src, /"humanize_drums"/);
  assert.match(src, /"apply_fx_chain_template"/);
  assert.match(src, /"run_master_bus_guardrails"/);
  assert.match(src, /"prepare_stems_one_click"/);
  assert.match(src, /"session_diff_undo_bundle"/);
  assert.match(src, /"auto_scene_sequencer"/);
  assert.match(src, /"create_panic_macro"/);
  assert.match(src, /"run_macro"/);
  assert.match(src, /"record_prompt_macro"/);
  assert.match(src, /"project_cleanup_bot"/);
  assert.match(src, /"reference_match_assistant"/);
  assert.match(src, /"set_collaborator_mode"/);
  assert.match(src, /"task_linked_production_flow"/);
  assert.match(src, /"voice_live_mode_command"/);
  assert.match(src, /"plugin_preset_intelligence"/);
  assert.match(src, /"export_deliverables_matrix"/);
  assert.match(src, /"run_auto_mix_pass"/);
  assert.match(src, /"build_vocal_chain"/);
  assert.match(src, /"repair_clip_timing"/);
  assert.match(src, /"build_transition_between_sections"/);
  assert.match(src, /"shape_section_energy"/);
  assert.match(src, /"configure_adaptive_macro_performer"/);
  assert.match(src, /"auto_gain_stage_tracks"/);
  assert.match(src, /"create_bus_architecture"/);
  assert.match(src, /"set_latency_safe_recording_mode"/);
  assert.match(src, /"arrangement_completion_assistant"/);
  assert.match(src, /"detect_track_roles"/);
  assert.match(src, /"run_release_prep_pipeline"/);
  assert.match(src, /"smart_sample_audit"/);
  assert.match(src, /"schedule_macro_timeline"/);
  assert.match(src, /"configure_live_improv_guardrails"/);
  assert.match(src, /"diagnose_mix_issue"/);
  assert.match(src, /"optimize_plugin_chain"/);
  assert.match(src, /"set_session_goal"/);
  assert.match(src, /"manage_setlist"/);
  assert.match(src, /"export_session_documentation"/);
  assert.match(src, /"upsert_arrangement_section"/);
  assert.match(src, /"list_arrangement_sections"/);
  assert.match(src, /"export_arrangement_sections"/);
  assert.match(src, /"import_arrangement_sections"/);
  assert.match(src, /"save_arrangement_section_profile"/);
  assert.match(src, /"load_arrangement_section_profile"/);
  assert.match(src, /"clone_arrangement_section_map"/);
  assert.match(src, /"list_arrangement_section_profiles"/);
  assert.match(src, /"delete_arrangement_section_profile"/);
  assert.match(src, /"delete_arrangement_section"/);
});
