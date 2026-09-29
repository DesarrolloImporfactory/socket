/**
 * Horario de atención por conexión (ver models/atencion_horarios.model.js).
 *
 * Devuelve siempre la forma que consume minutosHabiles() de
 * liberar_sin_respuesta.service: { horaInicio, horaFin, diasHabiles,
 * offsetMinutos }. Ecuador no tiene horario de verano, así que el offset es
 * fijo.
 */
const { db } = require('../database/config');
const AtencionHorarios = require('../models/atencion_horarios.model');

/**
 * Límite de tiempo de respuesta (minutos) — semáforo del dashboard de
 * atención. Configurable por conexión desde el 2026-09-29 (pedido «gestión de
 * incidencias», parte 4): columnas limite_advertencia_min / limite_critico_min
 * de atencion_horarios (atencion_limites_migration.sql). No están en el
 * modelo: db.sync no agrega columnas a una tabla existente y cada findByPk
 * fallaría hasta correr la migración. Se leen aparte; sin ellas, 5 / 10.
 */
const LIMITES_DEFAULT = { advertencia: 5, critico: 10 };

const HORARIO_DEFAULT = {
  horaInicio: 8,
  horaFin: 17,
  diasHabiles: [1, 2, 3, 4, 5],
  offsetMinutos: -5 * 60,
  limites: { ...LIMITES_DEFAULT },
};

let limitesCache = null; // { ok, at }
const RECHECK_MS = 5 * 60 * 1000;
async function tieneColumnasLimite() {
  const ahora = Date.now();
  if (limitesCache?.ok === true) return true;
  if (limitesCache?.ok === false && ahora - limitesCache.at < RECHECK_MS) return false;
  let ok = false;
  try {
    const rows = await db.query(
      "SHOW COLUMNS FROM atencion_horarios LIKE 'limite_advertencia_min'",
      { type: db.QueryTypes.SELECT },
    );
    ok = rows.length > 0;
  } catch (_) {
    ok = false;
  }
  limitesCache = { ok, at: ahora };
  return ok;
}

async function leerLimites(id_configuracion) {
  if (!id_configuracion || !(await tieneColumnasLimite())) return { ...LIMITES_DEFAULT };
  const [fila] = await db.query(
    `SELECT limite_advertencia_min, limite_critico_min
       FROM atencion_horarios WHERE id_configuracion = ?`,
    { replacements: [Number(id_configuracion)], type: db.QueryTypes.SELECT },
  );
  if (!fila) return { ...LIMITES_DEFAULT };
  return {
    advertencia: Number(fila.limite_advertencia_min) || LIMITES_DEFAULT.advertencia,
    critico: Number(fila.limite_critico_min) || LIMITES_DEFAULT.critico,
  };
}

const parsearDias = (texto) =>
  String(texto || '')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);

function normalizar(fila) {
  if (!fila) return { ...HORARIO_DEFAULT, limites: { ...LIMITES_DEFAULT } };
  const dias = parsearDias(fila.dias);
  return {
    horaInicio: Number(fila.hora_inicio),
    horaFin: Number(fila.hora_fin),
    diasHabiles: dias.length ? dias : HORARIO_DEFAULT.diasHabiles,
    offsetMinutos: HORARIO_DEFAULT.offsetMinutos,
    limites: { ...LIMITES_DEFAULT },
  };
}

async function obtenerHorario(id_configuracion) {
  if (!id_configuracion) return { ...HORARIO_DEFAULT, limites: { ...LIMITES_DEFAULT } };
  try {
    const fila = await AtencionHorarios.findByPk(Number(id_configuracion));
    const horario = normalizar(fila);
    horario.limites = await leerLimites(id_configuracion);
    return horario;
  } catch (e) {
    // Tabla recién definida y db.sync aún no corrió: horario por defecto.
    if (/doesn't exist/i.test(e?.message || '')) {
      return { ...HORARIO_DEFAULT, limites: { ...LIMITES_DEFAULT } };
    }
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

  // Límites opcionales: si no vienen, se dejan como estén.
  const traeLimites =
    datos?.limite_advertencia_min != null || datos?.limite_critico_min != null;
  let advertencia = null;
  let critico = null;
  if (traeLimites) {
    const actuales = await leerLimites(id_configuracion);
    advertencia = Number(datos.limite_advertencia_min ?? actuales.advertencia);
    critico = Number(datos.limite_critico_min ?? actuales.critico);
    if (!Number.isInteger(advertencia) || advertencia < 1 || advertencia > 1440) {
      throw new Error('El límite de respuesta debe estar entre 1 y 1440 minutos');
    }
    if (!Number.isInteger(critico) || critico <= advertencia || critico > 1440) {
      throw new Error('El límite crítico debe ser mayor que el límite de respuesta');
    }
    if (!(await tieneColumnasLimite())) {
      throw new Error('El límite configurable aún no está habilitado (falta la migración)');
    }
  }

  await AtencionHorarios.upsert({
    id_configuracion: Number(id_configuracion),
    hora_inicio: horaInicio,
    hora_fin: horaFin,
    dias: diasValidos.sort((a, b) => a - b).join(','),
    actualizado_por: id_sub_usuario,
    updated_at: new Date(),
  });
  if (traeLimites) {
    await db.query(
      `UPDATE atencion_horarios
          SET limite_advertencia_min = ?, limite_critico_min = ?
        WHERE id_configuracion = ?`,
      { replacements: [advertencia, critico, Number(id_configuracion)] },
    );
  }
  return obtenerHorario(id_configuracion);
}

/** Forma pública (la que viaja al front). */
const publico = (h) => ({
  inicio: h.horaInicio,
  fin: h.horaFin,
  dias: h.diasHabiles,
  limites_min: h.limites || { ...LIMITES_DEFAULT },
});

module.exports = {
  HORARIO_DEFAULT,
  LIMITES_DEFAULT,
  obtenerHorario,
  guardarHorario,
  publico,
};
