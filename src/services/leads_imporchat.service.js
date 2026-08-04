'use strict';

/**
 * services/leads_imporchat.service.js
 *
 * Marca, en el sidebar del chat, si la persona que escribe YA es cliente de
 * ImporChat.
 *
 * PARA QUÉ
 * La configuración de lanzamientos recibe cientos de mensajes de gente que vio
 * una campaña. Al agente le sirve saber de un vistazo a quién le está hablando:
 * un cliente que ya paga no necesita el mismo discurso que alguien que nunca
 * abrió cuenta.
 *
 * SOLO PARA UNA CONFIGURACIÓN
 * Se aplica únicamente a la config de lanzamientos (env
 * CHAT_LEADS_ID_CONFIGURACION). En el resto de cuentas el cliente del chat no
 * tiene por qué ser un usuario de la plataforma, y el cruce no significaría
 * nada.
 *
 * CÓMO SE CRUZA (medido sobre los datos reales de la config 242)
 * Dos llaves, porque ninguna alcanza sola:
 *   - email : 1.280 de 8.453 chats. Es la llave fuerte — 4.123 emails
 *             distintos, sin ninguno genérico que domine.
 *   - teléfono: aporta 34 cruces más que el email no encuentra. Es débil
 *             porque solo 461 de 1.743 usuarios tienen whatsapp_lead cargado.
 * Juntas cruzan ~15% de los chats. El resto son leads sin cuenta, que es
 * justamente lo que el color rojo debe señalar.
 *
 * EL TELÉFONO NO SE COMPARA DIRECTO
 * `celular_cliente` viene en E.164 sin + (593980444106) y `whatsapp_lead` se
 * guarda en formato local, a veces con cero inicial (0939143823 o 995348493).
 * Por eso se generan candidatos locales a partir del número del chat y se
 * buscan esos, en vez de intentar normalizar los 1.743 usuarios en cada query.
 */

const { db } = require('../database/config');

const ID_CONFIGURACION_LEADS = Number(
  process.env.CHAT_LEADS_ID_CONFIGURACION || 242,
);

/**
 * Prefijos país de la región. Se prueban de más largo a más corto para que
 * `521` (México vía WhatsApp) gane sobre `52`, y `593` sobre `59`.
 */
const CODIGOS_PAIS = [
  '521',
  '593',
  '591',
  '502',
  '503',
  '504',
  '505',
  '506',
  '507',
  '598',
  '595',
  '549',
  '57',
  '58',
  '56',
  '54',
  '52',
  '51',
  '1',
].sort((a, b) => b.length - a.length);

/** Del número del chat (E.164) saca los formatos locales con los que pudo registrarse. */
const candidatosLocales = (celular) => {
  const d = String(celular || '').replace(/\D/g, '');
  if (d.length < 8) return [];

  const out = new Set();
  for (const cc of CODIGOS_PAIS) {
    if (d.startsWith(cc) && d.length - cc.length >= 8) {
      const local = d.slice(cc.length);
      out.add(local);
      out.add('0' + local);
      // México y Argentina: WhatsApp intercala un 1 / 9 que el registro no tiene
      if (cc === '521' || cc === '549') out.add(local.replace(/^[19]/, ''));
    }
  }
  out.add(d);
  return [...out].filter((v) => v.length >= 8 && v.length <= 15);
};

/**
 * ¿Este usuario está usando ImporChat hoy?
 *
 * Verde solo si de verdad lo está ocupando: cuenta permanente, suscripción viva
 * en Stripe, o plan vigente por fecha. Tener una fila en la tabla no basta —
 * los que vienen de cursos existen desde el primer login, y pintarlos de verde
 * sin tarjeta ni plan vigente sería exactamente el dato equivocado.
 */
const STRIPE_MUERTO = new Set([
  'canceled',
  'incomplete_expired',
  'unpaid',
  'incomplete',
]);

const evaluarUsuario = (u) => {
  if (!u) return { estado: 'sin_cuenta', motivo: 'sin_cuenta' };

  if (Number(u.permanente) === 1)
    return { estado: 'activo', motivo: 'permanente' };

  const estadoCuenta = String(u.estado || '').toLowerCase();
  if (estadoCuenta === 'suspendido' || estadoCuenta === 'cancelado')
    return { estado: 'inactivo', motivo: `cuenta_${estadoCuenta}` };

  const statusStripe = String(u.stripe_subscription_status || '')
    .toLowerCase()
    .trim();
  const subViva =
    !!u.stripe_subscription_id && !STRIPE_MUERTO.has(statusStripe);

  const ahora = Date.now();
  const renovacionVigente =
    u.fecha_renovacion && ahora <= new Date(u.fecha_renovacion).getTime();
  const enTrial = u.trial_end && ahora <= new Date(u.trial_end).getTime();

  if (enTrial) return { estado: 'activo', motivo: 'trial' };
  if (subViva && renovacionVigente)
    return { estado: 'activo', motivo: 'suscrito' };
  if (subViva) return { estado: 'activo', motivo: 'suscrito_por_cobrar' };
  if (renovacionVigente && estadoCuenta === 'activo')
    return { estado: 'activo', motivo: 'plan_vigente' };

  // Existe la cuenta pero no hay nada que la sostenga: típicamente el alumno de
  // cursos que nunca registró tarjeta y ya se le venció la cortesía.
  return {
    estado: 'inactivo',
    motivo: u.stripe_subscription_id ? 'suscripcion_terminada' : 'sin_tarjeta',
  };
};

/**
 * Enriquece una página de chats con `cliente_imporchat`.
 *
 * Muta y devuelve el mismo array. Si la config no es la de lanzamientos, o
 * falla la consulta, devuelve los chats intactos: este dato es informativo y
 * jamás puede impedir que el sidebar cargue.
 */
const marcarClientesImporchat = async (chats, id_configuracion) => {
  if (Number(id_configuracion) !== ID_CONFIGURACION_LEADS) return chats;
  if (!Array.isArray(chats) || chats.length === 0) return chats;

  try {
    const emails = new Set();
    const telefonos = new Set();

    for (const c of chats) {
      const mail = String(c.email_cliente || '')
        .toLowerCase()
        .trim();
      if (mail.includes('@')) emails.add(mail);
      candidatosLocales(c.celular_cliente).forEach((t) => telefonos.add(t));
    }

    if (emails.size === 0 && telefonos.size === 0) return chats;

    // Una sola consulta por página (~10 chats), no una por chat.
    const condiciones = [];
    const replacements = {};
    if (emails.size) {
      condiciones.push('LOWER(TRIM(u.email_propietario)) IN (:emails)');
      replacements.emails = [...emails];
    }
    if (telefonos.size) {
      condiciones.push(
        "REPLACE(REPLACE(REPLACE(u.whatsapp_lead,' ',''),'-',''),'+','') IN (:telefonos)",
      );
      replacements.telefonos = [...telefonos];
    }

    const [usuarios] = await db.query(
      `SELECT u.id_usuario, u.email_propietario, u.whatsapp_lead, u.estado,
              u.permanente, u.id_plan, u.trial_end, u.fecha_renovacion,
              u.stripe_subscription_id, u.stripe_subscription_status,
              p.nombre_plan
         FROM usuarios_chat_center u
         LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
        WHERE ${condiciones.join(' OR ')}`,
      { replacements },
    );

    const porEmail = new Map();
    const porTelefono = new Map();
    for (const u of usuarios || []) {
      const mail = String(u.email_propietario || '')
        .toLowerCase()
        .trim();
      if (mail && !porEmail.has(mail)) porEmail.set(mail, u);
      const tel = String(u.whatsapp_lead || '').replace(/\D/g, '');
      if (tel && !porTelefono.has(tel)) porTelefono.set(tel, u);
    }

    for (const c of chats) {
      const mail = String(c.email_cliente || '')
        .toLowerCase()
        .trim();

      // El email primero: es la llave fuerte y la que el propio cliente
      // escribió al registrarse.
      let u = mail.includes('@') ? porEmail.get(mail) : null;
      let via = u ? 'email' : null;

      if (!u) {
        for (const t of candidatosLocales(c.celular_cliente)) {
          const encontrado = porTelefono.get(t);
          if (encontrado) {
            u = encontrado;
            via = 'whatsapp';
            break;
          }
        }
      }

      const { estado, motivo } = evaluarUsuario(u);
      c.cliente_imporchat = {
        estado, // activo | inactivo | sin_cuenta
        motivo,
        via, // por dónde se encontró: email | whatsapp | null
        id_usuario: u?.id_usuario || null,
        plan: u?.nombre_plan || null,
      };
    }

    return chats;
  } catch (e) {
    console.warn('[leadsImporchat] no se pudo marcar clientes:', e?.message);
    return chats;
  }
};

module.exports = {
  marcarClientesImporchat,
  ID_CONFIGURACION_LEADS,
  candidatosLocales,
  evaluarUsuario,
};
