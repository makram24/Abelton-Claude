import test from "node:test";
import assert from "node:assert/strict";
import { normalizeName, scoreNameMatch } from "../src/lib/names.js";
import { parseOscValue } from "../src/lib/oscParse.js";
import { classifyError } from "../src/lib/errors.js";
import { textResult } from "../src/lib/mcpResult.js";

test("normalizeName strips punctuation and casing", () => {
  assert.equal(normalizeName(" Kick-Drum_01 "), "kick drum 01");
});

test("scoreNameMatch ranks exact and partial names", () => {
  assert.equal(scoreNameMatch("drums", "drums"), 1);
  assert.ok(scoreNameMatch("drum", "drums") >= 0.9);
  assert.ok(scoreNameMatch("kick", "Kick Drum") > 0.5);
  assert.equal(scoreNameMatch("", "x"), 0);
});

test("parseOscValue reads single and multi-arg OSC messages", () => {
  assert.equal(parseOscValue({ args: [{ value: 120 }] }), 120);
  assert.deepEqual(parseOscValue({ args: [{ value: 1 }, { value: "A" }] }), [1, "A"]);
  assert.equal(parseOscValue(null, 42), 42);
});

test("classifyError maps known failure modes", () => {
  assert.equal(classifyError(new Error("Timeout waiting for OSC response")), "OSC_TIMEOUT");
  assert.equal(classifyError(new Error("Destructive action blocked")), "DESTRUCTIVE_CONFIRM_REQUIRED");
  assert.equal(classifyError(new Error("boom")), "UNKNOWN_ERROR");
});

test("textResult wraps JSON payload for MCP", () => {
  const out = textResult({ ok: true });
  assert.equal(out.content[0].type, "text");
  assert.match(out.content[0].text, /"ok": true/);
});
