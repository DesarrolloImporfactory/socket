/**
 * encuestaTemplateLink.js
 *
 * Une las plantillas de Meta con las encuestas: resuelve los parámetros
 * configurados en `encuestas.template_parameters` (incluido el link único
 * por cliente) y registra el envío cuando un asesor manda la plantilla a
 * mano desde el chat.
 *
 * Fuente única de verdad para el webhook (webhoook_contactos.controller.js)
 * y para el envío manual (whatsapp.controller.js / encuestas.controller.js).
 */

const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');

const FRONTEND_URL =
  process.env.FRONTEND_URL || 'https://chatcenter.imporfactory.app';

/**
 * Link público y único de la encuesta para un cliente concreto.
 * encuestas_publico resuelve al cliente por el ?cid=.
 */
function construirLinkEncuesta(idEncuesta, idCliente) {
  if (!idEncuesta || !idCliente) return '';
  return `${FRONTEND_URL}/encuesta-publica/${idEncuesta}?cid=${idCliente}`;
}

/**
 * Parse seguro de template_parameters (JSON string, array ya parseado,
 * null o vacío).
 */
function parseTemplateParams(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** ¿El placeholder configurado es el link de la encuesta? */
function esPlaceholderLink(placeholder) {
  return /\{link(_encuesta)?\}/i.test(String(placeholder ?? ''));
}

/**
 * Reemplaza {nombre}, {apellido}, {email}, {telefono} y {link_encuesta}
 * (alias {link}). Limpia espacios sobrantes cuando el placeholder queda vacío.
 */
function resolverPlaceholders(str, contacto = {}, opts = {}) {
  if (typeof str !== 'string') return String(str ?? '');

  // Compatibilidad legacy: defaultValue solo aplica a {nombre}
  const fallbackNombre = opts.defaultValue || '';

  const nombre = (contacto.nombre || '').trim() || fallbackNombre;
  const apellido = (contacto.apellido || '').trim();
  const email = (contacto.email || '').trim();
  const telefono = (contacto.telefono || '').trim();
  const linkEncuesta = (contacto.link_encuesta || '').trim();

  return (
    str
      // {link_encuesta} va primero para dejar el orden explícito
      .replace(/\{link_encuesta\}/gi, linkEncuesta)
      .replace(/\{link\}/gi, linkEncuesta)
      .replace(/\{nombre\}/gi, nombre)
      .replace(/\{apellido\}/gi, apellido)
      .replace(/\{email\}/gi, email)
      .replace(/\{telefono\}/gi, telefono)
      // limpieza estética: "Hola !" → "Hola!"
      .replace(/\s+([!,.?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

/**
 * Encuesta activa de esa conexión que usa esta plantilla de Meta.
 * Devuelve null si la plantilla no pertenece a ninguna encuesta.
 */
async function buscarEncuestaPorTemplate({ idConfiguracion, nombreTemplate }) {
  const cfg = Number(idConfiguracion) || 0;
  const tpl = String(nombreTemplate || '').trim();
  if (!cfg || !tpl) return null;

  const [row] = await db.query(
    `SELECT e.id AS id_encuesta, e.nombre AS nombre_encuesta, e.tipo,
            e.template_fuera_24h, e.template_parameters
       FROM encuestas_conexiones ec
       JOIN encuestas e ON e.id = ec.id_encuesta
      WHERE ec.id_configuracion = :cfg
        AND ec.activa = 1
        AND e.activa = 1
        AND e.deleted_at IS NULL
        AND e.template_fuera_24h = :tpl
      ORDER BY e.id DESC
      LIMIT 1`,
    { replacements: { cfg, tpl }, type: QueryTypes.SELECT },
  );

  return row || null;
}

/**
 * Cliente destinatario dentro de la conexión. Se busca primero por teléfono
 * (es el destinatario real del envío) y solo si no aparece se usa el id.
 */
async function resolverClienteDestino({
  idConfiguracion,
  telefono,
  idClienteChatCenter,
}) {
  const cfg = Number(idConfiguracion) || 0;
  if (!cfg) return null;

  const tel = String(telefono || '').replace(/\D/g, '');

  if (tel) {
    const [porTel] = await db.query(
      `SELECT id, nombre_cliente, apellido_cliente, email_cliente,
              celular_cliente, id_encargado
         FROM clientes_chat_center
        WHERE id_configuracion = :cfg
          AND deleted_at IS NULL
          AND (REGEXP_REPLACE(celular_cliente, '[^0-9]', '') = :tel
               OR telefono_limpio = :tel)
        ORDER BY id DESC
        LIMIT 1`,
      { replacements: { cfg, tel }, type: QueryTypes.SELECT },
    );
    if (porTel) return porTel;
  }

  const idCli = Number(idClienteChatCenter) || 0;
  if (idCli) {
    const [porId] = await db.query(
      `SELECT id, nombre_cliente, apellido_cliente, email_cliente,
              celular_cliente, id_encargado
         FROM clientes_chat_center
        WHERE id = :id AND id_configuracion = :cfg AND deleted_at IS NULL
        LIMIT 1`,
      { replacements: { id: idCli, cfg }, type: QueryTypes.SELECT },
    );
    if (porId) return porId;
  }

  return null;
}

/**
 * Resuelve los parámetros de la plantilla para un cliente concreto.
 *
 * @returns null si la plantilla no es de una encuesta o no hay cliente.
 *          Si hay match: { id_encuesta, nombre_encuesta, cliente, link,
 *                          parametros: [{ posicion, placeholder, valor, es_link }] }
 */
async function resolverParametrosEncuestaTemplate({
  idConfiguracion,
  nombreTemplate,
  telefono,
  idClienteChatCenter,
}) {
  const encuesta = await buscarEncuestaPorTemplate({
    idConfiguracion,
    nombreTemplate,
  });
  if (!encuesta) return null;

  const cliente = await resolverClienteDestino({
    idConfiguracion,
    telefono,
    idClienteChatCenter,
  });
  if (!cliente) return null;

  const link = construirLinkEncuesta(encuesta.id_encuesta, cliente.id);

  const contacto = {
    nombre: cliente.nombre_cliente || '',
    apellido: cliente.apellido_cliente || '',
    email: cliente.email_cliente || '',
    telefono: cliente.celular_cliente || '',
    link_encuesta: link,
  };

  const parametros = parseTemplateParams(encuesta.template_parameters).map(
    (p, idx) => ({
      posicion: idx + 1, // {{1}}, {{2}}, ...
      placeholder: String(p ?? ''),
      valor: resolverPlaceholders(String(p ?? ''), contacto),
      es_link: esPlaceholderLink(p),
    }),
  );

  return {
    id_encuesta: encuesta.id_encuesta,
    nombre_encuesta: encuesta.nombre_encuesta,
    tipo: encuesta.tipo,
    link,
    cliente: {
      id: cliente.id,
      nombre: contacto.nombre,
      apellido: contacto.apellido,
      email: contacto.email,
      telefono: contacto.telefono,
      id_encargado: cliente.id_encargado || null,
    },
    parametros,
  };
}

/**
 * Fuerza el link correcto en los parámetros del body antes de enviar a Meta.
 * El asesor puede editar el input, pero el ?cid= no se negocia: si no
 * corresponde al destinatario la respuesta se asocia al cliente equivocado.
 *
 * @returns { components, corregidos }
 */
function forzarLinkEnComponents(components, parametros) {
  const comps = Array.isArray(components) ? components : [];
  const linkParams = (parametros || []).filter((p) => p.es_link && p.valor);
  if (!linkParams.length) return { components: comps, corregidos: 0 };

  let corregidos = 0;

  const nuevos = comps.map((comp) => {
    if (String(comp?.type || '').toLowerCase() !== 'body') return comp;

    const params = Array.isArray(comp.parameters) ? [...comp.parameters] : [];

    linkParams.forEach((lp) => {
      const idx = lp.posicion - 1;
      if (idx < 0 || idx >= params.length) return;
      if (String(params[idx]?.text || '') === lp.valor) return;

      params[idx] = { ...(params[idx] || {}), type: 'text', text: lp.valor };
      corregidos += 1;
    });

    return { ...comp, parameters: params };
  });

  return { components: nuevos, corregidos };
}

/**
 * Registra el envío manual de la encuesta hecho por un asesor.
 * Si ya existe una fila abierta (pendiente/enviada/recibida) del mismo
 * cliente+encuesta no se duplica: el webhook pudo haberla creado antes.
 *
 * Nunca lanza: es fire-and-forget desde el envío del template.
 */
async function registrarEnvioEncuestaManual({
  idEncuesta,
  idConfiguracion,
  cliente,
  origen = 'chat_manual',
}) {
  try {
    if (!idEncuesta || !idConfiguracion || !cliente?.id) {
      return { registrado: false, razon: 'datos_incompletos' };
    }

    const [abierta] = await db.query(
      `SELECT id, estado FROM encuestas_respuestas
        WHERE id_encuesta = :enc AND id_cliente_chat_center = :cli
          AND estado IN ('pendiente', 'enviada', 'recibida')
        ORDER BY created_at DESC LIMIT 1`,
      {
        replacements: { enc: idEncuesta, cli: cliente.id },
        type: QueryTypes.SELECT,
      },
    );

    if (abierta) {
      // Ya hay una fila esperando respuesta (webhook o reenvío): se reutiliza
      await db.query(
        `UPDATE encuestas_respuestas SET updated_at = NOW() WHERE id = :id`,
        { replacements: { id: abierta.id }, type: QueryTypes.UPDATE },
      );
      return {
        registrado: true,
        reutilizada: true,
        id_respuesta: abierta.id,
        estado: abierta.estado,
      };
    }

    const [idRespuesta] = await db.query(
      `INSERT INTO encuestas_respuestas
        (id_encuesta, id_configuracion, id_cliente_chat_center, id_encargado,
         source, score, respuestas, datos_contacto, estado)
       VALUES (:enc, :cfg, :cli, :encargado, 'link', NULL, '{}', :datos, 'enviada')`,
      {
        replacements: {
          enc: idEncuesta,
          cfg: idConfiguracion,
          cli: cliente.id,
          encargado: cliente.id_encargado || null,
          datos: JSON.stringify({
            nombre: cliente.nombre || null,
            apellido: cliente.apellido || null,
            email: cliente.email || null,
            telefono: cliente.telefono || null,
            origen,
          }),
        },
        type: QueryTypes.INSERT,
      },
    );

    return { registrado: true, reutilizada: false, id_respuesta: idRespuesta };
  } catch (err) {
    console.error(
      '[encuestaTemplateLink] Error registrando envío manual:',
      err.message,
    );
    return { registrado: false, razon: 'error', error: err.message };
  }
}

module.exports = {
  FRONTEND_URL,
  construirLinkEncuesta,
  parseTemplateParams,
  esPlaceholderLink,
  resolverPlaceholders,
  buscarEncuestaPorTemplate,
  resolverClienteDestino,
  resolverParametrosEncuestaTemplate,
  forzarLinkEnComponents,
  registrarEnvioEncuestaManual,
};
