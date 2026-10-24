const { taparTelefonos } = require('./taparTelefonos');

/*  Rol «equipo»: el asesor que atiende los chats desde Team
 *  (team.imporchina.com) y nunca ve el teléfono del cliente.
 *
 *  Tres reglas, todas en el servidor:
 *  1. Solo entra con la sesión que emite /api/v1/equipo/sesion
 *     (`origen: 'team'`). Un token de login, de renew o de newLogin no le
 *     sirve aunque sea auténtico: el rol se lee fresco de la base en cada
 *     petición (protect, sesionVigente).
 *  2. Solo puede llamar rutas hechas para Team, bajo /api/v1/equipo/. Las
 *     ~600 rutas de la pantalla vieja (exportar, buscar por número, ajustes…)
 *     le responden 403 sin tener que revisarlas una por una.
 *  3. Todo lo que recibe pasa por taparTelefonos.
 *
 *  El rol solo se puede asignar en las cuentas de ROL_EQUIPO_CUENTAS (vacío =
 *  ninguna). Hasta que el canal en vivo tenga salas por cuenta (tramo 2), un
 *  usuario «equipo» no entra al socket.
 */

const ROL_EQUIPO = 'equipo';
const PREFIJO_EQUIPO = '/api/v1/equipo/';

function cuentasEquipo(valor = process.env.ROL_EQUIPO_CUENTAS) {
  return new Set(
    String(valor || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

function puedeTenerRolEquipo(id_usuario) {
  return cuentasEquipo().has(Number(id_usuario));
}

function esEquipo(user) {
  return String(user?.rol || '') === ROL_EQUIPO;
}

function rutaPermitidaEquipo(url) {
  const p = String(url || '').split('?')[0].toLowerCase();
  return p.startsWith(PREFIJO_EQUIPO) && !p.includes('..');
}

// Todo lo que sale por res.json / res.send(objeto) va tapado. res.json llama
// por dentro a res.send con el texto ya armado: ese pasa tal cual.
function envolverParaEquipo(res) {
  if (res._tapadoEquipo) return;
  res._tapadoEquipo = true;
  const json = res.json.bind(res);
  const send = res.send.bind(res);
  res.json = (body) => json(taparTelefonos(body));
  res.send = (body) =>
    body && typeof body === 'object' && !Buffer.isBuffer(body) ? json(taparTelefonos(body)) : send(body);
}

module.exports = {
  ROL_EQUIPO,
  PREFIJO_EQUIPO,
  cuentasEquipo,
  puedeTenerRolEquipo,
  esEquipo,
  rutaPermitidaEquipo,
  envolverParaEquipo,
};
