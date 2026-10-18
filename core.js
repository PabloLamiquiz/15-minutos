// Núcleo de cálculo de la página: lectura de datos, enganche del origen y de los destinos, Dijkstra, alcance y
// recuento. Lo usan index.html y las pruebas (build/test/test_core.mjs), así que lo que se comprueba es exactamente
// lo que calcula la página.
//
// Cada tramo de la red lleva sus «trozos» de pendiente homogénea, en orden desde u hasta v: longitud, pendiente de
// barrera, factor de tiempo en cada sentido y calidad. Un trozo bloqueado impide atravesar el tramo, pero lo que hay
// antes de él sigue siendo alcanzable desde ese lado.
(function (root) {
"use strict";
const Q = { STRUCTURE: 1, DISCONTINUITY: 2, MISSING: 4, LAYER: 8 };
const UNCERTAIN = Q.DISCONTINUITY | Q.MISSING;
const R_LAT = 110540, R_LON = 111320;
const mercX = lon => lon / 360 + 0.5, mercY = lat => 0.5 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI);

// ---------------------------------------------------------------- datos
// graph.bin v4 (ver build/write.mjs)
function parseGraph(u8) {
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const h = new Uint32Array(buf, 0, 8);
  if (h[0] !== 4) throw new Error("versión de datos desconocida (" + h[0] + ")");
  const [, nN, nE, nS, nB, nBP, nP, nPL] = h;
  let o = 32;
  const I = n => { const a = new Int32Array(buf, o, n); o += 4 * n; return a; };
  const acc = (a, k) => { const out = new Float64Array(a.length); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; out[i] = s / k; } return out; };
  const accI = a => { const out = new Uint32Array(a.length); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; out[i] = s; } return out; };
  const lon = acc(I(nN), 1e5), lat = acc(I(nN), 1e5), eu = accI(I(nE)), ev = accI(I(nE)), ldm = I(nE), en = I(nE);
  const slon = acc(I(nS), 1e5), slat = acc(I(nS), 1e5), pldm = I(nPL);
  const bk = I(nB), bst = I(nB + 1), blon = acc(I(nBP), 1e5), blat = acc(I(nBP), 1e5);
  const scnt = new Uint16Array(buf, o, nE); o += 2 * nE;
  const pcnt = new Uint16Array(buf, o, nE); o += 2 * nE;
  const sst = new Uint32Array(nE + 1), pstart = new Uint32Array(nE + 1);
  for (let e = 0; e < nE; e++) { sst[e + 1] = sst[e] + scnt[e]; pstart[e + 1] = pstart[e] + pcnt[e]; }
  const B = n => { const a = new Uint8Array(buf, o, n); o += n; return a; };
  const pg8 = B(nP), ptf8 = B(nP), ptb8 = B(nP), pq = B(nP), eflag = B(nE);
  const mx = Float64Array.from(lon, mercX), my = Float64Array.from(lat, mercY), smx = Float64Array.from(slon, mercX), smy = Float64Array.from(slat, mercY);
  const bmx = Float64Array.from(blon, mercX), bmy = Float64Array.from(blat, mercY);
  const elen = new Float64Array(nE), plen = new Float64Array(nP), ppos = new Float64Array(nP), pgr = new Float32Array(nP), ptf = new Float32Array(nP), ptb = new Float32Array(nP);
  const ecf = new Float64Array(nE), ecb = new Float64Array(nE), emaxg = new Float32Array(nE), eunc = new Uint8Array(nE), deg = new Uint32Array(nN);
  let pl = 0;
  for (let e = 0; e < nE; e++) {
    elen[e] = ldm[e] / 10; let pos = 0, mg = 0, unc = 0, cf = 0, cb = 0, used = 0;
    for (let p = pstart[e]; p < pstart[e + 1]; p++) {
      const last = p === pstart[e + 1] - 1, ld = last ? ldm[e] - used : pldm[pl++]; used += ld;
      plen[p] = ld / 10; ppos[p] = pos; pos += plen[p];
      pgr[p] = pg8[p] === 255 ? NaN : pg8[p] / 400; ptf[p] = 1 + ptf8[p] / 100; ptb[p] = 1 + ptb8[p] / 100;
      if (pgr[p] === pgr[p]) mg = Math.max(mg, pgr[p]); else unc = 1;
      if (pq[p] & UNCERTAIN) unc = 1;
      cf += plen[p] * ptf[p]; cb += plen[p] * ptb[p];
    }
    emaxg[e] = mg; eunc[e] = unc; ecf[e] = cf; ecb[e] = cb; deg[eu[e]]++; deg[ev[e]]++;
  }
  const adjStart = new Uint32Array(nN + 1);
  for (let i = 0; i < nN; i++) adjStart[i + 1] = adjStart[i] + deg[i];
  const fill = adjStart.slice(0, nN), adjEdge = new Uint32Array(2 * nE);
  for (let e = 0; e < nE; e++) { adjEdge[fill[eu[e]]++] = e; adjEdge[fill[ev[e]]++] = e; }
  return { nN, nE, nP, lon, lat, mx, my, eu, ev, elen, eflag, en, sst, slon, slat, smx, smy, pstart, plen, ppos, pgr, ptf, ptb, pq,
    ecf, ecb, emaxg, eunc, adjStart, adjEdge, nB, bk, bst, bmx, bmy };
}

// pois.json (ver build/write.mjs: encodeDestinations)
function parsePois(J) {
  const n = J.c.length;
  const P = { n, cats: J.cats, subs: J.subs, greenClasses: J.greenClasses, names: J.names,
    cat: Uint8Array.from(J.c), sub: Uint16Array.from(J.s), wc: Uint8Array.from(J.wc), gc: Int8Array.from(J.gc), st: Int32Array.from(J.st), ty: Int8Array.from(J.ty),
    name: Uint32Array.from(J.nm), lon: new Float64Array(n), lat: new Float64Array(n), mx: new Float64Array(n), my: new Float64Array(n),
    snapStart: new Uint32Array(n + 1), entStart: new Uint32Array(n + 1) };
  let ns = 0, ne = 0;
  for (let i = 0; i < n; i++) { ns += J.snap[i].length / 3; ne += J.ent[i].length; P.snapStart[i + 1] = ns; P.entStart[i + 1] = ne; }
  P.snapE = new Uint32Array(ns); P.snapPos = new Float32Array(ns); P.snapD = new Float32Array(ns); P.ent = new Uint32Array(ne);
  for (let i = 0; i < n; i++) {
    P.lon[i] = J.lon[i] / 1e6; P.lat[i] = J.lat[i] / 1e6; P.mx[i] = mercX(P.lon[i]); P.my[i] = mercY(P.lat[i]);
    const s = J.snap[i]; for (let k = 0; k < s.length / 3; k++) { const j = P.snapStart[i] + k; P.snapE[j] = s[3 * k]; P.snapPos[j] = s[3 * k + 1]; P.snapD[j] = s[3 * k + 2]; }
    const en = J.ent[i]; for (let k = 0; k < en.length; k++) P.ent[P.entStart[i] + k] = en[k];
  }
  P.entOf = new Map();   // estación -> bocas
  for (let i = 0; i < n; i++) if (P.cat[i] === 8 && P.st[i] >= 0) { if (!P.entOf.has(P.st[i])) P.entOf.set(P.st[i], []); P.entOf.get(P.st[i]).push(i); }
  return P;
}

// rejilla de tramos en Mercator (celdas de 2^-18, unos 115 m en Madrid): dibujo de lo visible y búsqueda del tramo más cercano
function buildEdgeGrid(g) {
  const K = 262144, cell = v => Math.floor(v * K);
  let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
  const grow = (x, y) => { const a = cell(x), b = cell(y); if (a < cx0) cx0 = a; if (a > cx1) cx1 = a; if (b < cy0) cy0 = b; if (b > cy1) cy1 = b; };
  for (let i = 0; i < g.nN; i++) grow(g.mx[i], g.my[i]);
  for (let i = 0; i < g.smx.length; i++) grow(g.smx[i], g.smy[i]);
  const W = cx1 - cx0 + 1, H = cy1 - cy0 + 1, bb = new Int32Array(4 * g.nE), start = new Uint32Array(W * H + 1);
  for (let e = 0; e < g.nE; e++) {
    let a0 = cell(g.mx[g.eu[e]]), a1 = a0, b0 = cell(g.my[g.eu[e]]), b1 = b0;
    const add = (x, y) => { const a = cell(x), b = cell(y); if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b; };
    add(g.mx[g.ev[e]], g.my[g.ev[e]]);
    for (let s = g.sst[e]; s < g.sst[e + 1]; s++) add(g.smx[s], g.smy[s]);
    a0 -= cx0; a1 -= cx0; b0 -= cy0; b1 -= cy0;
    bb[4 * e] = a0; bb[4 * e + 1] = a1; bb[4 * e + 2] = b0; bb[4 * e + 3] = b1;
    for (let y = b0; y <= b1; y++) for (let x = a0; x <= a1; x++) start[y * W + x + 1]++;
  }
  for (let c = 0; c < W * H; c++) start[c + 1] += start[c];
  const fill = start.slice(0, W * H), items = new Uint32Array(start[W * H]);
  for (let e = 0; e < g.nE; e++) for (let y = bb[4 * e + 2]; y <= bb[4 * e + 3]; y++) for (let x = bb[4 * e]; x <= bb[4 * e + 1]; x++) items[fill[y * W + x]++] = e;
  return { K, cx0, cy0, W, H, start, items, stamp: new Uint32Array(g.nE), gen: 0 };
}
function visibleEdges(eg, x0, y0, x1, y1) {
  eg.gen++; const out = [];
  const a = Math.max(0, Math.floor(x0 * eg.K) - eg.cx0), b = Math.min(eg.W - 1, Math.floor(x1 * eg.K) - eg.cx0);
  const c = Math.max(0, Math.floor(y0 * eg.K) - eg.cy0), d = Math.min(eg.H - 1, Math.floor(y1 * eg.K) - eg.cy0);
  for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) {
    const k0 = eg.start[y * eg.W + x], k1 = eg.start[y * eg.W + x + 1];
    for (let k = k0; k < k1; k++) { const e = eg.items[k]; if (eg.stamp[e] !== eg.gen) { eg.stamp[e] = eg.gen; out.push(e); } }
  }
  return out;
}

// ---------------------------------------------------------------- reglas
// o = { speed (m/s), avoidSteps, slope (tiempo según la pendiente), maxGrade (fracción; 0 = sin límite), uncertainBarrier }
const stairsBlocked = (g, e, o) => !!o.avoidSteps && !(g.eflag[e] & 8);   // escaleras: solo su casilla (salvo rampa etiquetada)
function pieceBlocked(g, e, p, o) {
  if (g.eflag[e] & 1) return stairsBlocked(g, e, o);
  if (!(o.maxGrade > 0)) return false;
  const gr = g.pgr[p];
  if (o.uncertainBarrier && ((g.pq[p] & UNCERTAIN) || gr !== gr)) return true;
  return gr === gr && gr > o.maxGrade + 1e-9;
}
function blocked(g, e, o) {   // ¿se puede atravesar el tramo entero?
  if (g.eflag[e] & 1) return stairsBlocked(g, e, o);
  if (!(o.maxGrade > 0)) return false;
  return g.emaxg[e] > o.maxGrade + 1e-9 || (!!o.uncertainBarrier && g.eunc[e] === 1);
}
function edgeTime(g, e, fwd, o) { return (o.slope ? (fwd ? g.ecf[e] : g.ecb[e]) : g.elen[e]) / o.speed; }

// tiempo para ir de x0 a x1 (m desde u) por el tramo; Infinity si hay que pisar un trozo bloqueado
function walkTime(g, e, x0, x1, o) {
  if (x0 === x1) return 0;
  const fwd = x1 > x0, a = Math.min(x0, x1), b = Math.max(x0, x1);
  let t = 0;
  for (let p = g.pstart[e]; p < g.pstart[e + 1]; p++) {
    const s = g.ppos[p], pa = Math.max(a, s), pb = Math.min(b, s + g.plen[p]);
    if (pb <= pa) continue;
    if (pieceBlocked(g, e, p, o)) return Infinity;
    t += (pb - pa) * (o.slope ? (fwd ? g.ptf[p] : g.ptb[p]) : 1);
  }
  return t / o.speed;
}
// hasta dónde se llega por el tramo saliendo de x0 hacia v (fwd) o hacia u con `budget` segundos
function reachFrom(g, e, x0, fwd, budget, o) {
  let x = x0, rem = budget * o.speed;
  const p0 = g.pstart[e], p1 = g.pstart[e + 1];
  if (fwd) {
    for (let p = p0; p < p1; p++) {
      const s = g.ppos[p], end = s + g.plen[p]; if (end <= x + 1e-9) continue;
      if (pieceBlocked(g, e, p, o)) return x;
      const f = o.slope ? g.ptf[p] : 1, need = (end - x) * f;
      if (rem >= need) { rem -= need; x = end; } else return x + rem / f;
    }
  } else {
    for (let p = p1 - 1; p >= p0; p--) {
      const s = g.ppos[p]; if (s >= x - 1e-9) continue;
      if (pieceBlocked(g, e, p, o)) return x;
      const f = o.slope ? g.ptb[p] : 1, need = (x - s) * f;
      if (rem >= need) { rem -= need; x = s; } else return x - rem / f;
    }
  }
  return x;
}
function pieceAt(g, e, x) {
  for (let p = g.pstart[e]; p < g.pstart[e + 1]; p++) if (x <= g.ppos[p] + g.plen[p] + 1e-9) return p;
  return g.pstart[e + 1] - 1;
}

// ---------------------------------------------------------------- geometría
function edgeLonLat(g, e) {
  const u = g.eu[e], v = g.ev[e], pts = [g.lon[u], g.lat[u]];
  for (let s = g.sst[e]; s < g.sst[e + 1]; s++) pts.push(g.slon[s], g.slat[s]);
  pts.push(g.lon[v], g.lat[v]); return pts;
}
// punto del tramo más cercano a (lon, lat) que se pueda pisar con estos ajustes: { d (m), pos (m desde u) }
function projectAllowed(g, e, lon, lat, o) {
  const cosL = Math.cos(lat * Math.PI / 180), kx = cosL * R_LON, ky = R_LAT, pts = edgeLonLat(g, e);
  const segs = []; let acc = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = (pts[i - 2] - lon) * kx, ay = (pts[i - 1] - lat) * ky, bx = (pts[i] - lon) * kx, by = (pts[i + 1] - lat) * ky, L = Math.hypot(bx - ax, by - ay);
    segs.push([ax, ay, bx, by, acc, L]); acc += L;
  }
  const sc = acc > 0 ? g.elen[e] / acc : 0;
  const distAt = x => { const xs = sc > 0 ? x / sc : 0; for (const [ax, ay, bx, by, s0, L] of segs) if (xs <= s0 + L + 1e-9) { const t = L > 0 ? Math.max(0, Math.min(1, (xs - s0) / L)) : 0; return Math.hypot(ax + t * (bx - ax), ay + t * (by - ay)); } return Infinity; };
  let bd = Infinity, bpos = 0;
  for (const [ax, ay, bx, by, s0, L] of segs) {
    const dx = bx - ax, dy = by - ay, L2 = L * L, t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0, d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < bd) { bd = d; bpos = (s0 + t * L) * sc; }
  }
  if (!o) return { d: bd, pos: bpos };
  const p = pieceAt(g, e, bpos);
  if (!pieceBlocked(g, e, p, o)) return { d: bd, pos: bpos };
  if (g.eflag[e] & 1) return null;
  // el punto más cercano cae en un trozo bloqueado: se prueba el borde permitido más cercano a cada lado
  let best = null;
  for (let q = p - 1; q >= g.pstart[e]; q--) if (!pieceBlocked(g, e, q, o)) { const x = g.ppos[q] + g.plen[q]; best = { d: distAt(x), pos: x }; break; }
  for (let q = p + 1; q < g.pstart[e + 1]; q++) if (!pieceBlocked(g, e, q, o)) { const x = g.ppos[q]; const d = distAt(x); if (!best || d < best.d) best = { d, pos: x }; break; }
  return best;
}
// tramo con un punto utilizable más cercano a (lon, lat), hasta maxD metros
function nearestEdge(g, eg, lon, lat, o, maxD) {
  const cosL = Math.cos(lat * Math.PI / 180);
  const cx = Math.floor(mercX(lon) * eg.K) - eg.cx0, cy = Math.floor(mercY(lat) * eg.K) - eg.cy0;
  const cellM = 1 / eg.K * 2 * Math.PI * 6378137 * cosL, rings = Math.ceil(maxD / cellM) + 1;
  let best = null; eg.gen++;
  for (let r = 0; r <= rings; r++) {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r || x < 0 || y < 0 || x >= eg.W || y >= eg.H) continue;
      for (let k = eg.start[y * eg.W + x]; k < eg.start[y * eg.W + x + 1]; k++) {
        const e = eg.items[k]; if (eg.stamp[e] === eg.gen) continue; eg.stamp[e] = eg.gen;
        const pr = projectAllowed(g, e, lon, lat, o);
        if (pr && pr.d <= maxD && (!best || pr.d < best.d)) best = { e, d: pr.d, pos: pr.pos };
      }
    }
    if (best && best.d <= (r - 1) * cellM) break;
  }
  return best;
}

// ---------------------------------------------------------------- cálculo
function dijkstra(g, seeds, o, T) {
  const dist = new Float64Array(g.nN).fill(Infinity), ht = [], hn = [];
  const push = (t, n) => { let i = ht.length; ht.push(t); hn.push(n); while (i > 0) { const p = (i - 1) >> 1; if (ht[p] <= t) break; ht[i] = ht[p]; hn[i] = hn[p]; i = p; } ht[i] = t; hn[i] = n; };
  const pop = () => { const lt = ht.pop(), ln = hn.pop(), L = ht.length; if (!L) return; let i = 0;
    while (true) { let c = 2 * i + 1; if (c >= L) break; if (c + 1 < L && ht[c + 1] < ht[c]) c++; if (ht[c] >= lt) break; ht[i] = ht[c]; hn[i] = hn[c]; i = c; }
    ht[i] = lt; hn[i] = ln; };
  for (const [n, t0] of seeds) if (t0 < dist[n]) { dist[n] = t0; push(t0, n); }
  while (ht.length) {
    const t = ht[0], n = hn[0]; pop();
    if (t > dist[n]) continue;
    if (t > T) break;
    for (let k = g.adjStart[n]; k < g.adjStart[n + 1]; k++) {
      const e = g.adjEdge[k];
      if (blocked(g, e, o)) continue;
      const fwd = g.eu[e] === n, m = fwd ? g.ev[e] : g.eu[e], nt = t + edgeTime(g, e, fwd, o);
      if (nt < dist[m]) { dist[m] = nt; push(nt, m); }
    }
  }
  return dist;
}

// Alcance desde un punto: se proyecta sobre el punto utilizable más cercano de la red (como mucho maxD m en línea
// recta) y se sale hacia los dos extremos de ese tramo. No hay más enlaces en línea recta: así no se puede «saltar»
// un tramo bloqueado.
function solve(g, eg, lon, lat, o, T, maxD = 300) {
  const s = nearestEdge(g, eg, lon, lat, o, maxD);
  if (!s) return null;
  const e = s.e, t0 = s.d / o.speed;
  const seeds = [[g.eu[e], t0 + walkTime(g, e, s.pos, 0, o)], [g.ev[e], t0 + walkTime(g, e, s.pos, g.elen[e], o)]];
  return { dist: dijkstra(g, seeds, o, T), e, pos: s.pos, d: s.d, t0, o, T };
}

// tramos alcanzados (para el dibujo y los km): { e, a, b (m desde u), tt (fracción de T al llegar al final) }
function collectReach(g, r) {
  const { dist, o, T } = r, items = []; let lengthM = 0;
  for (let e = 0; e < g.nE; e++) {
    const L = g.elen[e], du = dist[g.eu[e]], dv = dist[g.ev[e]];
    const iv = [];
    if (du <= T) iv.push([0, reachFrom(g, e, 0, true, T - du, o)]);
    if (dv <= T) iv.push([reachFrom(g, e, L, false, T - dv, o), L]);
    if (e === r.e && r.t0 <= T) iv.push([reachFrom(g, e, r.pos, false, T - r.t0, o), reachFrom(g, e, r.pos, true, T - r.t0, o)]);
    if (!iv.length) continue;
    iv.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [a, b] of iv) { if (b <= a + 1e-6) continue; const last = merged[merged.length - 1]; if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
    const whole = merged.length === 1 && merged[0][0] <= 1e-6 && merged[0][1] >= L - 1e-6;
    for (const [a, b] of merged) { items.push({ e, a, b, tt: e === r.e ? 0 : whole ? Math.max(du, dv) / T : 1 }); lengthM += b - a; }
  }
  return { items, lengthM };
}
// metros de lo alcanzado que cumplen una condición sobre el trozo (p. ej. pendiente incierta)
function overlapLength(g, items, pred) {
  let m = 0;
  for (const { e, a, b } of items) for (let p = g.pstart[e]; p < g.pstart[e + 1]; p++) {
    const s = g.ppos[p], o = Math.min(b, s + g.plen[p]) - Math.max(a, s);
    if (o > 0 && pred(e, p)) m += o;
  }
  return m;
}

// momento en que se llega a un punto de un tramo (pos m desde u) y desde ahí, d m en línea recta, al destino
function snapTime(g, r, e, pos, d) {
  const o = r.o;
  let t = Math.min(r.dist[g.eu[e]] + walkTime(g, e, 0, pos, o), r.dist[g.ev[e]] + walkTime(g, e, g.elen[e], pos, o));
  if (e === r.e) t = Math.min(t, r.t0 + walkTime(g, e, r.pos, pos, o));
  return t + d / o.speed;
}
function poiTime(g, P, r, i) {
  let t = Infinity;
  for (let k = P.entStart[i]; k < P.entStart[i + 1]; k++) t = Math.min(t, r.dist[P.ent[k]]);
  for (let k = P.snapStart[i]; k < P.snapStart[i + 1]; k++) t = Math.min(t, snapTime(g, r, P.snapE[k], P.snapPos[k], P.snapD[k]));
  return t;
}

// Recuento: categorías 0–7 (8 = bocas de metro, no se cuentan aparte). Las estaciones se alcanzan por sus bocas
// si las tienen. «Usable sin escalones»: estación etiquetada accesible y, si alguna de sus bocas está etiquetada
// como accesible, llegar a una de esas bocas. Las zonas verdes privadas no cuentan.
function countReach(g, P, r, avoid) {
  const T = r.T, n = P.n, inR = new Uint8Array(n), usable = new Uint8Array(n);
  const cat = new Array(8).fill(0), sub = new Map(), green = new Array(P.greenClasses.length).fill(0), st = [0, 0, 0, 0], ty = [0, 0, 0, 0];
  let stUsable = 0;
  const entIn = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (P.cat[i] === 8 && poiTime(g, P, r, i) <= T) entIn[i] = 1;
  for (let i = 0; i < n; i++) {
    const c = P.cat[i]; if (c === 8) continue;
    if (c === 3 && P.greenClasses[P.gc[i]] === "private") continue;
    const ents = c === 6 ? P.entOf.get(i) : null;
    const ok = ents ? ents.some(k => entIn[k]) : poiTime(g, P, r, i) <= T;
    if (!ok) continue;
    inR[i] = 1; cat[c]++; sub.set(P.sub[i], (sub.get(P.sub[i]) || 0) + 1);
    if (c === 3) green[P.gc[i]]++;
    if (c === 6) {
      st[P.wc[i]]++; ty[Math.max(0, P.ty[i])]++;
      const acc = ents ? ents.filter(k => P.wc[k] === 1) : [];
      if (!avoid || (P.wc[i] === 1 && (!acc.length || acc.some(k => entIn[k])))) { usable[i] = 1; stUsable++; }
    }
  }
  return { inR, usable, entIn, cat, sub, green, st, ty, stUsable };
}

const api = { Q, UNCERTAIN, mercX, mercY, parseGraph, parsePois, buildEdgeGrid, visibleEdges, pieceBlocked, blocked, edgeTime, walkTime, reachFrom,
  pieceAt, edgeLonLat, projectAllowed, nearestEdge, dijkstra, solve, collectReach, overlapLength, snapTime, poiTime, countReach };
if (typeof module === "object" && module.exports) module.exports = api; else root.Core = api;
})(typeof self !== "undefined" ? self : this);
