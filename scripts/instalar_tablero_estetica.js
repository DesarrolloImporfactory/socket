'use strict';

/**
 * Instala el tablero de CENTRO DE BELLEZA / ESTÉTICA en una configuración.
 *
 *   node scripts/instalar_tablero_estetica.js 838 --tienda "Bella Piel" --asistente "Sofía"
 *   node scripts/instalar_tablero_estetica.js 838 --tienda "Bella Piel" --asistente "Sofía" --aplicar
 *
 * Crear la conexión primero (solo si hace falta):
 *   node scripts/instalar_tablero_estetica.js --crear-conexion --usuario 1178 \
 *        --nombre "Centro de Belleza" --telefono 5939XXXXXXX --aplicar
 *
 * Simula por defecto: imprime qué haría y no escribe nada.
 *
 * Instala, en este orden:
 *   1. calendario interno (lo exige agendar_cita: sin una fila en `calendars`
 *      con account_id = la config, la cita no se crea y falla en silencio)
 *   2. columnas + su asistente en OpenAI (con la api_key de ESA cuenta)
 *   3. acciones de cada columna (los tags que mueven la tarjeta y agendan)
 *   4. personalización + snapshot del prompt base
 *   5. secuencias de remarketing por columna
 *
 * Es idempotente: lo que ya existe se respeta y se informa. Para reescribir el
 * prompt de una columna que ya tiene asistente, usa --actualizar-prompts.
 */

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');
const {
  COLUMNAS_ESTETICA,
  REMARKETING_ESTETICA,
} = require('../src/utils/kanban_catalogo_estetica.data');
const { compilarPromptFinal } = require('../src/utils/promptCompiler');

const OK = '✅';
const NO = '❌';
const WARN = '⚠️ ';
const SIN_CAMBIO = '·';

const arg = (nombre, def = null) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const flag = (nombre) => process.argv.includes(`--${nombre}`);

/* ── Alta de conexión ──────────────────────────────────────────
   Réplica del insert de configuraciones.controller (agregar conexión): mismos
   campos y la misma regla de unicidad de teléfono, que existe porque el webhook
   enruta por número y dos conexiones activas con el mismo número mandan los
   mensajes a la equivocada. */
async function crearConexion({ id_usuario, nombre, telefono, aplicar }) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!id_usuario || !nombre || !tel) {
    console.log(`${NO} para crear la conexión: --usuario --nombre --telefono`);
    return null;
  }

  const enUso = await db.query(
    `SELECT id, id_usuario FROM configuraciones
      WHERE suspendido = 0 AND telefono = ? LIMIT 1`,
    { replacements: [tel], type: db.QueryTypes.SELECT },
  );
  if (enUso.length) {
    console.log(
      `${NO} el teléfono ${tel} ya lo usa la conexión ${enUso[0].id} (usuario ${enUso[0].id_usuario})`,
    );
    return null;
  }

  console.log(`+ conexión nueva "${nombre}" · tel ${tel} · usuario ${id_usuario}`);
  if (!aplicar) return null;

  const key = `key_${Date.now().toString(36)}${Math.round(process.hrtime()[1] / 1000).toString(36)}`;
  const [id] = await db.query(
    `INSERT INTO configuraciones
       (id_usuario, nombre_configuracion, telefono, key_imporsuit, pais,
        tipo_configuracion, created_at)
     VALUES (?, ?, ?, ?, 'ec', 'kanban', NOW())`,
    {
      replacements: [id_usuario, nombre, tel, key],
      type: db.QueryTypes.INSERT,
    },
  );
  console.log(`   ${OK} conexión creada con id ${id}`);
  return id;
}

async function asegurarCalendario({ id_configuracion, nombre, aplicar }) {
  const [cal] = await db.query(
    `SELECT id, name FROM calendars WHERE account_id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (cal) {
    console.log(`${SIN_CAMBIO} calendario: ya existe (${cal.id} — "${cal.name}")`);
    return cal.id;
  }

  console.log(`+ calendario interno "${nombre}" (lo exige agendar_cita)`);
  if (!aplicar) return null;

  const [id] = await db.query(
    `INSERT INTO calendars
       (account_id, name, time_zone, color_hex, is_active, created_at, updated_at)
     VALUES (?, ?, 'America/Guayaquil', '#6366F1', 1, NOW(), NOW())`,
    { replacements: [id_configuracion, nombre], type: db.QueryTypes.INSERT },
  );
  console.log(`   ${OK} calendario creado con id ${id}`);
  return id;
}

async function crearAsistente({ col, prompt, api_key, tienda }) {
  const { data } = await axios.post(
    'https://api.openai.com/v1/assistants',
    {
      name: tienda ? `${col.nombre} - ${tienda}` : col.nombre,
      instructions: prompt,
      model: col.modelo || 'gpt-4o-mini',
      tools: [{ type: 'file_search' }],
    },
    {
      headers: {
        Authorization: `Bearer ${api_key}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2',
      },
      timeout: 20000,
    },
  );
  return data?.id || null;
}

async function instalarColumnas({ cfg, perso, aplicar, actualizarPrompts }) {
  const existentes = await db.query(
    `SELECT id, nombre, estado_db, activa_ia, assistant_id
       FROM kanban_columnas WHERE id_configuracion = ?`,
    { replacements: [cfg.id], type: db.QueryTypes.SELECT },
  );
  const porEstado = new Map(
    existentes.map((c) => [String(c.estado_db).toLowerCase(), c]),
  );

  for (const col of COLUMNAS_ESTETICA) {
    const ya = porEstado.get(col.estado_db);
    const prompt = col.instrucciones
      ? compilarPromptFinal(col.instrucciones, perso)
      : null;

    if (!ya) {
      console.log(
        `+ columna "${col.nombre}" (${col.estado_db})${col.activa_ia ? ` · asistente ${prompt.length} chars` : ' · sin IA'} · ${col.acciones.length} acción(es)`,
      );
      if (!aplicar) continue;

      let assistant_id = null;
      if (col.activa_ia && prompt) {
        assistant_id = await crearAsistente({
          col,
          prompt,
          api_key: cfg.api_key_openai,
          tienda: perso.nombre_tienda,
        });
      }

      const [idCol] = await db.query(
        `INSERT INTO kanban_columnas
           (id_configuracion, nombre, estado_db, color_fondo, color_texto,
            icono, orden, activo, es_estado_final, es_principal,
            es_dropi_principal, activa_ia, max_tokens, instrucciones, modelo,
            assistant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        {
          replacements: [
            cfg.id,
            col.nombre,
            col.estado_db,
            col.color_fondo,
            col.color_texto,
            col.icono,
            col.orden,
            col.activo,
            col.es_estado_final,
            col.es_principal,
            col.es_dropi_principal,
            col.activa_ia,
            col.max_tokens,
            prompt,
            col.modelo,
            assistant_id,
          ],
          type: db.QueryTypes.INSERT,
        },
      );

      await insertarAcciones(idCol, cfg.id, col.acciones);
      await guardarSnapshot(idCol, cfg.id, perso.nombre_tienda, col.instrucciones);
      console.log(`   ${OK} columna ${idCol}${assistant_id ? ` · ${assistant_id}` : ''}`);
      continue;
    }

    // Ya existe: solo se completan las acciones que falten, y el prompt únicamente
    // si se pide explícitamente (puede haberlo ajustado alguien a mano).
    const faltan = await accionesFaltantes(ya.id, col.acciones);
    if (faltan.length) {
      console.log(
        `~ columna "${col.nombre}": faltan ${faltan.length} acción(es) → ${faltan.map((a) => a.config.trigger || a.tipo_accion).join(', ')}`,
      );
      if (aplicar) await insertarAcciones(ya.id, cfg.id, faltan);
    }

    if (actualizarPrompts && col.instrucciones && ya.assistant_id) {
      console.log(`~ columna "${col.nombre}": actualizando prompt del asistente`);
      if (aplicar) {
        await axios.post(
          `https://api.openai.com/v1/assistants/${ya.assistant_id}`,
          { instructions: prompt },
          {
            headers: {
              Authorization: `Bearer ${cfg.api_key_openai}`,
              'Content-Type': 'application/json',
              'OpenAI-Beta': 'assistants=v2',
            },
            timeout: 20000,
          },
        );
        await db.query(
          `UPDATE kanban_columnas SET instrucciones = ? WHERE id = ?`,
          { replacements: [prompt, ya.id], type: db.QueryTypes.UPDATE },
        );
        await guardarSnapshot(ya.id, cfg.id, perso.nombre_tienda, col.instrucciones);
      }
    }

    if (!faltan.length && !actualizarPrompts) {
      console.log(`${SIN_CAMBIO} columna "${col.nombre}": ya está`);
    }
  }
}

async function accionesFaltantes(idCol, esperadas) {
  const filas = await db.query(
    `SELECT tipo_accion, config FROM kanban_acciones WHERE id_kanban_columna = ?`,
    { replacements: [idCol], type: db.QueryTypes.SELECT },
  );
  const clave = (tipo, cfg) => {
    let c = cfg;
    try {
      while (typeof c === 'string') c = JSON.parse(c);
    } catch {
      c = {};
    }
    return `${tipo}|${c?.trigger || ''}|${c?.estado_destino || ''}`;
  };
  const ya = new Set(filas.map((f) => clave(f.tipo_accion, f.config)));
  return esperadas.filter((a) => !ya.has(clave(a.tipo_accion, a.config)));
}

async function insertarAcciones(idCol, id_configuracion, acciones) {
  for (const a of acciones || []) {
    await db.query(
      `INSERT INTO kanban_acciones
         (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
       VALUES (?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          idCol,
          id_configuracion,
          a.tipo_accion,
          JSON.stringify(a.config || {}),
          a.activo ?? 1,
          a.orden ?? null,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }
}

/* El snapshot guarda el prompt BASE sin compilar: es lo que se vuelve a
   compilar cuando el cliente cambia el nombre de su centro o su tono. */
async function guardarSnapshot(idCol, id_configuracion, nombreTienda, promptBase) {
  const [existe] = await db.query(
    `SELECT id FROM kanban_columnas_personalizaciones
      WHERE id_kanban_columna = ? LIMIT 1`,
    { replacements: [idCol], type: db.QueryTypes.SELECT },
  );
  if (existe) {
    await db.query(
      `UPDATE kanban_columnas_personalizaciones
          SET prompt_base_snapshot = ?, nombre_tienda = ?
        WHERE id_kanban_columna = ?`,
      {
        replacements: [promptBase, nombreTienda, idCol],
        type: db.QueryTypes.UPDATE,
      },
    );
  } else {
    await db.query(
      `INSERT INTO kanban_columnas_personalizaciones
         (id_kanban_columna, id_configuracion, nombre_tienda, prompt_base_snapshot)
       VALUES (?, ?, ?, ?)`,
      {
        replacements: [idCol, id_configuracion, nombreTienda, promptBase],
        type: db.QueryTypes.INSERT,
      },
    );
  }
}

/* Textos de las plantillas que el tablero necesita fuera de la ventana de 24h.
   Sin variables a propósito: el motor de remarketing solo manda parámetros si
   quien programó el envío se los pasó, y en este flujo nadie lo hace — una
   plantilla con {{1}} y cero parámetros la rechaza Meta con 132000, en silencio.
   Meta tampoco acepta que el cuerpo empiece o termine con emoji. */
const PLANTILLAS_META = {
  seguimiento_post_cita: {
    texto:
      'Hola, esperamos que te haya ido muy bien en tu visita 💖 Cuéntanos cómo te ' +
      'sentiste, tu opinión nos ayuda a seguir cuidándote 😊 Escríbenos por aquí ' +
      'cuando quieras.',
  },
  reagendar_cita_estetica: {
    texto:
      'Hola, vimos que no alcanzamos a verte en tu cita 😊 Si quieres, buscamos ' +
      'juntos un nuevo espacio que te acomode mejor 💖 Escríbenos y lo coordinamos.',
  },
  /* El recordatorio SÍ lleva variables, y son exactamente las cuatro que manda
     aviso_calendarios: nombre, servicio, hora y dónde. Si ese orden o esa
     cantidad cambian, Meta tumba el envío entero con 132000. */
  recordatorio_cita: {
    texto:
      'Hola {{1}}, te recordamos tu cita de {{2}} hoy a las {{3}} ⏰ Te esperamos ' +
      'aquí: {{4}} 💖 Si necesitas moverla, escríbenos por este medio.',
    ejemplo: [
      'Ana',
      'Limpieza facial profunda',
      '15:00',
      'https://maps.app.goo.gl/ejemplo',
    ],
    // Es la que lee el cron de recordatorios desde configuraciones.
    campo_configuracion: 'template_notificar_calendario',
  },
};

const empiezaOTerminaConEmoji = (t) => {
  const s = String(t).trim();
  const esEmoji = (ch) => /\p{Extended_Pictographic}/u.test(ch || '');
  const chars = [...s];
  return esEmoji(chars[0]) || esEmoji(chars[chars.length - 1]);
};

/**
 * Deja listas en la WABA de la cuenta las plantillas que usa el tablero.
 * Devuelve el Set de nombres utilizables (aprobadas o en revisión).
 *
 * Existe porque las plantillas viven en cada WABA, no en nuestra base: escribir
 * el nombre en configuracion_remarketing sin que exista allá haría que el envío
 * falle contra Meta en vez de cancelarse limpio.
 */
async function asegurarPlantillasMeta({ cfg, aplicar }) {
  const usables = new Set();

  const [waba] = await db.query(
    `SELECT id_whatsapp, token FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [cfg.id], type: db.QueryTypes.SELECT },
  );

  if (!waba?.id_whatsapp || !waba?.token) {
    console.log(
      `${WARN}sin WhatsApp conectado: no se crean plantillas. Los seguimientos ` +
        `posteriores a 24h no saldrán hasta conectarlo y volver a correr esto.`,
    );
    return usables;
  }

  let existentes = [];
  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${waba.id_whatsapp}/message_templates?limit=200`,
      { headers: { Authorization: `Bearer ${waba.token}` }, timeout: 20000 },
    );
    existentes = data?.data || [];
  } catch (e) {
    console.log(
      `${WARN}no se pudo leer las plantillas de Meta: ${e.response?.data?.error?.message || e.message}`,
    );
    return usables;
  }

  /* La deja apuntada en configuraciones para el cron que la consume. */
  const apuntarEnConfig = async (def, nombre) => {
    if (!def.campo_configuracion || !aplicar) return;
    await db.query(
      `UPDATE configuraciones SET ${def.campo_configuracion} = ? WHERE id = ?`,
      { replacements: [nombre, cfg.id], type: db.QueryTypes.UPDATE },
    );
  };

  for (const [nombre, def] of Object.entries(PLANTILLAS_META)) {
    const ya = existentes.find((t) => t.name === nombre);
    if (ya) {
      // REJECTED no sirve: hay que corregirla a mano en el administrador de Meta.
      if (ya.status === 'REJECTED') {
        console.log(`${NO} plantilla "${nombre}": RECHAZADA por Meta`);
      } else {
        console.log(`${SIN_CAMBIO} plantilla "${nombre}": ya existe (${ya.status})`);
        usables.add(nombre);
        await apuntarEnConfig(def, nombre);
      }
      continue;
    }

    if (empiezaOTerminaConEmoji(def.texto)) {
      console.log(`${NO} plantilla "${nombre}": empieza o termina con emoji`);
      continue;
    }

    console.log(`+ plantilla "${nombre}" → se crea en Meta`);
    if (!aplicar) continue;

    const body = { type: 'BODY', text: def.texto };
    // Meta exige un ejemplo para cada variable, si no rechaza la creación.
    if (def.ejemplo) body.example = { body_text: [def.ejemplo] };

    const r = await axios.post(
      `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${waba.id_whatsapp}/message_templates`,
      {
        name: nombre,
        language: 'es',
        category: 'UTILITY',
        components: [body],
      },
      {
        headers: {
          Authorization: `Bearer ${waba.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
        validateStatus: () => true,
      },
    );

    if (r.status >= 200 && r.status < 300) {
      console.log(`   ${OK} enviada a revisión (${r.data?.status || 'PENDING'})`);
      usables.add(nombre);
      await apuntarEnConfig(def, nombre);
    } else {
      console.log(
        `   ${NO} Meta la rechazó: ${JSON.stringify(r.data?.error?.message || r.data).slice(0, 160)}`,
      );
    }
  }

  return usables;
}

async function instalarRemarketing({ id_configuracion, aplicar, plantillas }) {
  for (const bloque of REMARKETING_ESTETICA) {
    const [tiene] = await db.query(
      `SELECT 1 AS x FROM configuracion_remarketing
        WHERE id_configuracion = ? AND estado_contacto = ? LIMIT 1`,
      {
        replacements: [id_configuracion, bloque.estado_contacto],
        type: db.QueryTypes.SELECT,
      },
    );
    if (tiene) {
      /* Ya está, pero puede faltarle la plantilla: es lo normal cuando el
         tablero se instaló antes de conectar el número, o cuando Meta recién
         aprobó la plantilla. Se reconcilia en vez de dar el bloque por hecho. */
      let ajustados = 0;
      for (const sec of bloque.secuencias) {
        if (!sec.nombre_template || !plantillas?.has(sec.nombre_template))
          continue;
        const [fila] = await db.query(
          `SELECT id, nombre_template FROM configuracion_remarketing
            WHERE id_configuracion = ? AND estado_contacto = ? AND secuencia = ?
            LIMIT 1`,
          {
            replacements: [
              id_configuracion,
              bloque.estado_contacto,
              sec.secuencia,
            ],
            type: db.QueryTypes.SELECT,
          },
        );
        if (!fila || fila.nombre_template === sec.nombre_template) continue;

        ajustados += 1;
        if (aplicar) {
          await db.query(
            `UPDATE configuracion_remarketing
                SET nombre_template = ?, language_code = ?
              WHERE id = ?`,
            {
              replacements: [
                sec.nombre_template,
                sec.language_code || 'es',
                fila.id,
              ],
              type: db.QueryTypes.UPDATE,
            },
          );
        }
      }

      console.log(
        ajustados
          ? `~ remarketing "${bloque.estado_contacto}": se le conecta la plantilla (${ajustados} paso/s)`
          : `${SIN_CAMBIO} remarketing "${bloque.estado_contacto}": ya configurado`,
      );
      continue;
    }

    console.log(
      `+ remarketing "${bloque.estado_contacto}": ${bloque.secuencias.length} paso(s)`,
    );
    if (!aplicar) continue;

    for (const sec of bloque.secuencias) {
      const minutos = Number(sec.tiempo_espera_minutos) || 0;

      /* Solo se escribe el nombre de la plantilla si de verdad existe en la WABA
         de esta cuenta. Si no, se deja vacío: fuera de 24h el motor cancela
         limpio en vez de estrellarse contra Meta. */
      const tpl =
        sec.nombre_template && plantillas?.has(sec.nombre_template)
          ? sec.nombre_template
          : '';
      if (sec.nombre_template && !tpl) {
        console.log(
          `   ${WARN}paso ${sec.secuencia}: sin la plantilla "${sec.nombre_template}", solo enviará dentro de 24h`,
        );
      }
      await db.query(
        `INSERT INTO configuracion_remarketing
           (id_configuracion, estado_contacto, secuencia,
            tiempo_espera_horas, tiempo_espera_minutos,
            nombre_template, language_code, estado_destino,
            header_format, metodo_dentro_24h, prompt_ia, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        {
          replacements: [
            id_configuracion,
            bloque.estado_contacto,
            sec.secuencia,
            Math.round(minutos / 60),
            minutos,
            tpl,
            sec.language_code || 'es',
            sec.estado_destino || null,
            sec.header_format || null,
            sec.metodo_dentro_24h || 'ninguno',
            sec.prompt_ia || null,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }
    console.log(`   ${OK} instalado`);
  }
}

(async () => {
  const aplicar = flag('aplicar');
  const actualizarPrompts = flag('actualizar-prompts');

  // ── Modo alta de conexión ──
  if (flag('crear-conexion')) {
    const nuevo = await crearConexion({
      id_usuario: Number(arg('usuario')),
      nombre: arg('nombre'),
      telefono: arg('telefono'),
      aplicar,
    });
    if (!aplicar) {
      console.log(`\n${WARN}SIMULACIÓN — nada se escribió (agrega --aplicar)\n`);
    } else if (nuevo) {
      console.log(
        `\nSiguiente paso:\n  node scripts/instalar_tablero_estetica.js ${nuevo} --tienda "<nombre>" --asistente "<nombre>" --aplicar\n`,
      );
    }
    process.exit(0);
  }

  // ── Modo instalación del tablero ──
  const id_configuracion = process.argv
    .slice(2)
    .map(Number)
    .filter(Boolean)[0];
  if (!id_configuracion) {
    console.log(
      'Uso: node scripts/instalar_tablero_estetica.js <id_configuracion> --tienda "<nombre>" [--asistente "<nombre>"] [--aplicar] [--actualizar-prompts]',
    );
    process.exit(1);
  }

  const [cfg] = await db.query(
    `SELECT id, nombre_configuracion, id_usuario, api_key_openai, suspendido
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg) {
    console.log(`${NO} la configuración ${id_configuracion} no existe`);
    process.exit(1);
  }

  /* Copiar la api_key de otra conexión del mismo dueño. Una conexión recién
     creada no tiene key, y sin ella no hay asistentes. Compartirla entre
     conexiones del mismo cliente es lo normal aquí (todas viven en su misma
     cuenta de OpenAI), pero implica que comparten saldo y límites: lo que
     consuma este tablero se lo descuenta al resto. */
  const copiarDe = Number(arg('copiar-key-de', 0));
  if (copiarDe && !cfg.api_key_openai) {
    const [origen] = await db.query(
      `SELECT id, nombre_configuracion, id_usuario, api_key_openai
         FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [copiarDe], type: db.QueryTypes.SELECT },
    );
    if (!origen?.api_key_openai) {
      console.log(`${NO} la configuración ${copiarDe} no tiene api_key para copiar`);
      process.exit(1);
    }
    if (Number(origen.id_usuario) !== Number(cfg.id_usuario)) {
      console.log(
        `${NO} la ${copiarDe} es de otro usuario (${origen.id_usuario} ≠ ${cfg.id_usuario}): no se copia la key entre cuentas`,
      );
      process.exit(1);
    }
    console.log(
      `+ api_key copiada de la conexión ${origen.id} ("${origen.nombre_configuracion}")`,
    );
    if (aplicar) {
      await db.query(
        `UPDATE configuraciones SET api_key_openai = ? WHERE id = ?`,
        {
          replacements: [origen.api_key_openai, cfg.id],
          type: db.QueryTypes.UPDATE,
        },
      );
    }
    cfg.api_key_openai = origen.api_key_openai;
  }

  /* La personalización guardada manda: nombre del centro, tono, horario y
     cobertura (instrucciones_extra) los edita el cliente desde la UI y son parte
     del prompt final. Si no se lee de aquí, cada re-compilación los borraría.
     Los argumentos de línea de comandos solo rellenan lo que falte. */
  const [persoGuardada] = await db.query(
    `SELECT nombre_tienda, nombre_asistente_publico, instrucciones_extra,
            info_envio, productos_destacados, tono_personalizado
       FROM kanban_columnas_personalizaciones
      WHERE id_configuracion = ? AND nombre_tienda IS NOT NULL LIMIT 1`,
    { replacements: [cfg.id], type: db.QueryTypes.SELECT },
  );

  const tienda =
    arg('tienda', null) ||
    persoGuardada?.nombre_tienda ||
    cfg.nombre_configuracion;
  const asistente =
    arg('asistente', null) || persoGuardada?.nombre_asistente_publico || null;
  const perso = {
    ...(persoGuardada || {}),
    nombre_tienda: tienda,
    nombre_asistente_publico: asistente,
  };
  if (persoGuardada?.instrucciones_extra) {
    console.log(
      `${SIN_CAMBIO} usando las instrucciones extra guardadas (${persoGuardada.instrucciones_extra.length} chars: horario, cobertura…)`,
    );
  }

  console.log(`\n${'═'.repeat(66)}`);
  console.log(`CONFIG ${cfg.id} — ${cfg.nombre_configuracion}`);
  console.log(`Tienda en los prompts: "${tienda}"${asistente ? ` · asistente "${asistente}"` : ''}`);
  console.log('═'.repeat(66));

  if (cfg.suspendido) console.log(`${WARN}la conexión está SUSPENDIDA`);
  if (!cfg.api_key_openai) {
    console.log(
      `${NO} no tiene api_key de OpenAI: sin ella no se pueden crear los asistentes`,
    );
    process.exit(1);
  }

  await asegurarCalendario({
    id_configuracion: cfg.id,
    nombre: `Agenda ${tienda}`,
    aplicar,
  });
  await instalarColumnas({ cfg, perso, aplicar, actualizarPrompts });
  const plantillas = await asegurarPlantillasMeta({ cfg, aplicar });
  await instalarRemarketing({ id_configuracion: cfg.id, aplicar, plantillas });

  console.log(`\n${'─'.repeat(66)}`);
  if (!aplicar) {
    console.log(`${WARN}SIMULACIÓN — nada se escribió. Agrega --aplicar.`);
  } else {
    console.log(`${OK} listo. Falta, fuera de este script:`);
    console.log('   · cargar los servicios y precios reales en el catálogo');
    console.log('   · revisar horario y cobertura en la personalización');
  }
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.response?.data?.error?.message || e.message);
  process.exit(1);
});
