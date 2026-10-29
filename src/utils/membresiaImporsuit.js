/* ═══════════════════════════════════════════════════════════
   Membresía Imporsuit de un contacto (para las tarjetas del kanban)

   La cuenta de soporte atiende a gente que YA es usuaria de Imporsuit. El
   teléfono con el que escriben es el `whatsapp` de su(s) plataforma(s) en la
   BD legacy (db_2: plataformas → usuario_plataforma → users). La membresía
   vale 1 año desde users.fecha_suscripcion (misma regla que usa la cabecera
   de /chat); plataformas.fecha_caduca está vacía en toda la tabla, no sirve.

   Un mismo WhatsApp cuelga de varios users (tiendas distintas): gana la
   suscripción más reciente y los paquetes se OR-ean.

   Comparamos por la cola de 9 dígitos, igual que imporchat_cartera: los
   números viven con y sin código de país (+593 9…, 09…).
   ═══════════════════════════════════════════════════════════ */
const { db_2 } = require('../database/config');

const DIA_MS = 24 * 60 * 60 * 1000;

const digitos = (v) => String(v || '').replace(/\D/g, '');
const cola = (v, n = 9) => digitos(v).slice(-n);
/* 0000000000 / 1111111111 harían match con cualquiera: no se consultan. */
const colaUtil = (c) => c.length >= 8 && new Set(c).size >= 4;

const ymd = (d) => d.toISOString().slice(0, 10);

/** Calcula el estado de la membresía a partir de la fecha de suscripción. */
function calcularMembresia(fecha_suscripcion) {
  if (!fecha_suscripcion) return null;
  const inicio = new Date(fecha_suscripcion);
  if (Number.isNaN(inicio.getTime())) return null;
  const vence = new Date(inicio);
  vence.setFullYear(vence.getFullYear() + 1);
  const dias = Math.ceil((vence - Date.now()) / DIA_MS);
  return {
    fecha_suscripcion: ymd(inicio),
    vence_el: ymd(vence),
    dias_restantes: dias,
    vencida: dias <= 0,
  };
}

/**
 * Resuelve la membresía de un lote de celulares.
 * @returns {Map<string, object>} clave = cola de 9 dígitos del celular.
 */
async function resolverMembresias(celulares = [], { lanzar = false } = {}) {
  const out = new Map();
  const colas = [...new Set(celulares.map((c) => cola(c)).filter(colaUtil))];
  if (!colas.length) return out;

  let rows = [];
  try {
    rows = await db_2.query(
      `SELECT RIGHT(REGEXP_REPLACE(p.whatsapp, '[^0-9]', ''), 9) AS cola,
              u.fecha_suscripcion, u.plan_actual,
              u.importacion, u.ecommerce, u.membresia_ecommerce, u.productos
         FROM plataformas p
         JOIN usuario_plataforma up ON up.id_plataforma = p.id_plataforma
         JOIN users u ON u.id_users = up.id_usuario
        WHERE u.eliminado = 0
          AND RIGHT(REGEXP_REPLACE(p.whatsapp, '[^0-9]', ''), 9) IN (:colas)`,
      { replacements: { colas }, type: db_2.QueryTypes.SELECT },
    );
  } catch (err) {
    // El bot (ver_mi_membresia) necesita distinguir «no tiene» de «no pude preguntar».
    if (lanzar) throw err;
    console.error('[membresiaImporsuit] No se pudo consultar:', err.message);
    return out;
  }

  for (const r of rows) {
    const prev = out.get(r.cola);
    const masReciente =
      !prev?.fecha_suscripcion_raw ||
      (r.fecha_suscripcion &&
        new Date(r.fecha_suscripcion) > new Date(prev.fecha_suscripcion_raw));
    out.set(r.cola, {
      fecha_suscripcion_raw: masReciente
        ? r.fecha_suscripcion
        : prev.fecha_suscripcion_raw,
      plan_actual: masReciente ? r.plan_actual : prev.plan_actual,
      paquetes: {
        importacion: Number(prev?.paquetes?.importacion || r.importacion) === 1,
        ecommerce: Number(prev?.paquetes?.ecommerce || r.ecommerce) === 1,
        membresia_ecommerce:
          Number(
            prev?.paquetes?.membresia_ecommerce || r.membresia_ecommerce,
          ) === 1,
        productos: Number(prev?.paquetes?.productos || r.productos) === 1,
      },
    });
  }

  for (const [k, v] of out) {
    const calc = calcularMembresia(v.fecha_suscripcion_raw);
    out.set(k, {
      ...(calc || {
        fecha_suscripcion: null,
        vence_el: null,
        dias_restantes: null,
        vencida: null,
      }),
      plan_actual: v.plan_actual || null,
      paquetes: v.paquetes,
    });
  }
  return out;
}

/**
 * Membresía por el correo de la cuenta (users.email_users). La usa el bot
 * (ver_mi_membresia) cuando el WhatsApp no está en plataformas.whatsapp: el
 * 27-oct, de 60 alumnos de la 265, 3 salían por el número y 40 por el correo
 * de su cuenta IMPORCHAT. Misma regla: gana la suscripción más reciente.
 * @returns {Promise<object|null>}
 */
async function resolverMembresiaPorCorreo(correo, { lanzar = false } = {}) {
  const email = String(correo || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  let rows = [];
  try {
    rows = await db_2.query(
      `SELECT u.fecha_suscripcion, u.plan_actual,
              u.importacion, u.ecommerce, u.membresia_ecommerce, u.productos
         FROM users u
        WHERE u.eliminado = 0 AND LOWER(u.email_users) = :email
        LIMIT 20`,
      { replacements: { email }, type: db_2.QueryTypes.SELECT },
    );
  } catch (err) {
    if (lanzar) throw err;
    console.error('[membresiaImporsuit] No se pudo consultar por correo:', err.message);
    return null;
  }
  if (!rows.length) return null;
  const reciente = rows.reduce((a, r) =>
    r.fecha_suscripcion && (!a.fecha_suscripcion || new Date(r.fecha_suscripcion) > new Date(a.fecha_suscripcion)) ? r : a,
  );
  const alguno = (k) => rows.some((r) => Number(r[k]) === 1);
  return {
    ...(calcularMembresia(reciente.fecha_suscripcion) || { fecha_suscripcion: null, vence_el: null, dias_restantes: null, vencida: null }),
    plan_actual: reciente.plan_actual || null,
    paquetes: {
      importacion: alguno('importacion'),
      ecommerce: alguno('ecommerce'),
      membresia_ecommerce: alguno('membresia_ecommerce'),
      productos: alguno('productos'),
    },
  };
}

/** Adorna `items` (tarjetas con celular_cliente) con `membresia` o null. */
async function adornarMembresias(items = []) {
  const mapa = await resolverMembresias(items.map((i) => i.celular_cliente));
  items.forEach((i) => {
    i.membresia = mapa.get(cola(i.celular_cliente)) || null;
  });
}

module.exports = { resolverMembresias, resolverMembresiaPorCorreo, adornarMembresias, calcularMembresia };
