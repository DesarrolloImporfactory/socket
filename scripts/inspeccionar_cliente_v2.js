// scripts/inspeccionar_cliente_v2.js
// Lee toda la info necesaria para probar Kanban IA V2 desde Postman
// para un id_cliente concreto. Solo lectura.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/database/config');

(async () => {
  const idCliente = Number(process.argv[2]);
  if (!idCliente) {
    console.error('Uso: node scripts/inspeccionar_cliente_v2.js <id_cliente>');
    process.exit(1);
  }

  try {
    // 1. Cliente
    const [cliente] = await db.query(
      `SELECT id, id_configuracion, celular_cliente AS telefono, uid_cliente,
              nombre_cliente, estado_contacto, ultimo_mensaje_at, bot_openia,
              ultimo_texto, propietario
       FROM   clientes_chat_center
       WHERE  id = ? LIMIT 1`,
      { replacements: [idCliente], type: db.QueryTypes.SELECT },
    );

    if (!cliente) {
      console.error(`No existe clientes_chat_center.id = ${idCliente}`);
      process.exit(1);
    }

    // 2. Configuracion (api_key, telefono WA, etc.)
    const [config] = await db.query(
      `SELECT id, telefono, id_telefono AS business_phone_id, id_whatsapp,
              api_key_openai, openai_activo,
              token AS accessToken
       FROM   configuraciones
       WHERE  id = ? LIMIT 1`,
      { replacements: [cliente.id_configuracion], type: db.QueryTypes.SELECT },
    );

    // 3. Columna activa para ese estado
    const [columna] = await db.query(
      `SELECT id, nombre, estado_db, assistant_id, vector_store_id,
              activa_ia, max_tokens, activo
       FROM   kanban_columnas
       WHERE  id_configuracion = ?
         AND  LOWER(estado_db) = LOWER(?)
         AND  activo = 1
       LIMIT 1`,
      {
        replacements: [cliente.id_configuracion, cliente.estado_contacto],
        type: db.QueryTypes.SELECT,
      },
    );

    // 4. Todas las columnas de esa configuracion (para ver opciones)
    const columnas = await db.query(
      `SELECT id, nombre, estado_db, activa_ia, assistant_id
       FROM   kanban_columnas
       WHERE  id_configuracion = ? AND activo = 1
       ORDER  BY orden ASC`,
      { replacements: [cliente.id_configuracion], type: db.QueryTypes.SELECT },
    );

    // 5. Acciones configuradas para la columna activa (V1)
    let acciones = [];
    if (columna?.id) {
      acciones = await db.query(
        `SELECT id, tipo_accion, config, orden, activo
         FROM   kanban_acciones
         WHERE  id_kanban_columna = ?
         ORDER  BY orden ASC`,
        { replacements: [columna.id], type: db.QueryTypes.SELECT },
      );
    }

    // 6. ¿La tabla V2 existe? ¿Hay config V2 para esta columna?
    let v2Existe = false;
    let v2Config = null;
    try {
      const [check] = await db.query(
        `SELECT COUNT(*) AS c FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = 'kanban_columnas_v2_schemas'`,
        { type: db.QueryTypes.SELECT },
      );
      v2Existe = Number(check.c) > 0;
      if (v2Existe && columna?.id) {
        const [row] = await db.query(
          `SELECT id, response_schema, accion_map, modelo, activo
           FROM   kanban_columnas_v2_schemas
           WHERE  id_kanban_columna = ? LIMIT 1`,
          { replacements: [columna.id], type: db.QueryTypes.SELECT },
        );
        v2Config = row || null;
      }
    } catch (e) {
      v2Existe = false;
    }

    // ─── Salida ─────────────────────────────────────────────
    const safe = (s, n = 6) =>
      s ? `${String(s).slice(0, n)}...(${String(s).length} chars)` : null;

    console.log('\n══════ CLIENTE ══════');
    console.log({
      id: cliente.id,
      id_configuracion: cliente.id_configuracion,
      telefono: cliente.telefono,
      uid_cliente: cliente.uid_cliente,
      nombre_cliente: cliente.nombre_cliente,
      estado_contacto: cliente.estado_contacto,
      bot_openia: cliente.bot_openia,
      propietario: cliente.propietario,
      ultimo_mensaje_at: cliente.ultimo_mensaje_at,
      ultimo_texto: cliente.ultimo_texto?.slice(0, 80),
    });

    console.log('\n══════ CONFIGURACION ══════');
    console.log({
      id_configuracion: config?.id,
      telefono_wa: config?.telefono,
      business_phone_id: config?.business_phone_id,
      id_whatsapp: config?.id_whatsapp,
      api_key_openai: safe(config?.api_key_openai, 10),
      accessToken: safe(config?.accessToken, 12),
      openai_activo: config?.openai_activo,
    });

    console.log('\n══════ COLUMNA ACTIVA (estado_contacto = ' + cliente.estado_contacto + ') ══════');
    if (columna) {
      console.log({
        id: columna.id,
        nombre: columna.nombre,
        estado_db: columna.estado_db,
        activa_ia: columna.activa_ia,
        assistant_id: columna.assistant_id,
        vector_store_id: columna.vector_store_id,
        max_tokens: columna.max_tokens,
      });
    } else {
      console.log('  >>> NO HAY columna activa para este estado <<<');
    }

    console.log('\n══════ TODAS LAS COLUMNAS (id_configuracion=' + cliente.id_configuracion + ') ══════');
    columnas.forEach((c) =>
      console.log(`  - id=${c.id} estado_db="${c.estado_db}" nombre="${c.nombre}" activa_ia=${c.activa_ia} assistant=${c.assistant_id ? 'si' : 'no'}`),
    );

    console.log('\n══════ ACCIONES V1 DE LA COLUMNA ACTIVA ══════');
    if (acciones.length === 0) console.log('  (ninguna)');
    acciones.forEach((a) =>
      console.log(`  - tipo=${a.tipo_accion} orden=${a.orden} activo=${a.activo} config=${a.config?.slice?.(0, 120) || a.config}`),
    );

    console.log('\n══════ TABLAS V2 ══════');
    console.log(`  kanban_columnas_v2_schemas existe: ${v2Existe ? 'SI' : 'NO  ←  hay que correr la migration'}`);
    console.log(`  V2 config para columna ${columna?.id || '(sin columna)'}: ${v2Config ? 'SI (activo=' + v2Config.activo + ')' : 'NO'}`);

    console.log('\n══════ BODY LISTO PARA POSTMAN ══════');
    console.log('POST /api/v1/kanban_ia_v2/config/usar_seed_sara');
    console.log(JSON.stringify({
      id_configuracion: cliente.id_configuracion,
      id_kanban_columna: columna?.id || null,
    }, null, 2));

    console.log('\nPOST /api/v1/kanban_ia_v2/probar');
    console.log(JSON.stringify({
      id_configuracion: cliente.id_configuracion,
      id_cliente: cliente.id,
      telefono: cliente.telefono,
      mensaje: 'Hola quiero las zapatillas',
      estado_contacto: cliente.estado_contacto,
      business_phone_id: config?.business_phone_id,
      accessToken: config?.accessToken,
    }, null, 2));

    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.original) console.error('SQL:', err.original.sqlMessage || err.original.message);
    process.exit(1);
  }
})();
