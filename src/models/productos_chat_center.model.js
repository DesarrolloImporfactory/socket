const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ProductosChatCenter = db.define(
  'productos_chat_center',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    id_configuracion: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    nombre: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    // ===== nuevos =====
    material: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },

    tipo: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    // 1 = tiene variantes (talla/color) en productos_variaciones
    es_variable: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    precio: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    precio_proveedor: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },

    duracion: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    /* Plan de sesiones de un servicio. Vacío o 1 = sesión única; min < max = el
       plan varía según el caso (borrado de tatuajes: puede terminar en 3 o en
       8). El bot lo cruza con las sesiones a las que la persona SÍ vino para
       saber si empuja la siguiente, si pregunta o si ya terminó. */
    sesiones_min: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    sesiones_max: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    nombre_upsell: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    descripcion_upsell: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    precio_upsell: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    imagen_upsell_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    imagen_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    video_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },

    /* Álbum con el resto de las fotos. WhatsApp recibe una imagen por mensaje y
       mandar quince es spam, así que el sistema manda una y, cuando piden más,
       el bot pasa este enlace. Sin él la respuesta era "te las envía un asesor",
       que en un inmueble es perder la conversación. */
    galeria_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },

    // ===== nuevos =====
    landing_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },

    external_source: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },

    external_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    // ===== nuevos =====
    id_dropi: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    stock: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    // ===== nuevos =====
    es_privado: {
      type: DataTypes.TINYINT,
      allowNull: true,
    },

    combos_producto: {
      type: DataTypes.BLOB,
      allowNull: true,
    },
    eliminado: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    id_categoria: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'categorias_chat_center',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },

    /* ── Dónde queda este ítem ────────────────────────────────────
       Existe porque hay negocios donde la cita NO se hace en el local: en
       inmobiliaria la visita es en la casa. La agenda sigue siendo la de la
       oficina (`id_establecimiento`), pero el lugar al que llega la persona es
       la dirección de acá. Vacío = el ítem no tiene ubicación propia y la cita
       se hace en la sede, como siempre. */
    id_establecimiento: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    direccion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    sector: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    ciudad: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    // Para mandar el pin real de WhatsApp, no solo el enlace de Maps.
    latitud: {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    },
    longitud: {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    },
    google_maps_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },

    /* Ficha del nicho: {"dormitorios":"3","banos":"2"}. Qué claves son válidas
       lo define el preset de la cuenta (utils/fichaPresets.js). Va como JSON y
       no como columnas para que un catálogo de dropshipping no tenga que
       convivir con campos de inmuebles vacíos para siempre. */
    atributos_json: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    fecha_creacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    fecha_actualizacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'productos_chat_center',
    timestamps: false,
  },
);

module.exports = ProductosChatCenter;
