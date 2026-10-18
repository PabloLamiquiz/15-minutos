# Auditoría · 15 minutos (Madrid y Navalcarnero)

Trabajo hecho en la rama `auditoria-pendientes-servicios` del repositorio anterior (`15--minutos-madrid`) y publicado como proyecto nuevo (`15-minutos`). Primera entrega: 8 de octubre de 2026. Esta versión: 18 de octubre de 2026.

**Estado: lista para revisión.** Los datos de la página ya están regenerados con el método nuevo y la página los usa. Al final hay una lista de lo que queda pendiente.

Cada comprobación lleva una de estas dos marcas, para no dar por validado lo que solo reproduce sus propios resultados:

- **[independiente]**: compara con otra fuente u otra implementación.
- **[consistencia]**: comprueba que el código hace lo que dice, pero no que el dato sea correcto.

## 1. Resumen

- **Pendientes.**
  - Antes, la pendiente de cada tramo era la cuerda entre sus dos cruces, con el MDT05 del IGN y dividida entre `max(L, 20 m)`.
  - Ahora es el máximo en ventanas de 10 m sobre el perfil real del tramo, muestreado cada 2 m en el MDT 2025 del Ayuntamiento.
  - El tiempo se calcula con la función de Tobler, intervalo a intervalo y en cada sentido.
  - Los puentes, los muros y los saltos de cota se detectan y quedan marcados como inciertos.
- **Conexión a la red.**
  - El punto de salida se proyecta sobre el tramo permitido más cercano. Antes se unía en línea recta a todos los cruces cercanos, y así podía saltarse escaleras o cuestas.
  - Los destinos se enganchan a sus dos tramos más cercanos, o a sus accesos reales: caminos que cruzan el borde de un parque o recinto, o bocas de metro.
- **Resultados.**
  - Cambian mucho con el filtro del 6 %. Desde Sol, con 1,1 m/s y sin escaleras, la red alcanzable baja un **71 %** frente a la referencia; la v5 daba un 55 %. En Vistillas baja un **91 %**; la v5 daba un 73 %.
  - El motivo es la medida: una calle con una media del 4 % y un tramo de 20 m al 8 % ya no pasa el filtro del 6 %.
  - No se ha ajustado ningún parámetro para acercarse a los resultados anteriores.
- **Navalcarnero.**
  - Se añade como segundo lugar, con un selector en la página.
  - El MDT05 del IGN tiene «terrazas» de 1 m que inventan rampas. Se reconstruye la superficie entre curvas de nivel y la pendiente se mide en 30 m, una elección contrastada con el modelo municipal en Madrid (apartado 6).
  - OpenStreetMap tiene muy pocos servicios mapeados en Navalcarnero.

## 2. Hallazgos y estado

| # | Problema en la v5 publicada | Efecto | Estado en esta rama |
|---|---|---|---|
| E1 | Pendiente = desnivel entre los cruces del tramo (MDT05, 5 m) / `max(L, 20 m)` | Ignora subidas y bajadas dentro del tramo; en puentes y junto a muros un cruce toma la cota de abajo | Corregido (`slopes.mjs`) y en la página |
| E2 | El origen se unía en línea recta a todos los cruces a menos de 60–400 m | Podía «saltar» escaleras, muros o tramos excluidos | Corregido (`core.js`, `solve`): proyección sobre el trozo permitido más cercano, a 300 m como mucho, y salida por los dos extremos de ese tramo |
| E3 | Cada servicio iba al cruce más cercano, sin mirar si se llegaba a él por tramos permitidos | Igual que E2, para los destinos | Corregido: dos enganches (tramo y posición) o accesos reales; un destino solo cuenta si se llega a un enganche por trozos permitidos |
| E4 | Los parques contaban como un punto (centroide) | Un parque grande se «alcanzaba» solo al llegar a su centro | Corregido: los accesos son los cruces de los caminos con el borde, o los `entrance=*` y puertas etiquetados a menos de 60 m |
| E5 | No había un proceso de generación reproducible | No se podían auditar fuentes, fechas ni parámetros | Corregido: `cli.mjs` y módulos `*.mjs` (Node ≥ 18 o navegador), con informes en `<lugar>-audit-*` |
| E6 | Misma pendiente en los dos sentidos; para el tiempo, solo la cuerda | | Corregido: factores de tiempo de subida y de bajada por trozo |
| E7 | Partir la red en trozos de pendiente duplicaba nodos y pesaba 5–7 MB | | Corregido: cada tramo lleva sus trozos (posición, pendiente, factores, calidad) y se puede llegar hasta el borde de un trozo bloqueado |

## 3. Método de pendientes (`slopes.mjs`)

**Fuente en Madrid.** `SPA_28079_SERVICIO_MDT_MOSAICO_2025` ([MDT_1m.zip](https://geoportal.madrid.es/fsdescargas/IDEAM_WBGEOPORTAL/ELEVACIONES/2025/MDT/MOSAICO/MDT_1m.zip), 1.516.568.778 bytes, `Last-Modified` 15/10/2025).

- El zip contiene `MDT2024_1m.tif` (BigTIFF COG, Float64).
- Se usa su nivel de 2 m, leído en flujo: 3.306 teselas, 356 MB descargados.

**Perfil.**

- Se toma una muestra cada 2 m sobre la geometría real del tramo.
- Cada 4 m se añaden muestras a ±3 m en perpendicular.
- Los tramos de menos de 10 m se prolongan en línea recta para tener siempre 10 m de perfil (`extend`).

**Pendiente de barrera.**

- Es el máximo de la pendiente por mínimos cuadrados en ventanas de 10 m.
  - Por qué 10 m: es la escala de una rampa según la Orden TMA/851/2021 (art. 14: tramos de hasta 9 m).
  - Por qué mínimos cuadrados: no amplifica el error de una sola muestra.
- Las ventanas que tocan un salto o un desnivel transversal no cuentan.

**Saltos y desniveles.** Se marcan como «discontinuidad» y el trozo queda incierto:

- más de 0,5 m entre dos muestras, si además es al menos el triple que en los intervalos vecinos (bordillo alto, muro, otra cota);
- más de 1,5 m entre las muestras a ±3 m en perpendicular (muro o talud).

**Estructuras.**

- **Etiquetadas** (`bridge`, `tunnel` salvo `building_passage`, `indoor`): no se usa el terreno. La altura de los extremos se interpola por la red.
- **No etiquetadas**: se reconocen por la forma del perfil.
  - El patrón es una subida o bajada de al menos un 25 % y 2 m, que vuelve al nivel de partida en menos de 150 m con todo lo de en medio a un mismo lado.
  - El modelo municipal incluye los tableros de los puentes. Por ejemplo, el Paseo de la Virgen del Puerto aparecía con «cuestas» del 49 % al pasar bajo los puentes.
  - Ese trozo se sustituye por la recta y se marca como estructura estimada.

**Tiempo.**

- Se aplica la función de Tobler a cada intervalo de 2 m, con un factor para subir y otro para bajar.
- Donde no hay ventana válida se usa la pendiente de conjunto del tramo, o la de sus extremos.

**Trozos.**

- Cada tramo se parte donde cambia la clase (umbrales del 4, 6, 8, 10 y 12 %).
- Los trozos de menos de 10 m se unen al vecino de clase mayor, que es el criterio conservador.
- La suma de los trozos coincide con la longitud del tramo (diferencia máxima: 0 m) **[consistencia]**.

**Calidad por trozo.** Bits: 1 estructura, 2 discontinuidad, 4 sin dato, 8 `layer≠0`. La página permite tratar los inciertos como barrera.

**Resultado en Madrid**, km por clase de pendiente máxima:

| Clase | km |
|---|---|
| 0–4 % | 3.871 |
| 4–6 % | 1.412 |
| 6–8 % | 679 |
| 8–10 % | 350 |
| 10–12 % | 180 |
| > 12 % | 262 |
| Sin dato | 224 |
| Escaleras | 47,6 |

Marcados: 416 km con discontinuidad, 107 km de estructura, 155 km sin dato y 12,5 km con `layer`. En total hay 267.505 trozos en 201.368 tramos.

## 4. Validación de pendientes en Madrid

### 4.1 Seis casos frente al modelo de 10 cm [independiente en el remuestreo, no en la fuente]

La referencia son consultas `GetFeatureInfo` al WMS `MDT_2025` cada 1 m. Es la misma fuente con más resolución, así que contrasta el remuestreo a 2 m y la geometría, no la exactitud del modelo frente al terreno.

| Tramo | v5 | 10 cm: cuerda | 10 cm: máx. en 10 m | Nuevo (2 m) | Diagnóstico |
|---|---|---|---|---|---|
| Bailén (22 m) | 9,0 % | 0,0 % | 0,1 % | **0,4 %** | Artefacto de la v5 (cota bajo el viaducto) |
| Cuesta de la Vega (9 m) | 23,5 % | 2,3 % | – | **2,1 %** | Artefacto de la v5 |
| San Vicente (66 m)* | 9,6 % | 4,3 % | 7,3 % | **7,9 %** | Media del 4 % con un tramo cercano al 8 % |
| Segovia (55 m) | 6,0 % | 6,2 % | 7,7 % | **7,8 %** | Real; la media ocultaba el máximo |
| Atocha (24 m) | 9,1 % | −7,1 % | 7,5 % | **8,1 %** | Real; la v5 la sobrestimaba |
| José Ortega y Gasset (62 m)* | 6,1 % | 6,9 % | 9,8 % | **10,3 %** | Real, con un máximo local |

\* Geometría aproximada: el tramo de la v5 ya no existe en la red actual.

Notas:

- El método da un máximo entre 0,1 y 0,6 puntos por encima del modelo de 10 cm. Es un sesgo conservador, documentado y no corregido.
- Los valores de cada caso, con la vía de OSM y el error cuadrático medio entre el perfil de 2 m y el de 10 cm (2 a 15 cm), están en `madrid-audit-slope_cases.csv`.

### 4.2 MDT 2025 del Ayuntamiento frente al MDT05 del IGN [independiente]

Ver el apartado 6: en una zona de 5 × 5 km, las dos fuentes, de producción distinta, dan la misma distribución de pendientes medidas en 30 m.

### 4.3 Casos dudosos que quedan

Cerca de Madrid Río hay sendas cortas con pendientes de más del 12 %. Pueden ser escaleras o rampas sin etiquetar, o bordes de taludes que el modelo incluye. Quedan como están y en algunos casos marcadas como inciertas. Sin trabajo de campo no se puede decidir.

## 5. Validación del cálculo en la página (`core.js`)

**`test_core.mjs`** comprueba, sobre los datos reales:

- **[consistencia]** Monotonía:
  - más tiempo o más velocidad nunca reducen el alcance (km ni destinos);
  - relajar el umbral de pendiente nunca lo reduce, si el punto de salida no cambia de tramo;
  - añadir restricciones nunca lo amplía.
- **[consistencia]** Ningún trozo bloqueado aparece en lo alcanzado.
- **[independiente: otra implementación]** Se reconstruye la red partida físicamente en sus trozos, con nodos nuevos en cada corte, y se recalcula con un Dijkstra aparte (montículo binario propio). Tiempos en todos los nodos, km y destinos alcanzados coinciden con el núcleo:
  - diferencia máxima de tiempo: 2,3·10⁻¹³ s;
  - destinos distintos: 0.

Resultados:

- Madrid (Sol, Vistillas, Salamanca y Madrid Río): **187 de 187 comprobaciones correctas**.
- Navalcarnero (Plaza de Segovia y dos puntos más): **129 de 129**.

**`test_build.mjs`** es una prueba de principio a fin con un extracto pequeño (Andorra) y un terreno sintético (plano al 5 % con un muro de 3 m) **[consistencia]**. Comprueba que:

- la geometría sola reproduce exactamente los puntos de muestreo;
- el códec de alturas tiene un error máximo de 5 mm;
- la suma de trozos es exacta.

**`scenarios.mjs`** repite los escenarios medidos en la v5: los mismos puntos y ajustes, 15 minutos, referencia a 1,4 m/s. Las cifras de la v5 están en `scenarios_v5.json`.

| Lugar | Ajustes | v5 | Ahora |
|---|---|---|---|
| Sol | 1,1 m/s | −41 % | −42 % |
| Sol | 1,1 m/s, sin escaleras | −43 % | −43 % |
| Sol | + cuestas > 6 % | −55 % | **−71 %** |
| Sol | + tiempo con cuestas | −57 % | **−73 %** |
| Vistillas | 1,1 m/s, sin escaleras | −53 % | −53 % |
| Vistillas | + cuestas > 6 % | −73 % | **−91 %** |
| Salamanca | + cuestas > 6 % | −40 % | −49 % |
| Madrid Río | + cuestas > 6 % | −69 % | −81 % |

- Lo que no depende de las pendientes (velocidad, escaleras) apenas cambia.
- El filtro del 6 % es mucho más restrictivo, porque ahora mira el máximo local y no la media del tramo.
- Las referencias bajan algo (de 153 a 144,6 km en Sol): el origen ya no salta en línea recta a cruces cercanos y los datos de OpenStreetMap son de otra fecha.

**Revisión de la página en Chromium sin ventana (Playwright).**

- Casos probados:
  - Madrid y Navalcarnero;
  - español e inglés;
  - escritorio (1366 × 860) y móvil (390 × 844);
  - cambio de lugar con el selector y vuelta.
- Resultado:
  - sin errores en la consola;
  - sin desbordamiento horizontal;
  - el enlace guarda el lugar (`city=`).
- Tiempo hasta el primer cálculo en local:
  - Madrid: 1,0–1,5 s, con 4,5 MB comprimidos;
  - Navalcarnero: 0,25–0,35 s, con 97 KB.

## 6. Navalcarnero

**Red.**

- Fuente: extracto `madrid-261001.osm.pbf` de Geofabrik (85.089.786 bytes, md5 `076135a2cba8a9176307f9a311193a73`, datos hasta el 01/10/2026).
- Zona: caja de 10 × 10 km alrededor de la Plaza de Segovia.
- Tamaño: 3.708 tramos y 504,9 km, con el mismo filtro peatonal que Madrid.

**Servicios.** OpenStreetMap tiene muy pocos: 162 destinos.

- Servicios básicos: 1 farmacia, 8 supermercados, 8 restaurantes, 11 colegios y 7 escuelas infantiles.
- Zonas verdes: 31 parques.
- Paradas de bus: 78.
- Sin bancos, bibliotecas ni estaciones.

La página lo advierte y oculta el bloque de estaciones. Los recuentos de servicios no son representativos.

**Terreno.** MDT05 del IGN por WCS (`Elevacion25830_5`, ASCII Grid con decimales), pedido en 9 teselas sin huecos y unido en una malla.

**Problema detectado: terrazas de 1 m [independiente].**

- **Síntoma.** El MDT05 no es una superficie continua: las alturas se quedan en metros enteros a lo largo de mesetas y saltan al siguiente en pocos metros.
- **Cuánto.** Tienen altura entera exacta el 14 % de las celdas en Navalcarnero y el 31 % en una zona de Madrid.
- **Efecto.** Medida en 10 m, una calle con un 3 % uniforme aparece como llanos y rampas del 10 %.
- **Primer cálculo.** Con el método de Madrid salían más km en la clase 8–10 % (94) que en la 6–8 % (58). Con el filtro del 6 % se alcanzaban 0,3 km desde la Plaza de Segovia.

**Contraste en Madrid [independiente].**

- **Montaje.** Se descargó el MDT05 de una zona de 5 × 5 km del centro (UTM 437.500–442.500 E, 4.471.000–4.476.000 N) y se midieron las pendientes de los 715,6 km de tramos de su interior. La referencia es el MDT 2025 municipal, sin los trozos inciertos.
- **Método elegido.**
  1. Reconstrucción por bandas (`terrain.mjs`):
     - cada celda pertenece a la banda `round(z)`;
     - la curva k + 0,5 pasa entre bandas;
     - dentro de cada banda la altura se interpola según la distancia euclídea a la curva de debajo y a la de encima;
     - donde las curvas distan menos de 10 m (pendientes fuertes) se conserva el valor original;
     - en cimas y fondos también.
  2. Ventana de 30 m.
- **Contraste.** Se compara con el MDT municipal medido en la misma ventana. Error medio de la pendiente máxima de cada tramo: **1,6 puntos, sin sesgo** (mediana 0). El 95 % de los tramos queda entre −4,0 y +2,6 puntos.

| MDT05, ventana | Clase exacta | Clase ±1 | Error medio | Km mal bloqueados / no bloqueados con el 6 % (de los que bloquea la referencia) |
|---|---|---|---|---|
| Original, 10 m | 45 % | 74 % | 2,9 puntos | 148 / 47 (de 146) |
| Reconstruido, 10 m | 57 % | 86 % | 2,2 puntos | 57 / 64 (de 146) |
| Reconstruido, 20 m | 70 % | 93 % | 1,7 puntos | 34 / 39 (de 109) |
| **Reconstruido, 30 m** | **76 %** | **95 %** | **1,6 puntos** | **27 / 30 (de 98)** |

Km por clase en la zona, MDT municipal (30 m) frente a MDT05 reconstruido (30 m):

| Clase | MDT municipal | MDT05 reconstruido |
|---|---|---|
| 0–4 % | 479 | 481 |
| 4–6 % | 126 | 122 |
| 6–8 % | 58 | 55 |
| 8–10 % | 24 | 22 |
| 10–12 % | 10 | 9 |
| > 12 % | 7 | 9 |

**Variantes y prueba sintética.**

- **Sin mezcla.** Reconstruir también donde las curvas están cerca da lo mismo en la zona de contraste: 75,5 % de clase exacta y 1,6 puntos de error medio.
- **Suavizado.** Con un suavizado gaussiano en lugar de la reconstrucción (probado en ventanas de 10 m), el filtro deja pasar más cuestas: con σ = 10 m no bloquea 86 de los 146 km que bloquea la referencia.
- **Prueba sintética.** `test_terrain.mjs` usa laderas de pendiente conocida redondeadas a metros enteros **[consistencia]**:
  - con un 3 %, el error máximo en 10 m baja de 7 puntos a 0,3;
  - con un 10 %, las terrazas son cortas, se conserva el valor original y el error no cambia.

**Decisión.**

- En Navalcarnero se usa el MDT05 reconstruido con ventanas de 30 m (`CITIES.navalcarnero.slope`).
- La página dice «medida en 30 m» y avisa de que el filtro es orientativo.
- Aun así, alrededor de un 30 % de los km que el filtro del 6 % bloquea o deja pasar no coinciden con la referencia. Es el límite de un modelo de 5 m.
- Los scripts del contraste no están en el repositorio. Están en la carpeta de trabajo de la sesión (`dem_eval/eval.mjs`, `terrace.mjs`) y se pueden añadir si interesa.

**Resultado.**

- Km por clase:

  | Clase | km |
  |---|---|
  | 0–4 % | 240 |
  | 4–6 % | 126 |
  | 6–8 % | 60 |
  | 8–10 % | 32 |
  | 10–12 % | 24 |
  | > 12 % | 22 |

- Desde la Plaza de Segovia, a 1,1 m/s, sin escaleras y con tiempo por cuestas, se alcanzan:

  | Umbral | km alcanzados |
  |---|---|
  | 4 % | 3,4 |
  | 6 % | 14,3 |
  | 8 % | 30,6 |
  | Sin límite | 44,9 |

  El casco está en un alto y las salidas bajan.
- Las alturas sin reconstrucción coinciden byte a byte con el primer muestreo, lo que comprueba que el paso de teselas a malla única no cambia nada **[consistencia]**.

## 7. Servicios

- **Etiquetas** por categoría (`osm_build.mjs`, `RULES`); se aplica la primera regla que coincide:
  - Alimentación: `shop=supermarket|convenience|greengrocer|bakery|butcher`.
  - «Farmacias, consultas y hospitales»: `amenity=pharmacy|doctors|clinic|hospital|dentist`.
  - «Colegios, escuelas infantiles y bibliotecas»: `amenity=school|kindergarten|library`.
  - Zonas verdes y de juego: `leisure=park|garden|playground`. Se separan los parques de 0,5 ha o más (OMS, 2016), los de menos, las zonas de juego y los puntos sin polígono. Los **privados** (`access=private|no|customers`, `garden:type=residential|private`) no cuentan.
  - «Cafés, bares y restaurantes»: `amenity=cafe|restaurant|pub|bar`.
- **Duplicados**: hacen falta dos señales a la vez. Además de la misma categoría y subtipo, un nodo dentro del polígono del otro, o el mismo nombre normalizado a menos de 40 m. En Madrid se descartaron 29 restaurantes, 38 zonas de juego, etc. (`services_duplicates.csv`).
- **Enganche en Madrid** (`services_attachment.csv`):

  | Tipo de enganche | Destinos |
  |---|---|
  | Por caminos interiores | 1.194 |
  | Por accesos etiquetados | 565 |
  | Por los dos tramos más cercanos | 37.789 |
  | Sin enganche (no cuentan nunca) | 4 |

  Distancia al tramo: mediana de 4 m, percentil 90 de 13 m y máximo de 150 m.
- **Trazabilidad**: cada destino conserva su id de OSM, su regla y su enganche en `audit/pois.csv.gz`, con un enlace a openstreetmap.org.
- **No hecho**:
  - El cruce con el Censo de locales (datos.madrid.es, 200085) y con las farmacias de la Comunidad de Madrid.
  - La cifra del revisor, 2.331 restaurantes en el censo frente a 2.108 elementos en la web, no es una tasa de cobertura: cuentan cosas distintas sobre ámbitos distintos.

## 8. Reproducir

```
node cli.mjs --city madrid --pbf madrid-261006.osm.pbf --out .
node cli.mjs --city navalcarnero --pbf madrid-261001.osm.pbf --out .
node test_core.mjs madrid 40.4169,-3.7035 40.4121,-3.7140
node scenarios.mjs madrid scenarios.json scenarios_v5.json
```

- **Extracto de Madrid**: `madrid-261006.osm.pbf` era un fichero diario y Geofabrik ya lo ha borrado. Quedan documentados su md5 (`ad4f40446f40f6ec7e279eb90215d133`) y su sha256 en `madrid-audit-build_report.json`.
  - Para regenerar exactamente hace falta una copia de ese fichero.
  - Con otro extracto los resultados cambiarán un poco.
- **Cómo se generó**: los datos se generaron en un navegador, porque el entorno de trabajo no tenía acceso directo a esos servidores. Primero la etapa OSM y el muestreo del terreno, con el mismo código empaquetado; después la etapa 3 en Node. El código es el mismo en los dos entornos.

## 9. Limitaciones que no se pueden resolver con estos datos

- **Accesibilidad.** El filtro de pendiente no certifica la accesibilidad de ninguna calle (Orden TMA/851/2021). La pendiente es la del eje del tramo, no la de la acera.
- **Discontinuidades.** En los tramos junto a muros o a otra cota, el modelo no dice por qué nivel va el peatón.
- **Error del MDT municipal.** El error absoluto declarado es de 0,40 m (RMSE en Z). El relativo entre puntos cercanos, que es el que cuenta para la pendiente, no está documentado.
- **OpenStreetMap.**
  - Faltan etiquetas de puentes, escaleras y accesibilidad de estaciones.
  - En Navalcarnero faltan casi todos los servicios.

## 10. Pendiente

1. Cruce de servicios con el Censo de locales y con el registro de farmacias de la Comunidad de Madrid.
2. Comparación estratificada de pendientes (llano, fuerte, corto, largo, cerca del 6 %, junto a estructuras) frente al modelo de 10 cm, con más casos que los seis del apartado 4.1.
3. Revisión de los casos dudosos de Madrid Río.
4. Cambiar la imagen de vista previa (`og.png`), que solo muestra Madrid.
