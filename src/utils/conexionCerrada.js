// utils/conexionCerrada.js
// -----------------------------------------------------------------------------
// Detector de errores de "conexión muerta" del pool MySQL.
//
// mysql2 tira "Can't add new command when connection is in closed state" cuando
// se manda una query por una conexión que el servidor ya cerró (wait_timeout,
// KILL, reinicio de MySQL, corte de red). El pool de Sequelize valida la
// conexión al prestarla, pero hay una carrera: puede validarla como viva un
// instante antes de que el evento 'close' del socket llegue, y entonces la
// query revienta. También pasa cuando la conexión muere MIENTRAS está tomada
// (caso típico: la sesión que sostiene GET_LOCK queda ociosa todo el ciclo).
//
// No es un error de negocio: la conexión ya no sirve, el pool la descarta y el
// siguiente intento agarra una sana. Por eso se trata como "saltar el ciclo",
// no como fallo del registro.
// -----------------------------------------------------------------------------

const PATRONES = [
  /Can't add new command when connection is in closed state/i,
  /Cannot enqueue .* after (?:fatal error|invalid state|being destroyed)/i,
  /PROTOCOL_CONNECTION_LOST/i,
  /Connection lost: The server closed the connection/i,
  /ECONNRESET/i,
  /EPIPE/i,
];

function esConexionCerrada(err) {
  if (!err) return false;
  const texto = [
    err.message,
    err.original?.message,
    err.parent?.message,
    err.code,
    err.original?.code,
    err.parent?.code,
  ]
    .filter(Boolean)
    .join(' | ');
  return PATRONES.some((re) => re.test(texto));
}

module.exports = { esConexionCerrada, PATRONES_CONEXION_CERRADA: PATRONES };
