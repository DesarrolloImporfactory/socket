/**
 * scripts/otorgarCombo.js
 *
 * Activa un combo (Combo Implementación: $297, 6 meses gratis del plan e
 * ImporKiller) a un correo, desde la terminal y contra Stripe LIVE. Es la
 * misma lógica del botón «Activar combo» del dashboard del super admin
 * (services/combos.service.js); sirve cuando el panel local usa la llave de
 * prueba o cuando hay que hacerlo antes de un despliegue.
 *
 * Uso:
 *   node scripts/otorgarCombo.js --email cliente@correo.com            (vista previa)
 *   node scripts/otorgarCombo.js --email cliente@correo.com --aplicar
 *
 * Opciones:
 *   --combo <clave>   por defecto implementacion_297
 *   --plan <id>       plan a dejar; sin él conserva el suyo si ya incluye el
 *                     chat, o pone el del combo
 *   --meses <n>       por defecto los del combo
 *   --sumar           cuenta los meses desde donde termina lo que ya tiene
 *                     cubierto (por defecto, desde hoy)
 *   --repetir         permite otorgarlo aunque ya se le haya dado antes
 *   --por "<nombre>"  quién lo activa, para la nota de Seguimientos
 */
require('dotenv').config();
// Los precios de los complementos se eligen por entorno: aquí siempre live.
process.env.NODE_ENV = 'production';

const Stripe = require('stripe');
const combos = require('../src/services/combos.service');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const valor = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_live_')) {
  console.error('STRIPE_SECRET_KEY no es una llave live (sk_live_). Abortado.');
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

const email = valor('email');
if (!email) {
  console.error('Falta --email');
  process.exit(1);
}

const params = {
  stripe,
  email,
  clave: valor('combo') || 'implementacion_297',
  id_plan: parseInt(valor('plan'), 10) || null,
  meses: valor('meses'),
  desde: flag('sumar') ? 'sumar' : 'hoy',
};

const fecha = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

(async () => {
  const p = await combos.prepararCombo(params);
  console.log(`\n${p.combo.nombre} ($${p.combo.precio}) → ${p.email}`);
  console.log(`  Caso:            ${p.caso}`);
  console.log(
    `  Cuenta:          ${p.cuenta ? `#${p.cuenta.id_usuario} ${p.cuenta.nombre} · ${p.cuenta.plan_actual || 'sin plan'} · sub ${p.cuenta.stripe_subscription_status || 'ninguna'}` : 'no existe'}`,
  );
  console.log(`  Plan que queda:  ${p.plan.nombre} ($${p.plan.precio}/mes)`);
  console.log(
    `  Complementos:    ${p.addons.map((a) => `${a.nombre} ($${a.precio}/mes)`).join(', ') || '—'}`,
  );
  console.log(
    `  Tarjeta:         ${p.tarjeta ? `${p.tarjeta.marca} ${p.tarjeta.ultimos4}` : 'sin tarjeta'}`,
  );
  console.log(`  Cubierto hoy:    ${fecha(p.cubierto_hasta)}`);
  console.log(
    `  Gratis hasta:    ${p.gratis_hasta ? fecha(p.gratis_hasta) : `${p.combo.meses} meses desde que registre la tarjeta`}`,
  );
  console.log(`  Después paga:    $${p.cobro_mensual_despues}/mes`);
  for (const a of p.avisos) console.log(`  ! ${a}`);

  if (!flag('aplicar')) {
    console.log('\nVista previa. Agrega --aplicar para activarlo.\n');
    process.exit(0);
  }

  const r = await combos.otorgarCombo({
    ...params,
    repetir: flag('repetir'),
    ejecutor: { id: null, nombre: valor('por') || 'Equipo (script)' },
  });
  console.log(`\n${r.mensaje}`);
  console.log(
    `  estado=${r.estado} modo=${r.modo || '—'} sub=${r.stripe_subscription_id || '—'}\n`,
  );
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e?.message || e);
  process.exit(1);
});
