const User = require('./user.model');
const Plataforma = require('./plataforma.model');
const UsuarioPlataforma = require('./usuario_plataforma.model');
const Configuraciones = require('./configuraciones.model');
const ClientesChatCenter = require('./clientes_chat_center.model');
const MensajesClientes = require('./mensaje_cliente.model');
const ErroresChatMeta = require('./errores_chat_meta.model');
const EtiquetasChatCenter = require('./etiquetas_chat_center.model');
const EtiquetasAsignadas = require('./etiquetas_asignadas.model');
const Productos = require('./productos.model');
const Usuarios_chat_center = require('./usuarios_chat_center.model');
const Sub_usuarios_chat_center = require('./sub_usuarios_chat_center.model');
const Departamentos_chat_center = require('./departamentos_chat_center.model');
const Sub_usuarios_departamento = require('./sub_usuarios_departamento.model');
const Planes_chat_center = require('./planes_chat_center.model');
const Calendar = require('./calendar.model');
const Appointment = require('./appointment.model');
const AppointmentInvitee = require('./appointment_invitee.model');
const TikTokOAuthSession = require('./tiktok_oauth_session.model');
const TikTokConnection = require('./tiktok_connection.model');
const TikTokWebhookEvent = require('./tiktok_webhook_event.model');
const TikTokWebhookSubscription = require('./tiktok_webhook_subscription.model');
const TikTokNotification = require('./tiktok_notification.model');
const TikTokWebhookLog = require('./tiktok_webhook_log.model');
const DropiIntegrations = require('./dropi_integrations.model');
const ImporsuitCursos = require('./imporsuit/cursos.model');
const ProductosChatCenter = require('./productos_chat_center.model');
const ProductosWizard = require('./productos_wizard.model');
const ProductosWizardFlujo = require('./productos_wizard_flujo.model');
const RespondedorLogisticoConfig = require('./respondedor_logistico_config.model');
const CategoriasChatCenter = require('./categorias_chat_center.model');
const CatalogosChatCenter = require('./catalogos_chat_center.model');
const CatalogosItemsChatCenter = require('./catalogos_items_chat_center.model');
const EtapasLanding = require('./etapas_landing.model');
const TemplatesIA = require('./templates_ia.model');
const TemplatesIAPrivados = require('./templates_ia_privados.model');
const GeneracionesIA = require('./generaciones_ia.model');
const GeneracionesAngulosIA = require('./generaciones_angulos_ia.model');
const ProductosIA = require('./productos_ia.model');
const Password_reset_codes = require('./password_reset_codes.model');
const ShopifyConnections = require('./shopify_connections.model');

const initModel = () => {
  // Asociaciones existentes
  User.belongsToMany(Plataforma, {
    through: UsuarioPlataforma,
    foreignKey: 'id_usuario',
    otherKey: 'id_plataforma',
    as: 'plataformas',
  });

  Plataforma.belongsToMany(User, {
    through: UsuarioPlataforma,
    foreignKey: 'id_plataforma',
    otherKey: 'id_usuario',
    as: 'usuarios',
  });

  // ======= Etiquetas (ASIGNACIONES ↔ ETIQUETAS) =======
  EtiquetasAsignadas.belongsTo(EtiquetasChatCenter, {
    foreignKey: 'id_etiqueta',
    targetKey: 'id_etiqueta',
    as: 'etiqueta',
  });

  EtiquetasChatCenter.hasMany(EtiquetasAsignadas, {
    foreignKey: 'id_etiqueta',
    sourceKey: 'id_etiqueta',
    as: 'asignaciones',
  });

  // Asociación entre ClientesChatCenter y MensajesClientes
  ClientesChatCenter.hasMany(MensajesClientes, {
    foreignKey: 'celular_recibe',
    as: 'mensajes',
  });
  MensajesClientes.belongsTo(ClientesChatCenter, {
    foreignKey: 'celular_recibe',
    as: 'cliente',
  });
  MensajesClientes.belongsTo(ClientesChatCenter, {
    foreignKey: 'celular_recibe',
    targetKey: 'id',
    as: 'clientePorCelular',
  });

  // Un error por mensaje (si tu tabla puede tener varios, igual te sirve hasOne para traer 1 fila)
  MensajesClientes.hasOne(ErroresChatMeta, {
    foreignKey: 'id_wamid_mensaje',
    sourceKey: 'id_wamid_mensaje',
    as: 'error_meta',
  });
  ErroresChatMeta.belongsTo(MensajesClientes, {
    foreignKey: 'id_wamid_mensaje',
    targetKey: 'id_wamid_mensaje',
    as: 'mensaje',
  });

  // Asociación entre ClientesChatCenter y EtiquetasChatCenter
  ClientesChatCenter.belongsTo(EtiquetasChatCenter, {
    foreignKey: 'id_etiqueta',
    as: 'etiqueta',
  });

  Plataforma.hasMany(Productos, {
    foreignKey: 'id_plataforma',
    as: 'productos',
  });

  Productos.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  // Relación: Usuarios tiene muchos Sub_usuarios
  Usuarios_chat_center.hasMany(Sub_usuarios_chat_center, {
    foreignKey: 'id_usuario',
    sourceKey: 'id_usuario',
    as: 'sub_usuarios',
  });

  Sub_usuarios_chat_center.belongsTo(Usuarios_chat_center, {
    foreignKey: 'id_usuario',
    targetKey: 'id_usuario',
    as: 'usuario_principal',
  });

  // Relación: Planes tiene muchos Usuarios
  Planes_chat_center.hasMany(Usuarios_chat_center, {
    foreignKey: 'id_plan',
    sourceKey: 'id_plan',
    as: 'usuarios',
  });

  Usuarios_chat_center.belongsTo(Planes_chat_center, {
    foreignKey: 'id_plan',
    targetKey: 'id_plan',
    as: 'plan',
  });

  // Relación: Un departamento tiene muchos subusuarios

  Departamentos_chat_center.hasMany(Sub_usuarios_departamento, {
    foreignKey: 'id_departamento',
    sourceKey: 'id_departamento',
    as: 'sub_usuarios_departamento',
  });

  Sub_usuarios_departamento.belongsTo(Departamentos_chat_center, {
    foreignKey: 'id_departamento',
    targetKey: 'id_departamento',
    as: 'departamento',
  });

  // relacion: departamentos y configuraciones
  Departamentos_chat_center.belongsTo(Configuraciones, {
    foreignKey: 'id_configuracion', // columna en departamentos_chat_center
    targetKey: 'id', // PK en configuraciones (opcional, pero claro)
    as: 'configuracion',
  });

  Configuraciones.hasMany(Departamentos_chat_center, {
    foreignKey: 'id_configuracion',
    sourceKey: 'id',
    as: 'departamentos_chat_center',
  });

  //Relación: Un subusuario puede estar en muchos departamentos

  Sub_usuarios_chat_center.hasMany(Sub_usuarios_departamento, {
    foreignKey: 'id_sub_usuario',
    sourceKey: 'id_sub_usuario',
    as: 'departamentos_sub_usuario',
  });

  Sub_usuarios_departamento.belongsTo(Sub_usuarios_chat_center, {
    foreignKey: 'id_sub_usuario',
    targetKey: 'id_sub_usuario',
    as: 'sub_usuario',
  });

  // ===== Calendarios ↔ Citas
  Calendar.hasMany(Appointment, {
    foreignKey: 'calendar_id',
    as: 'appointments',
  });
  Appointment.belongsTo(Calendar, {
    foreignKey: 'calendar_id',
    as: 'calendar',
  });

  // ===== Citas ↔ Invitados
  Appointment.hasMany(AppointmentInvitee, {
    foreignKey: 'appointment_id',
    as: 'invitees',
  });
  AppointmentInvitee.belongsTo(Appointment, {
    foreignKey: 'appointment_id',
    as: 'appointment',
  });

  // ===== Enlaces con Users (si los usas para asignar/crear)
  Appointment.belongsTo(User, {
    foreignKey: 'assigned_user_id',
    targetKey: 'id_users',
    as: 'assigned_user',
  });
  User.hasMany(Appointment, {
    foreignKey: 'assigned_user_id',
    sourceKey: 'id_users',
    as: 'assigned_appointments',
  });

  Appointment.belongsTo(User, {
    foreignKey: 'created_by_user_id',
    targetKey: 'id_users',
    as: 'creator',
  });
  User.hasMany(Appointment, {
    foreignKey: 'created_by_user_id',
    sourceKey: 'id_users',
    as: 'created_appointments',
  });

  // Asociaciones de TikTok OAuth
  TikTokOAuthSession.hasMany(TikTokConnection, {
    foreignKey: 'oauth_session_id',
    sourceKey: 'id_oauth_session',
    as: 'connections',
  });

  TikTokConnection.belongsTo(TikTokOAuthSession, {
    foreignKey: 'oauth_session_id',
    targetKey: 'id_oauth_session',
    as: 'oauth_session',
  });

  //Configuraciones -> DropiIntegrations
  Configuraciones.hasOne(DropiIntegrations, {
    foreignKey: 'id_configuracion',
    sourceKey: 'id',
    as: 'dropi_integration',
  });

  DropiIntegrations.belongsTo(Configuraciones, {
    foreignKey: 'id_configuracion',
    targetKey: 'id',
    as: 'configuracion',
  });

  // ===== Imporsuit =====
  // Curso pertenece a un instructor (usuario)
  ImporsuitCursos.belongsTo(User, {
    foreignKey: 'instructor',
    targetKey: 'id_users',
    as: 'instructor_usuario',
  });

  User.hasMany(ImporsuitCursos, {
    foreignKey: 'instructor',
    sourceKey: 'id_users',
    as: 'cursos_instructor',
  });

  // ===== ProductosChatCenter ↔ CategoriasChatCenter =====
  ProductosChatCenter.belongsTo(CategoriasChatCenter, {
    foreignKey: 'id_categoria',
    targetKey: 'id',
    as: 'categoria',
  });

  CategoriasChatCenter.hasMany(ProductosChatCenter, {
    foreignKey: 'id_categoria',
    sourceKey: 'id',
    as: 'productos',
  });

  // ===== CatalogosChatCenter ↔ CatalogosItemsChatCenter =====
  CatalogosChatCenter.hasMany(CatalogosItemsChatCenter, {
    foreignKey: 'id_catalogo',
    sourceKey: 'id',
    as: 'items',
  });

  CatalogosItemsChatCenter.belongsTo(CatalogosChatCenter, {
    foreignKey: 'id_catalogo',
    targetKey: 'id',
    as: 'catalogo',
  });

  // ===== CatalogosItemsChatCenter ↔ ProductosChatCenter =====
  CatalogosItemsChatCenter.belongsTo(ProductosChatCenter, {
    foreignKey: 'id_producto',
    targetKey: 'id',
    as: 'producto',
  });

  ProductosChatCenter.hasMany(CatalogosItemsChatCenter, {
    foreignKey: 'id_producto',
    sourceKey: 'id',
    as: 'catalogos_items',
  });

  // ===== GeneracionesIA ↔ EtapasLanding =====
  GeneracionesIA.belongsTo(EtapasLanding, {
    foreignKey: 'id_etapa',
    targetKey: 'id',
    as: 'etapa',
  });

  EtapasLanding.hasMany(GeneracionesIA, {
    foreignKey: 'id_etapa',
    sourceKey: 'id',
    as: 'generaciones',
  });

  // ===== GeneracionesIA ↔ Usuarios_chat_center =====
  GeneracionesIA.belongsTo(Usuarios_chat_center, {
    foreignKey: 'id_usuario',
    targetKey: 'id_usuario',
    as: 'usuario',
  });

  Usuarios_chat_center.hasMany(GeneracionesIA, {
    foreignKey: 'id_usuario',
    sourceKey: 'id_usuario',
    as: 'generaciones_ia',
  });

  TemplatesIA.belongsTo(EtapasLanding, {
    foreignKey: 'id_etapa',
    targetKey: 'id',
    as: 'etapa',
  });

  EtapasLanding.hasMany(TemplatesIA, {
    foreignKey: 'id_etapa',
    sourceKey: 'id',
    as: 'templates',
  });

  ProductosIA.belongsTo(Usuarios_chat_center, {
    foreignKey: 'id_usuario',
    targetKey: 'id_usuario',
    as: 'usuario',
  });

  Usuarios_chat_center.hasMany(ProductosIA, {
    foreignKey: 'id_usuario',
    sourceKey: 'id_usuario',
    as: 'productos_ia',
  });

  // ===== ProductosIA ↔ GeneracionesIA =====
  ProductosIA.hasMany(GeneracionesIA, {
    foreignKey: 'id_producto',
    sourceKey: 'id',
    as: 'generaciones',
  });

  GeneracionesIA.belongsTo(ProductosIA, {
    foreignKey: 'id_producto',
    targetKey: 'id',
    as: 'producto',
  });

  // ===== GeneracionesIA ↔ TemplatesIA (faltaba) =====
  GeneracionesIA.belongsTo(TemplatesIA, {
    foreignKey: 'template_id',
    targetKey: 'id',
    as: 'template',
  });

  TemplatesIA.hasMany(GeneracionesIA, {
    foreignKey: 'template_id',
    sourceKey: 'id',
    as: 'generaciones',
  });

  TemplatesIAPrivados.belongsTo(EtapasLanding, {
    foreignKey: 'id_etapa',
    targetKey: 'id',
    as: 'etapa',
  });

  EtapasLanding.hasMany(TemplatesIAPrivados, {
    foreignKey: 'id_etapa',
    sourceKey: 'id',
    as: 'templates_privados',
  });

  Sub_usuarios_chat_center.hasMany(Password_reset_codes, {
    foreignKey: 'id_sub_usuario',
    sourceKey: 'id_sub_usuario',
    as: 'reset_codes',
  });

  Password_reset_codes.belongsTo(Sub_usuarios_chat_center, {
    foreignKey: 'id_sub_usuario',
    targetKey: 'id_sub_usuario',
    as: 'sub_usuario',
  });

  ShopifyConnections.belongsTo(Usuarios_chat_center, {
    foreignKey: 'id_usuario',
    targetKey: 'id_usuario',
    as: 'usuario',
  });

  Usuarios_chat_center.hasMany(ShopifyConnections, {
    foreignKey: 'id_usuario',
    sourceKey: 'id_usuario',
    as: 'shopify_connections',
  });
};

// Función para obtener todos los modelos
const getModels = () => {
  return {
    User,
    Plataforma,
    Configuraciones,
    UsuarioPlataforma,
    ClientesChatCenter,
    MensajesClientes,
    ErroresChatMeta,
    EtiquetasChatCenter,
    EtiquetasAsignadas,
    Productos,
    Usuarios_chat_center,
    Sub_usuarios_chat_center,
    Departamentos_chat_center,
    Sub_usuarios_departamento,
    Planes_chat_center,
    Calendar,
    Appointment,
    AppointmentInvitee,
    TikTokOAuthSession,
    TikTokConnection,
    TikTokWebhookEvent,
    TikTokWebhookSubscription,
    TikTokNotification,
    TikTokWebhookLog,
    DropiIntegrations,
    ImporsuitCursos,
    ProductosChatCenter,
    ProductosWizard,
    ProductosWizardFlujo,
    CategoriasChatCenter,
    CatalogosChatCenter,
    CatalogosItemsChatCenter,
    EtapasLanding,
    TemplatesIA,
    GeneracionesIA,
    GeneracionesAngulosIA,
    TemplatesIAPrivados,
    Password_reset_codes,
    ShopifyConnections,
  };
};

module.exports = initModel;
module.exports.getModels = getModels;
