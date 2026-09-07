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
const reglasSvc = require('../services/metaAdsReglas.service');

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

  // Programación: fecha-hora local de la cuenta ('YYYY-MM-DDTHH:mm' del
  // datetime-local del front). Vacío = lanzar de inmediato.
  const inicioRaw = String(body.inicio_at || '').trim();
  const inicio_at = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(inicioRaw)
    ? `${inicioRaw.replace('T', ' ').slice(0, 16)}:00`
    : null;

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
      inicio_at,
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
           imagen_hash = ?, imagenes_json = ?, estado_inicial = ?,
           inicio_at = ?
         WHERE id = ? AND id_configuracion = ? AND eliminado = 0`,
        {
          replacements: [
            c.nombre, c.id_producto, c.page_id, c.page_name,
            c.presupuesto_diario, c.paises, c.geo_json, c.edad_min,
            c.edad_max, c.genero, c.titulo, c.texto_principal,
            c.descripcion, c.mensaje_bienvenida, c.imagen_url,
            c.imagen_hash, c.imagenes_json, c.estado_inicial, c.inicio_at,
            id, id_configuracion,
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
          imagen_url, imagen_hash, imagenes_json, estado_inicial, inicio_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion, c.nombre, c.id_producto, c.page_id, c.page_name,
          c.presupuesto_diario, c.paises, c.geo_json, c.edad_min, c.edad_max,
          c.genero, c.titulo, c.texto_principal, c.descripcion,
          c.mensaje_bienvenida, c.imagen_url, c.imagen_hash, c.imagenes_json,
          c.estado_inicial, c.inicio_at,
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
      `SELECT p.*, pr.nombre AS producto_nombre,
              DATE_FORMAT(p.inicio_at, '%Y-%m-%d %H:%i:%s') AS inicio_at_str
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
      // Programación: solo se manda si la hora sigue en el futuro (con 5 min
      // de margen); una plantilla con hora vieja lanza de inmediato.
      inicio_at: (() => {
        if (!plantilla.inicio_at_str) return null;
        const f = new Date(plantilla.inicio_at_str.replace(' ', 'T'));
        return f.getTime() > Date.now() + 5 * 60 * 1000
          ? plantilla.inicio_at_str
          : null;
      })(),
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

// ══════════════════════════════════════════════
// 6) REGLAS AUTOMÁTICAS (motor propio, ver metaAdsReglas.service.js)
// ══════════════════════════════════════════════

exports.listarReglas = async (req, res) => {
  try {
    const id_configuracion = Number(req.query.id_configuracion);
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }
    const reglas = await db.query(
      `SELECT * FROM meta_ads_reglas
        WHERE id_configuracion = ?
        ORDER BY es_recomendada DESC, id ASC`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    // Recomendadas que aún no se han aplicado (para ofrecerlas en el front)
    const nombres = new Set(reglas.map((r) => r.nombre));
    const recomendadas_pendientes = reglasSvc.REGLAS_RECOMENDADAS.filter(
      (r) => !nombres.has(r.nombre),
    );
    return res.json({ success: true, data: reglas, recomendadas_pendientes });
  } catch (err) {
    logger.error(`launcher listarReglas: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

function normalizarRegla(body) {
  const nombre = String(body.nombre || '').trim();
  if (!nombre) return { ok: false, msg: 'El nombre de la regla es requerido.' };
  const nivel = body.nivel === 'campaign' ? 'campaign' : 'ad';

  // Ámbito: sobre qué campañas opina la regla.
  const ambito = ['imporchat', 'externas', 'todas', 'personalizado'].includes(
    body.ambito,
  )
    ? body.ambito
    : 'imporchat';
  let campanias_json = null;
  if (ambito === 'personalizado') {
    const lista = (Array.isArray(body.campanias) ? body.campanias : [])
      .filter((c) => c && (c.id || typeof c === 'string'))
      .map((c) => ({
        id: String(c.id || c).slice(0, 64),
        nombre: String(c.nombre || '').slice(0, 255),
      }))
      .slice(0, 50);
    if (!lista.length) {
      return {
        ok: false,
        msg: 'Elige al menos una campaña para el ámbito personalizado.',
      };
    }
    campanias_json = JSON.stringify(lista);
  }
  const metrica = ['cpa_msg', 'msgs', 'spend'].includes(body.metrica)
    ? body.metrica
    : 'cpa_msg';
  const operador = ['>', '<', '='].includes(body.operador)
    ? body.operador
    : '>';
  const umbral = Number(body.umbral);
  if (!Number.isFinite(umbral) || umbral < 0) {
    return { ok: false, msg: 'El umbral debe ser un número válido.' };
  }
  const accion =
    body.accion === 'subir_presupuesto' ? 'subir_presupuesto' : 'pausar';
  if (accion === 'subir_presupuesto' && nivel !== 'campaign') {
    return {
      ok: false,
      msg: 'La acción de presupuesto aplica a nivel campaña.',
    };
  }
  return {
    ok: true,
    cfg: {
      nombre: nombre.slice(0, 150),
      nivel,
      ambito,
      campanias_json,
      metrica,
      operador,
      umbral: Math.round(umbral * 100) / 100,
      gasto_minimo: Math.max(0, Number(body.gasto_minimo) || 0),
      periodo: body.periodo === '7d' ? '7d' : 'hoy',
      accion,
      accion_valor:
        accion === 'subir_presupuesto'
          ? Math.min(100, Math.max(1, Number(body.accion_valor) || 10))
          : null,
      accion_limite:
        accion === 'subir_presupuesto'
          ? Math.max(1, Number(body.accion_limite) || 50)
          : null,
      frecuencia: body.frecuencia === 'diaria' ? 'diaria' : '30m',
      activa: body.activa === 0 || body.activa === false ? 0 : 1,
    },
  };
}

exports.guardarRegla = async (req, res) => {
  try {
    const id_configuracion = Number(req.body.id_configuracion);
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }
    const norm = normalizarRegla(req.body);
    if (!norm.ok) {
      return res.status(400).json({ success: false, message: norm.msg });
    }
    const c = norm.cfg;
    const id = Number(req.body.id) || null;

    if (id) {
      await db.query(
        `UPDATE meta_ads_reglas SET
           nombre = ?, nivel = ?, ambito = ?, campanias_json = ?,
           metrica = ?, operador = ?, umbral = ?, gasto_minimo = ?,
           periodo = ?, accion = ?, accion_valor = ?, accion_limite = ?,
           frecuencia = ?, activa = ?
         WHERE id = ? AND id_configuracion = ?`,
        {
          replacements: [
            c.nombre, c.nivel, c.ambito, c.campanias_json, c.metrica,
            c.operador, c.umbral, c.gasto_minimo, c.periodo, c.accion,
            c.accion_valor, c.accion_limite, c.frecuencia, c.activa,
            id, id_configuracion,
          ],
        },
      );
      return res.json({ success: true, id });
    }

    const [insertId] = await db.query(
      `INSERT INTO meta_ads_reglas
         (id_configuracion, nombre, nivel, ambito, campanias_json, metrica,
          operador, umbral, gasto_minimo, periodo, accion, accion_valor,
          accion_limite, frecuencia, activa, es_recomendada)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      {
        replacements: [
          id_configuracion, c.nombre, c.nivel, c.ambito, c.campanias_json,
          c.metrica, c.operador, c.umbral, c.gasto_minimo, c.periodo,
          c.accion, c.accion_valor, c.accion_limite, c.frecuencia, c.activa,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
    return res.json({ success: true, id: insertId });
  } catch (err) {
    logger.error(`launcher guardarRegla: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.eliminarRegla = async (req, res) => {
  try {
    const { id, id_configuracion } = req.body;
    if (!Number(id) || !Number(id_configuracion)) {
      return res
        .status(400)
        .json({ success: false, message: 'id e id_configuracion requeridos.' });
    }
    await db.query(
      `DELETE FROM meta_ads_reglas WHERE id = ? AND id_configuracion = ?`,
      { replacements: [Number(id), Number(id_configuracion)] },
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error(`launcher eliminarRegla: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.aplicarRecomendadas = async (req, res) => {
  try {
    const id_configuracion = Number(req.body.id_configuracion);
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }
    const existentes = await db.query(
      `SELECT nombre FROM meta_ads_reglas WHERE id_configuracion = ?`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    const nombres = new Set(existentes.map((r) => r.nombre));
    // Selección parcial: si llega body.nombres, solo se aplican esas
    // (el cliente elige cuáles del paquete quiere).
    const elegidas = Array.isArray(req.body.nombres)
      ? new Set(req.body.nombres.map(String))
      : null;
    let creadas = 0;
    for (const r of reglasSvc.REGLAS_RECOMENDADAS) {
      if (nombres.has(r.nombre)) continue;
      if (elegidas && !elegidas.has(r.nombre)) continue;
      await db.query(
        `INSERT INTO meta_ads_reglas
           (id_configuracion, nombre, nivel, metrica, operador, umbral,
            gasto_minimo, periodo, accion, accion_valor, accion_limite,
            frecuencia, activa, es_recomendada)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        {
          replacements: [
            id_configuracion, r.nombre, r.nivel, r.metrica, r.operador,
            r.umbral, r.gasto_minimo, r.periodo, r.accion, r.accion_valor,
            r.accion_limite, r.frecuencia,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
      creadas++;
    }
    return res.json({ success: true, creadas });
  } catch (err) {
    logger.error(`launcher aplicarRecomendadas: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.logReglas = async (req, res) => {
  try {
    const id_configuracion = Number(req.query.id_configuracion);
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }
    const rows = await db.query(
      `SELECT * FROM meta_ads_reglas_log
        WHERE id_configuracion = ?
        ORDER BY id DESC
        LIMIT 60`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    logger.error(`launcher logReglas: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════
// 7) AVISOS POR WHATSAPP (check por configuración)
// ══════════════════════════════════════════════

exports.estadoAvisos = async (req, res) => {
  try {
    const id_configuracion = Number(req.query.id_configuracion);
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }
    const avisos = require('../services/metaAdsAvisos.service');
    const datos = await avisos.obtenerDatosAviso(id_configuracion);
    const lead = String(datos?.whatsapp_lead || '').replace(/\D/g, '');
    return res.json({
      success: true,
      data: {
        activo: Number(datos?.avisos_reglas) === 1,
        tiene_lead: lead.length >= 7,
        lead: lead || null,
        lead_pais: datos?.whatsapp_lead_pais || null,
      },
    });
  } catch (err) {
    logger.error(`launcher estadoAvisos: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.toggleAvisos = async (req, res) => {
  try {
    const id_configuracion = Number(req.body.id_configuracion);
    const activo = req.body.activo ? 1 : 0;
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }
    await db.query(
      `UPDATE meta_ad_connections SET avisos_reglas = ?
        WHERE id_configuracion = ? AND status = 'active'`,
      { replacements: [activo, id_configuracion] },
    );

    // Al encender el switch se aseguran las plantillas aprobadas en la WABA
    // del cliente (en segundo plano: "already exists" se ignora).
    if (activo === 1) {
      const avisos = require('../services/metaAdsAvisos.service');
      setImmediate(() =>
        avisos
          .asegurarPlantillasWaba(id_configuracion)
          .catch((e) =>
            logger.error(`toggleAvisos plantillas WABA: ${e.message}`),
          ),
      );
    }
    return res.json({ success: true, activo: activo === 1 });
  } catch (err) {
    logger.error(`launcher toggleAvisos: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Corre el motor YA para una configuración (además del cron de 30 min).
// Útil para probar una regla recién creada sin esperar el ciclo.
exports.ejecutarReglas = async (req, res) => {
  try {
    const id_configuracion = Number(req.body.id_configuracion);
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'id_configuracion requerido.' });
    }
    const resumen = await reglasSvc.evaluarReglasConfig(id_configuracion);
    return res.json({ success: true, data: resumen });
  } catch (err) {
    logger.error(`launcher ejecutarReglas: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};
