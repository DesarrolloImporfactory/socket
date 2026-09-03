const { Sequelize } = require('sequelize');

// min: 0 a propósito. Con min > 0 el pool mantiene conexiones ociosas para
// siempre; MySQL las cierra por wait_timeout (o un KILL/reinicio) y quedan
// zombis: al usarlas mysql2 tira "Can't add new command when connection is in
// closed state". Sin mínimo, las ociosas se reciclan cada `idle` ms y el pool
// abre una nueva cuando hace falta (coste despreciable frente a esos errores).
const commonPoolConfig = {
  max: 30,
  min: 0,
  acquire: 60000,
  idle: 10000,
  evict: 5000,
};

const commonDialectOptions = {
  connectTimeout: 20000,
  typeCast(field, next) {
    // Este bloque evita que DATETIME sea convertido a UTC
    if (field.type === 'DATETIME') {
      return field.string();
    }
    return next();
  },
};

const retryConfig = {
  max: 3,
  match: [
    /ECONNRESET/,
    /ECONNREFUSED/,
    /ETIMEDOUT/,
    /EPIPE/,
    /SequelizeConnectionError/,
    /SequelizeConnectionRefusedError/,
    /SequelizeHostNotFoundError/,
    /SequelizeHostNotReachableError/,
    /SequelizeInvalidConnectionError/,
    /SequelizeConnectionTimedOutError/,
    // Conexión que el servidor cerró y el pool alcanzó a prestar igual: la
    // query se reintenta y agarra una sana. Ver utils/conexionCerrada.js.
    /Can't add new command when connection is in closed state/,
    /Cannot enqueue .* after (fatal error|invalid state|being destroyed)/,
    /PROTOCOL_CONNECTION_LOST/,
    /Connection lost: The server closed the connection/,
  ],
};

const db = new Sequelize({
  dialect: 'mysql',
  host: process.env.DB_HOST_PRINCIPAL,
  username: process.env.DB_USERNAME_PRINCIPAL,
  password: process.env.DB_PASSWORD_PRINCIPAL,
  database: process.env.DB_DATABASE_PRINCIPAL,
  port: process.env.DB_PORT_PRINCIPAL,
  logging: false,
  timezone: '-05:00',
  pool: commonPoolConfig,
  dialectOptions: commonDialectOptions,
  retry: retryConfig,
  define: {
    timestamps: true,
  },
});

const db_2 = new Sequelize({
  dialect: 'mysql',
  host: process.env.DB_HOST,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT,
  logging: false,
  timezone: '-05:00',
  pool: commonPoolConfig,
  dialectOptions: commonDialectOptions,
  retry: retryConfig,
  define: {
    timestamps: true,
  },
});

module.exports = { db, db_2 };
