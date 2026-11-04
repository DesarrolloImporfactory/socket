'use strict';

/**
 * scripts/darAccesoPermanente.js
 *
 * Da acceso permanente (plan gratuito sin vencimiento) a una o varias cuentas
 * y, si se pide, cancela YA su suscripción en Stripe para que no se les
 * cobre más. Es lo mismo que hace el botón «Activar acceso permanente» del
 * Panel de Usuarios (super admin), pero desde la terminal: sirve cuando el
 * panel corre con la llave de prueba de Stripe (local) y la suscripción del
 * cliente vive en live.
 *
 * Misma lógica que el panel: services/acceso_permanente.service.js. Marca
 * permanente antes de cancelar, anula las facturas abiertas de la sub (si no,
 * Stripe las reintenta) y deja la nota en Seguimientos.
 *
 * Uso:
 *   node scripts/darAccesoPermanente.js --email a@b.com [--email c@d.com]   (solo muestra)
 *   node scripts/darAccesoPermanente.js --usuario 3414 --plan 22 --cancelar-stripe --aplicar
 *
 *   --email <correo>     email_propietario de la cuenta (repetible)
 *   --usuario <id>       id_usuario (repetible)
 *   --plan <id_plan>     plan base; si falta, el actual o Avanzado (4)
 *   --cancelar-stripe    cancela la suscripción viva en Stripe
 *   --aplicar            sin esto no escribe nada
 *
 * Usa SIEMPRE la llave live de Stripe (STRIPE_SECRET_KEY): las suscripciones
 * de los clientes viven ahí.
 */
require('dotenv').config();
const Stripe = require('stripe');
const { db } = require('../src/database/config');
const {
  activarAccesoPermanente,
  subViva,
  leerUsuario,
} = require('../src/services/acceso_permanente.service');

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const cancelarStripe = args.includes('--cancelar-stripe');
const valoresDe = (flag) =>
  args.reduce(
    (acc, a, i) => (a === flag && args[i + 1] ? [...acc, args[i + 1]] : acc),
    [],
  );
const emails = valoresDe('--email').map((e) => e.trim().toLowerCase());
const ids = valoresDe('--usuario').map(Number).filter(Boolean);
const idPlan = Number(valoresDe('--plan')[0]) || null;

if (!emails.length && !ids.length) {
  console.error('Indica al menos --email <correo> o --usuario <id>.');
  process.exit(1);
}

const key = process.env.STRIPE_SECRET_KEY || '';
if (cancelarStripe && !key.startsWith('sk_live_')) {
  console.error('STRIPE_SECRET_KEY no es una llave live (sk_live_). Abortado.');
  process.exit(1);
}
const stripe = cancelarStripe
  ? new Stripe(key, { apiVersion: '2024-06-20' })
  : null;

const fechaDe = (ts) =>
  ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;

async function resolverCuentas() {
  const out = [];
  for (const id of ids) {
    const u = await leerUsuario(id);
    if (u) out.push(u);
    else console.warn(`   ! no existe el usuario ${id}`);
  }
  for (const email of emails) {
    const rows = await db.query(
      `SELECT id_usuario FROM usuarios_chat_center
        WHERE LOWER(email_propietario) = ? LIMIT 1`,
      { replacements: [email], type: db.QueryTypes.SELECT },
    );
    if (!rows.length) {
      console.warn(`   ! no hay cuenta con el correo ${email}`);
      continue;
    }
    out.push(await leerUsuario(rows[0].id_usuario));
  }
  return out;
}

async function describirSub(u) {
  if (!u.stripe_subscription_id) return 'sin suscripción en Stripe';
  if (!stripe) {
    return `${u.stripe_subscription_id} (${u.stripe_subscription_status || 'sin status'} en BD)`;
  }
  try {
    const sub = await stripe.subscriptions.retrieve(u.stripe_subscription_id);
    const item = sub.items?.data?.[0];
    const fin = sub.current_period_end || item?.current_period_end || null;
    const monto =
      item?.price?.unit_amount != null
        ? `$${(item.price.unit_amount / 100).toFixed(2)} ${String(item.price.currency || '').toUpperCase()}`
        : '?';
    return `${sub.id} status=${sub.status} ${monto}/${item?.price?.recurring?.interval || '?'} próximo cobro=${fechaDe(fin)}${sub.cancel_at_period_end ? ' (cancelación programada)' : ''}`;
  } catch (e) {
    return `${u.stripe_subscription_id} (Stripe: ${e?.message})`;
  }
}

(async () => {
  const cuentas = await resolverCuentas();
  if (!cuentas.length) process.exit(1);

  console.log(
    `${aplicar ? 'APLICANDO' : 'SOLO MUESTRA (sin --aplicar)'} · ${cuentas.length} cuenta(s) · plan ${idPlan || 'actual/Avanzado'} · cancelar Stripe: ${cancelarStripe ? 'sí' : 'no'}\n`,
  );

  const ejecutor = { id: null, nombre: 'scripts/darAccesoPermanente.js' };

  for (const u of cuentas) {
    console.log(
      `▸ ${u.id_usuario} ${u.nombre} <${u.email_propietario}> · plan ${u.id_plan} · estado ${u.estado} · permanente ${u.permanente}`,
    );
    console.log(`   Stripe: ${await describirSub(u)}`);
    if (cancelarStripe && !subViva(u)) {
      console.log('   (la sub no está viva según la BD: no se cancela nada)');
    }

    const r = await activarAccesoPermanente({
      id_usuario: u.id_usuario,
      id_plan: idPlan,
      cancelar_stripe: cancelarStripe,
      stripe,
      ejecutor,
      aplicar,
    });

    if (!aplicar) {
      console.log(
        `   haría: permanente=1, estado=activo, plan ${r.plan.nombre_plan} (${r.plan.id_plan})${r.cancelar_stripe ? ', cancelar sub en Stripe y anular facturas abiertas' : ''}\n`,
      );
      continue;
    }

    console.log(`   ✔ ${r.asunto}: ${r.contenido}`);
    if (r.stripe_error) console.log(`   ✖ Stripe: ${r.stripe_error}`);
    const despues = await leerUsuario(u.id_usuario);
    console.log(
      `   ahora: permanente ${despues.permanente} · estado ${despues.estado} · plan ${despues.id_plan} · stripe ${despues.stripe_subscription_status}\n`,
    );
  }
  process.exit(0);
})().catch((e) => {
  console.error('FALLO', e?.message || e);
  process.exit(1);
});
