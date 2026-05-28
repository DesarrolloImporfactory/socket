require('dotenv').config();
const { ejecutarSnapshotDiario } = require('../src/cron/metricasSnapshot.js');

(async () => {
  await ejecutarSnapshotDiario();
  process.exit(0);
})();
