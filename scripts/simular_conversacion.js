/**
 * Simula una conversación completa contra los asistentes REALES de una cuenta,
 * sin mandar un solo mensaje de WhatsApp.
 *
 * Reproduce el camino de producción: inyecta el mismo contexto que arma
 * kanban_ia.service (sedes, agenda, precios, fichas, planes de sesiones), corre
 * el asistente de la columna donde está el contacto, aplica los tags para
 * moverlo de columna, limpia las coletillas de relleno y trocea el texto igual
 * que el envío real. El hilo es del cliente, no de la columna: al cambiar de
 * etapa cambia el asistente pero la conversación sigue.
 *
 * Existe para no tener que desplegar y probar con clientes de verdad.
 *
 * Uso:
 *   node scripts/simular_conversacion.js <id_configuracion> <id_cliente> "msg1" "msg2" ...
 *   node scripts/simular_conversacion.js 818 566217 --guion=laser
 */

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');
const { construirContextoColumna } = require('../src/utils/contextoColumna');
const { limpiarColetillas } = require('../src/utils/limpiarColetillas');
const { humanizarFechas } = require('../src/utils/humanizarFechas');
const { limpiarMarkdown } = require('../src/utils/formatoWhatsapp');
const {
  dividirRespuestaIA,
} = require('../src/utils/openia/dividirRespuestaIA');

const TAGS = [
  '[califica]:true',
  '[fuera_zona]:true',
  '[venta_producto]:true',
  '[cita_confirmada]:true',
  '[en_tratamiento]:true',
  '[plan_terminado]:true',
  '[no_asistio]:true',
  '[perdido]:true',
  '[asesor]:true',
  '[urgencia]:true',
];

const GUIONES = {
  laser: [
    'Hola, quiero informacion sobre la depilacion laser',
    'si quiero',
    'manana',
    'a las 10 esta bien',
  ],
  producto: [
    'hola, quiero comprar la maquina recortadora de cabello profesional',
    'que trae? tiene garantia?',
    'dale, la quiero',
    'yo me acerco a retirarla',
  ],
  fuera: [
    'Hola, quiero informacion de la depilacion laser',
    'escribo desde Cuenca',
    'nada mas gracias',
  ],
  // Post-cita: el cron pregunta cómo le fue y ella responde.
  asistio_bien: [
    'me fue increible, quede feliz con el resultado',
    'si, quiero seguir con el tratamiento completo',
  ],
  asistio_mal: [
    'la verdad no pude ir, se me complico el dia',
  ],
  tratamiento: [
    'hola, quiero agendar mi siguiente sesion de depilacion laser',
    'el lunes a las 11 porfa',
  ],
  no_asistio: [
    'perdon, se me paso la cita de ayer',
    'si, quiero reagendar',
  ],
  reprogramar: [
    'necesito cambiar mi cita para otro dia',
    'el martes en la tarde',
  ],
  inexistente: [
    'hacen botox? cuanto cuesta',
  ],
};

const [, , argConfig, argCliente, ...resto] = process.argv;
const ID_CONFIG = Number(argConfig);
const ID_CLIENTE = Number(argCliente);

const guion = resto.find((a) => a.startsWith('--guion='));
const MENSAJES = guion
  ? GUIONES[guion.split('=')[1]] || []
  : resto.filter((a) => !a.startsWith('--'));

if (!ID_CONFIG || !ID_CLIENTE || !MENSAJES.length) {
  console.error(
    'Uso: node scripts/simular_conversacion.js <id_configuracion> <id_cliente> "mensaje" ...\n' +
      `Guiones listos: ${Object.keys(GUIONES).join(', ')}`,
  );
  process.exit(1);
}

let headers;

const post = (url, body) => axios.post(url, body, { headers, timeout: 90000 });

async function correr(thread, assistant_id, maxTokens) {
  const { data: run } = await post(
    `https://api.openai.com/v1/threads/${thread}/runs`,
    { assistant_id, max_completion_tokens: maxTokens || 700 },
  );

  let estado = 'queued';
  let intentos = 0;
  while (!['completed', 'failed', 'incomplete'].includes(estado) && intentos < 40) {
    await new Promise((r) => setTimeout(r, 1200));
    intentos += 1;
    const { data } = await axios.get(
      `https://api.openai.com/v1/threads/${thread}/runs/${run.id}`,
      { headers },
    );
    estado = data.status;
  }

  const { data: msgs } = await axios.get(
    `https://api.openai.com/v1/threads/${thread}/messages`,
    { headers },
  );

  return (
    msgs.data
      .reverse()
      .find((m) => m.role === 'assistant' && m.run_id === run.id)
      ?.content?.[0]?.text?.value || '(sin respuesta)'
  );
}

async function main() {
  const [cfg] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );
  if (!cfg?.api_key_openai)
    throw new Error(`La configuración ${ID_CONFIG} no tiene api_key_openai`);

  headers = {
    Authorization: `Bearer ${cfg.api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const columnas = await db.query(
    `SELECT id, estado_db, nombre, assistant_id, max_tokens, modelo
       FROM kanban_columnas
      WHERE id_configuracion = ? AND activo = 1 AND activa_ia = 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );

  const porEstado = new Map(columnas.map((c) => [c.estado_db, c]));

  // Acciones de cada columna: definen el contexto que se inyecta y a dónde
  // mueve cada tag.
  for (const col of columnas) {
    col.acciones = await db.query(
      `SELECT tipo_accion, config FROM kanban_acciones
        WHERE id_kanban_columna = ? AND activo = 1`,
      { replacements: [col.id], type: db.QueryTypes.SELECT },
    );
  }

  const [contacto] = await db.query(
    `SELECT estado_contacto FROM clientes_chat_center WHERE id = ? LIMIT 1`,
    { replacements: [ID_CLIENTE], type: db.QueryTypes.SELECT },
  );

  const desde = resto.find((a) => a.startsWith('--desde='));
  // Permite probar una columna sin tener que mover el contacto a mano.
  let estado = desde ? desde.split('=')[1] : contacto?.estado_contacto || 'contacto_inicial';
  const { data: thread } = await post('https://api.openai.com/v1/threads', {});

  console.log(
    `Config ${ID_CONFIG} · contacto ${ID_CLIENTE} · empieza en "${estado}"\n` +
      `(thread desechable ${thread.id} — no se toca el hilo real del cliente)\n`,
  );

  const alertas = [];

  for (const mensaje of MENSAJES) {
    const col = porEstado.get(estado);
    if (!col) {
      console.log(`\n⛔ La columna "${estado}" no tiene IA activa. Fin.`);
      break;
    }

    console.log(`${'─'.repeat(72)}\n🙍 CLIENTE: ${mensaje}\n`);

    const contexto = await construirContextoColumna(
      ID_CONFIG,
      col.acciones,
      null,
      { mensaje, id_cliente: ID_CLIENTE },
    );

    if (contexto.trim()) {
      await post(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
        role: 'user',
        content: `🧾 Contexto adicional:\n\n${contexto.trim()}`,
      });
    }
    await post(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      role: 'user',
      content: mensaje,
    });

    const cruda = await correr(thread.id, col.assistant_id, col.max_tokens);

    const tags = TAGS.filter((t) =>
      cruda.toLowerCase().includes(t.toLowerCase()),
    );

    let texto = cruda;
    for (const t of TAGS) texto = texto.split(t).join('');
    const antesFiltro = texto.trim();
    texto = limpiarMarkdown(humanizarFechas(limpiarColetillas(antesFiltro)));
    const partes = dividirRespuestaIA(texto);

    console.log(
      `🤖 [${col.nombre} · ${col.modelo}] → ${partes.length} mensaje(s)`,
    );
    partes.forEach((p, i) =>
      console.log(`   ${i + 1}│ ${p.replace(/\n/g, '\n    │ ')}`),
    );

    if (texto !== antesFiltro) console.log('   🧹 se cortó una coletilla');
    console.log(`   ▸ tags: ${tags.length ? tags.join(', ') : 'ninguno'}`);

    // ── Revisiones automáticas de las fallas ya conocidas ──
    const revisar = (cond, aviso) => {
      if (cond) {
        alertas.push(aviso);
        console.log(`   ⚠️  ${aviso}`);
      }
    };

    revisar(
      /\d{4}-\d{2}-\d{2}/.test(texto),
      'escribió una fecha en formato de sistema (2026-08-01)',
    );
    revisar(
      /valoraci[oó]n facial/i.test(texto) && !/valoraci[oó]n/i.test(mensaje),
      'metió la valoración facial sin que se la pidieran',
    );
    revisar(
      /(no dudes|cualquier (cosa|duda)|si (quieres|necesitas|deseas) (saber|m[aá]s)|quedo a tu disposici[oó]n)/i.test(
        texto,
      ),
      'quedó una coletilla de relleno',
    );
    /* "está lleno" no es un error por sí solo: a veces es verdad. Se compara
       contra la agenda real y solo se avisa cuando la hora que rechazó estaba
       libre, que es la falla que veníamos persiguiendo. */
    if (/no (hay |tengo )?(disponibilidad|cupo)|est[aá] (lleno|ocupad)|no est[aá] disponible/i.test(texto)) {
      const horas = [...texto.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map(
        (m) => `${String(m[1]).padStart(2, '0')}:${m[2]}`,
      );

      const ocupadas = await db.query(
        `SELECT DATE_FORMAT(CONVERT_TZ(ap.start_utc, '+00:00', '-05:00'), '%H:%i') AS h
           FROM appointments ap
           JOIN calendars c ON c.id = ap.calendar_id
          WHERE c.account_id = ? AND ap.status IN ('Agendado', 'Confirmado')
            AND ap.start_utc > UTC_TIMESTAMP()`,
        { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
      );
      const setOcupadas = new Set(ocupadas.map((o) => o.h));

      // La hora rechazada es la primera que nombra; las siguientes suelen ser
      // las alternativas que ofrece.
      const rechazada = horas[0];
      if (rechazada && !setOcupadas.has(rechazada)) {
        revisar(true, `dijo que ${rechazada} no está disponible y en la agenda está libre`);
      } else if (rechazada) {
        console.log(`   ✔️  dijo que ${rechazada} está ocupada y es cierto`);
      }
    }
    revisar(
      /\*\*/.test(texto) || /^#{1,6}\s/m.test(texto),
      'quedó Markdown que WhatsApp no entiende',
    );


    /* Mismo enrutado determinista que hace kanban_ia.service: si el mensaje
       nombra un producto del catálogo con intención de compra, la ficha va a
       'venta_producto' aunque el modelo no haya escrito el tag. */
    const tieneDestinoProducto = col.acciones.some((ac) => {
      const c = typeof ac.config === 'string' ? JSON.parse(ac.config || '{}') : ac.config || {};
      return c.estado_destino === 'venta_producto';
    });

    if (tieneDestinoProducto && !tags.includes('[venta_producto]:true')) {
      const RE_COMPRA =
        /\b(compr|quiero la|quiero el|me la llevo|me lo llevo|cu[aá]nto (cuesta|vale|sale)|precio|venden|tienen|c[oó]mo la consigo)/i;
      if (RE_COMPRA.test(mensaje)) {
        const prods = await db.query(
          `SELECT nombre FROM productos_chat_center
             WHERE id_configuracion = ? AND eliminado = 0
               AND LOWER(COALESCE(tipo, '')) NOT LIKE 'servicio%'`,
          { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
        );
        const norm = (x) =>
          String(x || '').toLowerCase().normalize('NFD')
            .replace(/\p{M}/gu, '').replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ').trim();
        const palabras = norm(mensaje).split(' ').filter((w) => w.length > 3);
        const nombrado = prods.find((pr) => {
          const tk = norm(pr.nombre).split(' ').filter((t) => t.length > 3);
          return tk.filter((t) => palabras.includes(t)).length >= Math.min(2, tk.length);
        });
        if (nombrado) {
          estado = 'venta_producto';
          console.log(
            `   🛍️  enrutado por código: nombró "${nombrado.nombre}" con intención de compra → venta_producto`,
          );
        }
      }
    }
    // El tag manda a otra columna
    for (const ac of col.acciones) {
      if (ac.tipo_accion !== 'cambiar_estado') continue;
      const conf =
        typeof ac.config === 'string' ? JSON.parse(ac.config || '{}') : ac.config || {};
      if (
        conf.trigger &&
        tags.some((t) => t.toLowerCase() === String(conf.trigger).toLowerCase())
      ) {
        estado = conf.estado_destino;
        console.log(`   ➡️  pasa a "${estado}"`);
      }
    }
    console.log('');
  }

  console.log('═'.repeat(72));
  console.log(
    alertas.length
      ? `⚠️  ${alertas.length} cosa(s) que revisar:\n` +
          alertas.map((a) => `   · ${a}`).join('\n')
      : '✅ Sin fallas conocidas en esta corrida.',
  );
  console.log(`Estado final del contacto: "${estado}"`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
