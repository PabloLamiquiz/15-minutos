// Mallas del terreno: muestreo bilineal y reconstrucción de modelos «aterrazados».
//
// El MDT05 del IGN, en Madrid y en Navalcarnero, no es una superficie continua: las alturas se quedan en metros enteros
// a lo largo de mesetas y saltan al metro siguiente en pocos metros, como si el modelo se hubiera interpolado a partir de
// alturas redondeadas (en una zona de 5 × 5 km del centro de Madrid, el 31 % de las celdas tiene una altura entera
// exacta). Medida en ventanas de 10 m, una calle con un 3 % uniforme aparece como llanos y rampas del 10 %.
//
// Reconstrucción por bandas: cada celda pertenece a la banda round(z). La curva de nivel k + 0,5 pasa entre la última
// celda de la banda k y la primera de la k + 1, y dentro de cada banda la altura se interpola linealmente entre la curva
// de debajo y la de encima según la distancia a cada una (transformada de distancia euclídea). Donde las curvas están
// cerca (pendientes fuertes, menos de `blend[0]` m entre curvas) las terrazas son cortas y se conserva el valor original;
// entre `blend[0]` y `blend[1]` se mezclan. En cimas y fondos (sin curva a uno de los lados a menos de R m) se conserva z.
// Contraste con el MDT 2025 del Ayuntamiento: AUDITORIA.md, apartado «Navalcarnero».

// transformada de distancia euclídea al cuadrado en 1D (Felzenszwalb y Huttenlocher, 2012)
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k] && k > 0) k--; else break; }
    if (s <= z[k]) { v[0] = q; z[0] = -Infinity; z[1] = Infinity; k = 0; continue; }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
}
// distancia (en celdas) de cada celda de la ventana [r0,r1)×[c0,c1) a la celda marcada más cercana
export function edt(mask, NC, r0, r1, c0, c1) {
  const W = c1 - c0, H = r1 - r0, INF = 1e12, out = new Float64Array(W * H);
  const n = Math.max(W, H), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let c = 0; c < W; c++) {
    for (let r = 0; r < H; r++) f[r] = mask[(r0 + r) * NC + c0 + c] ? 0 : INF;
    edt1d(f, H, d, v, z); for (let r = 0; r < H; r++) out[r * W + c] = d[r];
  }
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) f[c] = out[r * W + c];
    edt1d(f, W, d, v, z); for (let c = 0; c < W; c++) out[r * W + c] = Math.sqrt(d[c]);
  }
  return out;
}

// Z: Float32Array de NR × NC (fila 0 = norte), cs: lado de la celda en m
export function deterrace(Z, NR, NC, cs, { R = 300, blend = [10, 20] } = {}) {
  const N = NR * NC, NONE = -2147483648, band = new Int32Array(N);
  const box = new Map();   // banda → [r0, r1, c0, c1]
  for (let i = 0; i < N; i++) {
    if (Z[i] !== Z[i]) { band[i] = NONE; continue; }
    const b = Math.round(Z[i]), r = (i / NC) | 0, c = i - r * NC; band[i] = b;
    const bb = box.get(b); if (!bb) box.set(b, [r, r, c, c]); else { if (r > bb[1]) bb[1] = r; if (c < bb[2]) bb[2] = c; if (c > bb[3]) bb[3] = c; }
  }
  const dUp = new Float32Array(N).fill(Infinity), dDn = new Float32Array(N).fill(Infinity);
  const Rc = Math.ceil(R / cs), mask = new Uint8Array(N);
  for (const [k, bb] of box) {
    const r0 = Math.max(0, bb[0] - Rc), r1 = Math.min(NR, bb[1] + Rc + 1), c0 = Math.max(0, bb[2] - Rc), c1 = Math.min(NC, bb[3] + Rc + 1), W = c1 - c0;
    for (const up of [true, false]) {
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) { const b = band[r * NC + c]; mask[r * NC + c] = b !== NONE && (up ? b > k : b < k) ? 1 : 0; }
      const D = edt(mask, NC, r0, r1, c0, c1), tgt = up ? dUp : dDn;
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) { const i = r * NC + c; if (band[i] === k) { const dm = D[(r - r0) * W + (c - c0)] * cs; if (dm <= R) tgt[i] = dm; } }
    }
  }
  const out = new Float32Array(N); let rebuilt = 0, kept = 0, integer = 0, valid = 0;
  for (let i = 0; i < N; i++) {
    const z = Z[i]; if (z !== z) { out[i] = NaN; continue; }
    valid++; if (Math.abs(z - Math.round(z)) < 0.0005) integer++;
    if (!(dUp[i] < Infinity) || !(dDn[i] < Infinity)) { out[i] = z; kept++; continue; }
    const du = Math.max(dUp[i] - cs / 2, 0.01), dd = Math.max(dDn[i] - cs / 2, 0.01), S = du + dd;
    const w = S <= blend[0] ? 0 : S >= blend[1] ? 1 : (S - blend[0]) / (blend[1] - blend[0]);
    out[i] = z * (1 - w) + (band[i] - 0.5 + dd / S) * w; if (w > 0) rebuilt++;
  }
  return { Z: out, stats: { method: "bandas de 1 m", R_m: R, blend_m: blend, bands: box.size, cells: valid, integerCells: integer, rebuilt, keptPeakOrPit: kept } };
}

// muestreo bilineal sobre los centros de celda; (x0, yTop): esquina noroeste de la malla en UTM
export function bilinear(Z, NR, NC, cs, x0, yTop) {
  return (x, y) => {
    const fc = (x - x0) / cs - 0.5, fr = (yTop - y) / cs - 0.5;
    if (fc < 0 || fr < 0 || fc > NC - 1 || fr > NR - 1) return NaN;
    const c = Math.min(Math.floor(fc), NC - 2), r = Math.min(Math.floor(fr), NR - 2), dx = fc - c, dy = fr - r;
    const a = Z[r * NC + c], b = Z[r * NC + c + 1], cc = Z[(r + 1) * NC + c], d = Z[(r + 1) * NC + c + 1];
    return (a * (1 - dx) + b * dx) * (1 - dy) + (cc * (1 - dx) + d * dx) * dy;
  };
}
