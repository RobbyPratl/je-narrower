// v5 script 1 — foundations + W1 Default
// Run via use_figma. Auto-layout stacking only; nodes resolved by name.
// Manual coordinate math is confined to cadenceCell() and amountStrip(), where it is unavoidable.

// ---------------------------------------------------------------- setup
const PAGE_NAME = "v5";
let page = figma.root.children.find((p) => p.name === PAGE_NAME);
if (!page) { page = figma.createPage(); page.name = PAGE_NAME; }
await figma.setCurrentPageAsync(page);

const FONTS = [
  ["Instrument Sans", "Regular"], ["Instrument Sans", "Medium"], ["Instrument Sans", "SemiBold"],
  ["Martian Mono", "Regular"], ["Martian Mono", "Medium"], ["Martian Mono", "SemiBold"],
];
await Promise.all(FONTS.map(([family, style]) => figma.loadFontAsync({ family, style })));

const hex = (h) => ({
  r: parseInt(h.slice(1, 3), 16) / 255,
  g: parseInt(h.slice(3, 5), 16) / 255,
  b: parseInt(h.slice(5, 7), 16) / 255,
});

// v5 palette — colour encodes epistemic status, never hierarchy
const T = {
  ground:   "#F7F8F9",  // background
  ink:      "#16181D",  // fact, sourced or computed — checkable
  mute:     "#8A9099",  // structure, axes, inactive marks
  inferred: "#4C5FD5",  // interpretation — not checkable
  signal:   "#C2410C",  // unusual, or deviating from a group
  verified: "#0F766E",  // a human concluded
};
const fill = (t, o) => [{ type: "SOLID", color: hex(T[t] || t), opacity: o === undefined ? 1 : o }];

// ---------------------------------------------------------------- tokens
{
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  let col = cols.find((c) => c.name === "JE");
  if (!col) {
    col = figma.variables.createVariableCollection("JE");
    col.renameMode(col.modes[0].modeId, "Default");
  }
  const mode = col.modes[0].modeId;
  const existing = {};
  for (const id of col.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (v) existing[v.name] = v;
  }
  // slate is retired — v5 has no dark surface
  if (existing["slate"]) { existing["slate"].remove(); delete existing["slate"]; }
  // retrieved becomes inferred: same hex, narrower meaning
  if (existing["retrieved"] && !existing["inferred"]) {
    existing["retrieved"].name = "inferred";
    existing["inferred"] = existing["retrieved"];
    delete existing["retrieved"];
  }
  const SPEC = [
    ["ground",   "#F7F8F9", ["FRAME_FILL", "SHAPE_FILL"], "Background. Cool paper, not cream."],
    ["ink",      "#16181D", ["TEXT_FILL", "FRAME_FILL", "SHAPE_FILL", "STROKE_COLOR"], "Fact — sourced or computed. Checkable."],
    ["mute",     "#8A9099", ["TEXT_FILL", "STROKE_COLOR", "SHAPE_FILL"], "Structure, axes, inactive marks."],
    ["inferred", "#4C5FD5", ["TEXT_FILL", "STROKE_COLOR", "FRAME_FILL", "SHAPE_FILL"], "Interpretation. Not checkable."],
    ["signal",   "#C2410C", ["TEXT_FILL", "STROKE_COLOR", "FRAME_FILL", "SHAPE_FILL"], "Unusual, or deviating from a group."],
    ["verified", "#0F766E", ["TEXT_FILL", "STROKE_COLOR", "FRAME_FILL", "SHAPE_FILL"], "A human concluded."],
  ];
  for (const [name, h, scopes, desc] of SPEC) {
    const v = existing[name] || figma.variables.createVariable(name, col, "COLOR");
    v.setValueForMode(mode, hex(h));
    v.scopes = scopes;
    v.description = desc;
  }
}

// ---------------------------------------------------------------- text styles
{
  const local = figma.getLocalTextStylesAsync
    ? await figma.getLocalTextStylesAsync()
    : figma.getLocalTextStyles();
  const have = new Set(local.map((s) => s.name));
  const SPEC = [
    ["ui/11",       "Instrument Sans", "Medium",   11, 16, 0],
    ["ui/11 label", "Instrument Sans", "Medium",   11, 16, 4],
    ["ui/12",       "Instrument Sans", "Regular",  12, 18, 0],
    ["ui/13",       "Instrument Sans", "Medium",   13, 20, 0],
    ["ui/15",       "Instrument Sans", "Medium",   15, 22, -1],
    ["ui/20",       "Instrument Sans", "SemiBold", 20, 26, -1.5],
    ["ui/28",       "Instrument Sans", "SemiBold", 28, 34, -2],
    ["prose/13",    "Instrument Sans", "Regular",  13, 22, 0],
    ["data/11",     "Martian Mono",    "Regular",  11, 16, -4],
    ["data/11 med", "Martian Mono",    "Medium",   11, 16, -4],
    ["data/12",     "Martian Mono",    "Regular",  12, 18, -4],
    ["data/13",     "Martian Mono",    "Medium",   13, 20, -4],
    ["data/20",     "Martian Mono",    "Medium",   20, 26, -4],
    ["data/28",     "Martian Mono",    "SemiBold", 28, 34, -4],
  ];
  for (const [name, family, style, size, lh, ls] of SPEC) {
    if (have.has(name)) continue;
    const s = figma.createTextStyle();
    s.name = name;
    s.fontName = { family, style };
    s.fontSize = size;
    s.lineHeight = { unit: "PIXELS", value: lh };
    s.letterSpacing = { unit: "PERCENT", value: ls };
  }
}

// ---------------------------------------------------------------- helpers
const V = (p) => { const f = figma.createAutoLayout("VERTICAL", p || {}); f.fills = []; return f; };
const H = (p) => { const f = figma.createAutoLayout("HORIZONTAL", p || {}); f.fills = []; return f; };
const mono = (c, s, st, tok, o) => {
  const t = figma.createText();
  t.fontName = { family: "Martian Mono", style: st || "Regular" };
  t.fontSize = s; t.letterSpacing = { unit: "PERCENT", value: -4 };
  t.lineHeight = { unit: "PIXELS", value: s + 5 };
  t.characters = c; t.fills = fill(tok || "ink", o);
  return t;
};
const sans = (c, s, st, tok, o, ls) => {
  const t = figma.createText();
  t.fontName = { family: "Instrument Sans", style: st || "Medium" };
  t.fontSize = s; t.letterSpacing = { unit: "PERCENT", value: ls === undefined ? 0 : ls };
  t.lineHeight = { unit: "PIXELS", value: s + 5 };
  t.characters = c; t.fills = fill(tok || "ink", o);
  return t;
};
const box = (w, h) => { const f = figma.createFrame(); f.resize(w, Math.max(h, 0.01)); f.fills = []; f.clipsContent = false; return f; };
const rect = (w, h, tok, o, r) => { const q = figma.createRectangle(); q.resize(w, h); q.fills = fill(tok, o); if (r) q.cornerRadius = r; return q; };
const grow = (p) => { const f = box(10, 4); p.appendChild(f); f.layoutSizingHorizontal = "FILL"; return f; };
const hrule = (p, o) => { const r = rect(100, 1, "ink", o === undefined ? 0.06 : o); p.appendChild(r); r.layoutSizingHorizontal = "FILL"; return r; };
const cell = (node, w, align) => {
  const f = box(w, 16);
  f.appendChild(node);
  node.y = 0;
  node.x = align === "right" ? w - node.width : align === "center" ? (w - node.width) / 2 : 0;
  return f;
};
const tickMark = (tok) => {
  const v = figma.createVector();
  v.name = "tick";
  v.vectorPaths = [{ windingRule: "NONE", data: "M 0.5 5.4 C 1.6 6.2 2.8 7.4 3.9 9.2 C 5.8 5.6 8.2 2.4 11 0.5" }];
  v.strokes = fill(tok || "verified", 1);
  v.strokeWeight = 1.75; v.strokeCap = "ROUND"; v.strokeJoin = "ROUND";
  v.fills = []; v.rotation = -3;
  return v;
};

// ---------------------------------------------------------------- layout constants
const W = 1440;
const PAD = 24;
const ROW_H = 28;              // compact density — v5 default
// cadence is sized so the columns total exactly W — the table is the application,
// it should not leave a gutter. 48 padding + 108 gaps + 1284 columns = 1440.
const COL = {
  pair: 152, count: 40, cadence: 672, consist: 104, amount: 168, prep: 64, status: 84,
};
const GAP = 18;
const TABLE_W = PAD * 2 + Object.values(COL).reduce((a, b) => a + b, 0) + GAP * 6;

// Shared scales — module constants, never per-row.
// v5: "Per-row auto-scaling makes the column lie."
const AMT_MAX = 92000;         // covers the 88.4k deviation
const MONTHS = ["J","F","M","A","M","J","J","A","S","O","N","D"];
const MCELL = COL.cadence / 12;

// ---------------------------------------------------------------- cell visuals
// Cadence sparkline. Marks positioned by month on the axis shared with the header,
// so marks align column-wise across every row. Size encodes amount on the shared scale.
const cadenceCell = (marks) => {
  const f = box(COL.cadence, ROW_H - 8);
  const midY = (ROW_H - 8) / 2;
  for (let m = 0; m < 12; m++) {
    const t = rect(1, ROW_H - 12, "mute", 0.16);
    f.appendChild(t);
    t.x = m * MCELL + MCELL / 2; t.y = 2;
  }
  for (const mk of marks) {
    const r = 1.6 + Math.sqrt(Math.min(mk.amt, AMT_MAX) / AMT_MAX) * 3.2;
    const d = figma.createEllipse();
    d.resize(r * 2, r * 2);
    d.fills = fill(mk.dev ? "signal" : "ink", mk.dev ? 1 : 0.78);
    f.appendChild(d);
    d.x = mk.m * MCELL + (mk.f === undefined ? 0.5 : mk.f) * MCELL - r;
    d.y = midY - r;
  }
  return f;
};

// Consistency bar. Solid means one decision; a gap means look closer.
const consistencyBar = (score) => {
  const f = box(COL.consist, 16);
  const bw = COL.consist - 44;   // leaves room for the numeric label without overflowing
  if (score === null) {                       // deviation — no group consistency exists
    for (let i = 0; i < 7; i++) {
      const d = rect(4, 3, "mute", 0.42);
      f.appendChild(d); d.x = i * 7.5; d.y = 7;
    }
    return f;
  }
  const tr = rect(bw, 5, "ink", 0.09); f.appendChild(tr); tr.y = 6;
  const fl = rect(Math.max(2, bw * score), 5, "ink", 0.72); f.appendChild(fl); fl.y = 6;
  const lb = mono(score.toFixed(2), 11, "Regular", "ink", 0.42);
  f.appendChild(lb); lb.x = bw + 8; lb.y = 0;
  return f;
};

// Amount range strip on the shared scale. Narrow reads formulaic; wide reads ad hoc.
const amountStrip = (min, max, med, dev) => {
  const f = box(COL.amount, 16);
  const track = COL.amount - 96;  // "12.4k-13.1k" is the widest label this must clear
  // Square-root scale. Still ONE scale shared by every row — v5's rule is against
  // per-row auto-scaling, not against non-linear scales. Linear put the 88.4k
  // deviation at the far right and squashed every 2–13k row into ~1px, which made
  // the column unreadable for the common case.
  const x = (v) => Math.sqrt(Math.min(v, AMT_MAX) / AMT_MAX) * track;
  const base = rect(track, 1, "mute", 0.28); f.appendChild(base); base.y = 8;
  const span = Math.max(2, x(max) - x(min));
  const bar = rect(span, 5, dev ? "signal" : "ink", dev ? 1 : 0.68);
  f.appendChild(bar); bar.x = x(min); bar.y = 6;
  if (max - min > 0) {
    const m = rect(1, 9, "ground", 1); f.appendChild(m); m.x = x(med); m.y = 4;
  }
  const fmt = (v) => (v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(v));
  const lbl = mono(min === max ? fmt(min) : `${fmt(min)}-${fmt(max)}`, 11, "Regular", dev ? "signal" : "ink", dev ? 1 : 0.75);
  f.appendChild(lbl); lbl.x = track + 10; lbl.y = 0;
  return f;
};

// Preparer chip: initial for one, joined initials for two, count for more, glyph for a system account.
const preparerChip = (prep) => {
  const f = box(COL.prep, 16);
  if (prep.type === "sys") {
    const g = rect(9, 9, "mute", 0.75, 1); f.appendChild(g); g.x = 0; g.y = 3;
    const t = mono("sys", 11, "Regular", "mute", 1); f.appendChild(t); t.x = 14;
    return f;
  }
  const t = mono(prep.label, 11, "Medium", "ink", 0.8);
  f.appendChild(t);
  if (prep.type === "many") {
    const b = mono(`+${prep.more}`, 11, "Regular", "ink", 0.4);
    f.appendChild(b); b.x = t.width + 5;
  }
  return f;
};

const statusCell = (status) => {
  const f = box(COL.status, 16);
  if (status === "reviewed") {
    const k = tickMark(); k.x = 0; k.y = 3; f.appendChild(k);
    const l = mono("reviewed", 11, "Regular", "verified", 0.92); l.x = 19; f.appendChild(l);
  } else if (status === "concluded") {
    const k = tickMark(); k.x = 0; k.y = 3; f.appendChild(k);
    const l = mono("concluded", 11, "Regular", "verified", 0.92); l.x = 19; f.appendChild(l);
  } else {
    f.appendChild(mono("open", 11, "Regular", "ink", 0.38));
  }
  return f;
};

const ruleChip = (label, tone) => {
  const c = H({ paddingLeft: 5, paddingRight: 5, paddingTop: 1, paddingBottom: 1, cornerRadius: 2, counterAxisAlignItems: "CENTER" });
  c.strokes = fill(tone === "signal" ? "signal" : "ink", tone === "signal" ? 0.4 : 0.14);
  c.strokeWeight = 1;
  c.appendChild(mono(label, 11, "Regular", tone === "signal" ? "signal" : "ink", tone === "signal" ? 1 : 0.6));
  return c;
};

// ---------------------------------------------------------------- fixture
const monthly = (amt, n) => Array.from({ length: n || 12 }, (_, i) => ({ m: i, f: 0.5, amt }));

const ROWS = [
  { kind:"group", glyph:">", pair:"6210 / 2110", count:45, marks:monthly(8600),
    consist:0.95, amt:[8200,9100,8600], prep:{type:"one",label:"R"}, status:"open",
    rules:["round_amount","off_hours"] },

  { kind:"group", glyph:">", pair:"5100 / 1590", count:12, marks:monthly(4000),
    consist:0.93, amt:[4000,4000,4000], prep:{type:"sys"}, status:"open",
    rules:["off_hours"] },

  { kind:"group", glyph:">", pair:"1100 / 4200", count:28, marks:monthly(12700),
    consist:0.88, amt:[12400,13100,12700], prep:{type:"one",label:"A"}, status:"open",
    rules:["round_amount"] },

  { kind:"deviation", glyph:"!", pair:"6210 / 2110", count:1,
    marks:[{ m:7, f:0.52, amt:88400, dev:true }],
    consist:null, amt:[88400,88400,88400], prep:{type:"one",label:"M"}, status:"open",
    rules:["deviation","amt 5x group median","different preparer"] },

  { kind:"group", glyph:"v", pair:"4010 / 2300", count:3, expanded:true,
    marks:[{ m:8, f:0.45, amt:25000 }, { m:8, f:0.93, amt:25000 }, { m:9, f:0.38, amt:40000 }],
    consist:0.33, amt:[25000,40000,25000], prep:{type:"one",label:"R,M"}, status:"open",
    rules:["pair_rarity","new_pair","round_amount"],
    children:[
      { id:"ACC-JV-0417", date:"14 Sep", amount:"25,000.00", score:0.62, rules:["pr","np","ra"], status:"open", selected:true },
      { id:"ACC-JV-0463", date:"28 Sep", amount:"25,000.00", score:0.62, rules:["pr","np","ra"], status:"open" },
      { id:"ACC-JV-0501", date:"12 Oct", amount:"40,000.00", score:0.71, rules:["pr","np"], status:"reviewed" },
    ] },

  { kind:"group", glyph:">", pair:"5200 / 1000", count:18, marks:monthly(2250),
    consist:0.91, amt:[2100,2400,2250], prep:{type:"sys"}, status:"reviewed",
    rules:["off_hours"] },

  { kind:"individual", glyph:"·", pair:"6800 / 2210", count:1,
    marks:[{ m:10, f:0.6, amt:15000 }],
    consist:null, amt:[15000,15000,15000], prep:{type:"one",label:"R"}, status:"reviewed",
    rules:["round_amount"] },

  { kind:"deviation", glyph:"!", pair:"5100 / 1590", count:1,
    marks:[{ m:2, f:0.34, amt:41200, dev:true }],
    consist:null, amt:[41200,41200,41200], prep:{type:"one",label:"A"}, status:"open",
    rules:["deviation","amt 9x group median"] },

  { kind:"group", glyph:">", pair:"4010 / 1100", count:9,
    marks:[{m:1,f:.4,amt:6000},{m:3,f:.5,amt:7400},{m:5,f:.3,amt:11200},{m:6,f:.7,amt:8100},
           {m:8,f:.2,amt:6600},{m:9,f:.8,amt:9900},{m:11,f:.45,amt:7200}],
    consist:0.72, amt:[6000,11200,7400], prep:{type:"one",label:"R,A"}, status:"open",
    rules:["pair_rarity"] },

  { kind:"group", glyph:">", pair:"2400 / 1000", count:24, marks:monthly(3100),
    consist:0.90, amt:[2900,3300,3100], prep:{type:"sys"}, status:"reviewed",
    rules:["off_hours"] },

  { kind:"individual", glyph:"·", pair:"7100 / 2110", count:1,
    marks:[{ m:5, f:0.28, amt:32500 }],
    consist:null, amt:[32500,32500,32500], prep:{type:"one",label:"M"}, status:"open",
    rules:["round_amount","posted_effective_gap"] },

  { kind:"group", glyph:">", pair:"1400 / 5100", count:16,
    marks:[{m:0,f:.5,amt:5200},{m:1,f:.5,amt:5400},{m:2,f:.5,amt:5100},{m:3,f:.5,amt:5600},
           {m:4,f:.5,amt:5300},{m:5,f:.5,amt:5500},{m:6,f:.5,amt:5200},{m:7,f:.5,amt:5400}],
    consist:0.86, amt:[5100,5600,5300], prep:{type:"one",label:"A"}, status:"open",
    rules:["pair_rarity","round_amount"] },
];

// ---------------------------------------------------------------- screen
const old = page.children.find((c) => c.name === "W1 — Default");
if (old) old.remove();

const W1 = V({ name: "W1 — Default", itemSpacing: 0 });
W1.fills = fill("ground");
page.appendChild(W1);
W1.resize(W, 900);
W1.counterAxisSizingMode = "FIXED";
W1.primaryAxisSizingMode = "FIXED";
W1.clipsContent = true;
W1.x = 0; W1.y = 0;

// ---- status bar: one line when reconciled
const bar = H({ name: "Status bar", paddingLeft: PAD, paddingRight: PAD, itemSpacing: 0, counterAxisAlignItems: "CENTER" });
W1.appendChild(bar);
bar.layoutSizingHorizontal = "FILL";
bar.layoutSizingVertical = "FIXED";
bar.resize(bar.width, 44);
bar.counterAxisSizingMode = "FIXED";
{
  const k = tickMark(); const kb = box(12, 10); kb.appendChild(k);
  bar.appendChild(kb);
  const sp = box(9, 4); bar.appendChild(sp);
  bar.appendChild(sans("Reconciled", 13, "Medium", "ink", 1));
  // separators as plain siblings — the row is CENTER aligned, so no manual offsets
  const meta = [["meridian-2025", 0.7, "Regular"], ["FY25 P1-P2", 0.7, "Regular"],
                ["1,972 entries", 0.7, "Regular"], ["203 flagged", 0.9, "Medium"]];
  for (const [txt, op, st] of meta) {
    bar.appendChild(box(10, 4));
    bar.appendChild(mono("·", 11, "Regular", "mute", 1));
    bar.appendChild(box(10, 4));
    bar.appendChild(mono(txt, 11, st, "ink", op));
  }
  grow(bar);
  const toggle = (label, on) => {
    const b = H({ paddingLeft: 9, paddingRight: 9, paddingTop: 4, paddingBottom: 4, cornerRadius: 3, counterAxisAlignItems: "CENTER" });
    b.name = `toggle ${label}`;
    b.fills = on ? fill("ink", 0.07) : [];
    b.strokes = fill("ink", on ? 0.28 : 0.14); b.strokeWeight = 1;
    b.appendChild(sans(label, 11, "Medium", "ink", on ? 0.9 : 0.55));
    return b;
  };
  // all three panels are off by default in v5
  for (const [l, on] of [["profile", false], ["graph", false], ["columns", false]]) {
    bar.appendChild(toggle(l, on));
    bar.appendChild(box(7, 4));
  }
}
hrule(W1, 0.14);

// ---- table controls
const ctrl = H({ name: "Table controls", paddingLeft: PAD, paddingRight: PAD, itemSpacing: 0, counterAxisAlignItems: "CENTER" });
W1.appendChild(ctrl);
ctrl.layoutSizingHorizontal = "FILL";
ctrl.layoutSizingVertical = "FIXED";
ctrl.resize(ctrl.width, 38);
ctrl.counterAxisSizingMode = "FIXED";
{
  ctrl.appendChild(sans("Reviewed", 11, "Medium", "ink", 0.5, 4));
  ctrl.appendChild(box(8, 4));
  ctrl.appendChild(mono("45 / 203", 11, "Medium", "ink", 0.9));
  ctrl.appendChild(box(12, 4));
  const pb = box(110, 16);
  const tr = rect(110, 4, "ink", 0.09); pb.appendChild(tr); tr.y = 6;
  const fl = rect(110 * (45 / 203), 4, "verified", 0.85); pb.appendChild(fl); fl.y = 6;
  ctrl.appendChild(pb);
  grow(ctrl);
  const seg = (opts, active) => {
    const g = H({ itemSpacing: 0, paddingLeft: 2, paddingRight: 2, paddingTop: 2, paddingBottom: 2, cornerRadius: 3, counterAxisAlignItems: "CENTER" });
    g.strokes = fill("ink", 0.14); g.strokeWeight = 1;
    for (const o of opts) {
      const s = H({ paddingLeft: 10, paddingRight: 10, paddingTop: 3, paddingBottom: 3, cornerRadius: 2, counterAxisAlignItems: "CENTER" });
      s.fills = o === active ? fill("ink", 0.09) : [];
      s.appendChild(sans(o, 11, "Medium", "ink", o === active ? 0.9 : 0.45));
      g.appendChild(s);
    }
    return g;
  };
  ctrl.appendChild(seg(["open", "reviewed", "all"], "open"));
  ctrl.appendChild(box(10, 4));
  ctrl.appendChild(seg(["group", "dev"], "group"));
}
hrule(W1, 0.14);

// ---- column header, carrying the shared time axis
const head = H({ name: "Column header", paddingLeft: PAD, paddingRight: PAD, itemSpacing: GAP, paddingTop: 7, paddingBottom: 6, counterAxisAlignItems: "CENTER" });
W1.appendChild(head);
head.layoutSizingHorizontal = "FILL";
{
  head.appendChild(cell(sans("Pair", 11, "Medium", "ink", 0.45, 4), COL.pair));
  head.appendChild(cell(sans("n", 11, "Medium", "ink", 0.45, 4), COL.count, "right"));
  const axis = box(COL.cadence, 16);
  for (let m = 0; m < 12; m++) {
    const t = mono(MONTHS[m], 11, "Regular", "mute", 1);
    axis.appendChild(t);
    t.x = m * MCELL + MCELL / 2 - t.width / 2;
  }
  head.appendChild(axis);
  head.appendChild(cell(sans("consist", 11, "Medium", "ink", 0.45, 4), COL.consist));
  head.appendChild(cell(sans("amount", 11, "Medium", "ink", 0.45, 4), COL.amount));
  head.appendChild(cell(sans("prep", 11, "Medium", "ink", 0.45, 4), COL.prep));
  head.appendChild(cell(sans("status", 11, "Medium", "ink", 0.45, 4), COL.status));
}
hrule(W1, 0.18);

// ---- rows
const table = V({ name: "Table", itemSpacing: 0 });
W1.appendChild(table);
table.layoutSizingHorizontal = "FILL";

for (const r of ROWS) {
  const dev = r.kind === "deviation";
  const block = V({ name: `row ${r.pair}${dev ? " (deviation)" : ""}`, itemSpacing: 0 });
  table.appendChild(block);
  block.layoutSizingHorizontal = "FILL";
  if (dev) block.fills = fill("signal", 0.04);

  const main = H({ paddingLeft: PAD, paddingRight: PAD, itemSpacing: GAP, paddingTop: 6, paddingBottom: 4, counterAxisAlignItems: "CENTER" });
  block.appendChild(main);
  main.layoutSizingHorizontal = "FILL";

  const pc = box(COL.pair, 16);
  const gl = mono(r.glyph, 11, "Regular", dev ? "signal" : "ink", dev ? 1 : 0.45);
  pc.appendChild(gl); gl.x = 0;
  const pt = mono(r.pair, 11, "Medium", dev ? "signal" : "ink", dev ? 1 : 0.95);
  pc.appendChild(pt); pt.x = 16;
  main.appendChild(pc);

  main.appendChild(cell(mono(String(r.count), 11, "Regular", "ink", 0.6), COL.count, "right"));
  main.appendChild(cadenceCell(r.marks));
  main.appendChild(consistencyBar(r.consist));
  main.appendChild(amountStrip(r.amt[0], r.amt[1], r.amt[2], dev));
  main.appendChild(preparerChip(r.prep));
  main.appendChild(statusCell(r.status));

  const sub = H({ paddingLeft: PAD + 16, paddingRight: PAD, itemSpacing: 5, paddingBottom: 7, counterAxisAlignItems: "CENTER" });
  block.appendChild(sub);
  sub.layoutSizingHorizontal = "FILL";
  for (const rl of r.rules) sub.appendChild(ruleChip(rl, dev ? "signal" : "ink"));

  if (r.expanded && r.children) {
    for (const c of r.children) {
      const cr = H({ name: `entry ${c.id}`, paddingLeft: PAD + 30, paddingRight: PAD, itemSpacing: GAP, paddingTop: 5, paddingBottom: 5, counterAxisAlignItems: "CENTER" });
      block.appendChild(cr);
      cr.layoutSizingHorizontal = "FILL";
      if (c.selected) cr.fills = fill("ink", 0.05);
      cr.appendChild(cell(mono(c.id, 11, "Medium", "ink", 0.92), 108));
      cr.appendChild(cell(mono(c.date, 11, "Regular", "ink", 0.55), 62));
      cr.appendChild(cell(mono(c.amount, 11, "Medium", "ink", 0.95), 86, "right"));
      cr.appendChild(cell(mono(c.score.toFixed(2), 11, "Regular", "ink", 0.7), 44, "right"));
      const chips = H({ itemSpacing: 4, counterAxisAlignItems: "CENTER" });
      for (const x of c.rules) chips.appendChild(ruleChip(x, "ink"));
      const cw = box(120, 18); cw.appendChild(chips);
      cr.appendChild(cw);
      grow(cr);
      cr.appendChild(statusCell(c.status));
    }
  }
  hrule(block, 0.06);
}

await W1.screenshot({ scale: 1 });
return {
  screen: W1.id,
  tableNaturalWidth: TABLE_W,
  rows: ROWS.length,
  contentHeight: W1.children.reduce((a, c) => a + c.height, 0),
};
