// Plantillas globales "Agente de E-commerce" (13 EC, 25 MX, 26 CO, 27 PE, 28 GT)
// — Contacto Inicial: el bot ya no se frena cuando le piden el precio.
//
// Caso cfg 476 (2026-10-14): el cliente preguntó el precio cinco veces y el
// bot solo contestó "¿a qué ciudad?"; al decir "solo 1" antes de la ciudad,
// la Interacción 2 (precio) se saltó y pasó directo a domicilio/agencia.
// Causa: "INTERACCION 1 — NO DAR PRECIO… SIN EXCEPCION".
//   1. Interacción 1: si pide precio/info, saluda + precio + imagen + ciudad.
//   2. Regla del precio: se contesta siempre y nunca se llega al envío sin él.
//   3. Interacción 2: si ya dijo la cantidad, no se la repregunta.
//   4. Ejemplo C y un caso más en el ejemplo prohibido.
//   5. Variedad de dos datos (talla + color): pide el que falta.
//   6. "Manta" (ciudad) se tomaba como producto inexistente → asesor.
//
//   node scripts/actualizarPlantillasEcommerce_2026_10_precio.js            → muestra los cambios
//   node scripts/actualizarPlantillasEcommerce_2026_10_precio.js --aplicar  → escribe
const ROOT = require('path').join(__dirname, '..');
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });
const fs = require('fs');
const path = require('path');
const { db } = require(ROOT + '/src/database/config');

const APLICAR = process.argv.includes('--aplicar');
const S = path.join(__dirname, '..', 'logs', 'plantillas');
fs.mkdirSync(S, { recursive: true });

const INTERACCION_1_VIEJA =
  /INTERACCION 1 — SOLO PREGUNTA CIUDAD \(NO VENDER, NO DAR PRECIO, NO FOTO\)\n[\s\S]*?SIN EXCEPCION: tu primer mensaje es SOLO esa pregunta, aunque ya tengas el precio a la mano\.\n/;

const INTERACCION_1_NUEVA = `INTERACCION 1 — SALUDO + CIUDAD
El cliente ya dijo que producto quiere. Tu tarea: saludar y preguntar la ciudad de envio.
"Hola! 😊 Soy [NOMBRE_ASISTENTE] de [NOMBRE_TIENDA], un gusto saludarte. Claro que si, con mucho gusto te ayudo con las [PRODUCTO]. ¿A que ciudad te las enviamos?"
Si NO menciona producto: "Hola! 😊 Soy [NOMBRE_ASISTENTE] de [NOMBRE_TIENDA], un gusto saludarte. Cuentame, ¿que producto te interesa?"
Si el cliente NO pregunto el precio, todavia no lo des: el precio va en la INTERACCION 2.
SI PREGUNTA EL PRECIO (obligatorio): si su mensaje pide precio, costo, valor o informacion ("precio", "cuanto cuesta", "cuanto vale", "info", "informacion"), en ESTE MISMO mensaje saluda, da el precio y los combos si existen, pon en linea aparte [producto_imagen_url]: con la URL del producto (OBLIGATORIA) y cierra preguntando la ciudad (ver EJEMPLO C). Nunca contestes una pregunta de precio solo con "¿a que ciudad?".
`;

const REGLA_PRECIO = `REGLA DEL PRECIO (MAXIMA PRIORIDAD — MANDA SOBRE EL ORDEN DE LAS INTERACCIONES)
- Si el cliente pregunta el precio en CUALQUIER momento, tu mensaje empieza con el precio (y los combos si existen) y DESPUES, en el mismo mensaje, haces la pregunta del paso que toca. PROHIBIDO responder una pregunta de precio sin decir el precio, aunque estes esperando otro dato.
- Nunca preguntes domicilio o agencia (INTERACCION 4) si el cliente todavia no recibio el precio en esta conversacion. Si ya dijo la cantidad antes de ver el precio ("solo 1", "quiero 2"), dale el precio de esa cantidad (el del combo si aplica) con la imagen y sigue con el paso que corresponde, sin volver a preguntar la cantidad.
- La PRIMERA vez que das el precio, en ese mismo mensaje va SIEMPRE la linea [producto_imagen_url]: del producto (y la del video si existe). Sin la foto el cliente no compra.
- Si ya diste el precio y no lo vuelven a pedir, no lo repitas.

`;
const ANCLA_REGLA_PRECIO = /\nCLIENTE RECURRENTE \(PRIORIDAD\)\n/;

const INTERACCION_2_ANCLA =
  /(Si el cliente no responde con la cantidad, vuelve a preguntarla antes de avanzar\.\n)/;
const INTERACCION_2_EXTRA = `Si ya diste el precio en la INTERACCION 1 (porque lo pidio), no lo repitas: solo pregunta la cantidad. Antes de preguntar la cantidad revisa TODO el historial: si el cliente YA dijo cuantas quiere ("solo 1", "una", "quiero 2"), aunque haya sido varios mensajes atras, NO se la preguntes: dale el precio de esa cantidad y pasa al paso siguiente (3 si es VARIABLE, 4 si es simple).
`;

const INTERACCION_3_ANCLA = /(\nNO avances sin que el cliente nombre la variedad\.\n)/;
const INTERACCION_3_EXTRA = `Si la variedad combina dos datos (por ejemplo talla y color) y el cliente dijo solo uno ("el negro", "talla M"), pregunta SOLO el que falta y NO pases al envio hasta tener los dos.
`;

const ANCLA_NO_EXISTE = /(- PRODUCTO NO EXISTE en file_search \(no encuentras el producto que pide el cliente\): )/;
const NO_EXISTE_EXTRA = `ANTES revisa que de verdad este pidiendo un producto: si tu ultimo mensaje pregunto la ciudad, la cantidad o un dato, lo que conteste es ESA respuesta (Manta, Loja, Salinas, El Carmen son ciudades; "2", "una" son cantidades), NUNCA un producto: sigue con el paso que toca. Solo si pide un producto que no esta: `;

const ANCLA_EJEMPLO_D = /\nEJEMPLO D — /;

/* El precio y los combos del ejemplo A cambian por país (moneda): el C usa los
   mismos para no contradecirlo. */
function ejemploC(texto) {
  const precio = texto.match(/El \*Cubre canas en barra\* cuesta \*([^*]+)\*/)?.[1];
  const combo = texto.match(/\n(- 2 unidades por [^\n]+)\n/)?.[1];
  if (!precio || !combo) throw new Error('no encontré el precio/combo del ejemplo A');
  return `
EJEMPLO C — el cliente PIDE EL PRECIO desde el primer mensaje:
Cliente: "Hola! Dame precio e informacion del cubre canas"
[NOMBRE_ASISTENTE]:
"Hola! 😊 Soy [NOMBRE_ASISTENTE] de [NOMBRE_TIENDA], un gusto saludarte. El *Cubre canas en barra* cuesta *${precio}*. Tambien tenemos combos:
${combo}

[producto_imagen_url]: https://ejemplo.com/foto.jpg

¿A que ciudad te lo enviamos?"
Cliente: "Quito"
[NOMBRE_ASISTENTE]: "¿Cuantas unidades quieres, o te interesa un combo? Recuerda que pagas al recibir!"
Variante — dijo la cantidad ANTES de ver el precio:
Cliente: "solo 1"
Cliente: "¿cuanto cuesta?"
[NOMBRE_ASISTENTE]: "Una unidad del *Cubre canas en barra* cuesta *${precio}* y pagas al recibir 😊 ¿A que ciudad te lo enviamos?"
(fijate: al que pregunta el precio SIEMPRE se le da el precio y despues sigue el paso pendiente. Y como ya dijo "solo 1", no se le vuelve a preguntar la cantidad)
`;
}

const ANCLA_PROHIBIDO = /(\[NOMBRE_ASISTENTE\] \(BIEN\): "¿Los 2 del mismo color\? ¿Negro o Cafe\? 🎨" y espera la respuesta\.\n)/;
const PROHIBIDO_PRECIO = `[NOMBRE_ASISTENTE] (MAL): el cliente pregunta "¿cuanto cuesta?" y respondes solo "¿A que ciudad te lo enviamos?" ← ignoro el precio. PROHIBIDO.
`;

function aplicarCambios(texto, pais) {
  const cambios = [];
  let t = texto;
  const exigir = (re, que) => {
    if (!re.test(t)) throw new Error(`${pais}: no encontré ${que}`);
  };

  exigir(INTERACCION_1_VIEJA, 'la Interacción 1 vieja');
  t = t.replace(INTERACCION_1_VIEJA, INTERACCION_1_NUEVA);
  cambios.push('Interacción 1: si pide precio, lo da junto con la ciudad');

  exigir(ANCLA_REGLA_PRECIO, 'el ancla de CLIENTE RECURRENTE');
  t = t.replace(ANCLA_REGLA_PRECIO, `\n${REGLA_PRECIO}CLIENTE RECURRENTE (PRIORIDAD)\n`);
  cambios.push('regla del precio (manda sobre el orden)');

  exigir(INTERACCION_2_ANCLA, 'el cierre de la Interacción 2');
  t = t.replace(INTERACCION_2_ANCLA, `$1${INTERACCION_2_EXTRA}`);
  cambios.push('Interacción 2: no repregunta la cantidad ni repite el precio');

  exigir(INTERACCION_3_ANCLA, 'el cierre de la Interacción 3');
  t = t.replace(INTERACCION_3_ANCLA, `$1${INTERACCION_3_EXTRA}`);
  cambios.push('Interacción 3: variedad combinada pide el dato que falta');

  exigir(ANCLA_NO_EXISTE, 'la objeción de producto inexistente');
  t = t.replace(ANCLA_NO_EXISTE, `$1${NO_EXISTE_EXTRA}`);
  cambios.push('producto inexistente: una ciudad o cantidad no es un producto');

  exigir(ANCLA_EJEMPLO_D, 'el ejemplo D');
  t = t.replace(ANCLA_EJEMPLO_D, `${ejemploC(t)}\nEJEMPLO D — `);
  cambios.push('ejemplo C (pide el precio de entrada)');

  exigir(ANCLA_PROHIBIDO, 'el cierre del ejemplo prohibido');
  t = t.replace(ANCLA_PROHIBIDO, `$1${PROHIBIDO_PRECIO}`);
  cambios.push('ejemplo prohibido: ignorar el precio');

  return { texto: t, cambios };
}

module.exports = { aplicarCambios };

if (require.main === module) {
  (async () => {
    const plantillas = await db.query(
      `SELECT id, nombre, pais, version, data FROM kanban_plantillas_globales
        WHERE id IN (13, 25, 26, 27, 28) AND activo = 1 ORDER BY id`,
      { type: db.QueryTypes.SELECT },
    );
    fs.writeFileSync(
      path.join(S, `respaldo_plantillas_${Date.now()}.json`),
      JSON.stringify(plantillas, null, 1),
    );

    for (const p of plantillas) {
      const data = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
      const ci = data.columnas.find((c) => c.estado_db === 'contacto_inicial');
      const { texto, cambios } = aplicarCambios(ci.instrucciones, p.pais);
      fs.writeFileSync(path.join(S, `plantilla_${p.id}_${p.pais}_precio.txt`), texto);
      const versionNueva = Math.round((Number(p.version) + 0.1) * 10) / 10;
      console.log(
        `\n${p.id} ${p.pais} v${p.version} → v${versionNueva}: ${ci.instrucciones.length} → ${texto.length} chars\n   - ${cambios.join('\n   - ')}`,
      );
      if (!APLICAR) continue;
      ci.instrucciones = texto;
      await db.query(
        `UPDATE kanban_plantillas_globales SET data = ?, version = ROUND(version + 0.1, 1) WHERE id = ?`,
        { replacements: [JSON.stringify(data), p.id] },
      );
      console.log('   ✔ aplicada');
    }
    process.exit(0);
  })().catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
}
