/** Shared parser for registerMcpTool(...) / server.registerTool(...) blocks in src/index.js */

export const oscSignals = [
  "sendMaybe(",
  "sendKnownMaybe(",
  "sendKnownRaw(",
  "sendPlanRaw(",
  "requestAny(",
  "requestKnown(",
  "probeEndpoint(",
  "oscClient.request(",
  "oscClient.send(",
  "getTracksSnapshot(",
  "refreshStateCache(",
  "runCapabilityProbe(",
  "resolveTrackIndexFromName(",
  "dispatchPlanAction("
];

export function extractParenGroup(s, openParenIndex) {
  let i = openParenIndex + 1;
  let depth = 1;
  const n = s.length;
  while (i < n && depth > 0) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") {
      i += 2;
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n) {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n) {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === "`") {
          i++;
          break;
        }
        if (s[i] === "$" && s[i + 1] === "{") {
          i += 2;
          let tmpl = 1;
          while (i < n && tmpl > 0) {
            if (s[i] === "{") tmpl++;
            else if (s[i] === "}") tmpl--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return [openParenIndex + 1, i];
}

export function listRegisterTools(src) {
  const needles = ["registerMcpTool", "server.registerTool"];
  const tools = [];
  const seen = new Set();
  for (const needle of needles) {
    let pos = 0;
    while (pos < src.length) {
      const hit = src.indexOf(needle, pos);
      if (hit === -1) break;
      // Skip the wrapper definition: function registerMcpTool(
      const before = src.slice(Math.max(0, hit - 20), hit);
      if (/function\s*$/.test(before.trimEnd()) || /function\s+$/.test(before)) {
        pos = hit + needle.length;
        continue;
      }
      const parenIdx = src.indexOf("(", hit + needle.length);
      if (parenIdx === -1) break;
      const group = extractParenGroup(src, parenIdx);
      if (!group) break;
      const [innerStart, endAfterClose] = group;
      const inner = src.slice(innerStart, endAfterClose - 1);
      const nameMatch = inner.match(/^\s*"([^"]+)"/);
      if (!nameMatch) {
        pos = endAfterClose;
        continue;
      }
      const name = nameMatch[1];
      if (seen.has(name)) {
        pos = endAfterClose;
        continue;
      }
      seen.add(name);
      const usesOsc = oscSignals.some((sig) => inner.includes(sig));
      const usesPlanRunner = inner.includes("runActionPlanExecution(");
      let endExclusive = endAfterClose;
      if (src[endExclusive] === ";") endExclusive++;
      while (endExclusive < src.length && (src[endExclusive] === "\n" || src[endExclusive] === "\r")) {
        endExclusive++;
      }
      tools.push({ name, usesOsc, usesPlanRunner, start: hit, end: endExclusive });
      pos = endExclusive;
    }
  }
  return tools;
}

export function classifyFromSource(src) {
  const tools = listRegisterTools(src);
  const directOsc = tools.filter((t) => t.usesOsc).map((t) => t.name);
  const planRunner = tools.filter((t) => !t.usesOsc && t.usesPlanRunner).map((t) => t.name);
  const localOnly = tools.filter((t) => !t.usesOsc && !t.usesPlanRunner).map((t) => t.name);
  return { tools, directOsc, planRunner, localOnly };
}
