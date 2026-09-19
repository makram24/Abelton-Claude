/**
 * Maintenance: strip local-only tools from src/index.js.
 * Prefer ABLETON_ENABLE_SCAFFOLD_TOOLS gating over deleting source.
 * Run only when you intend to mutate index.js.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyFromSource, listRegisterTools } from "./tool-classifier-lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const indexPath = join(root, "src", "index.js");

let src = readFileSync(indexPath, "utf8");
const { localOnly } = classifyFromSource(src);
const remove = new Set(localOnly);

const blocks = listRegisterTools(src);
const toRemove = blocks.filter((b) => remove.has(b.name)).sort((a, b) => b.start - a.start);

let out = src;
for (const { start, end, name } of toRemove) {
  out = out.slice(0, start) + out.slice(end);
  console.error("removed", name);
}

writeFileSync(indexPath, out, "utf8");
console.error("done", { removed: toRemove.length, remaining: listRegisterTools(out).length });
