/**
 * crearPlantillaAvisoPagoPendiente.js
 * Crea en la WABA de una configuración la plantilla `aviso_pago_pendiente`:
 * el aviso que Imporsuit dispara por WhatsApp cuando un usuario suspendido
 * por falta de pago intenta iniciar sesión (POST /api/public/v1/cobros/aviso-pago).
 *
 * Uso:
 *   node scripts/crearPlantillaAvisoPagoPendiente.js 242
 *   node scripts/crearPlantillaAvisoPagoPendiente.js 242 --dry
 *
 * --dry  muestra el payload y valida la estructura sin llamar a Meta.
 *
 * UTILITY, idioma `es`, solo cuerpo. Las tres variables las llena el
 * backend desde la cartera del cliente (utils/enlacePagoImporsuit.js):
 *   {{1}} nombre · {{2}} saldo vencido · {{3}} enlace Cobros/pagar/{uuid}
 * El enlace va en el cuerpo y no en un botón porque así lo pidió el negocio;
 * apunta a Imporsuit (new.imporsuitpro.com), que es quien crea el Checkout
 * en SU Stripe al hacer clic. Si la plantilla ya existe, Meta responde
 * "already exists" y se deja tal cual. Queda PENDING hasta que Meta la apruebe.
 */

/* eslint-disable no-console */
require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');
const { URL_BOTON_PAGO } = require('../src/utils/enlacePagoImporsuit');

const GRAPH_BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION}`;

const PLANTILLA = {
  name: 'aviso_pago_pendiente',
  text:
    '🔔 AVISO DE PAGO PENDIENTE\n' +
    'Hola {{1}}, vemos que aún tienes pendiente realizar un pago por ${{2}}.\n' +
    'Permítenos ayudarte a completarlo. Puedes pagar mediante:\n' +
    '💳 Enlace de pago o tarjeta:\n' +
    '{{3}}\n' +
    'Si tienes algún inconveniente para realizar el pago, escríbenos y te ayudaremos. Cuando lo realices, envíanos el comprobante por este medio.',
  // Valores de ejemplo para el revisor de Meta (obligatorios con variables).
  ejemplo: [
    'María',
    '150.00',
    URL_BOTON_PAGO.replace('{{1}}', '3f9c2a1e-7b4d-4c58-9e21-0a6f5d8b2c71'),
  ],
};

/* Lo que Meta rechaza y conviene atajar antes de gastar una llamada. */
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
        example: { body_text: [p.ejemplo] },
      },
    ],
  };
}

(async () => {
  const id_configuracion = Number(process.argv[2]);
  const dry = process.argv.includes('--dry');

  if (!id_configuracion) {
    console.error(
      'Uso: node scripts/crearPlantillaAvisoPagoPendiente.js <id_configuracion> [--dry]',
    );
    process.exit(1);
  }

  const errores = validar(PLANTILLA);
  if (errores.length) {
    console.error(`❌ ${PLANTILLA.name}: ${errores.join('; ')}`);
    process.exit(1);
  }

  if (dry) {
    console.log(`— ${PLANTILLA.name} (${PLANTILLA.text.length} caracteres):`);
    console.log(JSON.stringify(payload(PLANTILLA), null, 2));
    console.log('\nValidada. Nada se envió a Meta (--dry).');
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
  console.log(`Creando «${PLANTILLA.name}» en «${cfg.nombre_configuracion}» (WABA ${cfg.waba_id})`);

  try {
    const { data } = await axios.post(
      `${GRAPH_BASE}/${cfg.waba_id}/message_templates`,
      payload(PLANTILLA),
      {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      },
    );
    console.log(`✅ creada (id ${data?.id}, estado ${data?.status || 'PENDING'})`);
    process.exit(0);
  } catch (e) {
    const err = e?.response?.data?.error;
    const msg = err?.error_user_msg || err?.message || e.message;
    if (/already exists/i.test(msg)) {
      console.log('↔️  ya existía, nada que hacer.');
      process.exit(0);
    }
    console.error(`❌ ${msg}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('FALLO:', e?.response?.data || e.message);
  process.exit(1);
});
