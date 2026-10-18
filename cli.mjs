// Línea de órdenes (Node ≥ 18). Ejemplos:
//   node cli.mjs --city madrid --pbf madrid-261006.osm.pbf --out .              (todo: OSM, alturas y ficheros)
//   node cli.mjs --city navalcarnero --pbf madrid-261006.osm.pbf --out .
//   node cli.mjs --city madrid --pbf madrid-261006.osm.pbf --state-out estado.json.gz --z-out alturas.bin.gz
//   node cli.mjs --city madrid --state estado.json.gz --z alturas.bin.gz --z-meta alturas.json --out .
// Las alturas se leen de la fuente de cada lugar (CITIES en build.mjs): el MDT 2025 del Ayuntamiento para Madrid
// (--mdt permite usar una copia local de MDT_1m.zip) y el MDT05 del IGN por WCS para Navalcarnero.
import { readFileSync, writeFileSync, mkdirSync, createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { stage1, stage3, sampleElevation, writeOutputs, citiesIndex, CITIES } from "./build.mjs";
import { unpackState, gzip, gunzip, enc, decodeZ, encodeZ } from "./state.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) { const s = process.argv[i]; if (s.startsWith("--")) { const nx = process.argv[i + 1]; args[s.slice(2)] = nx && !nx.startsWith("--") ? (i++, nx) : true; } }
const out = args.out || ".";
const write = (p, b) => { const f = join(out, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, b); console.log("escrito", f, b.length, "bytes"); };
const log = m => console.log(m);
const cfg = CITIES[args.city || "madrid"];
if (!cfg) { console.error("lugar desconocido: " + args.city + " (disponibles: " + Object.keys(CITIES).join(", ") + ")"); process.exit(1); }

let packed;
if (args.state) packed = JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(readFileSync(args.state)))));
else if (args.pbf) {
  const bytes = new Uint8Array(readFileSync(args.pbf));
  const md5 = createHash("md5").update(bytes).digest("hex");
  if (md5 !== cfg.pbf.md5) console.warn(`aviso: md5 ${md5} distinto del documentado (${cfg.pbf.md5})`);
  packed = await stage1(bytes, async b => new Uint8Array(inflateSync(b)), cfg, log);
  packed.meta.osm.md5 = md5;
  if (args["state-out"]) write(args["state-out"], await gzip(enc(JSON.stringify(packed))));
} else {
  console.error("uso: node cli.mjs --city <lugar> (--pbf extracto.osm.pbf | --state estado.json.gz) [--z alturas.bin.gz] [--mdt MDT_1m.zip] [--out carpeta]");
  process.exit(1);
}
const state = unpackState(packed);
let z, demMeta = null;
if (args.z) {
  z = decodeZ(await gunzip(new Uint8Array(readFileSync(args.z))));
  demMeta = args["z-meta"] ? JSON.parse(readFileSync(args["z-meta"], "utf8")) : null;
} else {
  const opts = { onProgress: p => log("MDT: " + JSON.stringify(p)) };
  if (args.mdt && cfg.dem.type === "madrid-mdt") opts.fetchImpl = async () => new Response(Readable.toWeb(createReadStream(args.mdt)));
  ({ z, meta: demMeta } = await sampleElevation(state, cfg, opts));
  if (args["z-out"]) { write(args["z-out"], await gzip(encodeZ(z))); write(args["z-out"].replace(/\.bin\.gz$/, "") + ".json", enc(JSON.stringify(demMeta))); }
}
const res = stage3(state, z, demMeta, cfg);
await writeOutputs(res, write, cfg.id);
write("cities.json", enc(JSON.stringify(citiesIndex(), null, 1)));
console.log(JSON.stringify(res.report.stage3, null, 1));
