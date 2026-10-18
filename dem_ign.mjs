// Modelo Digital del Terreno MDT05 del Instituto Geográfico Nacional (malla de 5 m, ETRS89 UTM 30N), pedido al
// servicio WCS 2.0.1 de la IDEE en formato ASCII Grid, que conserva los decimales (el GeoTIFF del servicio redondea a
// metros). Se usa donde no hay modelo municipal (fuera del término de Madrid). Funciona en Node ≥ 18 y en el navegador.
// Los trozos pedidos se unen en una sola malla y, por defecto, se quitan las terrazas de 1 m del modelo (terrain.mjs).
import { deterrace as deterraceGrid, bilinear } from "./terrain.mjs";

export const IGN_WCS = "https://servicios.idee.es/wcs-inspire/mdt";

export function parseAsc(text) {   // la respuesta es multipart; la primera parte es la malla
  const a = text.indexOf("ncols"); if (a < 0) throw new Error("WCS: respuesta sin malla: " + text.slice(0, 200));
  const end = text.indexOf("\r\n--", a), body = text.slice(a, end < 0 ? undefined : end);
  const lines = body.split("\n"); const h = {}; let i = 0;
  for (; i < lines.length; i++) { const m = lines[i].trim().match(/^([a-zA-Z_]+)\s+(-?[\d.eE+-]+)$/); if (!m) break; h[m[1].toLowerCase()] = parseFloat(m[2]); }
  const nc = h.ncols, nr = h.nrows, v = new Float32Array(nc * nr), nd = h.nodata_value; let k = 0;
  for (; i < lines.length && k < v.length; i++) { const parts = lines[i].trim().split(/\s+/); for (const p of parts) if (p) { const x = parseFloat(p); v[k++] = x === nd ? NaN : x; } }
  if (k !== v.length) throw new Error(`WCS: malla incompleta (${k} de ${v.length})`);
  const x0 = h.xllcorner !== undefined ? h.xllcorner : h.xllcenter - h.cellsize / 2, y0 = h.yllcorner !== undefined ? h.yllcorner : h.yllcenter - h.cellsize / 2;
  return { nc, nr, cs: h.cellsize, x0, y0, v };
}

// rect: [x0, y0, x1, y1] UTM 30N absolutos. Se pide en trozos de `tile` m. Devuelve { meta, sample(xy, origin), grid }.
export async function loadIGNMDT(rect, { coverage = "Elevacion25830_5", url = IGN_WCS, tile = 5000, cs = 5, deterrace = true,
  fetchImpl = fetch, onProgress = () => {} } = {}) {
  const X0 = Math.floor(rect[0] / cs) * cs, Y0 = Math.floor(rect[1] / cs) * cs, X1 = Math.ceil(rect[2] / cs) * cs, Y1 = Math.ceil(rect[3] / cs) * cs;
  const NC = (X1 - X0) / cs, NR = (Y1 - Y0) / cs, Z = new Float32Array(NC * NR).fill(NaN);
  const xs = [], ys = [];
  for (let x = X0; x < X1; x += tile) xs.push([x, Math.min(X1, x + tile)]);
  for (let y = Y0; y < Y1; y += tile) ys.push([y, Math.min(Y1, y + tile)]);
  let n = 0;
  for (const [xa, xb] of xs) for (const [ya, yb] of ys) {
    const q = `${url}?service=WCS&version=2.0.1&request=GetCoverage&CoverageId=${coverage}&format=application/asc&subset=x(${xa},${xb})&subset=y(${ya},${yb})`;
    const r = await fetchImpl(q); if (!r.ok) throw new Error("WCS: " + r.status);
    const g = parseAsc(await r.text());
    if (Math.abs(g.cs - cs) > 1e-6) throw new Error(`WCS: celda de ${g.cs} m, se esperaba ${cs}`);
    for (let rr = 0; rr < g.nr; rr++) for (let c = 0; c < g.nc; c++) {   // a la malla común, por el centro de cada celda
      const x = g.x0 + (c + 0.5) * cs, y = g.y0 + (g.nr - rr - 0.5) * cs;
      const C = Math.floor((x - X0) / cs), R = Math.floor((Y1 - y) / cs);
      if (C >= 0 && R >= 0 && C < NC && R < NR) Z[R * NC + C] = g.v[rr * g.nc + c];
    }
    onProgress({ done: ++n, total: xs.length * ys.length });
  }
  let missing = 0; for (const v of Z) if (v !== v) missing++;
  let grid = Z, terr = null;
  if (deterrace) { const d = deterraceGrid(Z, NR, NC, cs); grid = d.Z; terr = d.stats; }
  const val = bilinear(grid, NR, NC, cs, X0, Y1);
  function sample(pts, org = [0, 0]) {
    const z = new Float32Array(pts.length / 2);
    for (let i = 0; i < z.length; i++) z[i] = val(pts[2 * i] + org[0], pts[2 * i + 1] + org[1]);
    return z;
  }
  return { meta: { source: "IGN MDT05 (WCS IDEE)", coverage, url, resolution_m: cs, tiles: n, grid: [X0, Y0, X1, Y1], cellsMissing: missing, deterrace: terr },
    sample, grid: { Z: grid, raw: Z, NR, NC, cs, X0, Y1 } };
}
