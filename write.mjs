// Etapa 3: codificación de los ficheros que carga la página y de los ficheros de auditoría.
import { Q } from "./slopes.mjs";

// graph.bin versión 4 (little endian). Secuencias de coordenadas y de índices como diferencias con la anterior
// (se comprimen mucho mejor); la página las acumula al leer.
//   cabecera 8 × uint32: 4, nodos, tramos, puntos de forma, líneas base, puntos de líneas base, trozos, longitudes de trozo
//   int32:  nodos lon, lat (grados × 1e5, diferencias)
//           tramos u, v (diferencias), longitud (dm), nombre (índice en extra.names)
//           formas lon, lat (× 1e5, diferencias)
//           longitud de los trozos (dm), salvo la del último de cada tramo, que es lo que falta hasta su longitud
//           líneas base: tipo, inicio (líneas+1), lon, lat (× 1e5, diferencias)
//   uint16: tramos: número de puntos de forma, número de trozos
//   uint8:  trozos: pendiente de barrera (en 0,25 %, redondeada hacia arriba; 255 = sin dato),
//                   factor de tiempo u→v y v→u ((factor − 1) × 100), calidad (1 estructura, 2 discontinuidad,
//                   4 sin dato, 8 capa≠0)
//           tramos: banderas (bit0 escalera, bit1 calle principal, bit2 estructura, bit3 escalera con rampa)
export function encodeGraph(graph, nodes, byEdge, nameIdx, lines) {
  const E = graph.edges, nN = graph.lon.length, nE = E.length;
  const dl = arr => { const o = new Array(arr.length); let p = 0; for (let i = 0; i < arr.length; i++) { o[i] = arr[i] - p; p = arr[i]; } return o; };
  const e5 = v => Math.round(v * 1e5), dm = v => Math.round(v * 10);
  const scnt = [], slon = [], slat = [];
  for (const e of E) { for (let k = 1; k < e.geom.length - 1; k++) { slon.push(e5(nodes.lon[e.geom[k]])); slat.push(e5(nodes.lat[e.geom[k]])); } scnt.push(e.geom.length - 2); }
  const pcnt = [], plen = [], pg = [], ptf = [], ptb = [], pq = [];
  const u8 = v => Math.max(0, Math.min(254, v));
  E.forEach((e, ei) => {
    const ps = byEdge[ei], L = dm(e.len);
    ps.forEach((p, k) => {
      const a = k === 0 ? 0 : dm(p.a), b = k === ps.length - 1 ? L : dm(p.b);
      if (k < ps.length - 1) plen.push(b - a);
      pg.push(p.gmax === p.gmax ? u8(Math.ceil(p.gmax * 400 - 1e-9)) : 255);
      ptf.push(Math.min(255, Math.max(0, Math.round((p.tf - 1) * 100)))); ptb.push(Math.min(255, Math.max(0, Math.round((p.tb - 1) * 100)))); pq.push(p.q & 255);
    });
    pcnt.push(ps.length);
  });
  if (scnt.some(v => v > 65535) || pcnt.some(v => v > 65535)) throw new Error("demasiados puntos o trozos en un tramo");
  const bk = [], bst = [0], blon = [], blat = [];
  for (const [kind, flat] of lines) { bk.push(kind); for (let i = 0; i < flat.length; i += 2) { blon.push(flat[i]); blat.push(flat[i + 1]); } bst.push(blon.length); }
  const nS = slon.length, nB = bk.length, nBP = blon.length, nP = pg.length, nPL = plen.length;
  const i32 = [
    dl(Array.from(graph.lon, e5)), dl(Array.from(graph.lat, e5)),
    dl(E.map(e => e.u)), dl(E.map(e => e.v)), E.map(e => dm(e.len)), E.map(e => nameIdx(e.name)),
    dl(slon), dl(slat), plen, bk, bst, dl(blon), dl(blat)];
  const n32 = i32.reduce((s, a) => s + a.length, 0), size0 = 32 + 4 * n32 + 4 * nE + 4 * nP + nE, size = Math.ceil(size0 / 4) * 4;
  const buf = new ArrayBuffer(size), dv = new DataView(buf); let o = 0;
  for (const v of [4, nN, nE, nS, nB, nBP, nP, nPL]) { dv.setUint32(o, v, true); o += 4; }
  for (const a of i32) for (const v of a) { dv.setInt32(o, v, true); o += 4; }
  for (const a of [scnt, pcnt]) for (const v of a) { dv.setUint16(o, v, true); o += 2; }
  for (const a of [pg, ptf, ptb, pq]) for (const v of a) dv.setUint8(o++, v);
  for (const e of E) dv.setUint8(o++, e.flags & 255);
  if (o !== size0) throw new Error("tamaño de graph.bin incoherente");
  return new Uint8Array(buf);
}

// Destinos en columnas para la página.
export const GREEN_CLASSES = ["green_large", "green_small", "playground", "park_point", "garden_point", "private"];
export function encodeDestinations(dests, catList, subList, nodeOfOsmIdx) {
  const keep = dests.filter(d => !d.dropped);
  const idx = new Map(keep.map((d, i) => [d.osm, i]));
  const names = [""], nameMap = new Map([["", 0]]);
  const ni = s => { if (!nameMap.has(s)) { nameMap.set(s, names.length); names.push(s); } return nameMap.get(s); };
  const WC = { yes: 1, limited: 2, no: 3 };
  const col = { id: [], c: [], s: [], lon: [], lat: [], nm: [], wc: [], gc: [], st: [], ty: [], snap: [], ent: [] };
  for (const d of keep) {
    col.id.push(d.osm); col.c.push(catList.indexOf(d.cat)); col.s.push(subList.indexOf(d.sub));
    col.lon.push(Math.round(d.lon * 1e6)); col.lat.push(Math.round(d.lat * 1e6)); col.nm.push(ni(d.name || ""));
    col.wc.push(WC[d.wc] || 0); col.gc.push(d.cat === "green" ? GREEN_CLASSES.indexOf(d.greenClass) : -1);
    col.st.push(d.station ? (idx.has(d.station) ? idx.get(d.station) : -1) : -1);
    col.ty.push(d.cat === "station" ? ["other", "subway", "train", "light_rail"].indexOf(d.stype) : -1);
    col.snap.push(d.snap ? d.snap.flat() : []);
    col.ent.push(d.entrances ? d.entrances.map(nodeOfOsmIdx) : []);
  }
  const { id, ...rest } = col;   // los ids de OSM van en <lugar>-audit-pois.csv.gz, que la página no necesita
  return { cats: catList, subs: subList, greenClasses: GREEN_CLASSES, names, ...rest };
}

export function csv(rows, header) {
  const esc = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [header.join(","), ...rows.map(r => header.map(h => esc(r[h])).join(","))].join("\n") + "\n";
}
export { Q };
