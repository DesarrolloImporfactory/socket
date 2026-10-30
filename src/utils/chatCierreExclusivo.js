const CHAT_RESTRINGIDO = Object.freeze({
  id_configuracion: 265,
  celular_cliente: '593984722561',
  id_sub_usuario_permitido: 274,
});

function digitos(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function puedeCerrarChat({ id_configuracion, celular_cliente, id_sub_usuario }) {
  const esChatProtegido =
    Number(id_configuracion) === CHAT_RESTRINGIDO.id_configuracion &&
    digitos(celular_cliente) === CHAT_RESTRINGIDO.celular_cliente;

  return (
    !esChatProtegido ||
    Number(id_sub_usuario) === CHAT_RESTRINGIDO.id_sub_usuario_permitido
  );
}

module.exports = { puedeCerrarChat };
