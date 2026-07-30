'use strict';

/**
 * Verifica, para una o varias configuraciones, si el seguimiento de RETIRO EN
 * AGENCIA está completo de punta a punta.
 *
 *   node scripts/verificar_seguimiento_agencia.js 10 411 404
 *
 * Son 5 eslabones y basta que falte uno para que no salga ni un mensaje. Este
 * script existe porque el síntoma de que falte cualquiera es el mismo —
 * silencio— y sin esto hay que ir tabla por tabla adivinando cuál es.
 */

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');

const OK = '✅';
const NO = '❌';
const WARN = '⚠️ ';

async function verificar(id_configuracion) {
  console.log(`\n${'═'.repeat(66)}`);
  const [cfg] = await db.query(
    `SELECT id, nombre_configuracion, id_whatsapp, token, dias_retiro_agencia
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg) {
    console.log(`${NO} config ${id_configuracion} no existe`);
    return;
  }
  console.log(`CONFIG ${cfg.id} — ${cfg.nombre_configuracion}`);
  console.log('═'.repeat(66));

  let completo = true;

  // 1. La columna del kanban
  const [col] = await db.query(
    `SELECT id, nombre FROM kanban_columnas
      WHERE id_configuracion = ? AND estado_db = 'retiro_agencia' LIMIT 1`,
    { replacements: [cfg.id], type: db.QueryTypes.SELECT },
  );
  console.log(
    col
      ? `${OK} 1. Columna del tablero: "${col.nombre}"`
      : `${NO} 1. Falta la columna 'retiro_agencia' en el tablero`,
  );
  if (!col) completo = false;

  // 2. El estado de Dropi que mueve al cliente a esa columna
  const [est] = await db.query(
    `SELECT nombre_template, columna_destino, activo
       FROM dropi_plantillas_config
      WHERE id_configuracion = ? AND estado_dropi = 'RETIRO EN AGENCIA' LIMIT 1`,
    { replacements: [cfg.id], type: db.QueryTypes.SELECT },
  );
  if (!est) {
    console.log(`${NO} 2. Sin configuración para el estado RETIRO EN AGENCIA`);
    completo = false;
  } else if (!Number(est.activo)) {
    console.log(`${NO} 2. El estado RETIRO EN AGENCIA está APAGADO`);
    completo = false;
  } else if (est.columna_destino !== 'retiro_agencia') {
    console.log(
      `${WARN}2. El estado mueve a "${est.columna_destino}", no a 'retiro_agencia' → la secuencia no se agenda`,
    );
    completo = false;
  } else {
    console.log(`${OK} 2. Estado RETIRO EN AGENCIA activo → mueve a la columna`);
  }

  // 3. La secuencia de recordatorios
  const secs = await db.query(
    `SELECT secuencia, tiempo_espera_horas, tiempo_espera_minutos,
            nombre_template, metodo_dentro_24h, activo
       FROM configuracion_remarketing
      WHERE id_configuracion = ? AND estado_contacto = 'retiro_agencia'
      ORDER BY secuencia`,
    { replacements: [cfg.id], type: db.QueryTypes.SELECT },
  );
  if (!secs.length) {
    console.log(
      `${NO} 3. Sin secuencia de seguimiento (se instala con "Actualizar tablero")`,
    );
    completo = false;
  } else {
    const activas = secs.filter((s) => Number(s.activo) === 1);
    console.log(
      `${activas.length ? OK : NO} 3. Secuencia: ${secs.length} paso(s), ${activas.length} activo(s)`,
    );
    for (const s of secs) {
      const horas = s.tiempo_espera_horas || Math.round((s.tiempo_espera_minutos || 0) / 60);
      console.log(
        `      paso ${s.secuencia}: +${horas}h · ${s.nombre_template || '(sin plantilla)'} · dentro24h=${s.metodo_dentro_24h}${Number(s.activo) ? '' : ' [APAGADO]'}`,
      );
    }
    if (!activas.length) completo = false;
  }

  // 4. Las plantillas, aprobadas en Meta
  const nombres = [...new Set(secs.map((s) => s.nombre_template).filter(Boolean))];
  if (!nombres.length) {
    console.log(`${WARN}4. La secuencia no referencia ninguna plantilla`);
  } else if (!cfg.id_whatsapp || !cfg.token) {
    console.log(`${WARN}4. Sin credenciales de WhatsApp: no se puede verificar`);
  } else {
    try {
      const { data } = await axios.get(
        `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${cfg.id_whatsapp}/message_templates`,
        { params: { access_token: cfg.token, limit: 200, fields: 'name,status' } },
      );
      const porNombre = new Map((data.data || []).map((t) => [t.name, t.status]));
      let todas = true;
      for (const n of nombres) {
        const st = porNombre.get(n);
        const ok = st === 'APPROVED';
        if (!ok) todas = false;
        console.log(`   ${ok ? OK : NO} 4. ${n}: ${st || 'NO EXISTE en la WABA'}`);
      }
      if (!todas) completo = false;
    } catch (e) {
      console.log(`${WARN}4. No se pudo consultar Meta: ${e.message}`);
    }
  }

  // 5. Los días que se le comunican al cliente
  console.log(`${OK} 5. Plazo que se comunica: ${cfg.dias_retiro_agencia} días`);

  // 6. El asistente que cierra el seguimiento
  // Sin él la secuencia sale pero nadie lee la respuesta: el cliente contesta
  // "ya lo retiré" y al día siguiente le llega el mismo recordatorio.
  if (col) {
    const [colIA] = await db.query(
      `SELECT activa_ia, assistant_id FROM kanban_columnas WHERE id = ? LIMIT 1`,
      { replacements: [col.id], type: db.QueryTypes.SELECT },
    );
    const conIA = Number(colIA?.activa_ia) === 1 && !!colIA?.assistant_id;
    console.log(
      conIA
        ? `${OK} 6. Asistente de cierre activo (${colIA.assistant_id})`
        : `${NO} 6. La columna no tiene asistente (se instala con "Actualizar tablero")`,
    );
    if (!conIA) completo = false;

    const acc = await db.query(
      `SELECT config FROM kanban_acciones
        WHERE id_kanban_columna = ? AND tipo_accion = 'cambiar_estado' AND activo = 1`,
      { replacements: [col.id], type: db.QueryTypes.SELECT },
    );
    const cfgs = acc.map((a) => {
      let c = a.config;
      try {
        while (typeof c === 'string') c = JSON.parse(c);
      } catch {
        return {};
      }
      return c || {};
    });
    const buscar = (tag) =>
      cfgs.find((c) => String(c.trigger || '').includes(tag));

    const cierre = buscar('pedido_retirado');
    console.log(
      cierre
        ? `${OK} 6b. Acción de cierre configurada (mueve a "${cierre.estado_destino}" al confirmar el retiro)`
        : `${NO} 6b. Falta la acción que cierra el seguimiento al confirmar el retiro`,
    );
    if (!cierre) completo = false;

    const escalar = buscar('asesor');
    console.log(
      escalar
        ? `${OK} 6c. Escalado a asesor configurado (mueve a "${escalar.estado_destino}")`
        : `${NO} 6c. Falta la acción que pasa a un asesor las preguntas que el bot no debe contestar`,
    );
    if (!escalar) completo = false;

    // 7. Las columnas a donde el bot mueve el contacto tienen que existir.
    // Si no, lo deja en un estado sin columna: el bot dejará de responderle y la
    // tarjeta desaparece del tablero. Falla en silencio, así que se revisa aquí.
    const destinos = [
      ...new Set([cierre?.estado_destino, escalar?.estado_destino].filter(Boolean)),
    ];
    for (const d of destinos) {
      const [existe] = await db.query(
        `SELECT id FROM kanban_columnas
          WHERE id_configuracion = ? AND estado_db = ? AND activo = 1 LIMIT 1`,
        { replacements: [cfg.id, d], type: db.QueryTypes.SELECT },
      );
      console.log(
        existe
          ? `${OK} 7. Columna destino "${d}" existe`
          : `${NO} 7. NO existe la columna "${d}": el contacto quedaría en un estado sin columna`,
      );
      if (!existe) completo = false;
    }
  }

  // Evidencia real: gente que ya pasó por ahí
  const [uso] = await db.query(
    `SELECT COUNT(*) AS agendados,
            SUM(enviado = 1) AS enviados,
            SUM(cancelado = 1) AS cancelados,
            MAX(creado_en) AS ultimo
       FROM remarketing_pendientes
      WHERE id_configuracion = ? AND estado_contacto_origen = 'retiro_agencia'`,
    { replacements: [cfg.id], type: db.QueryTypes.SELECT },
  );
  console.log(
    `\n   Actividad: ${uso.agendados || 0} agendados · ${uso.enviados || 0} enviados · ${uso.cancelados || 0} cancelados${uso.ultimo ? ` · último ${uso.ultimo}` : ''}`,
  );

  const [enCol] = await db.query(
    `SELECT COUNT(*) AS n FROM clientes_chat_center
      WHERE id_configuracion = ? AND estado_contacto = 'retiro_agencia'
        AND deleted_at IS NULL`,
    { replacements: [cfg.id], type: db.QueryTypes.SELECT },
  );
  console.log(`   Contactos hoy en la columna: ${enCol.n}`);

  console.log(
    `\n   ${completo ? '✅ LISTO — la cadena está completa' : '⚠️  INCOMPLETO — revisa los ❌ de arriba'}`,
  );
}

(async () => {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  if (!ids.length) {
    console.log('Uso: node scripts/verificar_seguimiento_agencia.js 10 411 404');
    process.exit(1);
  }
  for (const id of ids) await verificar(id);
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
