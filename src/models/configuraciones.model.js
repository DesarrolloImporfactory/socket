const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Configuraciones = db.define(
  'configuraciones',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      comment: 'Clave Primaria',
    },
    pais: {
      type: DataTypes.STRING(2),
      allowNull: true,
      defaultValue: 'ec',
    },
    id_plataforma: {
      type: DataTypes.BIGINT,
      allowNull: true,
      unique: true,
    },
    id_usuario: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    metodo_pago: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 1,
    },
    suspendido: {
      type: DataTypes.TINYINT, // o DataTypes.BOOLEAN, pero TINYINT mapea 0/1
      allowNull: false,
      defaultValue: 0,
    },
    suspended_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    key_imporsuit: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },
    nombre_configuracion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    telefono: {
      type: DataTypes.STRING(20), // En tu tabla es VARCHAR(20)
      allowNull: true,
    },
    id_telefono: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    id_whatsapp: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    token: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    webhook_url: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    template_generar_guia: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    api_key_openai: {
      type: DataTypes.STRING(1000),
      allowNull: true,
    },
    /* Con qué proveedor responde el bot del kanban. Se elige en Asistentes AI.
       'claude' exige api_key_claude; la de OpenAI se sigue usando para lo que
       Claude no cubre (audios, visión, Dropi). Ver utils/claude/claude.js. */
    proveedor_ia: {
      type: DataTypes.ENUM('openai', 'claude'),
      allowNull: false,
      defaultValue: 'openai',
    },
    // Cifrada igual que api_key_openai (utils/claude/apiKeyClaude.js).
    api_key_claude: {
      type: DataTypes.STRING(1000),
      allowNull: true,
    },
    /* A qué cuenta pertenece cada llave (utils/cuentaIA.js). Se llena al
       guardar la llave y solo se vuelve a consultar al cambiarla; así la vista
       de Asistentes no pregunta a OpenAI/Anthropic en cada visita y se puede
       buscar por correo con un SELECT. OpenAI: {nombre, email, organizacion,
       organizacion_id, organizacion_personal, proyecto, proyecto_id}. Claude:
       {organizacion, organizacion_id, workspace_id} (Anthropic no da el
       correo con una llave normal). *_cuenta_at = cuándo se consultó; NULL en
       cuenta con fecha = la consulta falló (llave revocada, red). */
    openai_cuenta: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    openai_cuenta_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    claude_cuenta: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    claude_cuenta_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    /* Aviso al dueño sobre su cuenta de OpenAI que NO apaga el bot (a
       diferencia de openai_activo=0). Hoy solo ORG_NO_VERIFICADA: la
       organización no está verificada para gpt-5 y el bot responde con el
       modelo de respaldo. Ver utils/openia/avisoOpenAI.js. */
    openai_aviso_codigo: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    openai_aviso_msg: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    openai_aviso_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    tipo_configuracion: {
      type: DataTypes.ENUM('imporfactory', 'ventas'),
      allowNull: true,
      defaultValue: 'ventas',
    },
    permiso_round_robin: {
      type: DataTypes.TINYINT, // o DataTypes.BOOLEAN, pero TINYINT mapea 0/1
      allowNull: false,
      defaultValue: 0,
    },
    /* Qué ficha extra usan los ítems de esta cuenta (utils/fichaPresets.js).
       NULL = ninguna, y entonces esos campos ni aparecen en el formulario: un
       catálogo de dropshipping no tiene por qué ver "dormitorios". */
    ficha_preset: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    /* 1 = al cerrar un chat desde /chat el contacto vuelve a la columna
       principal del kanban (histórico). 0 = se queda en su columna: para
       embudos de atención sin bot donde cerrar no es retroceder.
       Se edita en /kanban_config. Ver utils/kanbanConfigCuenta.js. */
    kanban_volver_al_cerrar: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    tableName: 'configuraciones',
    timestamps: false,
    comment: 'Tabla de configuraciones',
    freezeTableName: true,
  },
);

module.exports = Configuraciones;
