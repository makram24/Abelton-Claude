import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyFromSource } from "../scripts/tool-classifier-lib.mjs";
import {
  CORE_TOOLS,
  SCAFFOLD_TOOLS,
  assertTierPartition
} from "../src/toolTiers.js";

const indexPath = new URL("../src/index.js", import.meta.url);

async function source() {
  return readFile(indexPath, "utf8");
}

test("tool registry is fully partitioned into core vs scaffold", async () => {
  const src = await source();
  const { localOnly, directOsc, planRunner, tools } = classifyFromSource(src);
  assert.equal(localOnly.length, 0, "Expected zero local-only tools");
  assert.equal(tools.length, 121, "Expected 121 MCP tools defined in source");
  assert.equal(directOsc.length, 120);
  assert.deepEqual(planRunner, ["execute_action_plan"]);

  const names = tools.map((t) => t.name).sort();
  const { missing, duplicate, unknown } = assertTierPartition(names);
  assert.deepEqual(duplicate, [], "Tool must not be in both tiers");
  assert.deepEqual(unknown, [], "Every registered tool must be classified");
  assert.deepEqual(missing, [], "Tier lists must match registered tools");
  assert.equal(CORE_TOOLS.length + SCAFFOLD_TOOLS.length, 121);
});

test("core Live + plan entry points exist", async () => {
  const src = await source();
  assert.match(src, /"execute_action_plan"/);
  assert.match(src, /"undo"/);
  assert.match(src, /"redo"/);
  assert.match(src, /"set_tempo"/);
  assert.match(src, /"add_clip_notes"/);
  assert.match(src, /"generate_drum_pattern"/);
  assert.match(src, /OSC_ENDPOINT_VARIANTS/);
  assert.match(src, /function registerMcpTool/);
  assert.match(src, /ABLETON_ENABLE_SCAFFOLD_TOOLS/);
});

test("default surface is core-only (scaffolds gated)", () => {
  assert.equal(CORE_TOOLS.length, 69);
  assert.equal(SCAFFOLD_TOOLS.length, 52);
});
