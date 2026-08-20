/* Probar el bot mandándole mensajes al webhook local, como si fuera WhatsApp.
   ─────────────────────────────────────────────────────────────
   Arma el mismo payload que manda Meta y lo POSTea al webhook de este servidor.
   Después espera la respuesta del bot leyéndola de la base —no del log— y
   muestra qué contestó, a qué columna quedó el contacto y si dejó una solicitud
   de cita.

   ⚠️ DOS COSAS QUE NO SON UNA SIMULACIÓN ⚠️
   1. El bot contesta por la API real de WhatsApp: al número de prueba le LLEGA
      el mensaje de verdad. No hay modo "en seco".
   2. Este proyecto usa la MISMA base en local y en producción, así que cada
      corrida escribe filas reales: mensajes, cambios de columna, solicitudes de
      cita y, si el modo es automático, citas en el calendario.
   Por eso el script anuncia a quién le va a escribir antes de empezar.

   USO
     node scripts/probarWebhookWhatsapp.js "quiero ver la casa de Cumbayá"
     node scripts/probarWebhookWhatsapp.js --escenario fotos
     node scripts/probarWebhookWhatsapp.js --escenarios      (lista los guiones)
     node scripts/probarWebhookWhatsapp.js --estado          (dónde quedó)
     node scripts/probarWebhookWhatsapp.js --reset           (volver a empezar)

   Opciones:
     --cliente <id>   otro contacto (default: 566217, Michael)
     --url <url>      otro webhook  (default: http://localhost:$PORT)
     --espera <seg>   cuánto esperar la respuesta (default: 90)
*/

require('dotenv').config();

const axios = require('axios');
const { db } = require('../src/database/config');

const args = process.argv.slice(2);

/* Los índices que ya se consumió una opción, para que su VALOR no termine
   dentro del mensaje. Sin esto, `--espera 60 "Hola"` le mandaba al bot
   "60 Hola" — y el bot contestó igual, así que el error pasa desapercibido. */
const consumidos = new Set();

const opcion = (nombre, def = null) => {
  const i = args.indexOf(`--${nombre}`);
  if (i < 0 || !args[i + 1]) return def;
  consumidos.add(i).add(i + 1);
  return args[i + 1];
};
const bandera = (nombre) => {
  const i = args.indexOf(`--${nombre}`);
  if (i < 0) return false;
  consumidos.add(i);
  return true;
};

const textoLibre = () =>
  args
    .filter((a, i) => !consumidos.has(i) && !a.startsWith('--'))
    .join(' ')
    .trim();

/* `let`: un guion puede traer su propio contacto de prueba (`cliente`), y si
   no se pasó --cliente se usa ese. Así los guiones de dropshipping corren
   sobre la cuenta de pruebas de dropshipping sin tener que acordarse del id. */
const CLIENTE_FLAG = Number(opcion('cliente', 0));
let ID_CLIENTE = CLIENTE_FLAG || 566217;

/* --referral <source_id>: el PRIMER mensaje de la corrida llega "desde un
   anuncio", con el objeto referral que manda Meta cuando alguien toca un
   anuncio de clic-a-WhatsApp. Es la entrada del ~100% de los clientes de
   dropshipping, así que probar sin esto es probar otro embudo. El headline se
   lee de anuncios_producto (o se pasa con --headline si el anuncio no está
   mapeado). */
const REFERRAL_SOURCE = opcion('referral');
const REFERRAL_HEADLINE = opcion('headline');
const BASE = opcion(
  'url',
  `http://localhost:${process.env.PORT || 3000}`,
).replace(/\/$/, '');
const URL_WEBHOOK = `${BASE}/api/v1/webhook_meta/webhook_whatsapp`;
const ESPERA_MS = Number(opcion('espera', 90)) * 1000;

/* Pausa entre un mensaje y el siguiente de un guion.
   Cada turno del bot manda ~13.000 tokens de instrucciones más el contexto, así
   que cuatro mensajes seguidos topan el límite POR MINUTO de la cuenta de
   OpenAI y los últimos vuelven con 429. No es un problema del código: es la
   cuota. Con la pausa el guion tarda más y llega hasta el final. */
const PAUSA_MS = Number(opcion('pausa', 20)) * 1000;

/* ── Guiones ────────────────────────────────────────────────────
   Cada uno es una conversación completa, en el orden en que la escribiría una
   persona. Lo que se está probando va en `busca`: no es una aserción automática
   —el bot redacta distinto cada vez— es lo que hay que mirar en la respuesta. */
/* ── Aserciones automáticas de los guiones de dropshipping ──
   Cada guion puede traer `verificar({ turnos, estadoFinal })` y devolver la
   lista de fallas. `turnos` es la conversación tal como salió: [{ cliente,
   bot: [textos] }] o [{ humano }] para los pasos de una persona del negocio.
   Son aserciones de FORMA (qué NO puede volver a preguntar, a qué columna
   tiene que llegar, cuántos resúmenes), no de redacción: el bot escribe
   distinto cada vez, pero lo que nos trae soportes es siempre lo mismo. */
const RE_PIDE_DIRECCION = /direcci[oó]n (?:exacta|completa|de (?:entrega|env[ií]o))|dos calles|2 calles|calle principal|y una referencia|referencia (?:para|de) (?:llegar|entrega)/i;
const RE_PIDE_NOMBRE = /(?:tu|su|el) nombre(?: completo)?\??|nombre y apellido|apellido\??|c[oó]mo te llamas/i;
const RE_RESUMEN = /(?:^|\n)[^\n]{0,6}?Producto\s*:/i;
const botDijo = (t, re) => (t.bot || []).some((b) => re.test(b));
const desdeTurno = (turnos, i) => turnos.slice(i).filter((t) => t.bot);
const fallasComunes = ({ turnos, estadoFinal }, { desdeNombre, desdeDireccion, estadoEsperado = 'generar_guia', maxResumenes = 2 }) => {
  const fallas = [];
  if (desdeDireccion !== undefined) {
    desdeTurno(turnos, desdeDireccion).forEach((t) => {
      if (botDijo(t, RE_PIDE_DIRECCION)) fallas.push(`volvió a pedir la dirección después de "${t.cliente}"`);
    });
  }
  if (desdeNombre !== undefined) {
    desdeTurno(turnos, desdeNombre).forEach((t) => {
      if (botDijo(t, RE_PIDE_NOMBRE) && !botDijo(t, RE_RESUMEN)) fallas.push(`volvió a pedir el nombre después de "${t.cliente}"`);
    });
  }
  const resumenes = turnos.filter((t) => botDijo(t, RE_RESUMEN)).length;
  if (resumenes > maxResumenes) fallas.push(`mandó el resumen del pedido ${resumenes} veces (máximo ${maxResumenes})`);
  if (estadoEsperado && estadoFinal !== estadoEsperado) fallas.push(`terminó en "${estadoFinal}" y debía terminar en "${estadoEsperado}"`);
  return fallas;
};

const ESCENARIOS = {
  /* ── Dropshipping sobre la cuenta de pruebas (cfg 610, contacto 452858) ──
     Reproducen los soportes del 19 y 20 de agosto de 2026: el bot que pide
     la dirección a quien retira en agencia (360, Delfin), el que pierde el
     apellido y cierra sin tag (302, Josué), y el que repregunta lo ya dado.
     Correr con --columna contacto_inicial para arrancar limpio. */
  dropi_agencia: {
    cliente: 452858,
    titulo: 'Retiro en agencia: NO debe pedir dirección de domicilio ni repreguntar (caso 360, Delfin)',
    mensajes: [
      'Hola, quiero comprar el Guante Anticorte de Acero Inoxidable',
      'Soy de Orellana, del Coca',
      'Uno nomás',
      'Quiero retirar en la Servientrega del Coca, mi número es 0961871183',
      'Delfin Alvarado',
      { tipo: 'humano', texto: 'La Servientrega del Coca queda en la 9 de Octubre y Francisco de Orellana' },
      'ok ya le pasé esa dirección a mi hija, ella retira y paga',
    ],
    busca:
      'Después de "retiro en la Servientrega" NUNCA puede pedir "dirección exacta / dos calles / referencia". ' +
      'Con el nombre tiene que cerrar (resumen + tag) y el contacto terminar en Generar Guia. ' +
      'La línea Direccion del resumen debe ser la agencia por confirmar — Coca.',
    verificar: (r) => fallasComunes(r, { desdeDireccion: 3, desdeNombre: 5 }),
  },

  dropi_datos_sueltos: {
    cliente: 452858,
    titulo: 'Datos en pedazos + gracias repetidos: un solo cierre, sin repreguntar (caso 302, Josué)',
    mensajes: [
      'Hola! Quiero comprar el Onn Watch TV',
      'Quito',
      'Solo uno, ¿cuánto está?',
      'A domicilio',
      'Josué',
      'Yumbulema, mi teléfono es 0995438411',
      'Vilcabamba y Mariscal Sucre, referencia licorería Vivanco',
      'Si está correcto muchas gracias',
      'Muchas gracias, le espero',
      'Listo',
    ],
    busca:
      'Con "Josué" solo puede pedir el APELLIDO (no el nombre otra vez). Tras el apellido+teléfono no puede volver a pedir ' +
      'nombre ni teléfono; tras la dirección no puede volver a pedirla. Un solo resumen con el tag (máximo dos si su flujo ' +
      'confirma antes), el contacto termina en Generar Guia, y a "Muchas gracias, le espero" / "Listo" NO responde con otro resumen.',
    verificar: (r) => {
      const f = fallasComunes(r, { desdeNombre: 6, desdeDireccion: 7 });
      const t = r.turnos;
      const resumenTras = (i) => t[i] && botDijo(t[i], RE_RESUMEN);
      if (resumenTras(8) || resumenTras(9)) f.push('volvió a mandar el resumen después de que el cliente ya había confirmado');
      const ultimo = [...t].reverse().find((x) => botDijo(x, RE_RESUMEN));
      if (ultimo && !(ultimo.bot || []).some((b) => /0995438411/.test(b))) f.push('el resumen no lleva el teléfono que dio el cliente');
      if (ultimo && !(ultimo.bot || []).some((b) => /Yumbulema/i.test(b))) f.push('el resumen no lleva el apellido que dio el cliente');
      return f;
    },
  },

  dropi_todo_junto: {
    cliente: 452858,
    titulo: 'El cliente manda TODOS los datos de una: cero repreguntas, cierre directo',
    mensajes: [
      'Hola, quiero el Onn Watch TV, solo uno. Soy Carlos Pérez, de Guayaquil, mi celular es 0991234567, envíenlo a domicilio a Av. 9 de Octubre y Malecón, referencia frente al Banco Pichincha',
      'Sí, todo correcto, gracias',
      'Gracias, quedo atento',
    ],
    busca:
      'No puede pedir nombre, teléfono, ciudad ni dirección (ya los dio todos). Como mucho confirma/cierra. ' +
      'Un solo resumen con el tag, el contacto termina en Generar Guia, y al "quedo atento" no responde con otro resumen.',
    verificar: (r) => {
      const f = fallasComunes(r, { desdeNombre: 0, desdeDireccion: 0 });
      const t = r.turnos;
      if (t.some((x) => botDijo(x, /tu (?:n[uú]mero|tel[eé]fono|celular)\??|a qu[eé] ciudad/i) && !botDijo(x, RE_RESUMEN))) f.push('volvió a pedir teléfono o ciudad ya dados');
      if (t[2] && botDijo(t[2], RE_RESUMEN)) f.push('volvió a mandar el resumen después del cierre');
      return f;
    },
  },

  /* Dropshipping (correr con --cliente <id> --referral <source_id>).
     El primer mensaje NO nombra el producto a propósito: obliga a que el ancla
     salga del mapa del anuncio (anuncios_producto), que es el caso real. */
  dropi_anuncio: {
    titulo: 'Entrada por anuncio + cierre (no debe cambiar de producto jamás)',
    mensajes: [
      'Hola, quiero más información',
      'Precio',
      'Combo 1',
      'Está bien',
      'Quito',
    ],
    busca:
      'TODAS las respuestas deben ser del producto del anuncio (--referral): ' +
      'ni una foto, video o precio de OTRO producto. "Está bien" y "Quito" son ' +
      'los mensajes que antes lo hacían saltar de producto (caso 285).',
  },

  zona: {
    titulo: 'Pregunta por la zona (NO debe dar la dirección exacta)',
    mensajes: [
      'Hola, vi el arriendo de la casa en Cumbayá',
      '¿En qué parte de Cumbayá queda exactamente?',
    ],
    busca:
      'Debe decir el sector (La Primavera) y NO la dirección "calle Los Nogales". ' +
      'La dirección exacta se reserva hasta que la visita esté acordada.',
  },

  ficha: {
    titulo: 'Datos del inmueble (deben salir del catálogo, no inventados)',
    mensajes: [
      'Me interesa la casa de Cumbayá',
      '¿Cuántos dormitorios y baños tiene? ¿Cuántos metros?',
      '¿Cuánto es la alícuota?',
    ],
    busca:
      '3 dormitorios, 2 y medio baños, 180 m² de construcción, alícuota $85. ' +
      'Si dice otra cosa, está inventando en vez de leer la ficha.',
  },

  fotos: {
    titulo: 'Pide más fotos (debe pasar el álbum, no decir que las envía un asesor)',
    mensajes: [
      'Hola, me gustó la casa de Cumbayá',
      '¿Tienes más fotos?',
    ],
    busca: 'El enlace del álbum, solo y en su propia línea.',
  },

  /* OJO con el camino: la columna "En calificación" NO tiene la acción de
     agendar —en venta primero se califica y recién en "Lead prioritario" se
     agenda—, así que un guion que se quede ahí nunca va a agendar por más que
     el cliente insista. La casa de prueba es un ARRIENDO, y esa columna sí
     agenda, así que el mensaje inicial lo dice explícito. */
  agendar: {
    titulo: 'Agendar visita en modo solicitud (NO debe confirmarla)',
    mensajes: [
      'Hola, busco una casa en arriendo en Cumbayá',
      'Me mudo en dos semanas, puedo pagar hasta 1300 al mes. Somos 3 personas, sin mascotas, y trabajo en relación de dependencia',
      '¿Puedo ir a verla este jueves?',
      'El jueves a las 15:00 me va bien. Soy Michael Sebastián y mi número es 0962803007',
    ],
    busca:
      'NO puede decir "listo, nos vemos el jueves" ni "quedó agendada": debe ' +
      'decir que un asesor le confirma el horario. Y tiene que quedar una ' +
      'solicitud pendiente + el contacto en la columna "Por agendar visita". ' +
      'En el calendario NO debe aparecer ninguna cita nueva.',
  },

  captacion: {
    titulo: 'Propietario que ofrece un inmueble (ubicación + número de predio)',
    mensajes: [
      'Hola, tengo un departamento que quiero dar en arriendo',
      'Es en La Floresta, 2 dormitorios, lo quiero arrendar en 600',
      'Está vacío ahora mismo',
    ],
    busca:
      'Debe pedir la UBICACIÓN por WhatsApp (con el clip) y el NÚMERO DE ' +
      'PREDIO, sin convertirlos en requisito. Nunca debe valorar el inmueble ' +
      'ni hablar de comisión.',
  },

  ubicacion: {
    titulo: 'El cliente comparte su ubicación (el bot no debe pedirla de nuevo)',
    // Es el formato exacto en que el webhook guarda una ubicación entrante.
    mensajes: [
      'Hola, tengo una casa para vender',
      { tipo: 'location', latitud: -0.2004, longitud: -78.4867 },
    ],
    busca:
      'No puede pedir "la dirección en palabras" ni volver a pedir la ' +
      'ubicación: ya la tiene. Puede pedir una referencia para llegar.',
  },

  fuera: {
    titulo: 'Fuera de cobertura',
    mensajes: ['Hola, busco casa en arriendo pero en Guayaquil'],
    busca:
      'Las sedes cargadas son de Quito, así que debe decir que no atienden ' +
      'ahí — sin inventar que sí.',
  },

  precio: {
    titulo: 'Pregunta por algo que no está en el catálogo',
    mensajes: [
      'Hola, ¿tienes casas en Samborondón por 300 mil?',
    ],
    busca:
      'NO puede inventar un inmueble ni un precio. Debe ofrecer lo que sí ' +
      'tiene o pasar a un asesor.',
  },
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* Por qué no contestó.
   ─────────────────────────────────────────────────────────────
   "Sin respuesta, mirá el log" obliga a abrir un archivo de miles de líneas y
   saber qué buscar. Casi siempre la causa está en las últimas líneas y es una
   de tres: OpenAI devolvió 429 (límite por minuto o saldo), la columna no tiene
   la IA encendida, o el webhook no encontró la configuración. Se lee acá y se
   dice en una línea. */
async function porQueNoContesto() {
  const fs = require('fs').promises;
  const path = require('path');
  const archivo = path.join(
    process.cwd(),
    'src/logs/logs_meta/debug_log.txt',
  );

  try {
    const { size } = await fs.stat(archivo);
    const fd = await fs.open(archivo, 'r');
    // Solo la cola: el archivo crece sin límite.
    const largo = Math.min(size, 60000);
    const buf = Buffer.alloc(largo);
    await fd.read(buf, 0, largo, size - largo);
    await fd.close();

    const lineas = buf.toString('utf8').split('\n').slice(-120).reverse();

    const pistas = [
      [/status code 429/i, 'OpenAI respondió 429. Si openai_activo sigue en 1 es límite por minuto (esperá un rato); si se apagó, es saldo.'],
      [/insufficient_quota|SIN SALDO/i, 'La cuenta de OpenAI se quedó sin saldo.'],
      [/sin_columna|Sin columna para estado/i, 'El estado del contacto no coincide con ninguna columna activa del tablero.'],
      [/ia_inactiva/i, 'Esa columna tiene la IA apagada o sin asistente.'],
      [/No se encontró configuración con id_telefono/i, 'El webhook no reconoció el phone_number_id: revisá configuraciones.id_telefono.'],
      [/Error ejecutando asistente: (.+)/i, null],
      [/❌ (.+)/, null],
    ];

    for (const linea of lineas) {
      for (const [re, explicacion] of pistas) {
        const m = re.exec(linea);
        if (m) return explicacion || m[1] || m[0];
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function contexto() {
  const [cli] = await db.query(
    `SELECT id, id_configuracion, nombre_cliente, apellido_cliente,
            celular_cliente, estado_contacto
       FROM clientes_chat_center WHERE id = ? LIMIT 1`,
    { replacements: [ID_CLIENTE], type: db.QueryTypes.SELECT },
  );
  if (!cli) throw new Error(`No existe el contacto ${ID_CLIENTE}`);

  const [cfg] = await db.query(
    `SELECT id, id_telefono, id_whatsapp, telefono, nombre_configuracion
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [cli.id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg?.id_telefono) {
    throw new Error(
      `La configuración ${cli.id_configuracion} no tiene id_telefono: el webhook no la va a encontrar`,
    );
  }
  return { cli, cfg };
}

/* El payload de Meta. El `phone_number_id` es lo único que el webhook usa para
   saber de qué cuenta es el mensaje (busca configuraciones.id_telefono), y el
   `from` es lo que ata el mensaje al contacto. */
function armarPayload({ cli, cfg, mensaje, i, referral }) {
  const wamid = `wamid.PRUEBA${Date.now()}${i}`;
  const nombre = [cli.nombre_cliente, cli.apellido_cliente]
    .filter(Boolean)
    .join(' ');

  const base = {
    from: cli.celular_cliente,
    id: wamid,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };

  const msg =
    typeof mensaje === 'string'
      ? { ...base, text: { body: mensaje }, type: 'text' }
      : {
          ...base,
          type: 'location',
          location: { latitude: mensaje.latitud, longitude: mensaje.longitud },
        };

  // Mismo formato que manda Meta en un clic-a-WhatsApp real.
  if (referral) msg.referral = referral;

  return {
    payload: {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: cfg.id_whatsapp || '0',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: cfg.telefono,
                  phone_number_id: cfg.id_telefono,
                },
                contacts: [
                  { profile: { name: nombre || 'Prueba' }, wa_id: cli.celular_cliente },
                ],
                messages: [msg],
              },
              field: 'messages',
            },
          ],
        },
      ],
    },
    wamid,
  };
}

const ultimoId = async (idc) => {
  const [r] = await db.query(
    `SELECT COALESCE(MAX(id), 0) AS id FROM mensajes_clientes
      WHERE id_configuracion = ? AND celular_recibe = ?`,
    { replacements: [idc, String(ID_CLIENTE)], type: db.QueryTypes.SELECT },
  );
  return Number(r.id);
};

/* Se espera leyendo la base y no el log: lo que importa es lo que le llegó al
   cliente, y ahí queda registrado. */
async function esperarRespuesta(idc, desdeId) {
  const limite = Date.now() + ESPERA_MS;
  let vistos = [];

  while (Date.now() < limite) {
    await dormir(1500);

    const nuevos = await db.query(
      `SELECT id, rol_mensaje, tipo_mensaje, responsable, texto_mensaje, ruta_archivo
         FROM mensajes_clientes
        WHERE id_configuracion = ? AND celular_recibe = ? AND id > ?
        ORDER BY id ASC`,
      {
        replacements: [idc, String(ID_CLIENTE), desdeId],
        type: db.QueryTypes.SELECT,
      },
    );

    const delBot = nuevos.filter((m) => Number(m.rol_mensaje) === 1);

    /* Se da por terminada cuando pasan 3 segundos sin que aparezca nada nuevo:
       el bot puede mandar una foto y después el texto, y cortar en el primero
       mostraría media respuesta. */
    if (delBot.length && delBot.length === vistos.length) return delBot;
    vistos = delBot;
  }

  return vistos;
}

async function mostrarEstado(prefijo = '') {
  const { cli } = await contexto();

  const [col] = await db.query(
    `SELECT nombre, estado_db FROM kanban_columnas
      WHERE id_configuracion = ? AND LOWER(estado_db) = LOWER(?) AND activo = 1
      LIMIT 1`,
    {
      replacements: [cli.id_configuracion, cli.estado_contacto],
      type: db.QueryTypes.SELECT,
    },
  );

  console.log(
    `${prefijo}Columna: ${col?.nombre || '(sin columna)'} [${cli.estado_contacto}]`,
  );

  const sol = await db.query(
    `SELECT id, estado, servicio, preferencia_texto, inicio_sugerido, created_at
       FROM citas_solicitudes
      WHERE id_cliente = ? ORDER BY id DESC LIMIT 3`,
    { replacements: [ID_CLIENTE], type: db.QueryTypes.SELECT },
  );
  if (sol.length) {
    console.log(`${prefijo}Solicitudes de cita:`);
    sol.forEach((s) =>
      console.log(
        `${prefijo}  #${s.id} ${s.estado} · ${s.servicio || 'sin ítem'} · ` +
          `pidió "${s.preferencia_texto || '—'}" · ${s.inicio_sugerido || 'sin fecha'}`,
      ),
    );
  }

  const citas = await db.query(
    `SELECT ap.id, ap.title, ap.start_utc, ap.location_text
       FROM appointments ap
       JOIN appointment_invitees inv ON inv.appointment_id = ap.id
       JOIN calendars cal ON cal.id = ap.calendar_id
      WHERE cal.account_id = ?
        AND RIGHT(REGEXP_REPLACE(inv.phone, '[^0-9]', ''), 9) = ?
      ORDER BY ap.id DESC LIMIT 3`,
    {
      replacements: [cli.id_configuracion, String(cli.celular_cliente).slice(-9)],
      type: db.QueryTypes.SELECT,
    },
  );
  if (citas.length) {
    console.log(`${prefijo}Citas en el calendario:`);
    citas.forEach((c) =>
      console.log(`${prefijo}  #${c.id} ${c.title} · ${c.start_utc} · ${c.location_text}`),
    );
  }
}

/* Arrancar una prueba desde una columna concreta.
   Sin esto, para probar la columna de arriendo hay que convencer al asistente
   de entrada de que mande el lead ahí, y su criterio cambia de una corrida a
   otra: la prueba se vuelve una lotería. Poniendo el estado a mano se prueba
   LA columna que se quiere probar. */
async function reset(estado = 'contacto_inicial') {
  const { cli } = await contexto();

  const [col] = await db.query(
    `SELECT nombre FROM kanban_columnas
      WHERE id_configuracion = ? AND LOWER(estado_db) = LOWER(?) AND activo = 1
      LIMIT 1`,
    { replacements: [cli.id_configuracion, estado], type: db.QueryTypes.SELECT },
  );
  if (!col) {
    throw new Error(
      `La configuración ${cli.id_configuracion} no tiene una columna activa con estado_db "${estado}"`,
    );
  }

  await db.query(
    `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
    { replacements: [estado, ID_CLIENTE], type: db.QueryTypes.UPDATE },
  );

  /* El thread de OpenAI guarda la conversación entera del lado del asistente.
     Sin borrarlo, el bot arranca "recordando" la prueba anterior y no se puede
     probar un primer contacto dos veces. */
  await db.query(`DELETE FROM openai_threads WHERE id_cliente_chat_center = ?`, {
    replacements: [ID_CLIENTE],
    type: db.QueryTypes.DELETE,
  });
  /* Mismo corte que el botón "Reiniciar conversación" del panel: el recap y
     la ficha del pedido solo miran lo que venga DESPUÉS. Sin esto, la prueba
     heredaría el nombre/dirección de la corrida anterior como datos "ya
     dados" y no probaría nada. Si la columna no existe (migración no
     aplicada), se sigue como antes. */
  await db
    .query(
      `UPDATE clientes_chat_center
          SET reinicio_conversacion_at = NOW(), turnos_sin_avance = 0
        WHERE id = ?`,
      { replacements: [ID_CLIENTE], type: db.QueryTypes.UPDATE },
    )
    .catch(() =>
      /* sin la columna reinicio_conversacion_at (migración no aplicada) al
         menos se limpia el contador: si no, la red de "15 turnos sin avance"
         suma las corridas anteriores y manda la prueba a asesor a mitad. */
      db
        .query(`UPDATE clientes_chat_center SET turnos_sin_avance = 0 WHERE id = ?`, {
          replacements: [ID_CLIENTE],
          type: db.QueryTypes.UPDATE,
        })
        .catch(() => {}),
    );

  const [s] = await db.query(
    `UPDATE citas_solicitudes SET estado = 'descartada'
      WHERE id_cliente = ? AND estado = 'pendiente'`,
    { replacements: [ID_CLIENTE], type: db.QueryTypes.UPDATE },
  );

  console.log(
    `↺ ${cli.nombre_cliente} queda en "${col.nombre}" [${estado}], thread ` +
      `borrado y solicitudes pendientes descartadas.\n` +
      `  (los mensajes del historial NO se borran: son el registro de lo que pasó)`,
  );
}

/* Un mensaje de una PERSONA del negocio en medio del guion: se inserta como
   saliente (rol 1, responsable humano), igual que lo deja el panel cuando un
   asesor escribe. El bot tiene que verlo como contexto (6.8 del servicio). */
async function insertarMensajeHumano(cli, cfg, texto) {
  const [ult] = await db.query(
    `SELECT id_cliente, mid_mensaje, uid_whatsapp FROM mensajes_clientes
      WHERE id_configuracion = ? AND celular_recibe = ? AND rol_mensaje = 1
      ORDER BY id DESC LIMIT 1`,
    { replacements: [cfg.id, String(ID_CLIENTE)], type: db.QueryTypes.SELECT },
  );
  if (!ult) throw new Error('no hay un mensaje saliente previo del que copiar los campos');
  await db.query(
    `INSERT INTO mensajes_clientes
       (id_configuracion, id_cliente, mid_mensaje, tipo_mensaje, responsable,
        texto_mensaje, rol_mensaje, celular_recibe, uid_whatsapp,
        id_wamid_mensaje, visto, created_at, updated_at)
     VALUES (?, ?, ?, 'text', 'Asesor (prueba)', ?, 1, ?, ?, ?, 1, NOW(), NOW())`,
    {
      replacements: [
        cfg.id,
        ult.id_cliente,
        ult.mid_mensaje,
        texto,
        String(ID_CLIENTE),
        ult.uid_whatsapp,
        `wamid.HUMANO${Date.now()}`,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
}

/* El servicio no manda dos resúmenes de cierre al mismo contacto en menos de
   5 minutos (utils/dedupeAutoOrden → reclamarResumenCierre). Dos guiones
   seguidos sobre el MISMO contacto de prueba chocan con eso: el segundo
   cierre se procesa (columna, orden) pero el resumen no sale y la prueba
   parece fallar. Si hubo un resumen hace menos de 5 min, se espera. */
async function esperarCandadoResumen(idc) {
  const [r] = await db.query(
    `SELECT TIMESTAMPDIFF(SECOND, MAX(created_at), NOW()) AS hace
       FROM mensajes_clientes
      WHERE id_configuracion = ? AND celular_recibe = ? AND rol_mensaje = 1
        AND texto_mensaje LIKE '%Producto:%'
        AND created_at >= NOW() - INTERVAL 5 MINUTE`,
    { replacements: [idc, String(ID_CLIENTE)], type: db.QueryTypes.SELECT },
  );
  const hace = r?.hace === null || r?.hace === undefined ? null : Number(r.hace);
  if (hace === null) return;
  const faltan = 5 * 60 - hace + 5;
  if (faltan <= 0) return;
  console.log(
    `⏳ Hace ${hace}s salió un resumen de cierre a este contacto: espero ${faltan}s ` +
      `por el candado anti-resumen-repetido (5 min) antes de empezar.\n`,
  );
  await dormir(faltan * 1000);
}

async function enviar(mensajes) {
  const { cli, cfg } = await contexto();
  await esperarCandadoResumen(cfg.id);
  const turnos = [];

  console.log(
    `\n⚠️  El bot va a responder por WhatsApp DE VERDAD al ${cli.celular_cliente} ` +
      `(${cli.nombre_cliente}).\n` +
      `    Cuenta: ${cfg.nombre_configuracion} [${cfg.id}] · Webhook: ${URL_WEBHOOK}\n`,
  );

  await mostrarEstado('    ');
  console.log('');

  /* El referral se arma una vez y va SOLO en el primer mensaje de la corrida,
     igual que en la vida real: el clic al anuncio es la entrada. */
  let referral = null;
  if (REFERRAL_SOURCE) {
    let headline = REFERRAL_HEADLINE || '';
    if (!headline) {
      const [ad] = await db.query(
        `SELECT headline FROM anuncios_producto
          WHERE id_configuracion = ? AND source_id = ? LIMIT 1`,
        {
          replacements: [cli.id_configuracion, String(REFERRAL_SOURCE)],
          type: db.QueryTypes.SELECT,
        },
      );
      headline = ad?.headline || '';
    }
    referral = {
      source_url: `https://fb.me/prueba${REFERRAL_SOURCE}`,
      source_id: String(REFERRAL_SOURCE),
      source_type: 'ad',
      headline,
      body: 'Anuncio de prueba (webhook local)',
      media_type: 'image',
      ctwa_clid: `PRUEBA_${Date.now()}`,
    };
    console.log(
      `📣 Entrada por anuncio: source_id=${referral.source_id} · headline="${headline || '(sin headline)'}"\n`,
    );
  }

  for (let i = 0; i < mensajes.length; i += 1) {
    if (i > 0 && PAUSA_MS > 0) {
      console.log(`   ⏳ ${PAUSA_MS / 1000}s para no topar el límite de OpenAI…\n`);
      await dormir(PAUSA_MS);
    }

    const mensaje = mensajes[i];

    // Paso de una persona del negocio: se inserta y se sigue (no dispara al bot).
    if (mensaje && typeof mensaje === 'object' && mensaje.tipo === 'humano') {
      try {
        await insertarMensajeHumano(cli, cfg, mensaje.texto);
        console.log(`👩‍💼 (asesor) ${mensaje.texto}\n`);
        turnos.push({ humano: mensaje.texto });
      } catch (e) {
        console.log(`⚠️  No se pudo insertar el mensaje del asesor: ${e.message}\n`);
      }
      continue;
    }

    const desdeId = await ultimoId(cfg.id);
    const { payload } = armarPayload({
      cli,
      cfg,
      mensaje,
      i,
      referral: i === 0 ? referral : null,
    });

    const texto =
      typeof mensaje === 'string'
        ? mensaje
        : `[ubicación ${mensaje.latitud}, ${mensaje.longitud}]`;
    console.log(`👤 ${texto}`);

    try {
      await axios.post(URL_WEBHOOK, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
      });
    } catch (err) {
      if (err.code === 'ECONNREFUSED') {
        console.error(
          `\n❌ No hay nadie escuchando en ${BASE}. Levanta el servidor con ` +
            `\`npm run dev\` y volvé a correr esto.`,
        );
        process.exit(1);
      }
      console.error(`⚠️  El webhook respondió con error: ${err.message}`);
    }

    const respuestas = await esperarRespuesta(cfg.id, desdeId);

    if (!respuestas.length) {
      const causa = await porQueNoContesto();
      console.log(`🤖 (sin respuesta en ${ESPERA_MS / 1000}s)`);
      console.log(`   ⚠️  ${causa || 'revisá src/logs/logs_meta/debug_log.txt'}`);
    } else {
      respuestas.forEach((r) => {
        const etiqueta =
          r.tipo_mensaje && r.tipo_mensaje !== 'text'
            ? `[${r.tipo_mensaje}] `
            : '';
        console.log(
          `🤖 ${etiqueta}${(r.texto_mensaje || r.ruta_archivo || '').trim()}`,
        );
        if (r.responsable) console.log(`   ↳ ${r.responsable}`);
      });
    }
    turnos.push({
      cliente: texto,
      bot: respuestas.map((r) => String(r.texto_mensaje || '')),
    });
    console.log('');
  }

  console.log('── Cómo quedó ──');
  await mostrarEstado('  ');
  const { cli: fin } = await contexto();
  return { turnos, estadoFinal: String(fin.estado_contacto || '').toLowerCase() };
}

(async () => {
  if (bandera('escenarios')) {
    console.log('\nGuiones disponibles:\n');
    for (const [clave, e] of Object.entries(ESCENARIOS)) {
      console.log(`  ${clave.padEnd(11)} ${e.titulo}`);
    }
    console.log(
      '\n  node scripts/probarWebhookWhatsapp.js --escenario <nombre>\n',
    );
    process.exit(0);
  }

  if (bandera('estado')) {
    await mostrarEstado('  ');
    process.exit(0);
  }

  /* `--columna` sirve solo, para preparar el terreno, y también acompañando a
     un guion: ahí resetea y arranca de esa columna en una sola corrida. */
  const columna = opcion('columna');

  if (bandera('reset') || (columna && !opcion('escenario'))) {
    await reset(columna || 'contacto_inicial');
    process.exit(0);
  }

  const nombreEsc = opcion('escenario');
  if (nombreEsc) {
    const esc = ESCENARIOS[nombreEsc];
    if (!esc) {
      console.error(
        `No existe el guion "${nombreEsc}". Los que hay: ${Object.keys(ESCENARIOS).join(', ')}`,
      );
      process.exit(1);
    }
    // El guion trae su contacto de prueba; --cliente explícito manda.
    if (!CLIENTE_FLAG && esc.cliente) ID_CLIENTE = esc.cliente;
    console.log(`\n═══ ${esc.titulo} ═══`);
    console.log(`Qué mirar: ${esc.busca}`);
    if (columna) {
      await reset(columna);
      console.log('');
    }
    const resultado = await enviar(esc.mensajes);
    if (typeof esc.verificar === 'function') {
      let fallas = [];
      try {
        fallas = esc.verificar(resultado) || [];
      } catch (e) {
        fallas = [`la verificación reventó: ${e.message}`];
      }
      console.log('\n── Verificación automática ──');
      if (fallas.length) {
        fallas.forEach((f) => console.log(`  ❌ ${f}`));
        console.log(`\n❌ ${fallas.length} falla(s) en "${nombreEsc}"`);
        process.exit(1);
      }
      console.log('  ✅ sin fallas conocidas');
    }
    process.exit(0);
  }

  const texto = textoLibre();
  if (!texto) {
    console.log(
      'Pasá un mensaje entre comillas, o --escenarios para ver los guiones.',
    );
    process.exit(1);
  }

  await enviar([texto]);
  process.exit(0);
})().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
