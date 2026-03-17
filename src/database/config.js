const { Sequelize } = require('sequelize');

const commonPoolConfig = {
  max: 30,
  min: 5,
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
