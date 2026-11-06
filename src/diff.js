// A small unified line diff (LCS), bounded so a huge file never blocks a reply.
const MAX_CELLS = 4_000_000;

export function unifiedDiff(before, after, { path = "file", context = 3 } = {}) {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  if (a.length * b.length > MAX_CELLS) return { diff: null, summary: `too large for an inline diff (${a.length} → ${b.length} lines)`, added: null, removed: null };
  const n = a.length, m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push([" ", a[i++], j++]);
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) ops.push(["-", a[i++], j]);
    else ops.push(["+", b[j++], j]);
  }
  while (i < n) ops.push(["-", a[i++], j]);
  while (j < m) ops.push(["+", b[j++], j]);
  const changed = ops.map((o, k) => (o[0] !== " " ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return { diff: "", summary: "no change", added: 0, removed: 0 };
  const hunks = [];
  let start = Math.max(0, changed[0] - context), end = Math.min(ops.length, changed[0] + context + 1);
  for (const k of changed.slice(1)) {
    if (k - context <= end) end = Math.min(ops.length, k + context + 1);
    else {
      hunks.push([start, end]);
      start = Math.max(0, k - context);
      end = Math.min(ops.length, k + context + 1);
    }
  }
  hunks.push([start, end]);
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const [s0, e0] of hunks) {
    const slice = ops.slice(s0, e0);
    const aStart = ops.slice(0, s0).filter((o) => o[0] !== "+").length + 1;
    const bStart = ops.slice(0, s0).filter((o) => o[0] !== "-").length + 1;
    lines.push(`@@ -${aStart},${slice.filter((o) => o[0] !== "+").length} +${bStart},${slice.filter((o) => o[0] !== "-").length} @@`);
    for (const o of slice) lines.push(`${o[0]}${o[1]}`);
  }
  const added = ops.filter((o) => o[0] === "+").length, removed = ops.filter((o) => o[0] === "-").length;
  const text = lines.join("\n");
  return { diff: text.length > 20000 ? `${text.slice(0, 20000)}\n… (diff truncated)` : text, summary: `+${added} -${removed}`, added, removed };
}
