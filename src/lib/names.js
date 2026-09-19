/** Fuzzy track/name matching helpers (pure). */

export function normalizeName(v) {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function scoreNameMatch(query, candidate) {
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.startsWith(q)) return 0.9;
  if (c.includes(q)) return 0.75;
  const qTokens = q.split(" ").filter(Boolean);
  const cTokens = c.split(" ").filter(Boolean);
  const overlap = qTokens.filter((t) => cTokens.includes(t)).length;
  return (overlap / Math.max(qTokens.length, 1)) * 0.6;
}
