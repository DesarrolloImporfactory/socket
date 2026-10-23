/* ════════════════════════════════════════════════════════════════════════
   marcarLlavesInvalidas.js — cuentas cuyo bot lleva horas mudo por una API
   Key de OpenAI revocada, marcadas como la marcaría el motor.

   POR QUÉ: hasta el 2026-10-23 una llave inválida no apagaba la cuenta
   (openai_activo seguía en 1): solo quedaba el cartel "Incorrect API key" en
   el chat y /conexiones decía "Servicios al día". El motor nuevo sí la apaga,
   pero recién con el PRÓXIMO mensaje de un cliente. Este script hace ese
   trabajo hoy para las cuentas que ya están fallando, sin esperar.

   QUÉ HACE: busca cuentas con carteles del sistema por llave inválida en las
   últimas N horas, prueba cada llave EN VIVO contra OpenAI (GET /v1/models,
   no gasta tokens) y solo marca las que OpenAI rechaza con 401. Si la llave
   responde, no toca nada (el dueño ya la cambió).

   USO:
     node scripts/marcarLlavesInvalidas.js            → solo muestra (dry run)
     node scripts/marcarLlavesInvalidas.js --aplicar  → marca openai_activo=0
     --horas=48                                       → ventana (24 por defecto)
   ════════════════════════════════════════════════════════════════════════ */
require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');
const { leerApiKeyOpenAI } = require('../src/utils/openia/apiKeyOpenAI');

const APLICAR = process.argv.includes('--aplicar');
const HORAS = Number(
  (process.argv.find((a) => a.startsWith('--horas=')) || '').split('=')[1],
) || 24;

async function probarLlave(key) {
  try {
    await axios.get('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 15000,
    });
    return { ok: true };
  } catch (e) {
    const status = e?.response?.status;
    const msg = e?.response?.data?.error?.message || e.message;
    return { ok: false, status, msg };
  }
}

(async () => {
  const cuentas = await db.query(
    `SELECT c.id, c.nombre_configuracion, c.api_key_openai, c.openai_activo,
            COUNT(*) carteles, MAX(m.created_at) ultimo
       FROM mensajes_clientes m
       JOIN configuraciones c ON c.id = m.id_configuracion
      WHERE m.responsable = 'sistema_ia'
        AND m.created_at >= NOW() - INTERVAL :horas HOUR
        AND (m.texto_mensaje LIKE '%Incorrect API key%'
             OR m.texto_mensaje LIKE '%invalid_api_key%')
        AND c.openai_activo = 1
      GROUP BY c.id
      ORDER BY ultimo DESC`,
    { replacements: { horas: HORAS }, type: db.QueryTypes.SELECT },
  );

  console.log(
    `${cuentas.length} cuenta(s) con carteles de llave inválida en ${HORAS} h y openai_activo=1` +
      (APLICAR ? ' · APLICANDO' : ' · dry run (agrega --aplicar para marcar)'),
  );

  let marcadas = 0;
  for (const c of cuentas) {
    const key = leerApiKeyOpenAI(c.api_key_openai);
    if (!key) {
      console.log(`  cfg ${c.id} ${c.nombre_configuracion}: sin llave guardada, se omite`);
      continue;
    }
    const r = await probarLlave(key);
    if (r.ok) {
      console.log(`  cfg ${c.id} ${c.nombre_configuracion}: la llave YA responde, no se toca`);
      continue;
    }
    if (r.status !== 401) {
      console.log(`  cfg ${c.id} ${c.nombre_configuracion}: OpenAI devolvió ${r.status || '?'} (${r.msg}); no es llave, se omite`);
      continue;
    }
    const motivo = `API Key de OpenAI inválida o revocada: ${String(r.msg).replace(/\s+/g, ' ').slice(0, 300)}`;
    console.log(
      `  cfg ${c.id} ${c.nombre_configuracion}: 401 confirmado · ${c.carteles} carteles, último ${c.ultimo}` +
        (APLICAR ? ' → marcada' : ''),
    );
    if (APLICAR) {
      await db.query(
        `UPDATE configuraciones
            SET openai_activo = 0, openai_error_at = NOW(), openai_error_msg = ?
          WHERE id = ? AND openai_activo = 1`,
        { replacements: [motivo, c.id], type: db.QueryTypes.UPDATE },
      );
      marcadas++;
    }
  }
  if (APLICAR) console.log(`${marcadas} cuenta(s) marcada(s).`);
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
