'use strict';

/**
 * scripts/darMesesGratis.js
 *
 * Da N meses gratis de un plan creando una suscripción REAL en Stripe con
 * trial de N meses y cobro mensual después. Es lo mismo que el botón «Meses
 * gratis» del Panel de Usuarios (super admin), pero desde la terminal: sirve
 * cuando el panel corre con la llave de prueba de Stripe (local) y el
 * cliente vive en live.
 *
 * Caso que lo originó (2026-11-04): una cuenta que llegó de
 * Imporsuit (3 meses gratis), tenía ImporChat $39 cancelada por pago fallido
 * y había que pasarlo a Plan Comunidad con 3 meses gratis y cobro desde el
 * cuarto, con el webhook llevando la sub como cualquier otra.
 *
 * Misma lógica que el panel: services/acceso_permanente.service.js
 * (crearSuscripcionCortesia): cancela la sub viva anterior sin prorrateo,
 * anula las facturas abiertas del customer, crea la sub con la metadata del
 * checkout, apunta la BD y deja la nota en Seguimientos.
 *
 * Uso:
 *   node scripts/darMesesGratis.js --email a@b.com --plan 22 --meses 3            (solo muestra)
 *   node scripts/darMesesGratis.js --email a@b.com --plan 22 --meses 3 --aplicar
 *   node scripts/darMesesGratis.js --usuario 3317 --plan 22 --meses 3 --aplicar
 *
 * Usa SIEMPRE la llave live de Stripe (STRIPE_SECRET_KEY).
 */
require('dotenv').config();
const Stripe = require('stripe');
const { db } = require('../src/database/config');
const {
  crearSuscripcionCortesia,
  leerUsuario,
} = require('../src/services/acceso_permanente.service');

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const valorDe = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const email = (valorDe('--email') || '').trim().toLowerCase();
const idUsuarioArg = Number(valorDe('--usuario')) || null;
const idPlan = Number(valorDe('--plan')) || null;
const meses = Number(valorDe('--meses')) || 3;

if ((!email && !idUsuarioArg) || !idPlan) {
  console.error(
    'Uso: --email <correo> | --usuario <id>, --plan <id_plan>, [--meses N] [--aplicar]',
  );
  process.exit(1);
}

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_live_')) {
  console.error('STRIPE_SECRET_KEY no es una llave live (sk_live_). Abortado.');
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

(async () => {
  let id_usuario = idUsuarioArg;
  if (!id_usuario) {
    const rows = await db.query(
      `SELECT id_usuario FROM usuarios_chat_center
        WHERE LOWER(email_propietario) = ? LIMIT 1`,
      { replacements: [email], type: db.QueryTypes.SELECT },
    );
    if (!rows.length) {
      console.error(`No hay cuenta con el correo ${email}`);
      process.exit(1);
    }
    id_usuario = rows[0].id_usuario;
  }

  const u = await leerUsuario(id_usuario);
  console.log(
    `${aplicar ? 'APLICANDO' : 'SOLO MUESTRA (sin --aplicar)'} · plan ${idPlan} · ${meses} mes(es) gratis\n`,
  );
  console.log(
    `▸ ${u.id_usuario} ${u.nombre} <${u.email_propietario}> · plan ${u.id_plan} · estado ${u.estado} · permanente ${u.permanente}`,
  );
  console.log(
    `   sub actual: ${u.stripe_subscription_id || 'ninguna'} (${u.stripe_subscription_status || '-'})`,
  );

  const ejecutor = { id: null, nombre: 'scripts/darMesesGratis.js' };
  const r = await crearSuscripcionCortesia({
    stripe,
    id_usuario,
    id_plan: idPlan,
    meses,
    ejecutor,
    aplicar,
  });

  console.log(
    `   plan: ${r.plan.nombre_plan} ($${r.plan.precio_plan}/mes, ${r.plan.id_price})`,
  );
  console.log(`   customer: ${r.customer_id || 'se crearía uno nuevo'}`);
  console.log(
    `   tarjeta: ${r.tarjeta ? `${r.tarjeta.marca} ${r.tarjeta.ultimos4} vence ${r.tarjeta.vence}` : 'ninguna (el primer cobro quedará pendiente)'}`,
  );
  console.log(`   gratis hasta: ${r.trial_end.toISOString().slice(0, 10)}`);
  console.log(`   cancelar sub viva: ${r.cancelar_anterior || 'no'}`);
  console.log(
    `   facturas abiertas a anular: ${r.facturas_a_anular.length ? r.facturas_a_anular.map((f) => `${f.id} $${f.monto}`).join(', ') : 'ninguna'}`,
  );

  if (!aplicar) {
    console.log('\n(no se escribió nada)');
    process.exit(0);
  }

  console.log(`\n   ✔ ${r.asunto}`);
  console.log(`   ${r.contenido}`);
  const despues = await leerUsuario(id_usuario);
  console.log(
    `   ahora: plan ${despues.id_plan} · estado ${despues.estado} · sub ${despues.stripe_subscription_id} (${despues.stripe_subscription_status}) · renueva ${despues.fecha_renovacion}`,
  );
  process.exit(0);
})().catch((e) => {
  console.error('FALLO', e?.message || e);
  process.exit(1);
});
