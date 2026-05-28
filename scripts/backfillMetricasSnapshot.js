require('dotenv').config();

const {
  calcularSnapshot,
  guardarSnapshot,
} = require('../src/services/metricas.service');

(async () => {
  const dias = parseInt(process.argv[2], 10) || 365;
  console.log(`Backfill estimado de los últimos ${dias} días…`);

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  for (let i = dias; i >= 1; i--) {
    const d = new Date(hoy.getTime() - i * 24 * 60 * 60 * 1000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const fecha = `${yyyy}-${mm}-${dd}`;

    try {
      const snap = await calcularSnapshot(fecha, true);
      await guardarSnapshot(snap);
      if (i % 30 === 0 || i === 1) {
        console.log(
          `  ${fecha}  MRR=$${Number(snap.mrr).toFixed(2)}  Activos=${snap.clientes_activos}  Cortesias=${snap.clientes_cortesia}`,
        );
      }
    } catch (err) {
      console.error(`Error en ${fecha}:`, err.message);
    }
  }

  console.log('✅ Backfill terminado.');
  process.exit(0);
})();
