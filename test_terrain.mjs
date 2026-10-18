// Prueba sintética de la reconstrucción de terrazas (build/terrain.mjs):
//   node build/test/test_terrain.mjs
// Una ladera con pendiente conocida, redondeada a metros enteros en una malla de 5 m (como el MDT05), se reconstruye y
// se mide la pendiente en ventanas de 10 y 30 m a lo largo de una línea, antes y después. Es una comprobación de
// consistencia: el MDT05 real no es un redondeo puro (las transiciones están suavizadas); el contraste con datos reales
// está en AUDITORIA.md, apartado 6.
import { deterrace, bilinear } from "../terrain.mjs";

const NC = 400, NR = 400, cs = 5;
let fails = 0;
for (const [gx, gy] of [[0.03, 0], [0.02, 0.02], [0.06, -0.01], [0.10, 0.03]]) {
  const Z = new Float32Array(NR * NC);
  for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) Z[r * NC + c] = Math.round(600 + gx * c * cs - gy * r * cs);   // y hacia el norte
  const { Z: D } = deterrace(Z, NR, NC, cs);
  const raw = bilinear(Z, NR, NC, cs, 0, NR * cs), rec = bilinear(D, NR, NC, cs, 0, NR * cs);
  const g = Math.hypot(gx, gy), ux = gx / g, uy = gy / g;   // línea de máxima pendiente por el centro
  for (const win of [10, 30]) {
    let errRaw = 0, errRec = 0;
    for (let s = -300; s <= 300 - win; s += 2) {
      const x0 = 1000 + ux * s, y0 = 1000 + uy * s, x1 = x0 + ux * win, y1 = y0 + uy * win;
      errRaw = Math.max(errRaw, Math.abs((raw(x1, y1) - raw(x0, y0)) / win - g));
      errRec = Math.max(errRec, Math.abs((rec(x1, y1) - rec(x0, y0)) / win - g));
    }
    // con curvas a 20 m o más (pendientes de hasta el 5 %) la reconstrucción es completa y casi exacta; con pendientes
    // más fuertes las terrazas son cortas, se conserva parte del valor original y solo se exige no empeorar
    const ok = errRec <= errRaw + 1e-9 && (g > 0.05 || errRec < 0.005);
    if (!ok) fails++;
    console.log(`pendiente ${(g * 100).toFixed(1)} %, ventana ${win} m: error máximo ${(errRaw * 100).toFixed(1)} puntos sin reconstruir, ${(errRec * 100).toFixed(1)} reconstruida ${ok ? "" : "← FALLO"}`);
  }
}
console.log(fails ? `${fails} fallos` : "todo correcto");
process.exit(fails ? 1 : 0);
