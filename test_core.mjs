// Pruebas del núcleo de la página (core.js) sobre los datos generados:
//   node build/test/test_core.mjs data/madrid 40.4169,-3.7035 40.4121,-3.7140 …
// 1. Los trozos de cada tramo suman su longitud.
// 2. Monotonía: más tiempo o más velocidad nunca reducen el alcance; relajar el umbral de pendiente nunca lo
//    reduce; añadir restricciones nunca lo amplía (km y conjunto de destinos).
// 3. Ningún tramo bloqueado entra en lo alcanzado.
// 4. Comprobación independiente: se reconstruye la red partida en sus trozos y se recalcula con un Dijkstra aparte;
//    tiempos en los nodos, km alcanzados y destinos alcanzados tienen que coincidir con los del núcleo.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
const Core = createRequire(import.meta.url)("../../core.js");

const dir = process.argv[2] || "data/madrid";
const places = process.argv.slice(3).map(s => s.split(",").map(Number));
const G = Core.parseGraph(new Uint8Array(gunzipSync(readFileSync(dir + "/graph.bin.gz"))));
const EG = Core.buildEdgeGrid(G);
const P = Core.parsePois(JSON.parse(gunzipSync(readFileSync(dir + "/pois.json.gz")).toString()));
let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log("FALLO:", msg); } };

// 1
let maxd = 0; for (let e = 0; e < G.nE; e++) { let s = 0; for (let p = G.pstart[e]; p < G.pstart[e + 1]; p++) s += G.plen[p]; maxd = Math.max(maxd, Math.abs(s - G.elen[e])); }
ok(maxd < 1e-6, "suma de trozos ≠ longitud del tramo: " + maxd);
console.log(`red: ${G.nN} nodos, ${G.nE} tramos, ${G.nP} trozos; diferencia máxima suma de trozos − tramo: ${maxd.toExponential(1)} m`);

const run = (lon, lat, o, T) => { const r = Core.solve(G, EG, lon, lat, o, T); if (!r) return null; const R = Core.collectReach(G, r), C = Core.countReach(G, P, r, o.avoidSteps); return { r, km: R.lengthM / 1000, items: R.items, inR: C.inR, C }; };
const subset = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] && !b[i]) return false; return true; };
const base = { speed: 1.1, avoidSteps: false, slope: false, maxGrade: 0, uncertainBarrier: false };

for (const [lat, lon] of places) {
  console.log(`\n== ${lat}, ${lon}`);
  // 2a tiempo
  let prev = null;
  for (const m of [5, 10, 15, 20, 30]) {
    const x = run(lon, lat, { ...base, slope: true, avoidSteps: true, maxGrade: 0.06 }, m * 60);
    if (prev) { ok(x.km >= prev.km - 1e-9, `tiempo ${m}: km ${x.km} < ${prev.km}`); ok(subset(prev.inR, x.inR), `tiempo ${m}: se pierden destinos`); }
    prev = x;
  }
  // 2b velocidad
  prev = null;
  for (const v of [0.8, 1.0, 1.2, 1.4, 1.8]) {
    const x = run(lon, lat, { ...base, speed: v, slope: true }, 900);
    if (prev) { ok(x.km >= prev.km - 1e-9, `velocidad ${v}: km ${x.km} < ${prev.km}`); ok(subset(prev.inR, x.inR), `velocidad ${v}: se pierden destinos`); }
    prev = x;
  }
  // 2c umbral (de más estricto a sin límite), con y sin «inciertos como barrera»
  for (const unc of [false, true]) {
    prev = null; const line = [];
    for (const g of [0.04, 0.06, 0.08, 0.10, 0.12, 0]) {
      const x = run(lon, lat, { ...base, avoidSteps: true, slope: true, maxGrade: g, uncertainBarrier: unc && g > 0 }, 900);
      line.push(`${g ? g * 100 + "%" : "sin límite"} ${x ? x.km.toFixed(1) : "—"}`);
      if (prev && x) {
        const same = prev.r.e === x.r.e && Math.abs(prev.r.pos - x.r.pos) < 1e-6;
        if (same) { ok(x.km >= prev.km - 1e-9, `umbral ${g}: km ${x.km} < ${prev.km}`); ok(subset(prev.inR, x.inR), `umbral ${g}: se pierden destinos`); }
        else console.log(`  (umbral ${g}: el punto de salida cambia de tramo; la comparación no aplica)`);
      }
      prev = x || prev;
    }
    console.log(`  km por umbral${unc ? " (inciertos = barrera)" : ""}: ` + line.join(" · "));
  }
  // 2d restricciones acumuladas
  prev = null; const steps = [["base", {}], ["+escaleras", { avoidSteps: true }], ["+cuestas", { slope: true }], ["+6 %", { maxGrade: 0.06 }], ["+inciertos", { uncertainBarrier: true }]];
  let o = { ...base }; const line = [];
  for (const [name, add] of steps) {
    o = { ...o, ...add }; const x = run(lon, lat, o, 900); line.push(`${name} ${x ? x.km.toFixed(1) : "—"}`);
    if (prev && x) {
      const same = prev.r.e === x.r.e && Math.abs(prev.r.pos - x.r.pos) < 1e-6;
      if (same) { ok(x.km <= prev.km + 1e-9, `${name}: km ${x.km} > ${prev.km}`); ok(subset(x.inR, prev.inR), `${name}: aparecen destinos`); }
      else console.log(`  (${name}: el punto de salida cambia de tramo; la comparación no aplica)`);
    }
    prev = x || prev;
  }
  console.log("  km con restricciones acumuladas: " + line.join(" · "));
  // 3 y 4 con el escenario más restrictivo
  const strict = { speed: 1.1, avoidSteps: true, slope: true, maxGrade: 0.06, uncertainBarrier: false };
  const x = run(lon, lat, strict, 900);
  let bad = 0;
  for (const { e, a, b } of x.items) for (let p = G.pstart[e]; p < G.pstart[e + 1]; p++) {
    const ov = Math.min(b, G.ppos[p] + G.plen[p]) - Math.max(a, G.ppos[p]);
    if (ov > 1e-6 && Core.pieceBlocked(G, e, p, strict)) bad++;
  }
  ok(bad === 0, `${bad} trozos bloqueados dentro de lo alcanzado`);
  const ind = independent(x.r, strict, 900);
  let dmax = 0; for (let n = 0; n < G.nN; n++) { const a = x.r.dist[n], b = ind.dist[n]; if (a <= 900 || b <= 900) dmax = Math.max(dmax, Math.abs(a - b)); }
  ok(dmax < 1e-6, `tiempos en nodos distintos del cálculo independiente: ${dmax}`);
  ok(Math.abs(ind.km - x.km) < 1e-6 * Math.max(1, x.km), `km ${x.km} ≠ independiente ${ind.km}`);
  let dd = 0; for (let i = 0; i < P.n; i++) if (P.cat[i] !== 8 && P.cat[i] !== 6 && !(P.cat[i] === 3 && P.greenClasses[P.gc[i]] === "private") && x.inR[i] !== ind.inR[i]) dd++;
  ok(dd === 0, `${dd} destinos distintos del cálculo independiente`);
  if (dd && process.env.DEBUG) for (let i = 0; i < P.n; i++) if (P.cat[i] !== 8 && P.cat[i] !== 6 && !(P.cat[i] === 3 && P.greenClasses[P.gc[i]] === "private") && x.inR[i] !== ind.inR[i]) {
    const sn = []; for (let k = P.snapStart[i]; k < P.snapStart[i + 1]; k++) { const e = P.snapE[k]; sn.push({ e, pos: P.snapPos[k], d: P.snapD[k], L: G.elen[e], core: Core.snapTime(G, x.r, e, P.snapPos[k], P.snapD[k]), pieces: Array.from({ length: G.pstart[e + 1] - G.pstart[e] }, (_, j) => [G.ppos[G.pstart[e] + j], G.plen[G.pstart[e] + j], G.pgr[G.pstart[e] + j], Core.pieceBlocked(G, e, G.pstart[e] + j, strict)]) }); }
    const en = []; for (let k = P.entStart[i]; k < P.entStart[i + 1]; k++) en.push([P.ent[k], x.r.dist[P.ent[k]], ind.dist[P.ent[k]]]);
    console.log(JSON.stringify({ i, cat: P.cat[i], core: x.inR[i], ind: ind.inR[i], sn, en }));
  }
  console.log(`  independiente: |Δt| máx ${dmax.toExponential(1)} s, km ${x.km.toFixed(3)} frente a ${ind.km.toFixed(3)}, destinos distintos ${dd}`);
}
console.log(`\n${checks - fails} de ${checks} comprobaciones correctas`);
process.exit(fails ? 1 : 0);

// Red partida explícitamente en sus trozos (nodos nuevos en cada corte y en el punto de salida) y Dijkstra simple.
function independent(r, o, T) {
  const nodes = G.nN, adj = new Map(), add = (a, b, ta, tb) => { if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []); adj.get(a).push([b, ta]); adj.get(b).push([a, tb]); };
  let next = nodes; const cut = new Map();   // e -> [{x, node}]
  const pieceEdges = [];
  for (let e = 0; e < G.nE; e++) {
    const xs = [];
    for (let p = G.pstart[e] + 1; p < G.pstart[e + 1]; p++) xs.push(G.ppos[p]);
    if (e === r.e && !xs.some(x => Math.abs(x - r.pos) < 1e-9) && r.pos > 1e-9 && r.pos < G.elen[e] - 1e-9) xs.push(r.pos);
    xs.sort((a, b) => a - b);
    const pts = [{ x: 0, node: G.eu[e] }, ...xs.map(x => ({ x, node: next++ })), { x: G.elen[e], node: G.ev[e] }];
    cut.set(e, pts);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], p = Core.pieceAt(G, e, (a.x + b.x) / 2);
      if (Core.pieceBlocked(G, e, p, o)) { pieceEdges.push({ e, a, b, p, blocked: true }); continue; }
      const L = b.x - a.x, tf = L * (o.slope ? G.ptf[p] : 1) / o.speed, tb = L * (o.slope ? G.ptb[p] : 1) / o.speed;
      add(a.node, b.node, tf, tb); pieceEdges.push({ e, a, b, p, tf, tb });
    }
  }
  const pts = cut.get(r.e), start = pts.find(q => Math.abs(q.x - r.pos) < 1e-9);
  const dist = new Map([[start.node, r.t0]]), done = new Set(), heap = [];
  const push = x => { heap.push(x); let i = heap.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (heap[q][0] <= heap[i][0]) break; [heap[q], heap[i]] = [heap[i], heap[q]]; i = q; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, rr = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  push([r.t0, start.node]);
  while (heap.length) {
    const [t, n] = pop();
    if (done.has(n) || t > T) continue; done.add(n);
    for (const [m, w] of adj.get(n) || []) { const nt = t + w; if (nt < (dist.has(m) ? dist.get(m) : Infinity)) { dist.set(m, nt); push([nt, m]); } }
  }
  const D = n => dist.has(n) ? dist.get(n) : Infinity;
  let m = 0;
  for (const pe of pieceEdges) {
    if (pe.blocked) continue;
    const L = pe.b.x - pe.a.x, ta = D(pe.a.node), tb = D(pe.b.node);
    const ra = ta <= T ? Math.min(L, (T - ta) / pe.tf * L) : 0, rb = tb <= T ? Math.min(L, (T - tb) / pe.tb * L) : 0;
    m += Math.min(L, ra + rb);
  }
  const nodeDist = new Float64Array(G.nN); for (let n = 0; n < G.nN; n++) nodeDist[n] = D(n);
  const timeAt = (e, pos, d) => {
    const cp = cut.get(e); let k = 1; while (k < cp.length - 1 && cp[k].x < pos - 1e-9) k++;
    const a = cp[k - 1], b = cp[k], p = Core.pieceAt(G, e, (a.x + b.x) / 2);
    if (Core.pieceBlocked(G, e, p, o)) { if (Math.abs(pos - a.x) < 1e-4) return D(a.node) + d / o.speed; if (Math.abs(pos - b.x) < 1e-4) return D(b.node) + d / o.speed; return Infinity; }
    const f = (o.slope ? G.ptf[p] : 1) / o.speed, g2 = (o.slope ? G.ptb[p] : 1) / o.speed;
    return Math.min(D(a.node) + (pos - a.x) * f, D(b.node) + (b.x - pos) * g2) + d / o.speed;
  };
  const inR = new Uint8Array(P.n);
  for (let i = 0; i < P.n; i++) {
    let t = Infinity;
    for (let k = P.entStart[i]; k < P.entStart[i + 1]; k++) t = Math.min(t, D(P.ent[k]));
    for (let k = P.snapStart[i]; k < P.snapStart[i + 1]; k++) t = Math.min(t, timeAt(P.snapE[k], P.snapPos[k], P.snapD[k]));
    if (t <= T) inR[i] = 1;
  }
  return { dist: nodeDist, km: m / 1000, inR };
}
