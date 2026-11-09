'use strict';

/**
 * scripts/repararCortesiaDosMeses.js
 *
 * Completa a 3 meses la cortesía de los alumnos que quedaron con 2.
 *
 * Entre el 20-ago-2026 (883f614) y el 09-sep-2026 (f4c081b) la constante
 * MESES_CORTESIA_ESTUDIANTE de auth.controller valió 2. Como la cortesía se
 * vuelve a aplicar en cada login desde Imporsuit (fecha_inicio = NOW()), los
 * alumnos cuyo ÚLTIMO login SSO cayó en esa ventana quedaron con
 * fecha_renovacion = fecha_inicio + 2 meses: 129 cuentas al 09-11-2026, casi
 * todas ya vencidas (el front las manda a /planes). Daniel decidió darles los
 * 3 meses completos.
 *
 * Por cada cuenta del plan 21 con DATEDIFF(fecha_renovacion, fecha_inicio)
 * entre 55 y 65 días y fecha_inicio dentro de la ventana:
 *   - Sin suscripción de Stripe → fecha_renovacion = fecha_inicio + 3 meses.
 *   - Con suscripción viva (trialing / active / past_due) → se mueve el
 *     trial_end en Stripe a esa misma fecha (sin prorrateo) y se refleja en la
 *     BD; el webhook customer.subscription.updated la dejaría igual.
 *   - Con suscripción cancelada → solo la BD (no hay nada que extender en
 *     Stripe); si quiere seguir, tendrá que registrar tarjeta otra vez.
 *   - Si la nueva fecha ya pasó, no hay nada que recuperar: se lista y se
 *     deja como está.
 *
 * Uso:
 *   node scripts/repararCortesiaDosMeses.js             → solo muestra
 *   node scripts/repararCortesiaDosMeses.js --aplicar   → escribe BD y Stripe
 *
 * Usa SIEMPRE la llave live de Stripe (STRIPE_SECRET_KEY).
 */
require('dotenv').config();
const Stripe = require('stripe');
const { db } = require('../src/database/config');

const aplicar = process.argv.includes('--aplicar');
const MESES = 3;
const VENTANA_DESDE = '2026-08-20 00:00:00';
const VENTANA_HASTA = '2026-09-09 23:59:59';
const VIVAS = new Set(['trialing', 'active', 'past_due']);

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_live_')) {
  console.error('STRIPE_SECRET_KEY no es una llave live (sk_live_). Abortado.');
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

async function main() {
  const filas = await db.query(
    `SELECT id_usuario, email_propietario, estado,
            stripe_subscription_id, stripe_subscription_status,
            DATE_FORMAT(fecha_inicio, '%Y-%m-%d %H:%i') inicio,
            DATE_FORMAT(fecha_renovacion, '%Y-%m-%d') renov_actual,
            DATE_FORMAT(DATE_ADD(fecha_inicio, INTERVAL :meses MONTH), '%Y-%m-%d %H:%i') renov_nueva,
            UNIX_TIMESTAMP(DATE_ADD(fecha_inicio, INTERVAL :meses MONTH)) renov_nueva_ts
       FROM usuarios_chat_center
      WHERE id_plan = 21
        AND IFNULL(permanente, 0) = 0
        AND DATEDIFF(fecha_renovacion, fecha_inicio) BETWEEN 55 AND 65
        AND fecha_inicio BETWEEN :desde AND :hasta
      ORDER BY fecha_inicio`,
    {
      replacements: { meses: MESES, desde: VENTANA_DESDE, hasta: VENTANA_HASTA },
      type: db.QueryTypes.SELECT,
    },
  );

  console.log(
    `${aplicar ? 'APLICANDO' : 'SIMULACIÓN'} · ${filas.length} cuentas con 2 meses en la ventana ${VENTANA_DESDE.slice(0, 10)} → ${VENTANA_HASTA.slice(0, 10)}\n`,
  );

  const ahora = Math.floor(Date.now() / 1000);
  const resumen = { bd: 0, stripe: 0, canceladas: 0, yaPasada: 0, errores: 0 };

  for (const f of filas) {
    const tag = `#${f.id_usuario} ${f.email_propietario}`;
    const nuevaTs = Number(f.renov_nueva_ts);

    if (nuevaTs <= ahora) {
      // Con 3 meses también estaría vencida: no hay nada que devolverle.
      resumen.yaPasada++;
      console.log(`· ${tag}: ${f.renov_actual} → ${f.renov_nueva.slice(0, 10)} ya pasó, se deja igual`);
      continue;
    }

    let accion = 'BD';
    let subViva = null;

    if (f.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(f.stripe_subscription_id);
        if (VIVAS.has(sub.status)) {
          subViva = sub;
          accion = `Stripe(${sub.status}) + BD`;
        } else {
          accion = `BD (sub ${sub.status})`;
          resumen.canceladas++;
        }
      } catch (e) {
        resumen.errores++;
        console.log(`✗ ${tag}: no se pudo leer ${f.stripe_subscription_id}: ${e.message}`);
        continue;
      }
    }

    console.log(`${aplicar ? '✔' : '→'} ${tag}: ${f.renov_actual} → ${f.renov_nueva.slice(0, 10)} [${accion}]`);
    if (!aplicar) continue;

    try {
      if (subViva) {
        // Stripe exige trial_end en el futuro; mover el trial no genera
        // prorrateo ni factura. Si la sub ya estaba active (trial vencido
        // hace horas) vuelve a trialing hasta la nueva fecha.
        await stripe.subscriptions.update(subViva.id, {
          trial_end: nuevaTs,
          proration_behavior: 'none',
        });
        resumen.stripe++;
      }

      await db.query(
        `UPDATE usuarios_chat_center
            SET fecha_renovacion = FROM_UNIXTIME(:ts),
                estado = 'activo'
                ${subViva ? ", trial_end = FROM_UNIXTIME(:ts), stripe_subscription_status = 'trialing'" : ''}
          WHERE id_usuario = :id`,
        { replacements: { ts: nuevaTs, id: f.id_usuario }, type: db.QueryTypes.UPDATE },
      );
      resumen.bd++;
    } catch (e) {
      resumen.errores++;
      console.log(`✗ ${tag}: ${e.message}`);
    }
  }

  console.log('\nResumen:', resumen);
}

main()
  .catch((e) => {
    console.error('ERR', e);
    process.exitCode = 1;
  })
  .finally(() => db.close());
