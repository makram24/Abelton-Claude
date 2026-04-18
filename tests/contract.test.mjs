import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyFromSource } from "../scripts/tool-classifier-lib.mjs";

const indexPath = new URL("../src/index.js", import.meta.url);

async function source() {
  return readFile(indexPath, "utf8");
}

test("only AbletonOSC-backed MCP tools are registered", async () => {
  const src = await source();
  const { localOnly, directOsc, planRunner, tools } = classifyFromSource(src);
  assert.equal(localOnly.length, 0, "Expected zero local-only tools");
  assert.equal(tools.length, 121, "Expected 121 MCP tools total");
  assert.equal(directOsc.length, 120);
  assert.deepEqual(planRunner, ["execute_action_plan"]);
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
});

test("classifier lib is loadable from tests", async () => {
  const libPath = join(dirname(fileURLToPath(import.meta.url)), "../scripts/tool-classifier-lib.mjs");
  const raw = await readFile(libPath, "utf8");
  assert.match(raw, /export function classifyFromSource/);
});
