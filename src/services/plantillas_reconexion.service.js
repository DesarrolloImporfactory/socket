/* Recrea en la WABA actual las plantillas de Meta que las automatizaciones de
   la cuenta ya referencian.

   Caso que lo motivó (cfg 793 NEXUS SHOP, 2026-11-06): el cliente cambió el
   número de WhatsApp de una conexión que ya tenía el tablero global 13
   instalado. Las plantillas (guia_generada_k1, novedadk2, retiro_agencia_k1…)
   viven en la WABA, no en la cuenta: al vincular otro número la WABA nueva
   nació con 0 plantillas y el notifier de Dropi omitía todos los avisos de
   cambio de estado («la plantilla no existe o no está aprobada»), aunque en
   dropi_plantillas_config y configuracion_remarketing todo seguía configurado.

   Qué hace:
   1. plantillasReferenciadas(cfg) junta los nombres que la cuenta usa de
      verdad (Dropi, remarketing, guía, calendario, Shopify, agenda, encuestas)
      más los del setup de la plantilla global instalada.
   2. recrearPlantillasTrasReconexion(cfg) crea en la WABA actual las que
      falten y estén en el catálogo (fábrica + custom) con el mismo instalador
      del tablero (_crearTemplatesMeta, idempotente: salta las que ya existen).
      Las que no están en el catálogo (creadas a mano por el cliente) no se
      pueden reconstruir y se reportan como no_recreables.
   3. Deja el resultado en configuraciones_kanban_global_log (accion
      'templates_meta', motivo 'reconexion').

   Meta aprueba las plantillas nuevas en minutos; el notifier vuelve a leer la
   lista de aprobadas en cada corrida, así que los avisos se reanudan solos. */
const { db } = require('../database/config');
const { getConfigFromDB } = require('../utils/whatsappTemplate.helpers');
const {
  getTemplatesMetaMerged,
} = require('../utils/kanban_catalogo.provider');

const Q = (sql, replacements) =>
  db.query(sql, { replacements, type: db.QueryTypes.SELECT });

/* Candado por cuenta: una reconexión manual y una por Embedded Signup
   seguidas no deben crear la misma plantilla dos veces (Meta devolvería
   «name already exists» en la segunda y ensuciaría el log). */
const enCurso = new Set();

const limpio = (v) => String(v || '').trim();

/* Nombres de plantilla que las automatizaciones de la cuenta referencian.
   Devuelve { nombres: Set<string>, fuentes: { nombre: ['dropi:GUIA GENERADA', …] } }
   Cada consulta va en su propio try: una tabla que no exista en esta BD no
   debe impedir recrear el resto. */
async function plantillasReferenciadas(id_configuracion) {
  const fuentes = {};
  const sumar = (nombre, fuente) => {
    const n = limpio(nombre);
    // Las secuencias por IA guardan un texto de relleno entre paréntesis.
    if (!n || n.startsWith('(')) return;
    if (!fuentes[n]) fuentes[n] = [];
    fuentes[n].push(fuente);
  };

  try {
    const rows = await Q(
      `SELECT estado_dropi, nombre_template, proveedor
         FROM dropi_plantillas_config WHERE id_configuracion = ?`,
      [id_configuracion],
    );
    for (const r of rows) {
      sumar(r.nombre_template, `${r.proveedor || 'dropi'}:${r.estado_dropi}`);
    }
  } catch (e) {
    console.error('[plantillas_reconexion] dropi_plantillas_config:', e.message);
  }

  try {
    const rows = await Q(
      `SELECT estado_contacto, secuencia, nombre_template
         FROM configuracion_remarketing WHERE id_configuracion = ?`,
      [id_configuracion],
    );
    for (const r of rows) {
      sumar(
        r.nombre_template,
        `remarketing:${r.estado_contacto}#${r.secuencia}`,
      );
    }
  } catch (e) {
    console.error('[plantillas_reconexion] configuracion_remarketing:', e.message);
  }

  let cfg = null;
  try {
    [cfg] = await Q(
      `SELECT id_usuario, kanban_global_id, template_generar_guia,
              template_notificar_calendario
         FROM configuraciones WHERE id = ? LIMIT 1`,
      [id_configuracion],
    );
    if (cfg) {
      sumar(cfg.template_generar_guia, 'configuraciones:template_generar_guia');
      sumar(
        cfg.template_notificar_calendario,
        'configuraciones:template_notificar_calendario',
      );
    }
  } catch (e) {
    console.error('[plantillas_reconexion] configuraciones:', e.message);
  }

  try {
    const rows = await Q(
      `SELECT nombre_template_recuperacion
         FROM shopify_configuraciones WHERE id_configuracion = ?`,
      [id_configuracion],
    );
    for (const r of rows) {
      sumar(r.nombre_template_recuperacion, 'shopify:recuperacion_carrito');
    }
  } catch (e) {
    console.error('[plantillas_reconexion] shopify_configuraciones:', e.message);
  }

  try {
    const rows = await Q(
      `SELECT plantilla_confirmacion
         FROM agenda_publica_config WHERE id_configuracion = ?`,
      [id_configuracion],
    );
    for (const r of rows) {
      sumar(r.plantilla_confirmacion, 'agenda_publica:confirmacion');
    }
  } catch (e) {
    console.error('[plantillas_reconexion] agenda_publica_config:', e.message);
  }

  /* Las encuestas cuelgan del usuario, no de la conexión; la plantilla
     fuera de 24 h sale por el número de la conexión que atiende el chat. */
  if (cfg?.id_usuario) {
    try {
      const rows = await Q(
        `SELECT template_fuera_24h
           FROM encuestas WHERE id_usuario = ? AND deleted_at IS NULL`,
        [cfg.id_usuario],
      );
      for (const r of rows) sumar(r.template_fuera_24h, 'encuesta:fuera_24h');
    } catch (e) {
      console.error('[plantillas_reconexion] encuestas:', e.message);
    }
  }

  /* Lo que la plantilla global instalada pide en su setup. Si no acota
     ítems (null) aplicarGlobal creaba todas las de fábrica; aquí se respeta
     igual, así un tablero recién instalado queda idéntico tras el cambio. */
  if (cfg?.kanban_global_id) {
    try {
      const kanbanPlantillas = require('../controllers/kanban_plantillas.controller');
      const setup = await kanbanPlantillas._setupDeLaPlantillaInstalada(
        id_configuracion,
      );
      if (setup.templates_meta) {
        if (Array.isArray(setup.templates_meta_items)) {
          for (const n of setup.templates_meta_items) {
            sumar(n, `tablero:${cfg.kanban_global_id}`);
          }
        } else {
          const catalogo = await getTemplatesMetaMerged();
          for (const t of catalogo) {
            if (!t._custom) sumar(t.name, `tablero:${cfg.kanban_global_id}`);
          }
        }
      }
    } catch (e) {
      console.error('[plantillas_reconexion] setup tablero:', e.message);
    }
  }

  return { nombres: new Set(Object.keys(fuentes)), fuentes };
}

/* ¿La cuenta tiene algo que recrear? Barato: solo lee la BD. Lo usa el
   controlador de conexión para decidir qué contestarle al front sin esperar
   a Meta. */
async function tienePlantillasQueRecrear(id_configuracion) {
  const { nombres } = await plantillasReferenciadas(id_configuracion);
  return nombres.size;
}

/* Crea en la WABA actual las plantillas referenciadas que falten.
   @returns {Promise<{status, creadas, ya_existian, errores, no_recreables, referenciadas}>} */
async function recrearPlantillasTrasReconexion(
  id_configuracion,
  { motivo = 'reconexion', waba_anterior = null, logger = console } = {},
) {
  const id = Number(id_configuracion);
  if (!Number.isInteger(id)) return { status: 'cfg_invalida' };
  if (enCurso.has(id)) return { status: 'en_curso' };
  enCurso.add(id);

  const log = (...a) => logger.log(`[plantillas_reconexion][cfg=${id}]`, ...a);

  try {
    const waba = await getConfigFromDB(id);
    if (!waba?.WABA_ID || !waba?.ACCESS_TOKEN) {
      log('sin WABA o token: nada que recrear');
      return { status: 'sin_waba' };
    }

    const { nombres, fuentes } = await plantillasReferenciadas(id);
    if (!nombres.size) {
      log('la cuenta no referencia ninguna plantilla');
      return { status: 'sin_plantillas', referenciadas: [] };
    }

    const catalogo = await getTemplatesMetaMerged();
    const enCatalogo = new Set(catalogo.map((t) => t.name));
    const recreables = [...nombres].filter((n) => enCatalogo.has(n));
    const no_recreables = [...nombres].filter((n) => !enCatalogo.has(n));

    log(
      `referenciadas=${nombres.size} recreables=${recreables.length} ` +
        `no_recreables=${no_recreables.length} waba=${waba.WABA_ID}` +
        (waba_anterior ? ` (antes ${waba_anterior})` : ''),
    );

    let resultados = [];
    if (recreables.length) {
      const kanbanPlantillas = require('../controllers/kanban_plantillas.controller');
      resultados = await kanbanPlantillas._crearTemplatesMeta(
        id,
        new Set(recreables),
      );
    }

    const creadas = resultados
      .filter((r) => r.status === 'success')
      .map((r) => r.nombre);
    const ya_existian = resultados
      .filter((r) => r.status === 'omitido')
      .map((r) => r.nombre);
    const errores = resultados
      .filter((r) => !['success', 'omitido'].includes(r.status))
      .map((r) => ({ nombre: r.nombre, status: r.status, error: r.error }));

    log(
      `creadas=${creadas.length} ya_existian=${ya_existian.length} errores=${errores.length}`,
      errores.length ? JSON.stringify(errores).slice(0, 600) : '',
    );

    const resumen = {
      status: 'ok',
      motivo,
      waba_anterior,
      waba_nueva: waba.WABA_ID,
      referenciadas: [...nombres],
      fuentes,
      creadas,
      ya_existian,
      errores,
      no_recreables,
    };

    try {
      const [cfg] = await Q(
        `SELECT kanban_global_id FROM configuraciones WHERE id = ? LIMIT 1`,
        [id],
      );
      await db.query(
        `INSERT INTO configuraciones_kanban_global_log
           (id_configuracion, id_plantilla, accion, detalle)
         VALUES (?, ?, 'templates_meta', ?)`,
        {
          replacements: [
            id,
            cfg?.kanban_global_id || null,
            JSON.stringify({ templates_meta: resultados, ...resumen }),
          ],
        },
      );
    } catch (e) {
      logger.error(
        `[plantillas_reconexion][cfg=${id}] no se pudo registrar en el log:`,
        e.message,
      );
    }

    return resumen;
  } finally {
    enCurso.delete(id);
  }
}

module.exports = {
  plantillasReferenciadas,
  tienePlantillasQueRecrear,
  recrearPlantillasTrasReconexion,
};
