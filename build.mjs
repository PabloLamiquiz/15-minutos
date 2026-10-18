// Proceso completo de generación de los datos de la página. Los mismos módulos funcionan en Node ≥ 18 (línea de
// órdenes, al final de este fichero) y en el navegador.
//   1. OSM: red peatonal, destinos, duplicados, bocas de metro, zonas verdes y mapa base → estado intermedio
//   2. Elevación: perfil cada 2 m sobre la geometría real de cada tramo (MDT 2025 del Ayuntamiento en Madrid, MDT05
//      del IGN fuera del término municipal)
//   3. Pendientes por trozos, enganche de destinos y escritura de ficheros (data/<lugar>/ y data/<lugar>/audit/)
import { readOSM, buildWalkGraph, buildPolygons, buildDestinations, findDuplicates, greenClass, linkEntrances, buildBasemap,
  segmentIndex, attachDestinations, knownEntrances, CATS, RULES } from "./osm_build.mjs";
import { samplePlan, computeSlopes, SLOPE_PARAMS, Q, ORIGIN } from "./slopes.mjs";
import { loadMadridMDT } from "./dem_madrid.mjs";
import { loadIGNMDT } from "./dem_ign.mjs";
import { encodeGraph, encodeDestinations, csv, GREEN_CLASSES } from "./write.mjs";
import { bboxFromPoint, utm30 } from "./geo.mjs";
import { packState, unpackState, gzip, enc } from "./state.mjs";

// Lugares disponibles. Cada uno se genera por separado en data/<id>/ y la página deja elegir entre ellos.
// Extractos de OpenStreetMap de Geofabrik (Comunidad de Madrid). Geofabrik borra los ficheros diarios a los pocos días
// y conserva más tiempo los del día 1 de cada mes; se documentan nombre, md5 y fecha de los datos de cada uno.
const PBF_MADRID = { url: "https://download.geofabrik.de/europe/spain/madrid-261006.osm.pbf", md5: "ad4f40446f40f6ec7e279eb90215d133",
  note: "fichero diario, ya no disponible en Geofabrik; datos hasta 2026-10-06T20:21:06Z" };
const PBF_201001 = { url: "https://download.geofabrik.de/europe/spain/madrid-261001.osm.pbf", md5: "076135a2cba8a9176307f9a311193a73" };
export const CITIES = {
  madrid: {
    id: "madrid", name: "Madrid", start: "Puerta del Sol",
    center: [40.4169, -3.7035],  // Puerta del Sol
    radius: 7000,                // m: caja de 14 × 14 km (mismo criterio que osmnx.utils_geo.bbox_from_point)
    marginDeg: 0.01,             // nodos que se leen fuera de la caja para no cortar vías ni polígonos
    zoom: 15, pbf: PBF_MADRID,
    dem: {
      type: "madrid-mdt", dataset: "SPA_28079_SERVICIO_MDT_MOSAICO_2025", name: "MDT 2025 del Ayuntamiento de Madrid",
      url: "https://geoportal.madrid.es/fsdescargas/IDEAM_WBGEOPORTAL/ELEVACIONES/2025/MDT/MOSAICO/MDT_1m.zip",
      level: 1,                  // resolución reducida de 2 m dentro del COG de 1 m
      bytes: 1516568778, lastModified: "2025-10-15T12:21:37Z",
      attribution: { es: "Elevación: MDT 2025 © Ayuntamiento de Madrid", en: "Elevation: MDT 2025 © Madrid City Council", url: "https://geoportal.madrid.es" },
    },
  },
  navalcarnero: {
    id: "navalcarnero", name: "Navalcarnero", start: "Plaza de Segovia",
    center: [40.28763, -4.01426],   // Plaza de Segovia (centro de la vía peatonal 33733763 de OSM)
    radius: 5000,                   // m: caja de 10 × 10 km (casco, ensanches y urbanizaciones a menos de 5 km)
    marginDeg: 0.01, zoom: 15, pbf: PBF_201001,
    dem: {
      type: "ign-wcs", coverage: "Elevacion25830_5", name: "MDT05 del IGN (5 m)", url: "https://servicios.idee.es/wcs-inspire/mdt",
      deterrace: true,           // el MDT05 tiene terrazas de 1 m: se reconstruye entre curvas de nivel (terrain.mjs)
      attribution: { es: "Elevación: MDT05 © IGN (CC BY 4.0 scne.es)", en: "Elevation: MDT05 © IGN Spain (CC BY 4.0 scne.es)", url: "https://www.scne.es" },
    },
    // Con una malla de 5 m no se pueden medir rampas de 10 m: contrastado con el MDT municipal en 5 × 5 km de Madrid,
    // la pendiente máxima en ventanas de 30 m sale sin sesgo (error medio 1,6 puntos) y en ventanas de 10 m no
    // (AUDITORIA.md, «Navalcarnero»). La página indica la ventana de cada lugar.
    slope: { window: 30, minPiece: 30 },
  },
};
export const CONFIG = CITIES.madrid;   // compatibilidad
const KEEP_TAGS = ["name", "amenity", "shop", "leisure", "railway", "highway", "public_transport", "station", "subway", "train", "light_rail",
  "wheelchair", "access", "garden:type", "healthcare", "healthcare:speciality", "dispensing", "isced:level", "school", "operator", "operator:type",
  "playground", "landuse", "building", "opening_hours", "entrance"];

async function sha256hex(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(h, b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- etapa 1
export async function stage1(bytes, inflate, cfg = CONFIG, log = () => {}) {
  cfg = { ...cfg };
  const bbox = bboxFromPoint(cfg.center[0], cfg.center[1], cfg.radius), c = { bbox, marginDeg: cfg.marginDeg };
  const t0 = Date.now();
  const osm = await readOSM(bytes, inflate, c); log(`OSM leído en ${Date.now() - t0} ms`);
  const graph = buildWalkGraph(osm, c); log(`red: ${graph.edges.length} tramos, ${graph.stats.km.toFixed(1)} km`);
  const polys = buildPolygons(osm);
  const all = buildDestinations(osm, polys, c);
  const dup = findDuplicates(all);
  all.forEach((d, i) => { if (dup.dupOf[i] >= 0) { d.dropped = "duplicado"; d.dupOf = all[dup.dupOf[i]].osm; } });
  const live = all.filter(d => !d.dropped);
  const ent = linkEntrances(live, osm);
  for (const d of live) if (d.mergedInto) d.dropped = "estación repetida";
  for (const d of all) if (d.cat === "green") d.greenClass = greenClass(d);
  const known = knownEntrances(all, osm);
  const basemap = buildBasemap(osm, polys, graph, c); log("destinos y mapa base listos");
  // tabla de nodos reducida a la geometría de la red
  const used = new Map(), nlon = [], nlat = [];
  const ix = i => { let k = used.get(i); if (k === undefined) { k = nlon.length; used.set(i, k); nlon.push(osm.nodes.lon[i]); nlat.push(osm.nodes.lat[i]); } return k; };
  for (const e of graph.edges) e.geom = e.geom.map(ix);
  const nodeIdx = graph.nodeOsmIdx.map(ix);
  // informes
  const byType = {};
  for (const d of all) {
    const k = d.cat + "/" + d.sub, r = byType[k] || (byType[k] = { cat: d.cat, sub: d.sub, node: 0, way: 0, relation: 0, polygon: 0, dropped_duplicate: 0, dropped_station: 0, kept: 0 });
    r[{ n: "node", w: "way", r: "relation" }[d.osm[0]]]++; if (d.poly) r.polygon++;
    if (d.dropped === "duplicado") r.dropped_duplicate++; else if (d.dropped) r.dropped_station++; else r.kept++;
  }
  const greenCount = {}; for (const d of all) if (d.cat === "green" && !d.dropped) greenCount[d.greenClass] = (greenCount[d.greenClass] || 0) + 1;
  const ek = { steps: 0, steps_ramp: 0, bridge: 0, tunnel: 0, indoor: 0, layer: 0, incline: 0 };
  for (const e of graph.edges) { if (e.flags & 1) ek.steps++; if (e.flags & 8) ek.steps_ramp++; if (e.structure) ek[e.structure]++; if (e.layer && !e.structure) ek.layer++; if (e.incline) ek.incline++; }
  const S = {
    meta: { created: new Date().toISOString(), config: cfg, bbox,
      osm: { bytes: bytes.length, sha256: await sha256hex(bytes), timestamp: osm.info.timestamp ? new Date(osm.info.timestamp * 1000).toISOString() : null, replicationUrl: osm.info.replicationUrl || null } },
    reports: { graph: { ...graph.stats, edgeKinds: ek }, destTypes: Object.values(byType), duplicates: dup.reasons, entrances: ent, knownEntrances: known, greenClasses: greenCount,
      rules: RULES, precedence: "railway=station|halt|tram_stop → railway=subway_entrance|train_station_entrance → amenity=bench → shop → amenity (salud) → amenity (educación) → leisure → amenity (comer) → highway=bus_stop" },
    nodes: { lon: Float64Array.from(nlon), lat: Float64Array.from(nlat) },
    graph: { nodeIdx, nodeOsmId: graph.nodeOsmId, stats: graph.stats, edges: graph.edges },
    basemap,
    dests: all.map(d => {
      const tags = {}; for (const k of KEEP_TAGS) if (d.tags[k] !== undefined) tags[k] = d.tags[k];
      const o = { osm: d.osm, cat: d.cat, sub: d.sub, lon: d.lon, lat: d.lat, name: d.name, area: d.area, tags };
      for (const k of ["partial", "dropped", "dupOf", "mergedInto", "greenClass", "wc", "station", "stype", "stationByDistance", "known"]) if (d[k] !== undefined && d[k] !== "" && d[k] !== false) o[k] = d[k];
      if (d.poly && !d.dropped) o.poly = d.poly;
      return o;
    }),
  };
  return packState(S);
}

// ---------------------------------------------------------------- etapa 2: alturas en los puntos de muestreo
export function planFor(state) { return samplePlan(state.graph, { nodes: state.nodes }); }

// rectángulo UTM que cubre la caja del lugar con margen (para pedir el modelo del terreno de una vez)
export function utmRect(bbox, margin = 150) {
  const [W, S, E, N] = bbox, pts = [[W, S], [W, N], [E, S], [E, N]].map(([lo, la]) => utm30(lo, la));
  return [Math.floor(Math.min(...pts.map(p => p[0]))) - margin, Math.floor(Math.min(...pts.map(p => p[1]))) - margin,
    Math.ceil(Math.max(...pts.map(p => p[0]))) + margin, Math.ceil(Math.max(...pts.map(p => p[1]))) + margin];
}
export async function sampleElevation(state, cfg, opts = {}) {
  const sp = planFor(state), rect = utmRect(state.meta.bbox);
  const dem = cfg.dem.type === "madrid-mdt"
    ? await loadMadridMDT(cfg.dem.url, { rect, level: cfg.dem.level, ...opts })
    : await loadIGNMDT(rect, { coverage: cfg.dem.coverage, url: cfg.dem.url, deterrace: !!cfg.dem.deterrace, ...opts });
  return { z: dem.sample(sp.xy, ORIGIN), meta: { ...dem.meta, rect } };
}

// ---------------------------------------------------------------- etapa 3
// La red no se parte: cada tramo lleva sus trozos de pendiente homogénea (posición, pendiente de barrera, factores de
// tiempo en cada sentido y calidad) y la página los recorre en orden. Así se conservan las conexiones y la geometría
// originales y los datos ocupan menos.
export function stage3(state, z, demMeta, cfg = CONFIG, P = { ...SLOPE_PARAMS, ...(cfg.slope || {}) }) {
  const osmLike = { nodes: state.nodes };
  const sp = samplePlan(state.graph, osmLike, P);
  if (z.length !== sp.xy.length / 2) throw new Error(`alturas: ${z.length} muestras, se esperaban ${sp.xy.length / 2}`);
  const res = computeSlopes(state.graph, osmLike, sp, z, P);
  const byEdge = Array.from({ length: state.graph.edges.length }, () => []);
  for (const p of res.pieces) byEdge[p.edge].push(p);
  byEdge.forEach(l => l.sort((x, y) => x.a - y.a));
  // destinos
  const live = state.dests.filter(d => !d.dropped);
  const seg = segmentIndex(state.graph, osmLike);
  const attach = attachDestinations(live, state.graph, osmLike, seg);
  // nombres de calles y parques
  const names = [""], nIdx = new Map([["", 0]]);
  const ni = s => { s = s || ""; if (!nIdx.has(s)) { nIdx.set(s, names.length); names.push(s); } return nIdx.get(s); };
  const graphBin = encodeGraph(state.graph, state.nodes, byEdge, ni, state.basemap.lines);
  const subs = [...new Set(live.map(d => d.sub))].sort();
  const pois = encodeDestinations(live, CATS, subs, i => i);
  const date = (state.meta.osm.timestamp || "").slice(0, 10);
  const extra = {
    v: 4, city: cfg.id, name: cfg.name, startName: cfg.start, date, bbox: state.meta.bbox, start: cfg.center, zoom: cfg.zoom, names,
    parks: state.basemap.parks, water: state.basemap.water,
    parkLabels: state.basemap.labels.map(l => [Math.round(l.lon * 1e5), Math.round(l.lat * 1e5), ni(l.name)]),
    slope: { thresholds: P.thresholds.map(t => Math.round(t * 100)), window_m: P.window, step_m: P.step, minPiece_m: P.minPiece, quality: Q },
    dem: { name: cfg.dem.name, attribution: cfg.dem.attribution, resolution_m: demMeta && demMeta.resolution_m },
    sources: { osm: { url: cfg.pbf.url, timestamp: state.meta.osm.timestamp, sha256: state.meta.osm.sha256 }, dem: { ...cfg.dem, attribution: undefined } },
  };
  const rep = slopeReport(state, byEdge, z);
  rep.attach = attach;
  const snapD = live.filter(d => d.snap).map(d => d.snap[0][2]).sort((a, b) => a - b);
  rep.attach.snapDistance_m = { p50: snapD[snapD.length >> 1], p90: snapD[Math.floor(snapD.length * 0.9)], max: snapD[snapD.length - 1] };
  const report = { city: cfg.id, meta: state.meta, dem: demMeta || null, slopeParams: P, stage1: state.reports, stage3: rep,
    output: { nodes: state.graph.lon.length, edges: state.graph.edges.length, pieces: res.pieces.length, pois: live.length } };
  const auditFiles = auditTables(state, live);
  return { files: { "graph.bin": graphBin, "extra.json": enc(JSON.stringify(extra)), "pois.json": enc(JSON.stringify(pois)) }, report, audit: auditFiles, res, sp, live, byEdge };
}

function slopeReport(state, byEdge, z) {
  const cls = {}, qkm = { structure: 0, discontinuity: 0, missing: 0, layer: 0 };
  let total = 0, maxDiff = 0;
  state.graph.edges.forEach((e, ei) => {
    let sum = 0;
    for (const p of byEdge[ei]) {
      const L = (p.b - p.a) / 1000; sum += p.b - p.a; total += L;
      if (e.flags & 1) { cls.steps = (cls.steps || 0) + L; continue; }
      const g = p.gmax, k = g !== g ? "unknown" : g <= 0.04 ? "0-4" : g <= 0.06 ? "4-6" : g <= 0.08 ? "6-8" : g <= 0.10 ? "8-10" : g <= 0.12 ? "10-12" : ">12";
      cls[k] = (cls[k] || 0) + L;
      if (p.q & Q.STRUCTURE) qkm.structure += L; if (p.q & Q.DISCONTINUITY) qkm.discontinuity += L; if (p.q & Q.MISSING) qkm.missing += L; if (p.q & Q.LAYER) qkm.layer += L;
    }
    maxDiff = Math.max(maxDiff, Math.abs(sum - e.len));
  });
  let nan = 0; for (let i = 0; i < z.length; i++) if (z[i] !== z[i]) nan++;
  const round = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  const pieces = byEdge.reduce((s, l) => s + l.length, 0);
  return { km_by_class: round(cls), km_flagged: round(qkm), km_total: Math.round(total * 100) / 100,
    length_edges_m: Math.round(state.graph.edges.reduce((s, e) => s + e.len, 0) * 1000) / 1000, max_piece_sum_diff_m: maxDiff,
    edges: state.graph.edges.length, pieces, samples: z.length, samples_missing: nan };
}

function auditTables(state, live) {
  const types = csv(state.reports.destTypes.map(r => ({ ...r, rule: ruleText(r.cat, r.sub) })), ["cat", "sub", "rule", "node", "way", "relation", "polygon", "dropped_duplicate", "dropped_station", "kept"]);
  const dups = csv(state.reports.duplicates, ["cat", "sub", "keep", "drop", "dist_m", "why"]);
  const how = {}; for (const d of live) { const k = d.cat + "/" + d.sub, r = how[k] || (how[k] = { cat: d.cat, sub: d.sub, entrances: 0, snap: 0, none: 0, snap_p50_m: [], snap_gt50: 0 });
    if (d.entrances) r.entrances++; else if (d.snap) { r.snap++; r.snap_p50_m.push(d.snap[0][2]); if (d.snap[0][2] > 50) r.snap_gt50++; } else r.none++; }
  const attach = csv(Object.values(how).map(r => { const a = r.snap_p50_m.sort((x, y) => x - y); return { ...r, snap_p50_m: a.length ? a[a.length >> 1] : "" }; }),
    ["cat", "sub", "entrances", "snap", "none", "snap_p50_m", "snap_gt50"]);
  // todos los destinos de la página, con su id de OSM (procedencia), tipo, clase de zona verde y forma de enganche
  const pois = csv(live.map(d => ({ osm_id: d.osm, url: "https://www.openstreetmap.org/" + { n: "node", w: "way", r: "relation" }[d.osm[0]] + "/" + d.osm.slice(1),
    cat: d.cat, sub: d.sub, name: d.name, lon: d.lon.toFixed(6), lat: d.lat.toFixed(6), area_m2: d.area || "", green_class: d.greenClass || "", wheelchair: d.wc || "",
    attach: d.attach || "", snap_m: d.snap ? d.snap[0][2] : "", entrances: d.entrances ? d.entrances.length : 0 })),
    ["osm_id", "url", "cat", "sub", "name", "lon", "lat", "area_m2", "green_class", "wheelchair", "attach", "snap_m", "entrances"]);
  return { "services_types.csv": types, "services_duplicates.csv": dups, "services_attachment.csv": attach, "pois.csv.gz": pois };
}
function ruleText(cat, sub) {
  if (cat === "station") return `railway=${sub}`;
  if (cat === "entrance") return `railway=${sub}`;
  if (cat === "bench") return "amenity=bench";
  if (cat === "bus") return "highway=bus_stop";
  const r = RULES[cat]; return r ? `${r[0]}=${sub}` : "";
}

// ---------------------------------------------------------------- escritura
export async function writeOutputs(out, write, city = "madrid") {
  for (const [name, bytes] of Object.entries(out.files)) await write(`data/${city}/${name}.gz`, await gzip(bytes));
  await write(`data/${city}/audit/build_report.json`, enc(JSON.stringify(out.report, null, 1)));
  for (const [name, text] of Object.entries(out.audit)) await write(`data/${city}/audit/${name}`, name.endsWith(".gz") ? await gzip(enc(text)) : enc(text));
}

// índice de lugares para la página
export function citiesIndex() {
  return { cities: Object.values(CITIES).map(c => ({ id: c.id, name: c.name, start: c.start, center: c.center, zoom: c.zoom, radius_km: c.radius / 1000 })) };
}
