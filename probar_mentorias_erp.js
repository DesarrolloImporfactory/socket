/**
 * Prueba de SOLO LECTURA del servicio de mentorías del ERP.
 *
 * No crea ni cancela nada: lee la configuración del .env y consulta la
 * ocupación real del calendario para verificar que la consulta y el formato
 * de salida son los que espera el ERP.
 *
 *   node probar_mentorias_erp.js
 *
 * Borrable: es un script de verificación, no parte del servidor.
 */
require('dotenv').config();

const svc = require('./src/services/mentorias_erp.service');
const { db } = require('./src/database/config');

(async () => {
  try {
    console.log('── Configuración leída del .env ──');
    const cfg = svc.config();
    console.log(cfg);

    // Los mentores configurados, ¿tienen Google vinculado a ese calendario?
    // Sin vínculo activo el evento nunca sale, y es el fallo más silencioso
    // de toda la cadena.
    console.log('\n── Vínculo con Google de cada mentor ──');
    const vinculos = await db.query(
      `SELECT g.id_sub_usuario, s.nombre_encargado, g.google_email,
              g.google_calendar_id, g.is_active,
              (g.refresh_token IS NOT NULL) AS tiene_refresh
         FROM users_google_accounts g
         LEFT JOIN sub_usuarios_chat_center s
                ON s.id_sub_usuario = g.id_sub_usuario
        WHERE g.calendar_id = :cal AND g.id_sub_usuario IN (:mentores)`,
      {
        replacements: { cal: cfg.calendarId, mentores: cfg.mentores },
        type: db.QueryTypes.SELECT,
      },
    );

    if (!vinculos.length) {
      console.log('  ⚠ NINGUNO de los mentores tiene Google vinculado a este calendario.');
    }
    for (const v of vinculos) {
      console.log(
        `  ${v.id_sub_usuario} ${v.nombre_encargado} → ${v.google_email} ` +
          `(cal: ${v.google_calendar_id}, activo: ${v.is_active}, refresh: ${v.tiene_refresh ? 'sí' : 'NO'})`,
      );
    }

    console.log('\n── Ocupación de los próximos 28 días ──');
    const desde = '2026-08-24T00:00:00-05:00';
    const hasta = '2026-09-21T23:59:59-05:00';
    const r = await svc.ocupacion({ desde, hasta });

    console.log(`  mentores: ${JSON.stringify(r.mentores)}`);
    console.log(`  rangos ocupados: ${r.ocupado.length}`);
    for (const o of r.ocupado.slice(0, 8)) {
      console.log(`    mentor ${o.mentor}: ${o.inicio} → ${o.fin}`);
    }
    if (r.ocupado.length > 8) console.log(`    … y ${r.ocupado.length - 8} más`);

    console.log('\nOK — lectura correcta, no se escribió nada.');
  } catch (e) {
    console.error('FALLÓ:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await db.close().catch(() => {});
  }
})();
