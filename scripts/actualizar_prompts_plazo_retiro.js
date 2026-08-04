'use strict';

/**
 * Pone el placeholder {{PLAZO_RETIRO}} en los prompts de la secuencia de retiro
 * en agencia que ya están guardados en configuracion_remarketing.
 *
 *   node scripts/actualizar_prompts_plazo_retiro.js            → simulación
 *   node scripts/actualizar_prompts_plazo_retiro.js --aplicar  → escribe
 *
 * Por qué hace falta: el catálogo (utils/kanban_catalogo.data.js) solo se lee
 * al instalar o reinstalar el tablero. Las cuentas que ya tenían la secuencia
 * conservan el prompt viejo, que le prohibía a la IA nombrar el plazo ("NO
 * inventes el número de días"). Con el placeholder, el cron lo reemplaza en
 * cada envío por el valor de configuraciones.dias_retiro_agencia, así que los
 * tres recordatorios y el bot dicen el mismo número.
 *
 * Solo toca prompts que coinciden EXACTAMENTE con el texto que instaló el
 * catálogo. Si el cliente lo editó, se lo salta y lo reporta: su versión manda.
 */

require('dotenv').config();
const { db } = require('../src/database/config');

const APLICAR = process.argv.includes('--aplicar');

/* Líneas viejas → nuevas. Son las del catálogo antes de este cambio; se
   comparan enteras para no pisar un prompt personalizado que solo se parezca. */
const REEMPLAZOS = [
  {
    de: '- NO inventes el número de días: si no aparece en la conversación, habla de "un tiempo limitado"',
    a: '- El plazo de retiro que comunicamos es: {{PLAZO_RETIRO}}. Usa ESE plazo y ningún otro — el cron lo reemplaza por el que configuró la tienda, que no siempre es el que da la transportadora',
  },
  {
    de: '- Tuteo natural LATAM, cero presión agresiva',
    a: '- Tuteo natural LATAM, cero presión agresiva\n- El plazo de retiro que comunicamos es: {{PLAZO_RETIRO}}. Usa ESE plazo y ningún otro',
  },
];

(async () => {
  const filas = await db.query(
    `SELECT id, id_configuracion, secuencia, prompt_ia
       FROM configuracion_remarketing
      WHERE estado_contacto = 'retiro_agencia'
        AND prompt_ia IS NOT NULL
        AND prompt_ia <> ''
      ORDER BY id_configuracion, secuencia`,
    { type: db.QueryTypes.SELECT },
  );

  let actualizadas = 0;
  let yaListas = 0;
  let personalizadas = 0;

  for (const f of filas) {
    const original = String(f.prompt_ia);

    if (original.includes('{{PLAZO_RETIRO}}')) {
      yaListas++;
      continue;
    }

    let nuevo = original;
    for (const r of REEMPLAZOS) {
      if (nuevo.includes(r.de)) nuevo = nuevo.split(r.de).join(r.a);
    }

    if (nuevo === original) {
      // El k1 nunca habló del plazo (solo pregunta si ya retiró), así que aquí
      // caen tanto ese caso normal como un prompt que el cliente reescribió.
      // En los dos la acción es la misma: no tocarlo.
      personalizadas++;
      console.log(
        `  ⏭️  cfg ${f.id_configuracion} sec ${f.secuencia}: no menciona el plazo, se deja igual`,
      );
      continue;
    }

    actualizadas++;
    console.log(
      `  ${APLICAR ? '✏️ ' : '👀'} cfg ${f.id_configuracion} sec ${f.secuencia}: se agrega el plazo`,
    );

    if (APLICAR) {
      await db.query(
        `UPDATE configuracion_remarketing SET prompt_ia = ? WHERE id = ?`,
        { replacements: [nuevo, f.id], type: db.QueryTypes.UPDATE },
      );
    }
  }

  console.log(
    `\n${APLICAR ? 'APLICADO' : 'SIMULACIÓN (usa --aplicar para escribir)'}\n` +
      `  filas revisadas:      ${filas.length}\n` +
      `  a actualizar:         ${actualizadas}\n` +
      `  ya tenían el plazo:   ${yaListas}\n` +
      `  sin línea de plazo:   ${personalizadas}  (k1 y prompts reescritos)`,
  );

  await db.close();
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  try {
    await db.close();
  } catch (_) {}
  process.exit(1);
});
