/**
 * enlacePagoImporsuit.js
 *
 * Plantillas de cobranza de Imporsuit: resuelve, para el destinatario, el
 * saldo vencido de su cartera (db_2) y el valor del botón "Pagar".
 *
 * El mensaje NO lleva el link de Stripe: el Checkout vence en ~24 h y un
 * WhatsApp se abre cuando se abre. El botón apunta a una URL fija de
 * Imporsuit — `Cobros/pagar/{uuid_cartera}` — que recién al hacer clic crea
 * (o reusa) el cobro por el saldo de ESE momento y lo registra en
 * `cobros_links`, que es lo que el webhook de Stripe necesita para acreditar.
 * Por eso acá solo se LEE db_2: generar el cobro desde Node duplicaría
 * CobrosModel.php y dejaría dos sitios decidiendo cuánto se cobra.
 *
 * Fuente única para el envío manual (whatsapp.controller.js) y para el
 * programado / API pública (whatsapp.service.js).
 */

const { db_2 } = require('../database/config');
const { resolverClienteDestino } = require('./encuestaTemplateLink');
const {
  resolverEmailImporsuitPorCelular,
} = require('../services/imporsuitEmailSync.service');

/**
 * Plantillas que llevan enlace de pago, por conexión. Mismo formato que
 * `dropi_plantillas_config.parametros_json`: la posición en `body` es el
 * {{n}} y cada botón URL dinámico declara qué variable lleva.
 *
 * Variables disponibles: nombre, monto, cuotas, uuid_cartera.
 */
const PLANTILLAS_ENLACE_PAGO = {
  242: {
    saldo_pendiente_pago: {
      body: ['nombre', 'monto'],
      buttons: [{ index: 0, variable: 'uuid_cartera' }],
    },
  },
};

/** Base del botón URL de la plantilla en Meta (el {{1}} es el uuid). */
const URL_BOTON_PAGO = 'https://new.imporsuitpro.com/Cobros/pagar/{{1}}';

class SinSaldoVencidoError extends Error {
  constructor(message, code = 'SIN_SALDO_VENCIDO') {
    super(message);
    this.name = 'SinSaldoVencidoError';
    this.code = code;
  }
}

function plantillaDeEnlacePago(idConfiguracion, nombreTemplate) {
  const porConfig = PLANTILLAS_ENLACE_PAGO[Number(idConfiguracion)];
  if (!porConfig) return null;
  return porConfig[String(nombreTemplate || '').trim()] || null;
}

/**
 * Saldo VENCIDO del usuario de Imporsuit con ese correo. Mismo criterio que
 * CobrosModel::resolverDeuda('deuda') — estado 0, con saldo y fecha_limite
 * pasada — pero acá solo sirve para MOSTRAR el monto en el mensaje: lo que
 * se cobra lo vuelve a calcular Imporsuit al hacer clic.
 */
async function consultarSaldoVencido(email) {
  const correo = String(email || '').trim();
  if (!correo) return null;

  const [row] = await db_2.query(
    `SELECT u.id_users, u.nombre_users, MIN(ca.uuid) AS uuid_cartera,
            COUNT(*) AS cuotas, ROUND(SUM(c.monto_pendiente), 2) AS total
       FROM users u
       INNER JOIN carteras ca ON ca.id_users = u.id_users
       INNER JOIN cuenta_por_pagar c ON c.id_cartera = ca.id_cartera
      WHERE u.email_users = ? AND u.eliminado = 0
        AND c.estado = 0 AND c.monto_pendiente > 0
        AND c.fecha_limite < CURDATE()
      GROUP BY u.id_users, u.nombre_users`,
    { replacements: [correo], type: db_2.QueryTypes.SELECT },
  );

  if (!row || !(Number(row.total) > 0) || !row.uuid_cartera) return null;

  return {
    id_users: Number(row.id_users),
    nombre_users: row.nombre_users || '',
    uuid_cartera: String(row.uuid_cartera),
    cuotas: Number(row.cuotas) || 0,
    total: Number(row.total),
  };
}

/**
 * Valores de las variables para el destinatario.
 *
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
 * que el asesor haya escrito en esos campos no cuenta: monto y uuid salen de
 * la cartera. El header (si lo hay) se conserva tal cual.
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
  URL_BOTON_PAGO,
  SinSaldoVencidoError,
  plantillaDeEnlacePago,
  consultarSaldoVencido,
  resolverEnlacePagoTemplate,
  construirParametrosEnlacePago,
  forzarEnlacePagoEnComponents,
};
