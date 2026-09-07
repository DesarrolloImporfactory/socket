/**
 * metaAdsAvisos.service.js
 * Avisos por WhatsApp al dueño de la cuenta cuando una regla automática
 * actúa sobre su campaña o anuncio.
 *
 * El aviso sale por el WhatsApp Business de la propia configuración (mismo
 * circuito que dropi_notifier) hacia el whatsapp_lead personal del dueño
 * (usuarios_chat_center). Las plantillas viven en `avisos_plantillas`
 * (CRUD del super admin): el cuerpo lleva {{1}}..{{n}} y `parametros_json`
 * dice qué CLAVE del sistema llena cada posición — igual que las plantillas
 * Dropi, nada de texto adivinado.
 *
 * Al activar el switch de avisos se crean las plantillas activas en la WABA
 * del cliente (asegurarPlantillasWaba); cada envío exitoso queda registrado
 * en `avisos_enviados` (visible en Mi Perfil).
 */

const axios = require('axios');
const { db } = require('../database/config');
const logger = require('../utils/logger');

const GRAPH_BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION}`;

/* Claves disponibles para las variables de las plantillas. El contexto lo
   arma el motor de reglas; nombre_cliente sale de la BD. */
const CLAVES = {
  nombre_cliente: (ctx, datos) => datos.nombre_usuario || 'emprendedor',
  nombre_anuncio: (ctx) => ctx.nombre_anuncio || ctx.nombre_entidad || '',
  nombre_campania: (ctx) => ctx.nombre_campania || ctx.nombre_entidad || '',
  motivo: (ctx) => ctx.motivo || '',
  gasto: (ctx) =>
    ctx.gasto != null ? `$${Number(ctx.gasto).toFixed(2)}` : '',
  mensajes: (ctx) => String(ctx.mensajes ?? ''),
  costo_mensaje: (ctx) =>
    ctx.costo_mensaje != null
      ? `$${Number(ctx.costo_mensaje).toFixed(2)}`
      : '—',
  nuevo_presupuesto: (ctx) => ctx.nuevo_presupuesto || '',
  nombre_regla: (ctx) => ctx.nombre_regla || '',
};

const PARAMETROS_DEFAULT = {
  regla_anuncio_pausado: ['nombre_cliente', 'nombre_anuncio', 'motivo'],
  regla_campania_pausada: ['nombre_cliente', 'nombre_campania', 'motivo'],
  regla_presupuesto_subido: [
    'nombre_cliente',
    'nombre_campania',
    'motivo',
    'nuevo_presupuesto',
  ],
};

/* Número destino: whatsapp_lead son solo dígitos y el país viene aparte
   ('+593'). Se arma el E.164 sin '+' que pide la API de mensajes. */
function armarNumeroLead(lead, pais) {
  const digits = String(lead || '').replace(/\D/g, '');
  const cc = String(pais || '').replace(/\D/g, '');
  if (!digits) return null;
  if (cc && digits.startsWith(cc)) return digits;
  const sinCero = digits.replace(/^0+/, '');
  return cc ? `${cc}${sinCero}` : sinCero;
}

async function obtenerDatosAviso(id_configuracion) {
  const [row] = await db.query(
    `SELECT c.id_telefono AS phone_number_id, c.token AS waba_token,
            c.id_whatsapp AS waba_id,
            u.id_usuario, u.nombre AS nombre_usuario,
            u.whatsapp_lead, u.whatsapp_lead_pais,
            mac.avisos_reglas
       FROM configuraciones c
       JOIN usuarios_chat_center u ON u.id_usuario = c.id_usuario
       LEFT JOIN meta_ad_connections mac
         ON mac.id_configuracion = c.id AND mac.status = 'active'
      WHERE c.id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

async function obtenerPlantilla(evento) {
  const [row] = await db.query(
    `SELECT * FROM avisos_plantillas
      WHERE evento = ? AND activa = 1
      ORDER BY id ASC LIMIT 1`,
    { replacements: [evento], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

/* Interpola el cuerpo para la bitácora legible de Mi Perfil. */
function interpolar(cuerpo, valores) {
  return String(cuerpo || '').replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const v = valores[Number(n) - 1];
    return v != null && v !== '' ? v : m;
  });
}

/**
 * Envía el aviso (best-effort: jamás rompe el motor de reglas).
 * `contexto`: { nombre_entidad, nombre_anuncio?, nombre_campania?, motivo,
 *   gasto, mensajes, costo_mensaje, nuevo_presupuesto?, nombre_regla }
 */
async function enviarAvisoRegla({ id_configuracion, evento, contexto }) {
  try {
    const datos = await obtenerDatosAviso(id_configuracion);
    if (!datos || Number(datos.avisos_reglas) !== 1) return false;
    if (!datos.phone_number_id || !datos.waba_token) return false;

    const destino = armarNumeroLead(
      datos.whatsapp_lead,
      datos.whatsapp_lead_pais,
    );
    if (!destino) return false;

    const plantilla = await obtenerPlantilla(evento);
    if (!plantilla) return false;

    // Cada posición {{n}} del cuerpo se llena con la clave que mapeó el
    // super admin (parametros_json); sin mapa, el orden por defecto.
    let claves = null;
    try {
      claves = plantilla.parametros_json
        ? JSON.parse(plantilla.parametros_json)
        : null;
    } catch {
      claves = null;
    }
    if (!Array.isArray(claves) || !claves.length) {
      claves = PARAMETROS_DEFAULT[evento] || [];
    }
    const nVars = (String(plantilla.cuerpo).match(/\{\{\d+\}\}/g) || [])
      .length;
    const valores = [];
    for (let i = 0; i < nVars; i++) {
      const clave = claves[i];
      const resolver = CLAVES[clave];
      valores.push(
        resolver
          ? String(resolver(contexto || {}, datos) ?? '')
              .replace(/[\n\t]+/g, ' ')
              .slice(0, 550)
          : ' ',
      );
    }

    const payload = {
      messaging_product: 'whatsapp',
      to: destino,
      type: 'template',
      template: {
        name: plantilla.nombre_template,
        language: { code: plantilla.idioma || 'es' },
        components: valores.length
          ? [
              {
                type: 'body',
                parameters: valores.map((v) => ({ type: 'text', text: v })),
              },
            ]
          : undefined,
      },
    };

    await axios.post(
      `${GRAPH_BASE}/${datos.phone_number_id}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${datos.waba_token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    );

    // Bitácora para Mi Perfil: qué le avisamos y cuándo.
    try {
      await db.query(
        `INSERT INTO avisos_enviados
           (id_usuario, id_configuracion, evento, nombre_template, destino, resumen)
         VALUES (?, ?, ?, ?, ?, ?)`,
        {
          replacements: [
            datos.id_usuario || null,
            id_configuracion,
            evento,
            plantilla.nombre_template,
            destino,
            interpolar(plantilla.cuerpo, valores).slice(0, 500),
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    } catch (e) {
      logger.error(`metaAdsAvisos bitacora: ${e.message}`);
    }
    return true;
  } catch (e) {
    logger.error(
      `metaAdsAvisos cfg ${id_configuracion} evento ${evento}: ${e?.response?.data?.error?.message || e.message}`,
    );
    return false;
  }
}

/* Crea en la WABA del cliente las plantillas activas que aún no existan
   (categoría UTILITY: aprobación rápida). Se dispara al encender el switch
   de avisos; "already exists" se ignora. */
const EJEMPLOS_WABA = {
  nombre_cliente: 'Daniel',
  nombre_anuncio: 'Faja reductora · V2',
  nombre_campania: 'Faja reductora · lanzamiento EC',
  motivo: 'gastó $0.40 sin generar mensajes',
  gasto: '$3.10',
  mensajes: '5',
  costo_mensaje: '$0.62',
  nuevo_presupuesto: '$5.50',
  nombre_regla: 'Apagar anuncio sin mensajes',
};

async function asegurarPlantillasWaba(id_configuracion) {
  const [cfg] = await db.query(
    `SELECT id_whatsapp AS waba_id, token FROM configuraciones
      WHERE id = ? AND id_whatsapp IS NOT NULL AND token IS NOT NULL LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg) return { creadas: 0, errores: ['Sin WhatsApp API conectado'] };

  const plantillas = await db.query(
    `SELECT * FROM avisos_plantillas WHERE activa = 1`,
    { type: db.QueryTypes.SELECT },
  );

  let creadas = 0;
  const errores = [];
  for (const p of plantillas) {
    let claves = [];
    try {
      claves = p.parametros_json ? JSON.parse(p.parametros_json) : [];
    } catch {}
    const nVars = (String(p.cuerpo).match(/\{\{\d+\}\}/g) || []).length;
    const ejemplo = [];
    for (let i = 0; i < nVars; i++) {
      ejemplo.push(EJEMPLOS_WABA[claves[i]] || 'ejemplo');
    }
    const components = [
      {
        type: 'BODY',
        text: p.cuerpo,
        ...(nVars ? { example: { body_text: [ejemplo] } } : {}),
      },
    ];
    if (p.footer) components.push({ type: 'FOOTER', text: p.footer });

    try {
      await axios.post(
        `${GRAPH_BASE}/${cfg.waba_id}/message_templates`,
        {
          name: p.nombre_template,
          language: p.idioma || 'es',
          category: 'UTILITY',
          components,
        },
        {
          headers: {
            Authorization: `Bearer ${cfg.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
      creadas++;
    } catch (e) {
      const msg = e?.response?.data?.error?.message || e.message;
      if (!/already exists/i.test(msg)) {
        errores.push(`${p.nombre_template}: ${msg}`);
        logger.error(
          `metaAdsAvisos plantilla WABA cfg ${id_configuracion}: ${p.nombre_template}: ${msg}`,
        );
      }
    }
  }
  return { creadas, errores };
}

module.exports = {
  enviarAvisoRegla,
  obtenerDatosAviso,
  asegurarPlantillasWaba,
};
