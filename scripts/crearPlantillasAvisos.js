/**
 * crearPlantillasAvisos.js
 * Crea en la WABA de una configuración las plantillas de avisos activas de
 * `avisos_plantillas` (categoría UTILITY: aprobación rápida de Meta).
 *
 * Uso:
 *   node scripts/crearPlantillasAvisos.js <id_configuracion>
 *   node scripts/crearPlantillasAvisos.js <id_configuracion> --dry
 *
 * --dry solo muestra los payloads sin llamar a Meta.
 *
 * Nota: cada cliente necesita las plantillas en SU WABA, así que este script
 * se corre por configuración (o se invoca al activar el check de avisos).
 * Si la plantilla ya existe, Meta responde "already exists" y se ignora.
 */

/* eslint-disable no-console */
require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');

const GRAPH_BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION}`;

// Ejemplos por evento para el revisor de Meta (obligatorios con variables).
const EJEMPLOS = {
  regla_anuncio_pausado: ['Daniel', 'Faja reductora · V2', 'gastó $0.40 sin generar mensajes'],
  regla_campania_pausada: ['Daniel', 'Faja reductora · lanzamiento EC', 'costo por mensaje de $0.62 con $3.10 gastados'],
  regla_presupuesto_subido: ['Daniel', 'Faja reductora · lanzamiento EC', 'costo por mensaje de $0.18', '$5.50'],
};

(async () => {
  const id_configuracion = Number(process.argv[2]);
  const dry = process.argv.includes('--dry');
  if (!id_configuracion) {
    console.error('Uso: node scripts/crearPlantillasAvisos.js <id_configuracion> [--dry]');
    process.exit(1);
  }

  const [cfg] = await db.query(
    `SELECT id_whatsapp AS waba_id, token FROM configuraciones
      WHERE id = ? AND id_whatsapp IS NOT NULL AND token IS NOT NULL LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg) {
    console.error(`La configuración ${id_configuracion} no tiene WhatsApp API conectado.`);
    process.exit(1);
  }

  const plantillas = await db.query(
    `SELECT * FROM avisos_plantillas WHERE activa = 1`,
    { type: db.QueryTypes.SELECT },
  );
  if (!plantillas.length) {
    console.log('No hay plantillas activas en avisos_plantillas.');
    process.exit(0);
  }

  for (const p of plantillas) {
    const nVars = (p.cuerpo.match(/\{\{\d+\}\}/g) || []).length;
    const ejemplo = (EJEMPLOS[p.evento] || []).slice(0, nVars);
    while (ejemplo.length < nVars) ejemplo.push('ejemplo');

    const components = [
      {
        type: 'BODY',
        text: p.cuerpo,
        ...(nVars ? { example: { body_text: [ejemplo] } } : {}),
      },
    ];
    if (p.footer) components.push({ type: 'FOOTER', text: p.footer });

    const payload = {
      name: p.nombre_template,
      language: p.idioma || 'es',
      category: 'UTILITY',
      components,
    };

    if (dry) {
      console.log(`\n— ${p.nombre_template} (${p.evento}):`);
      console.log(JSON.stringify(payload, null, 2));
      continue;
    }

    try {
      const { data } = await axios.post(
        `${GRAPH_BASE}/${cfg.waba_id}/message_templates`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${cfg.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
      console.log(`✅ ${p.nombre_template}: creada (id ${data?.id}, estado ${data?.status || 'PENDING'})`);
    } catch (e) {
      const msg = e?.response?.data?.error?.message || e.message;
      if (/already exists/i.test(msg)) {
        console.log(`↔️  ${p.nombre_template}: ya existía, nada que hacer.`);
      } else {
        console.error(`❌ ${p.nombre_template}: ${msg}`);
      }
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error('FALLO:', e.message);
  process.exit(1);
});
