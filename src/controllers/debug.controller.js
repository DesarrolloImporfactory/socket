// controllers/debug.controller.js
const { db } = require('../database/config');
const catchAsync = require('../utils/catchAsync');

exports.dbTime = catchAsync(async (req, res) => {
  const [rows] = await db.query(`
    SELECT
      NOW()                                       AS db_now,        -- hora según TZ de la sesión MySQL
      UTC_TIMESTAMP()                             AS db_utc_now,    -- hora UTC en MySQL
      @@global.time_zone                          AS global_tz,     -- TZ global
      @@session.time_zone                         AS session_tz,    -- TZ de la conexión
      @@system_time_zone                          AS system_tz,     -- TZ del SO
      CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', 'America/Guayaquil') AS ec_now
  `);

  res.json(rows[0]);
});
