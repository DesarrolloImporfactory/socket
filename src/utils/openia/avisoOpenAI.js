// ════════════════════════════════════════════════════════════
// avisoOpenAI.js — avisos al dueño sobre su cuenta de OpenAI que NO apagan el bot.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// openai_activo/openai_error_msg significan "el bot está mudo" (sin saldo,
// llave inválida) y disparan el aviso bloqueante del front. Hay situaciones
// donde el bot SIGUE respondiendo pero el dueño tiene que hacer algo: la
// organización de OpenAI no está verificada para gpt-5 y el bot contesta con
// el modelo de respaldo (cfg 1478, 2026-10-22). Si eso se guardara en
// openai_error_msg el front diría "tu asistente está en pausa", que es falso.
// Por eso van en columnas aparte: openai_aviso_codigo / _msg / _at.
//
// Se escriben desde el motor (kanban_ia.service) y se limpian cuando la causa
// desaparece: gpt-5 vuelve a responder, el cliente pulsa "Ya verifiqué" (el
// controlador comprueba en vivo) o cambia la llave.
// ════════════════════════════════════════════════════════════
'use strict';

const { db } = require('../../database/config');

const AVISO_ORG_NO_VERIFICADA = 'ORG_NO_VERIFICADA';
/* El modelo de una columna no existe o la cuenta no tiene acceso: el bot
   calla en ESA columna (las demás siguen), así que no se apaga la cuenta. El
   msg nombra el modelo entre acentos graves (`gpt-x`): así se reconoce cuando
   ese mismo modelo vuelve a responder y el aviso se retira solo. */
const AVISO_MODELO_NO_DISPONIBLE = 'MODELO_NO_DISPONIBLE';
/* Último turno de la IA fallido por algo que no es saldo, llave ni modelo
   (límite por minuto, 500 de OpenAI, red). Es transitorio: el rescate de
   turnos reintenta a los 5 min y el primer turno que responde lo borra. Sirve
   para que /conexiones diga "la IA falló hace 3 min: …" mientras dure. */
const AVISO_ERROR_IA = 'ERROR_IA';

/* Un solo hueco por cuenta: si ya hay un aviso más grave, no se pisa. Orden:
   organización sin verificar > modelo no disponible > error pasajero. */
const PESO_AVISO = {
  [AVISO_ORG_NO_VERIFICADA]: 3,
  [AVISO_MODELO_NO_DISPONIBLE]: 2,
  [AVISO_ERROR_IA]: 1,
};

// Tolerante a que la columna no exista todavía (migración manual pendiente):
// un aviso nunca puede tumbar el turno del bot.
async function registrarAvisoOpenAI(id_configuracion, codigo, msg) {
  if (!id_configuracion) return false;
  try {
    const peso = PESO_AVISO[codigo] || 0;
    const pisables = Object.keys(PESO_AVISO).filter(
      (c) => PESO_AVISO[c] <= peso,
    );
    await db.query(
      `UPDATE configuraciones
          SET openai_aviso_codigo = ?, openai_aviso_msg = ?, openai_aviso_at = NOW()
        WHERE id = ?
          AND (openai_aviso_codigo IS NULL OR openai_aviso_codigo IN (?))`,
      {
        replacements: [
          codigo,
          String(msg || '').slice(0, 500),
          id_configuracion,
          pisables.length ? pisables : [''],
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    return true;
  } catch (e) {
    console.error(`[avisoOpenAI] no se pudo registrar ${codigo} en cfg ${id_configuracion}:`, e?.message);
    return false;
  }
}

// Limpia solo si el aviso vigente es de ese código (no pisa otro distinto).
async function limpiarAvisoOpenAI(id_configuracion, codigo = null) {
  if (!id_configuracion) return false;
  try {
    await db.query(
      `UPDATE configuraciones
          SET openai_aviso_codigo = NULL, openai_aviso_msg = NULL, openai_aviso_at = NULL
        WHERE id = ? ${codigo ? 'AND openai_aviso_codigo = ?' : ''}`,
      {
        replacements: codigo ? [id_configuracion, codigo] : [id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
    return true;
  } catch (e) {
    console.error(`[avisoOpenAI] no se pudo limpiar el aviso de cfg ${id_configuracion}:`, e?.message);
    return false;
  }
}

/* La IA acaba de responder con `modelo`: se retira el aviso de error pasajero
   y, si el aviso era de ese mismo modelo, también el de modelo no disponible.
   Un UPDATE por clave primaria que casi siempre no toca filas; va en la ruta
   de éxito de cada turno junto a marcarOpenAIActivo. */
async function limpiarAvisosTrasExito(id_configuracion, modelo = null) {
  if (!id_configuracion) return false;
  try {
    await db.query(
      `UPDATE configuraciones
          SET openai_aviso_codigo = NULL, openai_aviso_msg = NULL, openai_aviso_at = NULL
        WHERE id = ?
          AND (
            openai_aviso_codigo = ?
            OR (openai_aviso_codigo = ? AND openai_aviso_msg LIKE ?)
          )`,
      {
        replacements: [
          id_configuracion,
          AVISO_ERROR_IA,
          AVISO_MODELO_NO_DISPONIBLE,
          modelo ? `%\`${modelo}\`%` : '',
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    return true;
  } catch (e) {
    console.error(`[avisoOpenAI] no se pudo limpiar tras éxito en cfg ${id_configuracion}:`, e?.message);
    return false;
  }
}

async function leerAvisoOpenAI(id_configuracion) {
  try {
    const [row] = await db.query(
      `SELECT openai_aviso_codigo AS codigo, openai_aviso_msg AS msg, openai_aviso_at AS at
         FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    return row?.codigo ? { codigo: row.codigo, msg: row.msg, at: row.at } : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  AVISO_ORG_NO_VERIFICADA,
  AVISO_MODELO_NO_DISPONIBLE,
  AVISO_ERROR_IA,
  registrarAvisoOpenAI,
  limpiarAvisoOpenAI,
  limpiarAvisosTrasExito,
  leerAvisoOpenAI,
};
