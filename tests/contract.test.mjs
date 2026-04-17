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
