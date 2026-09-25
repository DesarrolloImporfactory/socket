/**
 * Horario de atención por conexión (ver models/atencion_horarios.model.js).
 *
 * Devuelve siempre la forma que consume minutosHabiles() de
 * liberar_sin_respuesta.service: { horaInicio, horaFin, diasHabiles,
 * offsetMinutos }. Ecuador no tiene horario de verano, así que el offset es
 * fijo.
 */
const AtencionHorarios = require('../models/atencion_horarios.model');

const HORARIO_DEFAULT = {
  horaInicio: 8,
  horaFin: 17,
  diasHabiles: [1, 2, 3, 4, 5],
  offsetMinutos: -5 * 60,
};

const parsearDias = (texto) =>
  String(texto || '')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);

function normalizar(fila) {
  if (!fila) return { ...HORARIO_DEFAULT };
  const dias = parsearDias(fila.dias);
  return {
    horaInicio: Number(fila.hora_inicio),
    horaFin: Number(fila.hora_fin),
    diasHabiles: dias.length ? dias : HORARIO_DEFAULT.diasHabiles,
    offsetMinutos: HORARIO_DEFAULT.offsetMinutos,
  };
}

async function obtenerHorario(id_configuracion) {
  if (!id_configuracion) return { ...HORARIO_DEFAULT };
  try {
    const fila = await AtencionHorarios.findByPk(Number(id_configuracion));
    return normalizar(fila);
  } catch (e) {
    // Tabla recién definida y db.sync aún no corrió: horario por defecto.
    if (/doesn't exist/i.test(e?.message || '')) return { ...HORARIO_DEFAULT };
    throw e;
  }
}

/** Valida y guarda. Lanza Error con mensaje legible si algo no cuadra. */
async function guardarHorario(id_configuracion, datos, id_sub_usuario = null) {
  const horaInicio = Number(datos?.hora_inicio);
  const horaFin = Number(datos?.hora_fin);
  const dias = Array.isArray(datos?.dias)
    ? datos.dias.map(Number)
    : parsearDias(datos?.dias);
  if (!Number.isInteger(horaInicio) || horaInicio < 0 || horaInicio > 23) {
    throw new Error('hora_inicio debe estar entre 0 y 23');
  }
  if (!Number.isInteger(horaFin) || horaFin < 1 || horaFin > 24) {
    throw new Error('hora_fin debe estar entre 1 y 24');
  }
  if (horaFin <= horaInicio) {
    throw new Error('hora_fin debe ser mayor que hora_inicio');
  }
  const diasValidos = [...new Set(dias)].filter(
    (d) => Number.isInteger(d) && d >= 0 && d <= 6,
  );
  if (!diasValidos.length) throw new Error('Elige al menos un día');

  await AtencionHorarios.upsert({
    id_configuracion: Number(id_configuracion),
    hora_inicio: horaInicio,
    hora_fin: horaFin,
    dias: diasValidos.sort((a, b) => a - b).join(','),
    actualizado_por: id_sub_usuario,
    updated_at: new Date(),
  });
  return obtenerHorario(id_configuracion);
}

/** Forma pública (la que viaja al front). */
const publico = (h) => ({
  inicio: h.horaInicio,
  fin: h.horaFin,
  dias: h.diasHabiles,
});

module.exports = { HORARIO_DEFAULT, obtenerHorario, guardarHorario, publico };
