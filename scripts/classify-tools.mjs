import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyFromSource } from "./tool-classifier-lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, "src", "index.js"), "utf8");
const { directOsc, planRunner, localOnly } = classifyFromSource(src);

console.log(
  JSON.stringify(
    {
      total: directOsc.length + planRunner.length + localOnly.length,
      directOscCount: directOsc.length,
      planRunnerCount: planRunner.length,
      localOnlyCount: localOnly.length,
      directOsc: directOsc.sort(),
      planRunnerIndirectOsc: planRunner.sort(),
      localOnly: localOnly.sort()
    },
    null,
    2
  )
);
