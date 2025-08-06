const { Sequelize } = require('sequelize');

const db = new Sequelize({
  dialect: 'mysql',
  host: process.env.DB_HOST,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT,
  logging: false,
  timezone: '-05:00',
  dialectOptions: {
    typeCast(field, next) {
      // Este bloque evita que DATETIME sea convertido a UTC
      if (field.type === 'DATETIME') {
        return field.string();
      }
      return next();
    },
  },
  define: {
    timestamps: true,
    underscored: true,
  },
});

module.exports = { db };
