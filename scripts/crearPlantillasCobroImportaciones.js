/**
 * crearPlantillasCobroImportaciones.js
 * Crea en la WABA de una configuración las once plantillas de cobro de
 * importaciones (logística e impuestos) que redactó Vivi para la línea
 * «Soporte Importaciones Expertos» (configuración 265).
 *
 * Uso:
 *   node scripts/crearPlantillasCobroImportaciones.js <id_configuracion>
 *   node scripts/crearPlantillasCobroImportaciones.js <id_configuracion> --dry
 *   node scripts/crearPlantillasCobroImportaciones.js <id_configuracion> --solo logistica_asignada,impuestos_aviso
 *
 * --dry  muestra los payloads y valida la estructura sin llamar a Meta.
 * --solo crea únicamente las plantillas indicadas (separadas por coma).
 *
 * Todas son UTILITY, idioma `es`, solo cuerpo (sin encabezado, pie ni
 * botones). La cuenta bancaria va escrita en el texto: Meta no acepta
 * texto opcional y el cobro siempre es a la misma cuenta.
 * Si la plantilla ya existe en la WABA, Meta responde "already exists" y
 * se deja tal cual.
 */

/* eslint-disable no-console */
require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');

const GRAPH_BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION}`;

// Cuenta oficial de cobro. Es texto fijo, no variable.
const CUENTA =
  '🏦 Produbanco · Cuenta de Ahorros N° 20002443498\n' +
  '👤 Cherrez Rodriguez Evelyn Carolina · C.I. 1725399677';

// Valores de ejemplo para el revisor de Meta (obligatorios con variables).
const EJ = {
  nombre: 'María',
  consolidado: 'IMP020 GRUPAL 2026 C#20',
  monto: '350.00',
  fecha: '25 de octubre',
  tiempo: '5 días',
};

const PLANTILLAS = [
  /* ───────────── LOGÍSTICA ───────────── */
  {
    name: 'logistica_asignada',
    text:
      'Hola {{1}}! 👋 Buenas noticias: tu carga ya fue asignada al consolidado {{2}} 🚢\n\n' +
      '💵 Valor de logística: ${{3}}\n\n' +
      'Para confirmar tu espacio y avanzar con el embarque, realiza el pago a la cuenta oficial:\n' +
      `${CUENTA}\n\n` +
      '📸 Cuando pagues, envíanos el comprobante por este chat para registrarlo.\n\n' +
      '⚠️ Paga solo a las cuentas oficiales que te compartimos por este canal.',
    ejemplo: [EJ.nombre, EJ.consolidado, EJ.monto],
  },
  {
    name: 'logistica_recordatorio_1',
    text:
      'Hola {{1}} 😊 Te recuerdo que tienes pendiente el pago de logística de tu carga en el contenedor {{2}}.\n\n' +
      '💵 Valor: ${{3}}\n\n' +
      'Si ya pagaste, envíanos el comprobante y lo registramos de una. Si tienes alguna duda, aquí estoy para ayudarte 🙌',
    ejemplo: [EJ.nombre, EJ.consolidado, EJ.monto],
  },
  {
    name: 'logistica_recordatorio_2',
    text:
      'Hola {{1}}, ¿cómo vas? 👋 Tu pago de logística (${{2}}) sigue pendiente.\n\n' +
      'Tu carga ya tiene espacio en el contenedor y queremos que salga sin contratiempos 🚢 ¿Me confirmas para qué día tienes previsto el pago?',
    ejemplo: [EJ.nombre, EJ.monto],
  },
  {
    name: 'logistica_recordatorio_3',
    text:
      'Hola {{1}}. Seguimos sin registrar el pago de logística de tu carga (${{2}}) del consolidado {{3}}.\n\n' +
      'Necesitamos tener los pagos al día para cerrar el embarque. Por favor realiza el pago hoy o escríbeme si tienes algún inconveniente y lo vemos juntos 🤝',
    ejemplo: [EJ.nombre, EJ.monto, EJ.consolidado],
  },
  {
    // Último recordatorio: cierra con la fecha límite, sin frase de consecuencia.
    name: 'logistica_recordatorio_4',
    text:
      'Hola {{1}}, tu pago de logística sigue pendiente: ${{2}} 📌\n\n' +
      'Tienes hasta el {{3}} para realizarlo y dejar tu carga lista para el embarque.\n\n' +
      'Envíanos el comprobante apenas pagues. Quedamos atentos 🙌',
    ejemplo: [EJ.nombre, EJ.monto, EJ.fecha],
  },

  /* ───────────── IMPUESTOS ───────────── */
  {
    name: 'impuestos_aviso',
    text:
      '¡Hola {{1}}! 🇪🇨 Tu carga llega aprox. el *{{2}}* 🚢\n\n' +
      '💵 *Total impuestos: ${{3}}*\n\n' +
      'Para nacionalizar y liberar tu carga sin retrasos, el pago debe estar listo antes de la llegada.\n' +
      `${CUENTA}\n\n` +
      '📸 Envía el comprobante por aquí para registrarlo.',
    ejemplo: [EJ.nombre, EJ.fecha, EJ.monto],
  },
  {
    name: 'impuestos_recordatorio_a',
    text:
      'Hola {{1}} 👋 Recordatorio: faltan *{{2}}* para que llegue tu carga y el pago de impuestos (*${{3}}*) sigue pendiente. ¡Evita retrasos en la liberación! 🚢',
    ejemplo: [EJ.nombre, EJ.tiempo, EJ.monto],
  },
  {
    name: 'impuestos_recordatorio_b',
    text:
      'Hola {{1}}, tu carga ya está en camino 🌊 Solo falta tu pago de impuestos (*${{2}}*) para dejar lista la nacionalización. ¿Me confirmas cuándo lo realizas?',
    ejemplo: [EJ.nombre, EJ.monto],
  },
  {
    name: 'impuestos_recordatorio_c',
    text:
      'Hola {{1}} 😊 Si ya pagaste los impuestos de tu carga, envíame el comprobante para registrarlo. Si no, recuerda que el valor es *${{2}}* y la llegada es el *{{3}}* 🚢',
    ejemplo: [EJ.nombre, EJ.monto, EJ.fecha],
  },
  {
    name: 'impuestos_recordatorio_d',
    text:
      'Hola {{1}}, cuenta regresiva ⏳ Llegada en *{{2}}*. Impuestos pendientes: *${{3}}*. Mientras antes pagues, más rápido tienes tu mercadería en tus manos 📦',
    ejemplo: [EJ.nombre, EJ.tiempo, EJ.monto],
  },
  {
    // La carga ya llegó: cierra pidiendo el comprobante, sin frase de bodegaje.
    name: 'impuestos_carga_llego',
    text:
      'Hola {{1}}. Tu carga ya llegó ✅ pero está detenida por el pago de impuestos pendiente (*${{2}}*).\n\n' +
      'Apenas registremos tu pago avanzamos con la liberación y coordinamos la entrega. Envíanos el comprobante por este chat 📸',
    ejemplo: [EJ.nombre, EJ.monto],
  },
];

/* Lo que Meta rechaza y conviene atajar antes de gastar una llamada:
   variables sin ejemplo, cuerpo que empieza o termina en variable,
   numeración con huecos y cuerpo de más de 1024 caracteres. */
function validar(p) {
  const errores = [];
  const vars = [...p.text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const n = vars.length ? Math.max(...vars) : 0;
  for (let i = 1; i <= n; i++) {
    if (!vars.includes(i)) errores.push(`falta la variable {{${i}}}`);
  }
  if (p.ejemplo.length !== n) {
    errores.push(`${n} variables pero ${p.ejemplo.length} ejemplos`);
  }
  if (/^\s*\{\{\d+\}\}/.test(p.text)) errores.push('empieza con variable');
  if (/\{\{\d+\}\}\s*$/.test(p.text)) errores.push('termina con variable');
  if (p.text.length > 1024) errores.push(`cuerpo de ${p.text.length} caracteres`);
  if (!/^[a-z0-9_]+$/.test(p.name)) errores.push('nombre inválido');
  return errores;
}

function payload(p) {
  return {
    name: p.name,
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: p.text,
        ...(p.ejemplo.length ? { example: { body_text: [p.ejemplo] } } : {}),
      },
    ],
  };
}

(async () => {
  const id_configuracion = Number(process.argv[2]);
  const dry = process.argv.includes('--dry');
  const iSolo = process.argv.indexOf('--solo');
  const solo =
    iSolo > -1 && process.argv[iSolo + 1]
      ? process.argv[iSolo + 1].split(',').map((s) => s.trim())
      : null;

  if (!id_configuracion) {
    console.error(
      'Uso: node scripts/crearPlantillasCobroImportaciones.js <id_configuracion> [--dry] [--solo a,b]',
    );
    process.exit(1);
  }

  const seleccion = solo
    ? PLANTILLAS.filter((p) => solo.includes(p.name))
    : PLANTILLAS;
  if (!seleccion.length) {
    console.error('Ninguna plantilla coincide con --solo.');
    process.exit(1);
  }

  let conErrores = 0;
  for (const p of seleccion) {
    const errores = validar(p);
    if (errores.length) {
      conErrores++;
      console.error(`❌ ${p.name}: ${errores.join('; ')}`);
    }
  }
  if (conErrores) {
    console.error(`\n${conErrores} plantilla(s) con errores de estructura. No se envía nada.`);
    process.exit(1);
  }

  if (dry) {
    for (const p of seleccion) {
      console.log(`\n— ${p.name} (${p.text.length} caracteres):`);
      console.log(JSON.stringify(payload(p), null, 2));
    }
    console.log(`\n${seleccion.length} plantillas validadas. Nada se envió a Meta (--dry).`);
    process.exit(0);
  }

  const [cfg] = await db.query(
    `SELECT nombre_configuracion, id_whatsapp AS waba_id, token FROM configuraciones
      WHERE id = ? AND id_whatsapp IS NOT NULL AND token IS NOT NULL LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg) {
    console.error(`La configuración ${id_configuracion} no tiene WhatsApp API conectado.`);
    process.exit(1);
  }
  console.log(`Creando ${seleccion.length} plantillas en «${cfg.nombre_configuracion}» (WABA ${cfg.waba_id})\n`);

  const resumen = { creadas: 0, existian: 0, errores: 0 };
  for (const p of seleccion) {
    try {
      const { data } = await axios.post(
        `${GRAPH_BASE}/${cfg.waba_id}/message_templates`,
        payload(p),
        {
          headers: {
            Authorization: `Bearer ${cfg.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
      resumen.creadas++;
      console.log(`✅ ${p.name}: creada (id ${data?.id}, estado ${data?.status || 'PENDING'})`);
    } catch (e) {
      const err = e?.response?.data?.error;
      const msg = err?.error_user_msg || err?.message || e.message;
      if (/already exists/i.test(msg)) {
        resumen.existian++;
        console.log(`↔️  ${p.name}: ya existía, nada que hacer.`);
      } else {
        resumen.errores++;
        console.error(`❌ ${p.name}: ${msg}`);
      }
    }
  }

  console.log(
    `\nListo: ${resumen.creadas} creadas, ${resumen.existian} ya existían, ${resumen.errores} con error.`,
  );
  process.exit(resumen.errores ? 1 : 0);
})().catch((e) => {
  console.error('FALLO:', e?.response?.data || e.message);
  process.exit(1);
});
