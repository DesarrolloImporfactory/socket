/**
 * Simula lo que pasa DESPUÉS de una cita, sin esperar a que llegue el día.
 *
 * Adelanta el reloj de una cita real (la mueve al pasado), corre la misma lógica
 * del cron `seguimiento_citas` y muestra:
 *   - a qué columna se mueve la ficha,
 *   - el mensaje de seguimiento que le llegaría al cliente, generado con el
 *     prompt de remarketing de esa columna y el asistente real.
 *
 * NO manda ningún WhatsApp y deja todo como estaba al terminar.
 *
 * Uso:
 *   node scripts/simular_postcita.js <id_configuracion> <id_cliente>
 *   node scripts/simular_postcita.js 818 566217 --estado=Cancelado
 */

require('dotenv').config();
const axios = require('axios');
const moment = require('moment-timezone');
const { db } = require('../src/database/config');

const ID_CONFIG = Number(process.argv[2]);
const ID_CLIENTE = Number(process.argv[3]);
const argEstado = process.argv.find((a) => a.startsWith('--estado='));
const ESTADO_CITA = argEstado ? argEstado.split('=')[1] : 'Agendado';

if (!ID_CONFIG || !ID_CLIENTE) {
  console.error(
    'Uso: node scripts/simular_postcita.js <id_configuracion> <id_cliente> [--estado=Cancelado]',
  );
  process.exit(1);
}

async function main() {
  const [cfg] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );

  const headers = {
    Authorization: `Bearer ${cfg.api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  // La cita más próxima de este contacto: es la que se va a "hacer pasar".
  const [cita] = await db.query(
    `SELECT ap.id, ap.title, ap.start_utc, ap.end_utc, ap.status
       FROM appointments ap
       JOIN calendars cal ON cal.id = ap.calendar_id
       JOIN appointment_invitees inv ON inv.appointment_id = ap.id
       JOIN clientes_chat_center cli
         ON cli.celular_last9 = RIGHT(REGEXP_REPLACE(inv.phone, '[^0-9]', ''), 9)
      WHERE cal.account_id = ? AND cli.id = ?
      ORDER BY ap.start_utc DESC LIMIT 1`,
    { replacements: [ID_CONFIG, ID_CLIENTE], type: db.QueryTypes.SELECT },
  );

  if (!cita) {
    console.error(
      'Ese contacto no tiene ninguna cita en la agenda. Agenda una primero (o corre el guion "laser" del simulador de conversación).',
    );
    return;
  }

  const [contacto] = await db.query(
    `SELECT estado_contacto FROM clientes_chat_center WHERE id = ?`,
    { replacements: [ID_CLIENTE], type: db.QueryTypes.SELECT },
  );

  console.log(
    `Cita #${cita.id} "${cita.title}"\n` +
      `  estaba para: ${cita.start_utc} (UTC) · marca en agenda: ${cita.status}\n` +
      `  el contacto está en: "${contacto.estado_contacto}"\n`,
  );

  const original = { ...cita, estado_contacto: contacto.estado_contacto };

  /* Se la manda al pasado: terminó hace 95 minutos, o sea pasada la ventana de
     90 que espera el cron. */
  const finFalso = moment.utc().subtract(95, 'minutes');
  const inicioFalso = finFalso.clone().subtract(
    moment.utc(cita.end_utc).diff(moment.utc(cita.start_utc), 'minutes') || 60,
    'minutes',
  );

  await db.query(
    `UPDATE appointments SET start_utc = ?, end_utc = ?, status = ? WHERE id = ?`,
    {
      replacements: [
        inicioFalso.format('YYYY-MM-DD HH:mm:ss'),
        finFalso.format('YYYY-MM-DD HH:mm:ss'),
        ESTADO_CITA,
        cita.id,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );

  // El cron solo cierra citas de contactos que están en "cita_agendada".
  await db.query(
    `UPDATE clientes_chat_center SET estado_contacto = 'cita_agendada' WHERE id = ?`,
    { replacements: [ID_CLIENTE], type: db.QueryTypes.UPDATE },
  );

  console.log(
    `⏩ Reloj adelantado: la cita terminó hace 95 minutos con marca "${ESTADO_CITA}".\n`,
  );

  const { cerrarCitasPasadas } = require('../src/cron/seguimiento_citas');
  await cerrarCitasPasadas();

  const [despues] = await db.query(
    `SELECT estado_contacto FROM clientes_chat_center WHERE id = ?`,
    { replacements: [ID_CLIENTE], type: db.QueryTypes.SELECT },
  );
  console.log(`\n➡️  El contacto quedó en: "${despues.estado_contacto}"`);

  // ── El mensaje que le llegaría ──────────────────────────────────
  const [pendiente] = await db.query(
    `SELECT id, tiempo_disparo, prompt_ia, metodo_dentro_24h, nombre_template
       FROM remarketing_pendientes
      WHERE id_cliente_chat_center = ? AND enviado = 0 AND cancelado = 0
      ORDER BY id DESC LIMIT 1`,
    { replacements: [ID_CLIENTE], type: db.QueryTypes.SELECT },
  );

  if (!pendiente) {
    console.log(
      '\n⚠️  No quedó ningún seguimiento programado. Revisa que la columna tenga remarketing activo.',
    );
  } else {
    const espera = moment(pendiente.tiempo_disparo).diff(moment(), 'minutes');
    console.log(
      `\n📅 Seguimiento programado para ${moment(pendiente.tiempo_disparo).format('YYYY-MM-DD HH:mm')} ` +
        `(en ${espera} min) · método: ${pendiente.metodo_dentro_24h}`,
    );

    if (pendiente.prompt_ia) {
      const [col] = await db.query(
        `SELECT assistant_id, nombre FROM kanban_columnas
          WHERE id_configuracion = ? AND estado_db = ? AND activo = 1 LIMIT 1`,
        {
          replacements: [ID_CONFIG, despues.estado_contacto],
          type: db.QueryTypes.SELECT,
        },
      );

      const { data: th } = await axios.post(
        'https://api.openai.com/v1/threads',
        {},
        { headers },
      );
      await axios.post(
        `https://api.openai.com/v1/threads/${th.id}/messages`,
        {
          role: 'user',
          content: `[Resumen: la clienta tenía la cita "${cita.title}" y acaba de pasar.]`,
        },
        { headers },
      );

      const { data: run } = await axios.post(
        `https://api.openai.com/v1/threads/${th.id}/runs`,
        {
          assistant_id: col.assistant_id,
          additional_instructions: pendiente.prompt_ia,
          additional_messages: [
            {
              role: 'user',
              content:
                '[ACCIÓN INTERNA: GENERAR_REMARKETING] Sigue ESTRICTAMENTE las instrucciones de remarketing en additional_instructions. NO saludes de nuevo, NO te presentes, NO preguntes ciudad ni datos nuevos.',
            },
          ],
          max_completion_tokens: 400,
        },
        { headers, timeout: 90000 },
      );

      let estado = 'queued';
      let n = 0;
      while (!['completed', 'failed'].includes(estado) && n < 40) {
        await new Promise((r) => setTimeout(r, 1200));
        n += 1;
        const { data } = await axios.get(
          `https://api.openai.com/v1/threads/${th.id}/runs/${run.id}`,
          { headers },
        );
        estado = data.status;
      }

      const { data: msgs } = await axios.get(
        `https://api.openai.com/v1/threads/${th.id}/messages`,
        { headers },
      );
      const texto =
        msgs.data
          .reverse()
          .find((m) => m.role === 'assistant' && m.run_id === run.id)
          ?.content?.[0]?.text?.value || '(sin respuesta)';

      const {
        limpiarColetillas,
      } = require('../src/utils/limpiarColetillas');
      const { humanizarFechas } = require('../src/utils/humanizarFechas');
      const { limpiarMarkdown } = require('../src/utils/formatoWhatsapp');

      console.log(
        `\n💬 Mensaje que le llegaría (columna "${col.nombre}"):\n\n   ` +
          limpiarMarkdown(humanizarFechas(limpiarColetillas(texto))).replace(
            /\n/g,
            '\n   ',
          ),
      );

      /* Y la conversación sigue: se contesta ese mensaje en el MISMO hilo y con
         el asistente de la columna a la que acaba de llegar, que es lo que pasa
         en producción cuando la clienta responde el seguimiento. */
      const respuestas = process.argv
        .slice(4)
        .filter((a) => !a.startsWith('--'));

      if (respuestas.length) {
        const {
          construirContextoColumna,
        } = require('../src/utils/contextoColumna');
        const {
          dividirRespuestaIA,
        } = require('../src/utils/openia/dividirRespuestaIA');

        const acciones = await db.query(
          `SELECT tipo_accion, config FROM kanban_acciones a
             JOIN kanban_columnas c ON c.id = a.id_kanban_columna
            WHERE c.id_configuracion = ? AND c.estado_db = ? AND a.activo = 1`,
          {
            replacements: [ID_CONFIG, despues.estado_contacto],
            type: db.QueryTypes.SELECT,
          },
        );

        const TAGS = [
          '[cita_confirmada]:true',
          '[en_tratamiento]:true',
          '[plan_terminado]:true',
          '[no_asistio]:true',
          '[perdido]:true',
          '[asesor]:true',
          '[califica]:true',
        ];

        for (const respuesta of respuestas) {
          console.log(
            `\n${'─'.repeat(70)}\n🙍 CLIENTE responde: ${respuesta}\n`,
          );

          const ctx = await construirContextoColumna(ID_CONFIG, acciones, null, {
            mensaje: respuesta,
            id_cliente: ID_CLIENTE,
          });

          if (ctx.trim()) {
            await axios.post(
              `https://api.openai.com/v1/threads/${th.id}/messages`,
              { role: 'user', content: `🧾 Contexto adicional:\n\n${ctx.trim()}` },
              { headers },
            );
          }
          await axios.post(
            `https://api.openai.com/v1/threads/${th.id}/messages`,
            { role: 'user', content: respuesta },
            { headers },
          );

          const { data: r2 } = await axios.post(
            `https://api.openai.com/v1/threads/${th.id}/runs`,
            { assistant_id: col.assistant_id, max_completion_tokens: 700 },
            { headers, timeout: 90000 },
          );

          let e2 = 'queued';
          let k = 0;
          while (!['completed', 'failed'].includes(e2) && k < 40) {
            await new Promise((r) => setTimeout(r, 1200));
            k += 1;
            const { data } = await axios.get(
              `https://api.openai.com/v1/threads/${th.id}/runs/${r2.id}`,
              { headers },
            );
            e2 = data.status;
          }

          const { data: m2 } = await axios.get(
            `https://api.openai.com/v1/threads/${th.id}/messages`,
            { headers },
          );
          const cruda =
            m2.data
              .reverse()
              .find((m) => m.role === 'assistant' && m.run_id === r2.id)
              ?.content?.[0]?.text?.value || '(sin respuesta)';

          const tags = TAGS.filter((t) =>
            cruda.toLowerCase().includes(t.toLowerCase()),
          );
          let limpio = cruda;
          for (const t of TAGS) limpio = limpio.split(t).join('');
          limpio = limpiarMarkdown(
            humanizarFechas(limpiarColetillas(limpio.trim())),
          );

          const partes = dividirRespuestaIA(limpio);
          console.log(`🤖 [${col.nombre}] → ${partes.length} mensaje(s)`);
          partes.forEach((p, i) =>
            console.log(`   ${i + 1}│ ${p.replace(/\n/g, '\n    │ ')}`),
          );
          console.log(
            `   ▸ tags: ${tags.length ? tags.join(', ') : 'ninguno'}`,
          );
        }
      }
    }
  }

  // ── Dejar todo como estaba ──────────────────────────────────────
  await db.query(
    `UPDATE appointments SET start_utc = ?, end_utc = ?, status = ? WHERE id = ?`,
    {
      replacements: [
        original.start_utc,
        original.end_utc,
        original.status,
        original.id,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );
  await db.query(
    `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
    { replacements: [original.estado_contacto, ID_CLIENTE], type: db.QueryTypes.UPDATE },
  );
  if (pendiente) {
    await db.query(
      `UPDATE remarketing_pendientes SET cancelado = 1 WHERE id = ?`,
      { replacements: [pendiente.id], type: db.QueryTypes.UPDATE },
    );
  }

  console.log(
    `\n(todo restaurado: la cita volvió a ${original.start_utc}, el contacto a "${original.estado_contacto}" y el seguimiento de prueba quedó cancelado)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
