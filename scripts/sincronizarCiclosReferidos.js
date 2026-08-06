'use strict';

/**
 * scripts/sincronizarCiclosReferidos.js
 *
 * Pone `referido_ciclos_previos` en el número REAL de facturas pagadas que
 * lleva cada referido, leyéndolo de Stripe.
 *
 * POR QUÉ HACE FALTA
 * La migración de comunidades dejó a todos en 2 —un valor plano— para que
 * comisionaran de inmediato. El efecto no deseado: quien solo había pagado una
 * vez veía su SEGUNDA factura contada como ciclo 3, y esa es justamente la que
 * según la regla del programa sirve para recuperar el subsidio de los $5 del
 * primer mes. Con el conteo real, el ciclo 3 es de verdad el tercer mes pagado.
 *
 * Es idempotente: correrlo dos veces deja el mismo resultado. Y se puede volver
 * a correr cada vez que se atribuya un lote nuevo de usuarios.
 *
 * OJO CON LA LLAVE DE STRIPE
 * Fuera de producción usa la llave de test, donde los clientes reales no
 * existen y todos saldrían en 0. Para leer los datos de verdad:
 *   NODE_ENV=production node scripts/sincronizarCiclosReferidos.js
 *
 * USO
 *   ... sincronizarCiclosReferidos.js                          → simulacro, no escribe
 *   ... sincronizarCiclosReferidos.js --aplicar                → escribe
 *   ... sincronizarCiclosReferidos.js --atribuir correo@x.com=2711 --aplicar
 *        ↑ además ata ese correo al referidor indicado antes de sincronizar
 */

require('dotenv').config();

const Stripe = require('stripe');
const { db } = require('../src/database/config');

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const STRIPE_SECRET = isProd
  ? process.env.STRIPE_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });
const SELECT = { type: db.QueryTypes.SELECT };

/** Mismo criterio que el reporte histórico y que el webhook: solo cobros reales. */
async function contarFacturasPagadas(customerId) {
  let total = 0;
  let starting_after;

  for (let pagina = 0; pagina < 12; pagina++) {
    const lote = await stripe.invoices.list({
      customer: customerId,
      status: 'paid',
      limit: 100,
      ...(starting_after && { starting_after }),
    });

    for (const inv of lote.data) {
      const devuelto = Number(inv.post_payment_credit_notes_amount || 0);
      const neto = Number(inv.amount_paid || 0) - devuelto;
      const sub =
        inv.subscription ||
        inv.parent?.subscription_details?.subscription ||
        inv.lines?.data?.[0]?.subscription ||
        null;
      if (neto > 0 && sub) total++;
    }

    if (!lote.has_more) break;
    starting_after = lote.data[lote.data.length - 1]?.id;
    if (!starting_after) break;
  }

  return total;
}

async function atribuir(spec, aplicar) {
  const [correo, refIdRaw] = String(spec).split('=');
  const idReferidor = Number(refIdRaw);
  const email = String(correo || '').trim().toLowerCase();

  if (!email || !idReferidor) {
    console.log('  ⚠ formato inválido, se esperaba correo@dominio=ID_REFERIDOR');
    return;
  }

  const [usuario] = await db.query(
    `SELECT id_usuario, nombre, email_propietario, referido_por, id_comunidad
       FROM usuarios_chat_center
      WHERE LOWER(email_propietario) = :email
      LIMIT 1`,
    { replacements: { email }, ...SELECT },
  );

  if (!usuario) {
    console.log(`  ⚠ no existe ninguna cuenta con ${email}`);
    return;
  }
  if (usuario.id_usuario === idReferidor) {
    console.log('  ⚠ nadie se refiere a sí mismo; se omite');
    return;
  }
  if (usuario.referido_por) {
    console.log(
      `  · ${usuario.nombre} ya estaba atribuido a #${usuario.referido_por}; no se pisa`,
    );
    return;
  }

  const [referidor] = await db.query(
    `SELECT nombre FROM usuarios_chat_center WHERE id_usuario = :id`,
    { replacements: { id: idReferidor }, ...SELECT },
  );
  if (!referidor) {
    console.log(`  ⚠ no existe el referidor #${idReferidor}`);
    return;
  }

  console.log(
    `  ${aplicar ? '✓' : '·'} ${usuario.nombre} (#${usuario.id_usuario}) → ${referidor.nombre} (#${idReferidor})`,
  );

  if (aplicar) {
    await db.query(
      `UPDATE usuarios_chat_center
          SET referido_por = :ref, referido_en = NOW(), referido_origen = 'comunidad'
        WHERE id_usuario = :id AND referido_por IS NULL`,
      { replacements: { ref: idReferidor, id: usuario.id_usuario } },
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');

  console.log(
    `\n${aplicar ? '### APLICANDO CAMBIOS ###' : '### SIMULACRO — no se escribe nada ###'}` +
      `   (Stripe ${isProd ? 'PROD' : 'TEST'})\n`,
  );

  // 1) Atribuciones puntuales
  const specs = args
    .map((a, i) => (a === '--atribuir' ? args[i + 1] : null))
    .filter(Boolean);

  if (specs.length) {
    console.log('Atribuciones:');
    for (const s of specs) await atribuir(s, aplicar);
    console.log('');
  }

  // 2) Sincronizar ciclos contra Stripe
  const referidos = await db.query(
    `SELECT u.id_usuario, u.nombre, u.id_costumer, u.estado,
            u.referido_ciclos_previos AS actual,
            r.nombre AS referidor
       FROM usuarios_chat_center u
       JOIN usuarios_chat_center r ON r.id_usuario = u.referido_por
      WHERE u.referido_por IS NOT NULL
      ORDER BY u.referido_por, u.id_usuario`,
    SELECT,
  );

  if (!referidos.length) {
    console.log('No hay referidos atribuidos.');
    return;
  }

  console.log(`Ciclos reales de ${referidos.length} referidos:\n`);

  let cambios = 0;
  for (const r of referidos) {
    let real = 0;
    if (r.id_costumer) {
      try {
        real = await contarFacturasPagadas(r.id_costumer);
      } catch (e) {
        console.log(`  ⚠ ${r.nombre}: ${e?.message} — se omite`);
        continue;
      }
    }

    const actual = Number(r.actual || 0);
    const igual = actual === real;
    if (!igual) cambios++;

    console.log(
      `  ${igual ? ' ' : aplicar ? '✓' : '·'} ${String(r.nombre).slice(0, 34).padEnd(34)} ` +
        `#${String(r.id_usuario).padEnd(5)} ${String(r.estado).padEnd(9)} ` +
        `${actual} → ${real}${igual ? '  (sin cambio)' : ''}`,
    );

    if (aplicar && !igual) {
      await db.query(
        `UPDATE usuarios_chat_center
            SET referido_ciclos_previos = :n WHERE id_usuario = :id`,
        { replacements: { n: real, id: r.id_usuario } },
      );
    }
  }

  console.log(
    `\n${cambios} de ${referidos.length} ${aplicar ? 'actualizados' : 'cambiarían'}.` +
      (aplicar ? '' : '\nCorre otra vez con --aplicar para escribirlo.\n'),
  );
}

main()
  .catch((e) => {
    console.error('Error:', e?.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
