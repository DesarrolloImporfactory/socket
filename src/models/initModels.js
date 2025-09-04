const User = require('./user.model');
const Plataforma = require('./plataforma.model');
const UsuarioPlataforma = require('./usuario_plataforma.model');
const ClientesChatCenter = require('./clientes_chat_center.model');
const MensajesClientes = require('./mensaje_cliente.model');
const ErroresChatMeta = require('./errores_chat_meta.model');
const EtiquetasChatCenter = require('./etiquetas_chat_center.model');
const FacturasCot = require('./facturas_cot.model');
const DetalleFactCot = require('./detalle_fact_cot.model');
const Productos = require('./productos.model');
const InventarioBodegas = require('./inventario_bodegas.model');
const Usuarios_chat_center = require('./usuarios_chat_center.model');
const Sub_usuarios_chat_center = require('./sub_usuarios_chat_center.model');
const Departamentos_chat_center = require('./departamentos_chat_center.model');
const Sub_usuarios_departamento = require('./sub_usuarios_departamento.model');
const Planes_chat_center = require('./planes_chat_center.model');
const Calendar = require('./calendar.model');
const Appointment = require('./appointment.model');
const AppointmentInvitee = require('./appointment_invitee.model');

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

  // Asociación entre Plataforma y ClientesChatCenter
  Plataforma.hasMany(ClientesChatCenter, {
    foreignKey: 'id_plataforma',
    as: 'clientes',
  });
  ClientesChatCenter.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  // Asociación entre ClientesChatCenter y MensajesClientes
  ClientesChatCenter.hasMany(MensajesClientes, {
    foreignKey: 'id_cliente',
    as: 'mensajes',
  });
  MensajesClientes.belongsTo(ClientesChatCenter, {
    foreignKey: 'id_cliente',
    as: 'cliente',
  });
  MensajesClientes.belongsTo(ClientesChatCenter, {
    foreignKey: 'celular_recibe',
    targetKey: 'id',
    as: 'clientePorCelular',
  });

  // Asociación entre Plataforma y MensajesClientes
  Plataforma.hasMany(MensajesClientes, {
    foreignKey: 'id_plataforma',
    as: 'mensajes',
  });
  MensajesClientes.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
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

  FacturasCot.hasMany(DetalleFactCot, {
    foreignKey: 'id_factura',
    as: 'detalles',
  });

  DetalleFactCot.belongsTo(FacturasCot, {
    foreignKey: 'id_factura',
    as: 'factura',
  });

  Plataforma.hasMany(FacturasCot, {
    foreignKey: 'id_plataforma',
    as: 'facturas',
  });

  FacturasCot.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  Plataforma.hasMany(DetalleFactCot, {
    foreignKey: 'id_plataforma',
    as: 'detalles',
  });

  DetalleFactCot.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  Productos.hasMany(DetalleFactCot, {
    foreignKey: 'id_producto',
    as: 'detalles',
  });

  DetalleFactCot.belongsTo(Productos, {
    foreignKey: 'id_producto',
    as: 'producto',
  });

  Plataforma.hasMany(Productos, {
    foreignKey: 'id_plataforma',
    as: 'productos',
  });

  Productos.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  InventarioBodegas.belongsTo(Productos, {
    foreignKey: 'id_producto',
    as: 'producto',
  });

  Productos.hasMany(InventarioBodegas, {
    foreignKey: 'id_producto',
    as: 'inventarios',
  });

  Plataforma.hasMany(InventarioBodegas, {
    foreignKey: 'id_plataforma',
    as: 'inventarios',
  });

  InventarioBodegas.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  DetalleFactCot.belongsTo(InventarioBodegas, {
    foreignKey: 'id_inventario',
    as: 'inventario',
  });

  InventarioBodegas.hasMany(DetalleFactCot, {
    foreignKey: 'id_inventario',
    as: 'detalles',
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
};
module.exports = initModel;
