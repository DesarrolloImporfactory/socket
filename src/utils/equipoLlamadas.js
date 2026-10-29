/*  Ayudantes de las llamadas desde Team (controllers/equipo_llamadas.controller.js),
 *  sin base de datos: se prueban con `node scripts/probarEquipoLlamadas.js`. */

const LETRAS = 'ghijklmnopqrstuv'; // una letra por cifra hexadecimal

function aLetras(texto) {
  return Buffer.from(String(texto), 'utf8')
    .toString('hex')
    .replace(/[0-9a-f]/g, (h) => LETRAS[parseInt(h, 16)]);
}

function deLetras(letras) {
  const hex = String(letras).replace(/[g-v]/g, (l) => (LETRAS.indexOf(l)).toString(16));
  return Buffer.from(hex, 'hex').toString('utf8');
}

function listaIds(crudo) {
  const t = String(crudo || '').trim();
  if (!t) return null;
  return t
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** { 265: 818 } a partir de «265:818,242:818». */
function puentes(crudo = process.env.EQUIPO_LLAMADAS_PUENTE) {
  const out = {};
  for (const par of String(crudo || '').split(',')) {
    const [a, b] = par.split(':').map((x) => Number(String(x).trim()));
    if (Number.isInteger(a) && a > 0 && Number.isInteger(b) && b > 0) out[a] = b;
  }
  return out;
}

/** ¿Este asesor puede llamar desde Team? */
function habilitado(id_sub_usuario, env = process.env) {
  if (String(env.EQUIPO_LLAMADAS || '').trim() !== '1') return false;
  const solo = listaIds(env.EQUIPO_LLAMADAS_SUBS);
  return solo === null || solo.includes(Number(id_sub_usuario));
}

/** Mientras se prueba: solo esos chats (EQUIPO_LLAMADAS_CHATS; vacío = todos). */
function chatEnPrueba(id_cliente, env = process.env) {
  const solo = listaIds(env.EQUIPO_LLAMADAS_CHATS);
  return solo === null || solo.includes(Number(id_cliente));
}

const zadarmaPrendido = (env = process.env) => String(env.EQUIPO_LLAMADAS_ZADARMA || '').trim() === '1';

/** Fase para Team a partir de la memoria (viva) o de la fila (cerrada). */
function faseWa(vivo, fila) {
  if (vivo) {
    if (vivo.estado === 'accepted') return { fase: 'en_curso' };
    if (vivo.estado === 'rejected_cliente') return { fase: 'terminada', motivo: 'rechazada' };
    return { fase: 'llamando' };
  }
  const motivo = { completed: 'completada', rejected: 'rechazada', missed: 'no_contesto', failed: 'fallo' }[fila.estado];
  if (motivo || fila.fin_at) return { fase: 'terminada', motivo: motivo || 'fallo', duracion_seg: Number(fila.duracion_seg) || 0 };
  // Sin memoria ni cierre: el servidor se reinició a mitad de la llamada.
  return { fase: 'terminada', motivo: 'fallo' };
}

module.exports = { aLetras, deLetras, listaIds, puentes, habilitado, chatEnPrueba, zadarmaPrendido, faseWa };
