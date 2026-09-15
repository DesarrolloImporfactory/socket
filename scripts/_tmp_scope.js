require("dotenv").config();
const { db } = require('../src/database/config');
(async () => {
  const q = (s, r={}) => db.query(s, { replacements: r, type: db.QueryTypes.SELECT });
  const cols = (await q(`SHOW COLUMNS FROM dropi_integrations`)).map(c=>c.Field).filter(f=>!/key|token|secret/i.test(f));
  console.log('INTEG', JSON.stringify(await q(`SELECT ${cols.join(',')} FROM dropi_integrations WHERE id IN (49,57)`)));
  console.log('MANUALES', JSON.stringify(await q(`SELECT id_configuracion, id_usuario, COUNT(*) n, MIN(fecha) d1, MAX(fecha) d2, SUM(gasto_diario) gasto FROM dropi_daily_metrics WHERE id_configuracion=322 OR id_usuario=951 GROUP BY 1,2`)));
  console.log('CACHE_CTX', JSON.stringify(await q(`SELECT id_configuracion, id_usuario, COUNT(*) n, MIN(order_created_at) d1, MAX(order_created_at) d2, MAX(synced_at) sync FROM dropi_orders_cache WHERE id_configuracion=322 OR id_usuario=951 GROUP BY 1,2`)));
  console.log('AUTO_ORD', JSON.stringify(await q(`SELECT table_name FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name='id_integracion' OR (table_schema=DATABASE() AND column_name='integration_id')`)));
  // alcance global de forma webhook
  const wh = `JSON_EXTRACT(order_data,'$.orderdetails[0].product.sale_price') IS NULL AND JSON_EXTRACT(order_data,'$.orderdetails[0].price') IS NOT NULL`;
  console.log('WEBHOOK_SHAPE_TOTAL', JSON.stringify(await q(`SELECT classified_status, COUNT(*) n, COUNT(DISTINCT CONCAT(id_configuracion,'/',id_usuario)) cuentas FROM dropi_orders_cache WHERE ${wh} GROUP BY classified_status ORDER BY n DESC`)));
  console.log('WEBHOOK_SHAPE_CON_HERMANA_RICA', JSON.stringify(await q(`SELECT COUNT(*) n FROM dropi_orders_cache a WHERE ${wh.replace(/order_data/g,'a.order_data')} AND EXISTS (SELECT 1 FROM dropi_orders_cache b WHERE b.dropi_order_id=a.dropi_order_id AND b.id<>a.id AND JSON_EXTRACT(b.order_data,'$.orderdetails[0].product.sale_price') IS NOT NULL)`)));
  console.log('SIN_ORDERDETAILS', JSON.stringify(await q(`SELECT COUNT(*) n FROM dropi_orders_cache WHERE JSON_LENGTH(order_data,'$.orderdetails') IS NULL OR JSON_LENGTH(order_data,'$.orderdetails')=0`)));
  console.log('WEBHOOK_SHAPE_POR_CUENTA', JSON.stringify(await q(`SELECT id_configuracion, id_usuario, COUNT(*) n FROM dropi_orders_cache WHERE ${wh} GROUP BY 1,2 ORDER BY n DESC LIMIT 12`)));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
