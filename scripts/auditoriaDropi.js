/* Lee la auditoría de Dropi (dropi_auditoria_acciones): qué pidió el chat
   al server, cuánto tardó y qué contestó Dropi. Las peticiones solo salen
   de producción; esto permite analizarlas desde cualquier máquina con .env.

   node scripts/auditoriaDropi.js                     resumen 7 días, todas las cuentas
   node scripts/auditoriaDropi.js --cfg 569           una cuenta
   node scripts/auditoriaDropi.js --cfg 569 --dias 2 --detalle   últimas filas con el JSON
   node scripts/auditoriaDropi.js --accion crear_orden --resultado error_dropi
*/
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/database/config');

const arg = (n, def = null) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const cfg = Number(arg('cfg')) || null;
const dias = Number(arg('dias')) || 7;
const accion = arg('accion');
const resultado = arg('resultado');
const detalle = arg('detalle') === true;
const limite = Number(arg('limite')) || 30;

const q = (sql, r) => db.query(sql, { replacements: r, type: db.QueryTypes.SELECT });

(async () => {
  const where = ['created_at >= NOW() - INTERVAL ? DAY'];
  const rep = [dias];
  if (cfg) { where.push('id_configuracion = ?'); rep.push(cfg); }
  if (accion && accion !== true) { where.push('accion = ?'); rep.push(accion); }
  if (resultado && resultado !== true) { where.push('resultado = ?'); rep.push(resultado); }
  const W = where.join(' AND ');

  const resumen = await q(
    `SELECT accion, resultado, COUNT(*) n, ROUND(AVG(ms)) ms_prom, MAX(ms) ms_max,
            COUNT(DISTINCT id_configuracion) cuentas
       FROM dropi_auditoria_acciones WHERE ${W}
      GROUP BY accion, resultado ORDER BY accion, n DESC`,
    rep,
  );
  console.log(`\n== Resumen (${dias} días${cfg ? `, cfg ${cfg}` : ''}) ==`);
  console.table(resumen);

  const motivos = await q(
    `SELECT accion, resultado, LEFT(motivo, 110) motivo, COUNT(*) n
       FROM dropi_auditoria_acciones WHERE ${W} AND resultado <> 'ok'
      GROUP BY accion, resultado, LEFT(motivo, 110) ORDER BY n DESC LIMIT 15`,
    rep,
  );
  console.log('\n== Motivos de lo que no salió bien ==');
  console.table(motivos);

  const porDia = await q(
    `SELECT DATE(created_at) dia, SUM(resultado = 'ok') ok, SUM(resultado <> 'ok') mal,
            ROUND(AVG(ms)) ms_prom, SUM(ms > 30000) mas_30s
       FROM dropi_auditoria_acciones WHERE ${W}
      GROUP BY DATE(created_at) ORDER BY dia`,
    rep,
  );
  console.log('\n== Por día ==');
  console.table(porDia);

  if (cfg || detalle) {
    const filas = await q(
      `SELECT id, id_configuracion cfg, accion, country_code pais, resultado, ms, created_at,
              LEFT(motivo, 160) motivo ${detalle ? ', detalle' : ''}
         FROM dropi_auditoria_acciones WHERE ${W}
        ORDER BY id DESC LIMIT ?`,
      [...rep, limite],
    );
    console.log(`\n== Últimas ${filas.length} ==`);
    for (const f of filas) {
      const { detalle: d, ...resto } = f;
      console.log(JSON.stringify(resto));
      if (detalle && d) console.log('   ', String(d).slice(0, 1500));
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
