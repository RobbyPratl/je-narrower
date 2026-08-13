// Consistency model for v8 — proving the demo beat lands with honest arithmetic
// before it goes into the prototype.
//
// consistency = the WEAKEST attribute agreement, not the mean.
// Rationale: a uniform preparer does not help you conclude on a group whose
// amounts vary 10x. The group is only as concludable as its worst attribute.
//
// amt agreement is magnitude-aware: 1 - mean(|x - median| / median), floored at 0.
// The other four are count-based: fraction of members matching the modal value.

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const modeOf = (xs) => {
  const c = {}; let best = null, n = -1;
  for (const x of xs) { c[x] = (c[x] || 0) + 1; if (c[x] > n) { n = c[x]; best = x; } }
  return [best, n];
};

function consistency(members) {
  const n = members.length;
  if (!n) return { score: 0, attrs: [] };
  const med = median(members.map(m => m.amount)) || 1;
  const amtAgree = Math.max(0, 1 - members.reduce((s, m) => s + Math.abs(m.amount - med) / med, 0) / n);
  const frac = (key) => modeOf(members.map(m => m[key]))[1] / n;
  const attrs = [
    ['amt', amtAgree],
    ['prep', frac('preparer')],
    ['time', members.filter(m => m.monthEnd).length / n],
    ['desc', members.filter(m => m.narration).length / n],
    ['lines', frac('lines')],
  ];
  return { score: Math.min(...attrs.map(a => a[1])), attrs, median: med, n };
}

// ---- the demo group: 45 entries on 6210 / 2110 ----
let seed = 6210211;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

const members = [];
for (let i = 0; i < 44; i++) {
  members.push({
    id: 'ACC-JV-' + String(102 + i * 7).padStart(4, '0'),
    amount: Math.round(8600 * (1 + (rnd() - 0.5) * 0.24) * 100) / 100, // ±12% band, ~6% mean deviation
    preparer: 'R',
    monthEnd: true,
    narration: i !== 11 && i !== 29,
    lines: 2,
  });
}
const outlier = { id: 'ACC-JV-0388', amount: 88400, preparer: 'M', monthEnd: false, narration: true, lines: 2 };

const withOutlier = consistency([...members, outlier]);
const without = consistency(members);

const show = (label, c) => {
  console.log(`\n${label}  n=${c.n}  median=${c.median.toFixed(2)}`);
  for (const [k, v] of c.attrs) console.log(`   ${k.padEnd(6)} ${v.toFixed(3)}`);
  console.log(`   ${'SCORE'.padEnd(6)} ${c.score.toFixed(2)}  (weakest attribute)`);
};
show('WITH outlier   ', withOutlier);
show('WITHOUT outlier', without);
console.log(`\n>>> demo beat: ${withOutlier.score.toFixed(2)} -> ${without.score.toFixed(2)}`);
console.log(`>>> brief asks for: 0.71 -> 0.94`);
