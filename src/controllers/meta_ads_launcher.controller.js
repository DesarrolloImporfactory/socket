/**
 * meta_ads_launcher.controller.js
 * Lanzador de campañas: el cliente guarda plantillas (producto, presupuesto,
 * alcance, creativo, mensaje) y las lanza con un click en su cuenta
 * publicitaria conectada. Tab "Lanzador" de conexion-dashboard?view=ads.
 *
 * Tablas: meta_ads_plantillas, meta_ads_lanzamientos
 * (ver meta_ads_launcher_migration.sql — se aplican a mano, sin modelo).
 */

const { db } = require('../database/config');
const logger = require('../utils/logger');
const launcher = require('../services/metaAdsLauncher.service');

async function getAdConnection(id_configuracion) {
  const rows = await db.query(
    `SELECT * FROM meta_ad_connections WHERE id_configuracion = ? AND status = 'active' LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return rows[0] || null;
}

const PAISES_VALIDOS = /^[A-Z]{2}$/;

/* Normaliza y valida el cuerpo de una plantilla. Devuelve { ok, cfg | msg }. */
function normalizarPlantilla(body) {
  const nombre = String(body.nombre || '').trim();
  if (!nombre) return { ok: false, msg: 'El nombre de la plantilla es requerido.' };

  const presupuesto = Number(body.presupuesto_diario);
  if (!Number.isFinite(presupuesto) || presupuesto < 1) {
    return {
      ok: false,
      msg: 'El presupuesto diario debe ser un número mayor o igual a 1.',
    };
  }

  // geo: { modo: 'paises'|'especifico', paises: [...], lugares: [{key,name,type}] }
  // Compatibilidad: si no llega geo se arma desde body.paises (CSV).
  let geo = body.geo;
  if (typeof geo === 'string') {
    try {
      geo = JSON.parse(geo);
    } catch {
      geo = null;
    }
  }
  const modo = geo?.modo === 'especifico' ? 'especifico' : 'paises';
  const paises = (
    Array.isArray(geo?.paises) ? geo.paises : String(body.paises || 'EC').split(',')
  )
    .map((p) => String(p).trim().toUpperCase())
    .filter((p) => PAISES_VALIDOS.test(p));
  if (!paises.length) {
    return { ok: false, msg: 'Indica al menos un país válido (código ISO-2).' };
  }
  let lugares = [];
  if (modo === 'especifico') {
    lugares = (Array.isArray(geo?.lugares) ? geo.lugares : [])
      .filter((l) => l && l.key && ['region', 'city'].includes(l.type))
      .map((l) => ({
        key: String(l.key).slice(0, 32),
        name: String(l.name || '').slice(0, 120),
        type: l.type,
      }))
      .slice(0, 25);
    if (!lugares.length) {
      return {
        ok: false,
        msg: 'Agrega al menos una provincia o ciudad para segmentar.',
      };
    }
  }

  // Hasta 6 creativos (imágenes o videos) = hasta 6 anuncios en el mismo
  // conjunto. Meta recomienda máximo ~6 activos por conjunto para no romper
  // la fase de aprendizaje. El primero queda también en imagen_hash/
  // imagen_url por compatibilidad.
  const imagenes = (Array.isArray(body.imagenes) ? body.imagenes : [])
    .map((i) => {
      if (i?.tipo === 'video' && i.video_id) {
        return {
          tipo: 'video',
          video_id: String(i.video_id).slice(0, 32),
          thumb_url: i.thumb_url ? String(i.thumb_url) : null,
          url: i.url ? String(i.url) : i.thumb_url || null,
        };
      }
      if (i?.hash) {
        return {
          tipo: 'imagen',
          hash: String(i.hash).slice(0, 128),
          url: i.url ? String(i.url) : null,
        };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 6);

  const edad_min = Math.max(18, Math.min(65, Number(body.edad_min) || 18));
  const edad_max = Math.max(edad_min, Math.min(65, Number(body.edad_max) || 65));
  const genero = ['all', 'male', 'female'].includes(body.genero)
    ? body.genero
    : 'all';
  const estado_inicial = body.estado_inicial === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';

  return {
    ok: true,
    cfg: {
      nombre: nombre.slice(0, 150),
      id_producto: Number(body.id_producto) || null,
      page_id: body.page_id ? String(body.page_id).trim() : null,
      page_name: body.page_name ? String(body.page_name).slice(0, 255) : null,
      presupuesto_diario: Math.round(presupuesto * 100) / 100,
      paises: paises.join(','),
      geo_json: JSON.stringify({ modo, paises, lugares }),
      edad_min,
      edad_max,
      genero,
      titulo: String(body.titulo || '').slice(0, 255) || null,
      texto_principal: String(body.texto_principal || '') || null,
      descripcion: String(body.descripcion || '').slice(0, 255) || null,
      mensaje_bienvenida: String(body.mensaje_bienvenida || '') || null,
      imagen_url:
        imagenes[0]?.url || String(body.imagen_url || '') || null,
      imagen_hash:
        imagenes.find((i) => i.tipo === 'imagen')?.hash ||
        String(body.imagen_hash || '').slice(0, 128) ||
        null,
      imagenes_json: imagenes.length ? JSON.stringify(imagenes) : null,
      estado_inicial,
    },
  };
}

/* Qué le falta a una plantilla para poder lanzarse de verdad. */
function faltantesParaLanzar(p) {
  const faltan = [];
  if (!p.page_id) faltan.push('página de Facebook');
  let nCreativos = p.imagen_hash ? 1 : 0;
  try {
    const arr = p.imagenes_json ? JSON.parse(p.imagenes_json) : null;
    if (Array.isArray(arr) && arr.length) nCreativos = arr.length;
  } catch {}
  if (!nCreativos) faltan.push('imagen o video del anuncio');
  if (!p.texto_principal && !p.titulo) faltan.push('texto o título del anuncio');
  return faltan;
}

// ══════════════════════════════════════════════
// 1) CONTEXTO — lo que el wizard necesita para armarse
// ══════════════════════════════════════════════

exports.contexto = async (req, res) => {
  try {
    const id_configuracion = Number(req.query.id_configuracion);
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }

    const conn = await getAdConnection(id_configuracion);

    // Páginas: las de messenger_pages (ya conectadas al chat center) más las
    // que el token de ads pueda ver; se dedup-lican por page_id.
    const paginasDb = await db.query(
      `SELECT page_id, page_name FROM messenger_pages
        WHERE id_configuracion = ? AND status = 'active'
        ORDER BY id_messenger_page DESC`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    const [paginasToken, titularToken] = conn
      ? await Promise.all([
          launcher.listarPaginasDelToken(conn),
          launcher.obtenerTitularToken(conn),
        ])
      : [[], null];
    const vistas = new Map();
    for (const p of [
      ...paginasDb.map((x) => ({
        page_id: String(x.page_id),
        page_name: x.page_name || String(x.page_id),
        origen: 'chatcenter',
      })),
      ...paginasToken,
    ]) {
      if (!vistas.has(p.page_id)) vistas.set(p.page_id, p);
    }

    const productos = await db.query(
      `SELECT id, nombre, imagen_url FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0
        ORDER BY nombre ASC
        LIMIT 400`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    return res.json({
      success: true,
      data: {
        conectado: !!conn,
        ad_account_id: conn?.ad_account_id || null,
        ad_account_name: conn?.ad_account_name || null,
        currency: conn?.currency || 'USD',
        paginas: [...vistas.values()],
        titular_token: titularToken,
        productos,
      },
    });
  } catch (err) {
    logger.error(`launcher contexto: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════
// 2) PLANTILLAS — CRUD
// ══════════════════════════════════════════════

exports.listarPlantillas = async (req, res) => {
  try {
    const id_configuracion = Number(req.query.id_configuracion);
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }

    const rows = await db.query(
      `SELECT p.*, pr.nombre AS producto_nombre
         FROM meta_ads_plantillas p
         LEFT JOIN productos_chat_center pr ON pr.id = p.id_producto
        WHERE p.id_configuracion = ? AND p.eliminado = 0
        ORDER BY p.updated_at DESC`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    const data = rows.map((p) => ({
      ...p,
      faltantes: faltantesParaLanzar(p),
    }));

    return res.json({ success: true, data });
  } catch (err) {
    logger.error(`launcher listarPlantillas: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.guardarPlantilla = async (req, res) => {
  try {
    const id_configuracion = Number(req.body.id_configuracion);
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }

    const norm = normalizarPlantilla(req.body);
    if (!norm.ok) {
      return res.status(400).json({ success: false, message: norm.msg });
    }
    const c = norm.cfg;
    const id = Number(req.body.id) || null;

    // El título del anuncio ES el ancla del bot: llega como referral.headline
    // y la resolución por texto lo compara contra el nombre del producto. Con
    // producto vinculado, el título se fija al nombre EXACTO de Imporchat
    // (doble seguro junto al pre-registro del ad_id en anuncios_producto) —
    // se impone aquí y no solo en la UI.
    if (c.id_producto) {
      const [prod] = await db.query(
        `SELECT nombre FROM productos_chat_center
          WHERE id = ? AND id_configuracion = ? AND eliminado = 0 LIMIT 1`,
        {
          replacements: [c.id_producto, id_configuracion],
          type: db.QueryTypes.SELECT,
        },
      );
      if (prod) c.titulo = String(prod.nombre).slice(0, 255);
      else c.id_producto = null;
    }

    if (id) {
      const [result] = await db.query(
        `UPDATE meta_ads_plantillas SET
           nombre = ?, id_producto = ?, page_id = ?, page_name = ?,
           presupuesto_diario = ?, paises = ?, geo_json = ?, edad_min = ?,
           edad_max = ?, genero = ?, titulo = ?, texto_principal = ?,
           descripcion = ?, mensaje_bienvenida = ?, imagen_url = ?,
           imagen_hash = ?, imagenes_json = ?, estado_inicial = ?
         WHERE id = ? AND id_configuracion = ? AND eliminado = 0`,
        {
          replacements: [
            c.nombre, c.id_producto, c.page_id, c.page_name,
            c.presupuesto_diario, c.paises, c.geo_json, c.edad_min,
            c.edad_max, c.genero, c.titulo, c.texto_principal,
            c.descripcion, c.mensaje_bienvenida, c.imagen_url,
            c.imagen_hash, c.imagenes_json, c.estado_inicial, id,
            id_configuracion,
          ],
        },
      );
      if (!result || result.affectedRows === 0) {
        return res
          .status(404)
          .json({ success: false, message: 'Plantilla no encontrada.' });
      }
      return res.json({ success: true, id });
    }

    const [insertId] = await db.query(
      `INSERT INTO meta_ads_plantillas
         (id_configuracion, nombre, id_producto, page_id, page_name,
          presupuesto_diario, paises, geo_json, edad_min, edad_max, genero,
          titulo, texto_principal, descripcion, mensaje_bienvenida,
          imagen_url, imagen_hash, imagenes_json, estado_inicial)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion, c.nombre, c.id_producto, c.page_id, c.page_name,
          c.presupuesto_diario, c.paises, c.geo_json, c.edad_min, c.edad_max,
          c.genero, c.titulo, c.texto_principal, c.descripcion,
          c.mensaje_bienvenida, c.imagen_url, c.imagen_hash, c.imagenes_json,
          c.estado_inicial,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    return res.json({ success: true, id: insertId });
  } catch (err) {
    logger.error(`launcher guardarPlantilla: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.eliminarPlantilla = async (req, res) => {
  try {
    const { id, id_configuracion } = req.body;
    if (!Number(id) || !Number(id_configuracion)) {
      return res
        .status(400)
        .json({ success: false, message: 'id e id_configuracion requeridos.' });
    }
    await db.query(
      `UPDATE meta_ads_plantillas SET eliminado = 1
        WHERE id = ? AND id_configuracion = ?`,
      { replacements: [Number(id), Number(id_configuracion)] },
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error(`launcher eliminarPlantilla: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════
// 3) IMAGEN — sube el creativo a act_X/adimages y devuelve el hash
// ══════════════════════════════════════════════

exports.subirImagen = async (req, res) => {
  try {
    const id_configuracion = Number(req.body.id_configuracion);
    if (!id_configuracion || !req.file) {
      return res.status(400).json({
        success: false,
        message: 'id_configuracion y archivo (imagen) requeridos.',
      });
    }

    const conn = await getAdConnection(id_configuracion);
    if (!conn) {
      return res.json({
        success: false,
        message: 'No hay cuenta de ads conectada.',
      });
    }

    const subida = await launcher.subirImagen({
      conn,
      buffer: req.file.buffer,
      filename: req.file.originalname || 'creativo.jpg',
    });

    return res.json({
      success: true,
      data: { imagen_hash: subida.hash, imagen_url: subida.url },
    });
  } catch (err) {
    logger.error(`launcher subirImagen: ${err.message}`);
    return res.status(500).json({
      success: false,
      message:
        'Meta rechazó la imagen. Verifica el permiso ads_management de la cuenta.',
      meta_error: err.meta_error || err.message,
    });
  }
};

// Igual que subirImagen pero acepta también video: sube a act_X/advideos y
// devuelve el video_id + la miniatura que Meta genera (con polling corto).
exports.subirMedia = async (req, res) => {
  try {
    const id_configuracion = Number(req.body.id_configuracion);
    if (!id_configuracion || !req.file) {
      return res.status(400).json({
        success: false,
        message: 'id_configuracion y archivo (imagen o video) requeridos.',
      });
    }

    const conn = await getAdConnection(id_configuracion);
    if (!conn) {
      return res.json({
        success: false,
        message: 'No hay cuenta de ads conectada.',
      });
    }

    if (String(req.file.mimetype).startsWith('video/')) {
      const { video_id } = await launcher.subirVideo({
        conn,
        buffer: req.file.buffer,
        filename: req.file.originalname || 'video.mp4',
        mimetype: req.file.mimetype,
      });
      const thumb = await launcher.obtenerMiniaturaVideo(conn, video_id);
      return res.json({
        success: true,
        data: { tipo: 'video', video_id, thumb_url: thumb, url: thumb },
      });
    }

    const subida = await launcher.subirImagen({
      conn,
      buffer: req.file.buffer,
      filename: req.file.originalname || 'creativo.jpg',
    });
    return res.json({
      success: true,
      data: { tipo: 'imagen', hash: subida.hash, url: subida.url },
    });
  } catch (err) {
    logger.error(`launcher subirMedia: ${err.message}`);
    return res.status(500).json({
      success: false,
      message:
        'Meta rechazó el archivo. Verifica el permiso ads_management de la cuenta.',
      meta_error: err.meta_error || err.message,
    });
  }
};

// ══════════════════════════════════════════════
// 4) LANZAR — un click: campaña + conjunto + creativo + anuncio
// ══════════════════════════════════════════════

exports.lanzar = async (req, res) => {
  try {
    const id_configuracion = Number(req.body.id_configuracion);
    const id_plantilla = Number(req.body.id_plantilla);
    if (!id_configuracion || !id_plantilla) {
      return res.status(400).json({
        success: false,
        message: 'id_configuracion e id_plantilla requeridos.',
      });
    }

    const [plantilla] = await db.query(
      `SELECT p.*, pr.nombre AS producto_nombre
         FROM meta_ads_plantillas p
         LEFT JOIN productos_chat_center pr
           ON pr.id = p.id_producto AND pr.eliminado = 0
        WHERE p.id = ? AND p.id_configuracion = ? AND p.eliminado = 0
        LIMIT 1`,
      {
        replacements: [id_plantilla, id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );
    if (!plantilla) {
      return res
        .status(404)
        .json({ success: false, message: 'Plantilla no encontrada.' });
    }

    const faltan = faltantesParaLanzar(plantilla);
    if (faltan.length) {
      return res.status(400).json({
        success: false,
        message: `La plantilla no está lista para lanzar. Falta: ${faltan.join(', ')}.`,
      });
    }

    const conn = await getAdConnection(id_configuracion);
    if (!conn) {
      return res.json({
        success: false,
        message: 'No hay cuenta de ads conectada.',
      });
    }

    // Permite forzar el estado en el momento del lanzamiento sin editar la
    // plantilla ("lanzar pausado para revisarlo primero").
    const estado_inicial = ['ACTIVE', 'PAUSED'].includes(req.body.estado)
      ? req.body.estado
      : plantilla.estado_inicial;

    // Alcance: geo_json (modo país completo o provincias/ciudades). Las
    // plantillas anteriores a la columna caen al CSV de países.
    let geoPlantilla = null;
    try {
      geoPlantilla = plantilla.geo_json ? JSON.parse(plantilla.geo_json) : null;
    } catch {}
    const cfg = {
      nombre: plantilla.nombre,
      page_id: plantilla.page_id,
      presupuesto_diario: plantilla.presupuesto_diario,
      paises: String(plantilla.paises || 'EC').split(','),
      geo: geoPlantilla,
      edad_min: plantilla.edad_min,
      edad_max: plantilla.edad_max,
      genero: plantilla.genero,
      // Con producto vinculado el título del anuncio SIEMPRE es su nombre en
      // Imporchat: es el referral.headline con el que el bot lo detecta.
      titulo: plantilla.producto_nombre || plantilla.titulo,
      texto_principal: plantilla.texto_principal,
      descripcion: plantilla.descripcion,
      mensaje_bienvenida: plantilla.mensaje_bienvenida,
      imagen_hash: plantilla.imagen_hash,
      creativos: (() => {
        try {
          const arr = plantilla.imagenes_json
            ? JSON.parse(plantilla.imagenes_json)
            : null;
          if (!Array.isArray(arr) || !arr.length) return null;
          // Entradas guardadas antes del soporte de video no traen tipo.
          return arr.map((c) => ({ tipo: c.tipo || 'imagen', ...c }));
        } catch {
          return null;
        }
      })(),
      estado_inicial,
    };

    let paquete;
    try {
      paquete = await launcher.lanzarPaquete({ conn, cfg });
    } catch (err) {
      await db.query(
        `INSERT INTO meta_ads_lanzamientos
           (id_configuracion, id_plantilla, plantilla_nombre, resultado,
            estado_inicial, presupuesto_diario, error_meta)
         VALUES (?, ?, ?, 'error', ?, ?, ?)`,
        {
          replacements: [
            id_configuracion,
            id_plantilla,
            plantilla.nombre,
            estado_inicial,
            plantilla.presupuesto_diario,
            JSON.stringify(err.meta_error || err.message).slice(0, 5000),
          ],
          type: db.QueryTypes.INSERT,
        },
      );
      return res.json({
        success: false,
        message: `Meta rechazó el lanzamiento en el paso "${err.paso || '?'}": ${
          err.meta_error?.error_user_msg ||
          err.meta_error?.message ||
          err.message
        }`,
        meta_error: err.meta_error || null,
      });
    }

    await db.query(
      `INSERT INTO meta_ads_lanzamientos
         (id_configuracion, id_plantilla, plantilla_nombre, campaign_id,
          adset_id, creative_id, ad_id, ads_json, resultado, estado_inicial,
          presupuesto_diario)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
      {
        replacements: [
          id_configuracion,
          id_plantilla,
          plantilla.nombre,
          paquete.campaign_id,
          paquete.adset_id,
          paquete.creative_id,
          paquete.ad_id,
          JSON.stringify(paquete.ads || []),
          estado_inicial,
          plantilla.presupuesto_diario,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    await db.query(
      `UPDATE meta_ads_plantillas
          SET veces_lanzada = veces_lanzada + 1,
              ultimo_lanzamiento_at = NOW()
        WHERE id = ?`,
      { replacements: [id_plantilla] },
    );

    // Cierre del ciclo de atribución: cada ad_id recién creado es exactamente
    // el referral.source_id que llegará por el webhook de WhatsApp.
    // Registrarlos deja la resolución anuncio → producto exacta desde el
    // primer clic, para TODAS las variaciones.
    if (plantilla.id_producto) {
      for (const ad of paquete.ads || [{ ad_id: paquete.ad_id }]) {
        try {
          await db.query(
            `INSERT INTO anuncios_producto
               (id_configuracion, source_id, id_producto, headline, via)
             VALUES (?, ?, ?, ?, 'manual')
             ON DUPLICATE KEY UPDATE id_producto = VALUES(id_producto)`,
            {
              replacements: [
                id_configuracion,
                String(ad.ad_id),
                plantilla.id_producto,
                plantilla.producto_nombre ||
                  plantilla.titulo ||
                  plantilla.nombre,
              ],
              type: db.QueryTypes.INSERT,
            },
          );
        } catch (e) {
          logger.error(`launcher anuncios_producto: ${e.message}`);
        }
      }
    }

    return res.json({
      success: true,
      data: {
        ...paquete,
        estado_inicial,
        ads_manager_url: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${String(
          conn.ad_account_id,
        ).replace('act_', '')}&selected_campaign_ids=${paquete.campaign_id}`,
      },
    });
  } catch (err) {
    logger.error(`launcher lanzar: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════
// 4b) BUSCAR ZONAS (provincias/ciudades) para segmentar
// ══════════════════════════════════════════════

exports.buscarGeo = async (req, res) => {
  try {
    const id_configuracion = Number(req.query.id_configuracion);
    const q = String(req.query.q || '').trim();
    const pais = String(req.query.pais || '')
      .trim()
      .toUpperCase();
    if (!id_configuracion || q.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'id_configuracion y q (mínimo 2 letras) requeridos.',
      });
    }
    const conn = await getAdConnection(id_configuracion);
    if (!conn) {
      return res.json({
        success: false,
        message: 'No hay cuenta de ads conectada.',
      });
    }
    const data = await launcher.buscarGeo({
      conn,
      q,
      pais: PAISES_VALIDOS.test(pais) ? pais : null,
    });
    return res.json({ success: true, data });
  } catch (err) {
    logger.error(`launcher buscarGeo: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: 'No se pudo buscar la zona. Inténtalo de nuevo.',
      meta_error: err.meta_error || err.message,
    });
  }
};

// ══════════════════════════════════════════════
// 5) HISTORIAL
// ══════════════════════════════════════════════

exports.listarLanzamientos = async (req, res) => {
  try {
    const id_configuracion = Number(req.query.id_configuracion);
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }
    const rows = await db.query(
      `SELECT id, id_plantilla, plantilla_nombre, campaign_id, ad_id,
              ads_json, resultado, estado_inicial, presupuesto_diario,
              error_meta, created_at
         FROM meta_ads_lanzamientos
        WHERE id_configuracion = ?
        ORDER BY id DESC
        LIMIT 50`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    logger.error(`launcher listarLanzamientos: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};
