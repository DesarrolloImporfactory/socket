const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const Stripe = require('stripe');

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const STRIPE_SECRET = isProd
  ? process.env.STRIPE_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });

// ── Helpers ──────────────────────────────────────────────────

function limpiarTelefono(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function normalizarEmail(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

function periodoActual() {
  // 'YYYY-MM' del momento de procesamiento
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function calcularNuevaFechaRenovacion(fechaActual) {
  // Si la fecha actual es futura, sumamos sobre ella (acumular).
  // Si está vencida o no existe, sumamos sobre HOY.
  const ahora = new Date();
  const base =
    fechaActual && new Date(fechaActual) > ahora
      ? new Date(fechaActual)
      : new Date(ahora);

  base.setDate(base.getDate() + 30);
  return base;
}

async function marcarAudit(auditId, fields) {
  const sets = [];
  const repl = { id: auditId };
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = :${k}`);
    repl[k] = v;
  }
  if (!sets.includes('procesado_at = :procesado_at')) {
    sets.push('procesado_at = NOW()');
  }
  await db.query(
    `UPDATE webhook_trhive_eventos SET ${sets.join(', ')} WHERE id = :id`,
    { replacements: repl, type: QueryTypes.UPDATE },
  );
}

// ── Sincronización con Stripe (anti-doble cobro) ──────────────

async function sincronizarStripe(subscriptionId, nuevaFechaRenovacion) {
  if (!subscriptionId) {
    return {
      action: 'no_stripe_sub',
      notes: 'usuario sin stripe_subscription_id',
    };
  }

  const resumesAtUnix = Math.floor(nuevaFechaRenovacion.getTime() / 1000);

  let sub;
  try {
    sub = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (e) {
    return {
      action: 'stripe_retrieve_failed',
      notes: `No se pudo retrieve la sub: ${e.message}`,
    };
  }

  // Sub cancelada o muerta → no tocar
  if (['canceled', 'incomplete_expired'].includes(sub.status)) {
    return {
      action: 'stripe_skipped',
      notes: `Sub en estado ${sub.status}, no se sincroniza`,
    };
  }

  // En trial → extender trial_end (lo más limpio)
  if (sub.status === 'trialing') {
    try {
      await stripe.subscriptions.update(subscriptionId, {
        trial_end: resumesAtUnix,
        proration_behavior: 'none',
      });
      return {
        action: 'trial_extended',
        notes: `trial_end movido a ${nuevaFechaRenovacion.toISOString()}`,
      };
    } catch (e) {
      return {
        action: 'trial_extend_failed',
        notes: e.message,
      };
    }
  }

  // En active / past_due / unpaid → pause_collection
  try {
    await stripe.subscriptions.update(subscriptionId, {
      pause_collection: {
        behavior: 'void',
        resumes_at: resumesAtUnix,
      },
    });
    return {
      action: 'paused',
      notes: `pause_collection.resumes_at = ${nuevaFechaRenovacion.toISOString()}`,
    };
  } catch (e) {
    return {
      action: 'pause_failed',
      notes: e.message,
    };
  }
}

// ── Procesamiento principal ──────────────────────────────────

async function procesarEventoTrhive({ auditId, body }) {
  const email = normalizarEmail(body.correo || body.email || '');
  const nombre = body.nombre || '';
  const telefono = limpiarTelefono(body.telefono || '');
  const periodo = periodoActual();

  // Validación mínima
  if (!email) {
    await marcarAudit(auditId, {
      status: 'error',
      processing_notes: 'No vino email/correo en el body',
    });
    return;
  }

  // Idempotencia: ¿ya procesamos este email este mes?
  const [yaAplicado] = await db.query(
    `SELECT id FROM webhook_trhive_eventos
      WHERE email = :email
        AND periodo_aplicado = :periodo
        AND status = 'processed'
        AND id != :id
      LIMIT 1`,
    {
      replacements: { email, periodo, id: auditId },
      type: QueryTypes.SELECT,
    },
  );

  if (yaAplicado) {
    await marcarAudit(auditId, {
      email,
      periodo_aplicado: periodo,
      status: 'duplicate',
      processing_notes: `Ya aplicado en ${periodo} (audit ref id=${yaAplicado.id})`,
    });
    console.log(
      `[trhive] Duplicado ignorado: email=${email} periodo=${periodo}`,
    );
    return;
  }

  // Buscar usuario en usuarios_chat_center
  const [user] = await db.query(
    `SELECT id_usuario, id_plan, estado, fecha_renovacion, stripe_subscription_id, email_propietario
       FROM usuarios_chat_center
      WHERE email_propietario = :email
      LIMIT 1`,
    {
      replacements: { email },
      type: QueryTypes.SELECT,
    },
  );

  if (!user) {
    await marcarAudit(auditId, {
      email,
      periodo_aplicado: periodo,
      status: 'user_not_found',
      processing_notes: `Email "${email}" no existe en usuarios_chat_center. Se descarta.`,
    });
    console.log(`[trhive] Usuario no encontrado: ${email}`);
    return;
  }

  // Calcular nueva fecha
  const nuevaFecha = calcularNuevaFechaRenovacion(user.fecha_renovacion);

  // UPDATE usuario: extender renovación + asegurar activo
  await db.query(
    `UPDATE usuarios_chat_center
        SET id_plan = COALESCE(NULLIF(id_plan, 0), 21),
            estado = 'activo',
            fecha_inicio = COALESCE(fecha_inicio, NOW()),
            fecha_renovacion = :nueva
      WHERE id_usuario = :uid`,
    {
      replacements: { nueva: nuevaFecha, uid: user.id_usuario },
      type: QueryTypes.UPDATE,
    },
  );

  console.log(
    `[trhive] Usuario ${user.id_usuario} (${email}) → fecha_renovacion=${nuevaFecha.toISOString()}`,
  );

  // Sincronizar Stripe (evitar doble cobro)
  const stripeResult = await sincronizarStripe(
    user.stripe_subscription_id,
    nuevaFecha,
  );

  console.log(
    `[trhive] Stripe sync: ${stripeResult.action} - ${stripeResult.notes}`,
  );

  // Auditar todo
  await marcarAudit(auditId, {
    id_usuario: user.id_usuario,
    email,
    periodo_aplicado: periodo,
    status: 'processed',
    stripe_action: stripeResult.action,
    nueva_fecha_renovacion: nuevaFecha,
    processing_notes: `OK. Plan 21 activo. Renovación → ${nuevaFecha.toISOString()}. Stripe: ${stripeResult.notes}`,
  });
}

// ── Endpoint público ─────────────────────────────────────────

exports.inbound_trive = async (req, res) => {
  const ts = new Date().toISOString();

  console.log(`[trhive ${ts}] HEADERS:`, JSON.stringify(req.headers));
  console.log(`[trhive ${ts}] BODY:`, JSON.stringify(req.body));

  let auditId = null;

  // PASO 1 — Almacenar crudo (auditoría siempre primero)
  try {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    const [insertId] = await db.query(
      `INSERT INTO webhook_trhive_eventos
        (raw_headers, raw_body, raw_query, http_method, ip, user_agent, status)
       VALUES (:hdrs, :body, :query, :method, :ip, :ua, 'received')`,
      {
        replacements: {
          hdrs: JSON.stringify(req.headers || {}),
          body: JSON.stringify(req.body || {}),
          query: JSON.stringify(req.query || {}),
          method: req.method || null,
          ip,
          ua: req.headers['user-agent'] || null,
        },
        type: QueryTypes.INSERT,
      },
    );

    auditId = insertId;
    console.log(`[trhive] Evento almacenado: id=${auditId}`);
  } catch (err) {
    console.error('[trhive] Error guardando evento:', err);
    return res.status(200).json({
      ok: false,
      error: 'storage_failed',
      message: err.message,
    });
  }

  // PASO 2 — Responder YA a Trhive/Make (no esperar al procesamiento)
  res.status(200).json({ ok: true, audit_id: auditId, received: true });

  // PASO 3 — Procesamiento async (fire-and-forget)
  procesarEventoTrhive({ auditId, body: req.body || {} }).catch((err) => {
    console.error('[trhive] Error procesando:', err);
    marcarAudit(auditId, {
      status: 'error',
      processing_notes: `Excepción: ${err.message}`,
    }).catch(() => {});
  });
};

exports.admin_reprocesar_trhive = async (req, res) => {
  // Auth simple por header secret
  const secret = req.headers['x-admin-secret'] || '';
  if (
    !process.env.ADMIN_REPROCESS_SECRET ||
    secret !== process.env.ADMIN_REPROCESS_SECRET
  ) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const auditIdEspecifico = Number(req.body?.audit_id) || null;
  const dryRun = Boolean(req.body?.dry_run);
  const forzar = Boolean(req.body?.forzar); // permite reprocesar incluso si no está 'received'

  try {
    let pendientes;

    if (auditIdEspecifico) {
      // UN solo audit
      const sqlOne = forzar
        ? `SELECT id, raw_body, status FROM webhook_trhive_eventos
            WHERE id = :id LIMIT 1`
        : `SELECT id, raw_body, status FROM webhook_trhive_eventos
            WHERE id = :id AND status = 'received' LIMIT 1`;

      pendientes = await db.query(sqlOne, {
        replacements: { id: auditIdEspecifico },
        type: QueryTypes.SELECT,
      });

      if (!pendientes.length) {
        return res.status(404).json({
          ok: false,
          error: forzar
            ? 'audit_id no existe'
            : 'audit_id no existe o ya fue procesado (usa "forzar":true para reprocesar)',
        });
      }
    } else {
      // TODOS los pendientes Make/production
      pendientes = await db.query(
        `SELECT id, raw_body, status FROM webhook_trhive_eventos
          WHERE user_agent = 'Make/production'
            AND status = 'received'
          ORDER BY id ASC`,
        { type: QueryTypes.SELECT },
      );
    }

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dry_run: true,
        encontrados: pendientes.length,
        ids: pendientes.map((p) => p.id),
      });
    }

    const resultados = [];

    for (const evt of pendientes) {
      const body =
        typeof evt.raw_body === 'string'
          ? JSON.parse(evt.raw_body)
          : evt.raw_body;

      try {
        await procesarEventoTrhive({ auditId: evt.id, body });

        const [final] = await db.query(
          `SELECT id, email, id_usuario, status, stripe_action,
                  nueva_fecha_renovacion, processing_notes
             FROM webhook_trhive_eventos WHERE id = :id LIMIT 1`,
          { replacements: { id: evt.id }, type: QueryTypes.SELECT },
        );

        resultados.push({
          audit_id: evt.id,
          email: body.correo || null,
          ok: true,
          ...final,
        });
      } catch (e) {
        resultados.push({
          audit_id: evt.id,
          email: body.correo || null,
          ok: false,
          error: e.message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      total_procesados: resultados.length,
      resultados,
    });
  } catch (err) {
    console.error('[admin_reprocesar_trhive] Error fatal:', err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
};
