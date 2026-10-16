/**
 * enlacePagoImporsuit.js
 *
 * Plantillas de cobranza de Imporsuit: resuelve, para el destinatario, el
 * saldo vencido de su cartera (db_2) y el valor del enlace "Pagar".
 *
 * El mensaje NO lleva el link de Stripe: el Checkout vence en ~24 h y un
 * WhatsApp se abre cuando se abre. El enlace apunta a una URL fija de
 * Imporsuit — `Cobros/pagar/{uuid_cartera}` — que recién al hacer clic crea
 * (o reusa) el cobro por el saldo de ESE momento y lo registra en
 * `cobros_links`, que es lo que el webhook de Stripe necesita para acreditar.
 * Por eso acá solo se LEE db_2: generar el cobro desde Node duplicaría
 * CobrosModel.php y dejaría dos sitios decidiendo cuánto se cobra. Y por eso
 * el pago cae en la cuenta de Stripe de Imporsuit (la del PHP), no en la de
 * ImporChat.
 *
 * Fuente única para el envío manual (whatsapp.controller.js), para el
 * programado / API pública (whatsapp.service.js) y para el aviso automático
 * que dispara Imporsuit cuando un suspendido intenta ingresar
 * (public_mensajes.controller.js → POST /cobros/aviso-pago).
 */

const { db, db_2 } = require('../database/config');
const { resolverClienteDestino } = require('./encuestaTemplateLink');
const {
  resolverEmailImporsuitPorCelular,
} = require('../services/imporsuitEmailSync.service');

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

/**
 * Plantillas que llevan enlace de pago, por conexión. Mismo formato que
 * `dropi_plantillas_config.parametros_json`: la posición en `body` es el
 * {{n}} y cada botón URL dinámico declara qué variable lleva.
 *
 * Variables disponibles: nombre, monto, cuotas, uuid_cartera, url_pago.
 */
const PLANTILLAS_ENLACE_PAGO = {
  242: {
    // Manual / programada: el enlace va en un botón URL (el {{1}} del botón
    // es el uuid de la cartera).
    saldo_pendiente_pago: {
      body: ['nombre', 'monto'],
      buttons: [{ index: 0, variable: 'uuid_cartera' }],
    },
    // Aviso automático al suspendido que intenta entrar a Imporsuit: el
    // enlace completo va en el cuerpo ({{3}}). Sin botones.
    aviso_pago_pendiente: {
      body: ['nombre', 'monto', 'url_pago'],
      buttons: [],
    },
  },
};

/** Plantilla que manda el aviso automático si Imporsuit no indica otra. */
const PLANTILLA_AVISO_PAGO_DEFAULT = 'aviso_pago_pendiente';

/** Base del enlace de pago de Imporsuit (el {{1}} es el uuid de la cartera). */
const URL_BOTON_PAGO = 'https://new.imporsuitpro.com/Cobros/pagar/{{1}}';

const urlPagoCartera = (uuid) =>
  URL_BOTON_PAGO.replace('{{1}}', encodeURIComponent(String(uuid || '')));

class SinSaldoVencidoError extends Error {
  constructor(message, code = 'SIN_SALDO_VENCIDO') {
    super(message);
    this.name = 'SinSaldoVencidoError';
    this.code = code;
  }
}

/** Todas las plantillas de cobro de una conexión, o null si no tiene. */
function plantillasEnlacePagoDeConfig(idConfiguracion) {
  return PLANTILLAS_ENLACE_PAGO[Number(idConfiguracion)] || null;
}

function plantillaDeEnlacePago(idConfiguracion, nombreTemplate) {
  const porConfig = plantillasEnlacePagoDeConfig(idConfiguracion);
  if (!porConfig) return null;
  return porConfig[String(nombreTemplate || '').trim()] || null;
}

/**
 * Saldo VENCIDO del usuario de Imporsuit. Mismo criterio que
 * CobrosModel::resolverDeuda('deuda') — estado 0, con saldo y fecha_limite
 * pasada — pero acá solo sirve para MOSTRAR el monto en el mensaje: lo que
 * se cobra lo vuelve a calcular Imporsuit al hacer clic.
 *
 * Se busca por correo (la llave común con los contactos del chat) o por
 * id_users (lo que manda Imporsuit cuando avisa un intento de ingreso).
 */
async function consultarSaldoVencidoPor({ email, idUsers }) {
  const correo = String(email || '').trim();
  const idU = Number(idUsers) || 0;
  if (!correo && !idU) return null;

  const [row] = await db_2.query(
    `SELECT u.id_users, u.nombre_users, u.email_users, MIN(ca.uuid) AS uuid_cartera,
            COUNT(*) AS cuotas, ROUND(SUM(c.monto_pendiente), 2) AS total
       FROM users u
       INNER JOIN carteras ca ON ca.id_users = u.id_users
       INNER JOIN cuenta_por_pagar c ON c.id_cartera = ca.id_cartera
      WHERE ${idU ? 'u.id_users = ?' : 'u.email_users = ?'} AND u.eliminado = 0
        AND c.estado = 0 AND c.monto_pendiente > 0
        AND c.fecha_limite < CURDATE()
      GROUP BY u.id_users, u.nombre_users, u.email_users`,
    { replacements: [idU || correo], type: db_2.QueryTypes.SELECT },
  );

  if (!row || !(Number(row.total) > 0) || !row.uuid_cartera) return null;

  return {
    id_users: Number(row.id_users),
    nombre_users: row.nombre_users || '',
    email: String(row.email_users || '').trim(),
    uuid_cartera: String(row.uuid_cartera),
    cuotas: Number(row.cuotas) || 0,
    total: Number(row.total),
  };
}

async function consultarSaldoVencido(email) {
  return consultarSaldoVencidoPor({ email });
}

/**
 * Quién es, en esta conexión, el cliente de Imporsuit al que hay que
 * avisarle. Parte de la cuenta (id_users o correo) y busca el contacto del
 * chat por correo; si no hay contacto con celular, usa el WhatsApp que el
 * cliente registró en su plataforma de Imporsuit (el envío creará el chat).
 *
 * @returns null si la cuenta no existe en Imporsuit.
 */
async function resolverDestinatarioImporsuit({ idConfiguracion, idUsers, email }) {
  const cfg = Number(idConfiguracion) || 0;
  const idU = Number(idUsers) || 0;
  const correo = String(email || '').trim();
  if (!cfg || (!idU && !correo)) return null;

  const [usuario] = await db_2.query(
    `SELECT id_users, nombre_users, email_users
       FROM users
      WHERE ${idU ? 'id_users = ?' : 'email_users = ?'} AND eliminado = 0
      ORDER BY id_users ASC
      LIMIT 1`,
    { replacements: [idU || correo], type: db_2.QueryTypes.SELECT },
  );
  if (!usuario) return null;

  const emailUsuario = String(usuario.email_users || '').trim();

  let contacto = null;
  if (emailUsuario) {
    [contacto] = await db.query(
      `SELECT id, nombre_cliente, celular_cliente, email_cliente
         FROM clientes_chat_center
        WHERE id_configuracion = ?
          AND deleted_at IS NULL
          AND LOWER(TRIM(email_cliente)) = LOWER(?)
          AND COALESCE(celular_cliente, '') <> ''
        ORDER BY id DESC
        LIMIT 1`,
      { replacements: [cfg, emailUsuario], type: db.QueryTypes.SELECT },
    );
  }

  let telefono = onlyDigits(contacto?.celular_cliente);
  if (!telefono) {
    const [plat] = await db_2.query(
      `SELECT p.whatsapp
         FROM usuario_plataforma up
         INNER JOIN plataformas p ON p.id_plataforma = up.id_plataforma
        WHERE up.id_usuario = ? AND COALESCE(p.whatsapp, '') <> ''
        ORDER BY p.id_plataforma DESC
        LIMIT 1`,
      { replacements: [Number(usuario.id_users)], type: db_2.QueryTypes.SELECT },
    );
    telefono = onlyDigits(plat?.whatsapp);
  }

  return {
    id_users: Number(usuario.id_users),
    email: emailUsuario,
    nombre_users: usuario.nombre_users || '',
    telefono: telefono || null,
    id_cliente_chat_center: contacto ? Number(contacto.id) : null,
    nombre_contacto: String(contacto?.nombre_cliente || '').trim() || null,
  };
}

/**
 * Último mensaje de cobro (cualquier plantilla de cobro de la conexión,
 * manual o automática) enviado a ese cliente dentro de la ventana. Sirve
 * de candado para que el aviso automático no se repita en cada intento de
 * ingreso ni pise lo que un asesor ya mandó a mano.
 *
 * Los salientes guardan en `celular_recibe` el id del contacto, así que se
 * reúnen todos los contactos de la conexión con ese número (puede haber
 * duplicados) y se busca por ellos.
 */
async function ultimoAvisoPagoCobro({
  idConfiguracion,
  telefono,
  idCliente = null,
  horas = 72,
}) {
  const cfg = Number(idConfiguracion) || 0;
  const plantillas = Object.keys(plantillasEnlacePagoDeConfig(cfg) || {});
  const tel = onlyDigits(telefono);
  if (!cfg || !plantillas.length || (!tel && !idCliente)) return null;

  const filtros = [];
  const repl = { cfg };
  if (tel) {
    filtros.push(
      `REGEXP_REPLACE(celular_cliente, '[^0-9]', '') = :tel OR telefono_limpio = :tel`,
    );
    repl.tel = tel;
  }
  if (idCliente) {
    filtros.push('id = :idCliente');
    repl.idCliente = Number(idCliente);
  }

  const contactos = await db.query(
    `SELECT id FROM clientes_chat_center
      WHERE id_configuracion = :cfg AND deleted_at IS NULL AND (${filtros.join(' OR ')})`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );
  const ids = contactos.map((c) => String(c.id));
  if (!ids.length) return null;

  const [row] = await db.query(
    `SELECT created_at, template_name
       FROM mensajes_clientes
      WHERE id_configuracion = :cfg
        AND rol_mensaje = 1
        AND celular_recibe IN (:ids)
        AND template_name IN (:plantillas)
        AND created_at >= DATE_SUB(NOW(), INTERVAL :horas HOUR)
      ORDER BY created_at DESC
      LIMIT 1`,
    {
      replacements: { cfg, ids, plantillas, horas: Math.max(1, Number(horas) || 72) },
      type: db.QueryTypes.SELECT,
    },
  );
  return row || null;
}

/**
 * Valores de las variables para el destinatario.
 *
 * @param emailConocido correo de la cuenta de Imporsuit cuando ya se sabe
 *        (aviso automático): evita depender de que el contacto del chat
 *        tenga el correo cargado o de que su número coincida con la plataforma.
 * @returns null si la plantilla no es de enlace de pago.
 * @throws SinSaldoVencidoError si lo es pero no hay nada que cobrarle: se
 *         corta el envío, porque decirle "tienes pagos pendientes" a quien
 *         está al día es peor que no mandar nada.
 */
async function resolverEnlacePagoTemplate({
  idConfiguracion,
  nombreTemplate,
  telefono,
  idClienteChatCenter,
  emailConocido = null,
}) {
  const mapeo = plantillaDeEnlacePago(idConfiguracion, nombreTemplate);
  if (!mapeo) return null;

  const cliente = await resolverClienteDestino({
    idConfiguracion,
    telefono,
    idClienteChatCenter,
  });

  // El correo es la llave común con Imporsuit. Si el contacto no lo tiene,
  // se intenta por el WhatsApp de su plataforma.
  const email =
    String(emailConocido || '').trim() ||
    String(cliente?.email_cliente || '').trim() ||
    (await resolverEmailImporsuitPorCelular(
      telefono || cliente?.celular_cliente,
    ));

  if (!email) {
    throw new SinSaldoVencidoError(
      'El contacto no tiene correo y su número no coincide con ninguna cuenta de Imporsuit: no se puede calcular su saldo pendiente.',
      'CONTACTO_SIN_CUENTA_IMPORSUIT',
    );
  }

  const saldo = await consultarSaldoVencido(email);
  if (!saldo) {
    throw new SinSaldoVencidoError(
      `${email} no tiene saldo vencido en Imporsuit: no se envía la plantilla de cobro.`,
    );
  }

  const nombre =
    String(cliente?.nombre_cliente || '').trim() ||
    String(saldo.nombre_users).trim().split(/\s+/)[0] ||
    'cliente';

  return {
    mapeo,
    email,
    saldo,
    valores: {
      nombre,
      monto: saldo.total.toFixed(2),
      cuotas: String(saldo.cuotas),
      uuid_cartera: saldo.uuid_cartera,
      url_pago: urlPagoCartera(saldo.uuid_cartera),
    },
  };
}

/** Lista plana [body..., botones...]: la forma de template_parameters. */
function construirParametrosEnlacePago({ mapeo, valores }) {
  const botones = [...(mapeo.buttons || [])].sort(
    (a, b) => Number(a.index) - Number(b.index),
  );
  return [
    ...(mapeo.body || []).map((v) => String(valores[v] ?? '-')),
    ...botones.map((b) => String(valores[b.variable] ?? '-')),
  ];
}

/**
 * Pisa body y botones URL del payload de Graph con los valores reales. Lo
 * que el asesor haya escrito en esos campos no cuenta: monto y enlace salen
 * de la cartera. El header (si lo hay) se conserva tal cual.
 */
function forzarEnlacePagoEnComponents(components, { mapeo, valores }) {
  const tipo = (c) => String(c?.type || '').toLowerCase();

  const resto = (Array.isArray(components) ? components : []).filter(
    (c) => tipo(c) !== 'body' && tipo(c) !== 'button',
  );

  const body = {
    type: 'body',
    parameters: (mapeo.body || []).map((v) => ({
      type: 'text',
      text: String(valores[v] ?? '-'),
    })),
  };

  const botones = (mapeo.buttons || []).map((b) => ({
    type: 'button',
    sub_type: 'url',
    index: String(b.index),
    parameters: [{ type: 'text', text: String(valores[b.variable] ?? '-') }],
  }));

  return [...resto, body, ...botones];
}

module.exports = {
  PLANTILLAS_ENLACE_PAGO,
  PLANTILLA_AVISO_PAGO_DEFAULT,
  URL_BOTON_PAGO,
  SinSaldoVencidoError,
  urlPagoCartera,
  plantillasEnlacePagoDeConfig,
  plantillaDeEnlacePago,
  consultarSaldoVencido,
  consultarSaldoVencidoPor,
  resolverDestinatarioImporsuit,
  ultimoAvisoPagoCobro,
  resolverEnlacePagoTemplate,
  construirParametrosEnlacePago,
  forzarEnlacePagoEnComponents,
};
