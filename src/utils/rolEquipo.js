const { taparTelefonos, taparTexto } = require('./taparTelefonos');

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
const EMISOR_TEAM = 'chatcenter';
const DESTINO_TEAM = 'team';

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

// Sin mayúsculas ni espacios: «Equipo» o « equipo» también son el rol, para
// que nunca quede un usuario que se guardó así viendo todo.
function normalizarRol(rol) {
  return String(rol ?? '').trim().toLowerCase();
}

function esEquipo(user) {
  return normalizarRol(user?.rol) === ROL_EQUIPO;
}

// Una sesión de Team vale solo si trae su sello y si el usuario y la cuenta
// siguen autorizados. Sacar la cuenta de ROL_EQUIPO_CUENTAS corta al instante
// las sesiones vivas; no hay que esperar las 8 h.
function sesionTeamValida(decoded, user) {
  return (
    decoded?.origen === 'team' &&
    decoded?.iss === EMISOR_TEAM &&
    decoded?.aud === DESTINO_TEAM &&
    esEquipo(user) &&
    puedeTenerRolEquipo(user?.id_usuario)
  );
}

function rutaPermitidaEquipo(url) {
  const p = String(url || '').split('?')[0].toLowerCase();
  return p.startsWith(PREFIJO_EQUIPO) && !p.includes('..');
}

// Todo lo que sale va tapado: res.json, res.jsonp, res.send(objeto) y
// res.send(texto) (si es JSON se tapa como objeto; si no, como texto). Lo que
// no pasa por send —res.write, res.end con datos, sendFile, download— se
// corta con 500: una ruta de Team que lo use tiene que pasar por res.json.
function envolverParaEquipo(res) {
  if (res._tapadoEquipo) return;
  res._tapadoEquipo = true;
  const json = res.json.bind(res);
  const send = res.send.bind(res);
  const end = res.end.bind(res);
  let dentro = 0; // > 0 mientras express arma la respuesta desde json/send
  const conSend = (fn) => {
    dentro += 1;
    try {
      return fn();
    } finally {
      dentro -= 1;
    }
  };
  res.json = (body) => conSend(() => json(taparTelefonos(body)));
  res.jsonp = res.json;
  res.send = (body) => {
    if (dentro) return send(body);
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return res.json(body);
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      const t = body.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          return res.json(JSON.parse(t));
        } catch (_) {
          // no era JSON
        }
      }
      return conSend(() => send(taparTexto(body, null)));
    }
    return conSend(() => send(body));
  };
  const cortar = () => {
    if (!res.headersSent) res.status(500);
    return end();
  };
  res.end = (chunk, ...resto) =>
    dentro || chunk === undefined || chunk === null || chunk === '' || typeof chunk === 'function'
      ? end(chunk, ...resto)
      : cortar();
  res.write = () => {
    cortar();
    return false;
  };
  res.sendFile = cortar;
  res.download = cortar;
}

module.exports = {
  ROL_EQUIPO,
  PREFIJO_EQUIPO,
  EMISOR_TEAM,
  DESTINO_TEAM,
  sesionTeamValida,
  cuentasEquipo,
  puedeTenerRolEquipo,
  normalizarRol,
  esEquipo,
  rutaPermitidaEquipo,
  envolverParaEquipo,
};
