import test from "node:test";
import assert from "node:assert/strict";

test("config defaults keep scaffolds off and role at operator", async () => {
  const prevScaffold = process.env.ABLETON_ENABLE_SCAFFOLD_TOOLS;
  const prevRole = process.env.ABLETON_DEFAULT_ROLE;
  delete process.env.ABLETON_ENABLE_SCAFFOLD_TOOLS;
  delete process.env.ABLETON_DEFAULT_ROLE;

  // Fresh import after env clear — use dynamic import with cache bust
  const { getConfig } = await import(`../src/config.js?t=${Date.now()}`);
  const cfg = getConfig();
  assert.equal(cfg.ABLETON_ENABLE_SCAFFOLD_TOOLS, false);
  assert.equal(cfg.ABLETON_DEFAULT_ROLE, "operator");
  assert.equal(cfg.ABLETON_REQUIRE_DESTRUCTIVE_CONFIRM, true);

  if (prevScaffold !== undefined) process.env.ABLETON_ENABLE_SCAFFOLD_TOOLS = prevScaffold;
  if (prevRole !== undefined) process.env.ABLETON_DEFAULT_ROLE = prevRole;
});
