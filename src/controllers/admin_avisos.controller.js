/**
 * admin_avisos.controller.js
 * CRUD del super admin sobre las plantillas de avisos por WhatsApp
 * (tabla avisos_plantillas). Nada quemado: el super admin decide qué
 * plantillas siguen, cuáles se van y cuáles se agregan; el motor de reglas
 * usa la activa de cada evento.
 */

const { db } = require('../database/config');
const logger = require('../utils/logger');

const EVENTOS_VALIDOS = [
  'regla_anuncio_pausado',
  'regla_campania_pausada',
  'regla_presupuesto_subido',
];

// Claves del sistema con las que se puede llenar cada {{n}} del cuerpo
// (mismo modelo que las plantillas Dropi: selects, nada escrito a mano).
const CLAVES_DISPONIBLES = [
  { key: 'nombre_cliente', label: 'Nombre del cliente' },
  { key: 'nombre_anuncio', label: 'Nombre del anuncio' },
  { key: 'nombre_campania', label: 'Nombre de la campaña' },
  { key: 'motivo', label: 'Motivo (con cifras reales)' },
  { key: 'gasto', label: 'Gasto acumulado' },
  { key: 'mensajes', label: 'Cantidad de mensajes' },
  { key: 'costo_mensaje', label: 'Costo por mensaje' },
  { key: 'nuevo_presupuesto', label: 'Nuevo presupuesto diario' },
  { key: 'nombre_regla', label: 'Nombre de la regla' },
];

exports.listar = async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT * FROM avisos_plantillas ORDER BY evento ASC, id ASC`,
      { type: db.QueryTypes.SELECT },
    );
    return res.json({
      success: true,
      data: rows,
      eventos: EVENTOS_VALIDOS,
      claves: CLAVES_DISPONIBLES,
    });
  } catch (err) {
    logger.error(`admin_avisos listar: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.guardar = async (req, res) => {
  try {
    const {
      id,
      evento,
      nombre_template,
      idioma,
      cuerpo,
      footer,
      variables_desc,
      activa,
    } = req.body;

    if (!EVENTOS_VALIDOS.includes(evento)) {
      return res.status(400).json({
        success: false,
        message: `Evento inválido. Usa uno de: ${EVENTOS_VALIDOS.join(', ')}.`,
      });
    }
    const nombre = String(nombre_template || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 120);
    if (!nombre) {
      return res.status(400).json({
        success: false,
        message: 'El nombre del template es requerido (minúsculas y _).',
      });
    }
    const body = String(cuerpo || '').trim();
    if (!body) {
      return res
        .status(400)
        .json({ success: false, message: 'El cuerpo es requerido.' });
    }

    // Mapa de variables: una clave del sistema por cada {{n}} del cuerpo.
    const nVars = (body.match(/\{\{\d+\}\}/g) || []).length;
    const clavesValidas = new Set(CLAVES_DISPONIBLES.map((c) => c.key));
    const parametros = (
      Array.isArray(req.body.parametros) ? req.body.parametros : []
    )
      .map((p) => String(p))
      .slice(0, 10);
    if (parametros.length !== nVars) {
      return res.status(400).json({
        success: false,
        message: `El cuerpo tiene ${nVars} variables y llegaron ${parametros.length} mapeos.`,
      });
    }
    const invalida = parametros.find((p) => !clavesValidas.has(p));
    if (invalida) {
      return res.status(400).json({
        success: false,
        message: `Clave inválida: ${invalida}.`,
      });
    }

    const valores = [
      evento,
      nombre,
      String(idioma || 'es').slice(0, 10),
      body,
      nVars ? JSON.stringify(parametros) : null,
      String(footer || '').slice(0, 120) || null,
      String(variables_desc || '').slice(0, 500) || null,
      activa === 0 || activa === false ? 0 : 1,
    ];

    if (Number(id)) {
      await db.query(
        `UPDATE avisos_plantillas SET
           evento = ?, nombre_template = ?, idioma = ?, cuerpo = ?,
           parametros_json = ?, footer = ?, variables_desc = ?, activa = ?
         WHERE id = ?`,
        { replacements: [...valores, Number(id)] },
      );
      return res.json({ success: true, id: Number(id) });
    }

    const [insertId] = await db.query(
      `INSERT INTO avisos_plantillas
         (evento, nombre_template, idioma, cuerpo, parametros_json, footer,
          variables_desc, activa)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      { replacements: valores, type: db.QueryTypes.INSERT },
    );
    return res.json({ success: true, id: insertId });
  } catch (err) {
    logger.error(`admin_avisos guardar: ${err.message}`);
    const msg = /uq_evento_nombre|Duplicate/i.test(err.message)
      ? 'Ya existe una plantilla con ese evento y nombre.'
      : err.message;
    return res.status(500).json({ success: false, message: msg });
  }
};

exports.eliminar = async (req, res) => {
  try {
    const id = Number(req.body.id);
    if (!id) {
      return res
        .status(400)
        .json({ success: false, message: 'id requerido.' });
    }
    await db.query(`DELETE FROM avisos_plantillas WHERE id = ?`, {
      replacements: [id],
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error(`admin_avisos eliminar: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
};
