// Escenarios de referencia (los mismos lugares y ajustes que se midieron en la versión publicada v5) calculados con el
// núcleo de la página (core.js) sobre los datos actuales:
//   node scenarios.mjs madrid scenarios.json [scenarios_v5.json]
// Con el tercer argumento, añade la cifra de la v5 para comparar.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
const Core = createRequire(import.meta.url)("./core.js");
const [city, scenF, v5F] = process.argv.slice(2), here = new URL(".", import.meta.url).pathname, file = f => here + city + "-" + f;
const S = JSON.parse(readFileSync(scenF, "utf8")), V5 = v5F ? JSON.parse(readFileSync(v5F, "utf8")) : null;
const G = Core.parseGraph(new Uint8Array(gunzipSync(readFileSync(file("graph.bin.gz"))))), EG = Core.buildEdgeGrid(G);
const P = Core.parsePois(JSON.parse(gunzipSync(readFileSync(file("pois.json.gz"))).toString()));
const T = S.minutes * 60, REF = { speed: 1.4, avoidSteps: false, slope: false, maxGrade: 0, uncertainBarrier: false };
const amen = [0, 1, 2, 3, 4];
const rows = [];
for (const [place, [lat, lon]] of Object.entries(S.places)) {
  const rR = Core.solve(G, EG, lon, lat, REF, T), kmR = Core.collectReach(G, rR).lengthM / 1000, cR = Core.countReach(G, P, rR, false);
  for (const [name, s] of Object.entries(S.settings)) {
    const o = { speed: s.spd, avoidSteps: !!s.st, slope: !!s.cu, maxGrade: s.pm ? s.pm / 100 : 0, uncertainBarrier: !!s.pu };
    const r = Core.solve(G, EG, lon, lat, o, T);
    if (!r) { rows.push({ place, name, km: 0 }); continue; }
    const km = Core.collectReach(G, r).lengthM / 1000, c = Core.countReach(G, P, r, o.avoidSteps);
    const v5 = V5 && V5[`${place}/${name}`];
    rows.push({ place, name, km: +km.toFixed(1), kmRef: +kmR.toFixed(1), pct: Math.round((km / kmR - 1) * 100),
      amenities: amen.reduce((a, k) => a + c.cat[k], 0), amenitiesRef: amen.reduce((a, k) => a + cR.cat[k], 0), stations: c.cat[6], stationsUsable: c.stUsable,
      v5: v5 ? { km: v5.km_adj, kmRef: v5.km_ref, pct: Math.round((v5.km_adj / v5.km_ref - 1) * 100) } : undefined });
  }
}
console.log("lugar | ajustes | km | % frente a la referencia (1,4 m/s) | servicios | estaciones (sin escalones) | v5: km, %");
for (const r of rows) console.log([r.place, r.name, r.km, (r.pct > 0 ? "+" : "") + r.pct + " %", `${r.amenities} de ${r.amenitiesRef}`, `${r.stations} (${r.stationsUsable})`, r.v5 ? `${r.v5.km} de ${r.v5.kmRef}, ${r.v5.pct} %` : ""].join(" | "));
