const User = require('./user.model');
const Plataforma = require('./plataforma.model');
const UsuarioPlataforma = require('./usuario_plataforma.model');
const ClientesChatCenter = require('./clientes_chat_center.model');
const MensajesClientes = require('./mensaje_cliente.model');
const EtiquetasChatCenter = require('./etiquetas_chat_center.model');
const FacturasCot = require('./facturas_cot.model');
const DetalleFactCot = require('./detalle_fact_cot.model');
const Productos = require('./productos.model');
const InventarioBodegas = require('./inventario_bodegas.model');
const Usuarios_chat_center = require('./usuarios_chat_center.model');
const Sub_usuarios_chat_center = require('./sub_usuarios_chat_center.model');
const Planes_chat_center = require('./planes_chat_center.model');
const Calendar = require('./calendar.model');
const CalendarMember = require('./calendar_member.model');
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

  // ===== Calendarios ↔ Citas
  Calendar.hasMany(Appointment, {
    foreignKey: 'calendar_id',
    as: 'appointments',
  });
  Appointment.belongsTo(Calendar, {
    foreignKey: 'calendar_id',
    as: 'calendar',
  });

  // ===== Calendarios ↔ Miembros
  Calendar.hasMany(CalendarMember, {
    foreignKey: 'calendar_id',
    as: 'members',
  });
  CalendarMember.belongsTo(Calendar, {
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

  // ===== Enlaces con tabla Users (id_users)
  // Miembro -> User
  CalendarMember.belongsTo(User, {
    foreignKey: 'user_id',
    targetKey: 'id_users',
    as: 'user',
  });
  User.hasMany(CalendarMember, {
    foreignKey: 'user_id',
    sourceKey: 'id_users',
    as: 'calendar_memberships',
  });

  // Cita.asignado -> User
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

  // (Opcional) Cita.creada_por -> User
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
