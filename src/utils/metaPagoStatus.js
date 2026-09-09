const axios = require('axios');
const { db } = require('../database/config');

/* Reactivación automática de `configuraciones.metodo_pago`.
   ─────────────────────────────────────────────────────────────
   El webhook de Meta pone metodo_pago = 0 cuando una plantilla rebota con el
   error 131042 (problema con el método de pago del WABA). Hasta ahora la
   única forma de volver a 1 era un switch manual en el administrador, así que
   el aviso "Acción requerida en Meta" seguía saliendo días después de que el
   cliente arreglara la facturación.

   Meta expone el estado real con `GET /{phone_number_id}?fields=health_status`
   (Messaging Health Status): devuelve can_send_message por entidad (número,
   WABA, negocio, app) con valores AVAILABLE / LIMITED / BLOCKED y, cuando algo
   está BLOCKED, los errores con su descripción. Con eso comprobamos sin tener
   que gastar una plantilla, igual que la sonda de OpenAI (openai_reintentar).

   Tres puntos de entrada, mismo veredicto:
   - webhook: cada status sent/delivered/read con metodo_pago = 0 dispara una
     comprobación (con candado de 10 min por cuenta para no golpear a Graph en
     cada mensaje).
   - GET_DATA_ADMIN: antes de mostrar el aviso en /chat y /contactos se
     comprueba una vez (mismo candado); si Meta ya está bien, el aviso no sale.
   - botón "ya lo corregí": el cliente pide la comprobación al instante, sin
     candado. */

const VIGENCIA_CANDADO_MS = 10 * 60 * 1000;
const MAX_ENTRADAS = 5000;
const ULTIMA_COMPROBACION = new Map(); // id_configuracion → ts

function graphVersion() {
  return process.env.GRAPH_VERSION || 'v22.0';
}

function limpiarCandado() {
  if (ULTIMA_COMPROBACION.size < MAX_ENTRADAS) return;
  const limite = Date.now() - VIGENCIA_CANDADO_MS;
  for (const [id, ts] of ULTIMA_COMPROBACION) {
    if (ts < limite) ULTIMA_COMPROBACION.delete(id);
  }
}

function describirBloqueo(entities = []) {
  const bloqueadas = entities.filter((e) => e?.can_send_message === 'BLOCKED');
  const partes = [];
  for (const ent of bloqueadas) {
    const errores = Array.isArray(ent.errors) ? ent.errors : [];
    if (!errores.length) {
      partes.push(`${ent.entity_type || 'ENTIDAD'} bloqueada`);
      continue;
    }
    for (const err of errores) {
      const desc = err?.error_description || err?.error_code || 'sin detalle';
      partes.push(`${ent.entity_type || 'ENTIDAD'}: ${desc}`);
    }
  }
  return partes.join(' | ').slice(0, 500);
}

/* Consulta health_status y traduce a un veredicto:
   { ok: true }                          → Meta deja enviar (AVAILABLE/LIMITED)
   { ok: false, motivo: 'bloqueado' }    → sigue bloqueado; detalle con la razón
   { ok: false, motivo: 'sin_conexion' } → la cuenta no tiene id_telefono/token
   { ok: false, motivo: 'indeterminado' }→ Graph no respondió o el token falló */
async function consultarSaludMeta(configuracion) {
  const nodo = configuracion?.id_telefono || configuracion?.id_whatsapp;
  const token = configuracion?.token;
  if (!nodo || !token) {
    return {
      ok: false,
      motivo: 'sin_conexion',
      detalle: 'La conexión no tiene número o token de WhatsApp vinculado.',
    };
  }

  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/${graphVersion()}/${nodo}`,
      {
        params: { fields: 'health_status', access_token: token },
        timeout: 10000,
      },
    );

    const salud = data?.health_status;
    if (!salud || !salud.can_send_message) {
      return {
        ok: false,
        motivo: 'indeterminado',
        detalle: 'Meta no devolvió health_status para esta conexión.',
      };
    }

    if (salud.can_send_message === 'BLOCKED') {
      return {
        ok: false,
        motivo: 'bloqueado',
        detalle: describirBloqueo(salud.entities),
        estado: salud.can_send_message,
      };
    }

    return { ok: true, estado: salud.can_send_message };
  } catch (err) {
    const meta = err?.response?.data?.error;
    const detalle = (meta?.message || err.message || '').slice(0, 500);
    return { ok: false, motivo: 'indeterminado', detalle };
  }
}

async function marcarMetodoPagoActivo(id_configuracion) {
  await db.query(`UPDATE configuraciones SET metodo_pago = 1 WHERE id = ?`, {
    replacements: [id_configuracion],
    type: db.QueryTypes.UPDATE,
  });
}

/* Comprobación sin candado. Reactiva en BD si Meta deja enviar y devuelve el
   veredicto completo para que el endpoint le ponga texto al cliente. */
async function comprobarYReactivarMetodoPago(configuracion, origen = '') {
  const veredicto = await consultarSaludMeta(configuracion);
  if (veredicto.ok) {
    await marcarMetodoPagoActivo(configuracion.id);
    // Para que el resto del mismo ciclo (webhook, GET_DATA_ADMIN) vea el dato.
    if (typeof configuracion === 'object') configuracion.metodo_pago = 1;
    console.log(
      `[metodoPago] cfg ${configuracion.id} reactivada (${veredicto.estado})${origen ? ` · ${origen}` : ''}`,
    );
  } else {
    console.log(
      `[metodoPago] cfg ${configuracion.id} sigue en 0 · ${veredicto.motivo}${veredicto.detalle ? `: ${veredicto.detalle}` : ''}${origen ? ` · ${origen}` : ''}`,
    );
  }
  return veredicto;
}

/* Versión con candado para los caminos automáticos. Devuelve true solo si
   reactivó en esta llamada. Nunca lanza: un fallo aquí no puede tumbar el
   webhook ni la carga del chat. */
async function reactivarMetodoPagoSiCorresponde(configuracion, origen = '') {
  try {
    if (!configuracion?.id) return false;
    if (Number(configuracion.metodo_pago) !== 0) return false;

    const ahora = Date.now();
    const ultima = ULTIMA_COMPROBACION.get(configuracion.id) || 0;
    if (ahora - ultima < VIGENCIA_CANDADO_MS) return false;
    limpiarCandado();
    ULTIMA_COMPROBACION.set(configuracion.id, ahora);

    const veredicto = await comprobarYReactivarMetodoPago(
      configuracion,
      origen,
    );
    return !!veredicto.ok;
  } catch (err) {
    console.error('[metodoPago] error comprobando:', err.message);
    return false;
  }
}

/* Cuando vuelve a llegar un 131042 se suelta el candado: el siguiente status
   bueno debe poder comprobar de inmediato, no esperar 10 minutos. */
function olvidarComprobacion(id_configuracion) {
  ULTIMA_COMPROBACION.delete(id_configuracion);
}

module.exports = {
  consultarSaludMeta,
  comprobarYReactivarMetodoPago,
  reactivarMetodoPagoSiCorresponde,
  olvidarComprobacion,
};
