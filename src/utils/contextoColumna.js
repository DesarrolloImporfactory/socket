'use strict';

/* Contexto que se le entrega al asistente de una columna antes de responder:
   sedes y disponibilidad del calendario.

   Vive aquí y no dentro de kanban_ia.service porque el chat de prueba
   (kanban_columnas/chat_prueba) mandaba SOLO las instrucciones, sin ninguno de
   estos bloques. El prompt le dice al bot "decide la cobertura con la lista de
   sedes que se te entrega" y en la prueba esa lista nunca llegaba: el bot daba
   por fuera de cobertura a todo el mundo, incluso a la ciudad donde el negocio
   sí tiene sede. Un solo constructor para los dos caminos evita que vuelvan a
   separarse. */

const { db } = require('../database/config');
const { enlaceUbicacionSede } = require('./ubicacionSede');

/**
 * @param {number} id_configuracion
 * @param {Array<{tipo_accion:string}>} acciones  acciones activas de la columna
 * @param {(msg:string)=>any} [log]
 * @returns {Promise<string>} bloque de contexto (puede venir vacío)
 */
async function construirContextoColumna(id_configuracion, acciones, log) {
  const say = typeof log === 'function' ? log : () => {};
  const tiene = (t) => (acciones || []).some((a) => a.tipo_accion === t);
  let bloque = '';

  // ── Sedes / sucursales ──────────────────────────────────────
  // Deja de ser criterio del modelo saber si alguien está dentro de cobertura:
  // se le entrega la lista real de sedes con su ciudad, dirección y horario.
  if (tiene('contexto_establecimientos')) {
    try {
      const sedes = await db.query(
        `SELECT id, nombre, ciudad, provincia, direccion, referencia,
                google_maps_url, telefono, horario
           FROM establecimientos_chat_center
          WHERE id_configuracion = ? AND activo = 1 AND eliminado = 0
          ORDER BY orden ASC, id ASC`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );

      if (sedes.length) {
        /* Quién atiende en cada sede. Es lo que le da capacidad a la agenda y,
           si el negocio les puso nombre, lo que permite que la clienta pida con
           quién quiere atenderse. */
        const profesionales = await db.query(
          `SELECT id_establecimiento, nombre FROM profesionales_chat_center
            WHERE id_configuracion = ? AND activo = 1 AND eliminado = 0
            ORDER BY orden ASC, id ASC`,
          { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
        );
        const porSede = new Map();
        profesionales.forEach((p) => {
          const k = Number(p.id_establecimiento);
          if (!porSede.has(k)) porSede.set(k, []);
          porSede.get(k).push(p.nombre);
        });

        const lineas = sedes.map((s) => {
          const partes = [
            `- ${s.nombre} (${s.ciudad}${s.provincia ? `, ${s.provincia}` : ''})`,
          ];
          if (s.direccion) partes.push(`  Dirección: ${s.direccion}`);
          if (s.referencia) partes.push(`  Referencia: ${s.referencia}`);
          const mapa = enlaceUbicacionSede(s);
          if (mapa) partes.push(`  Ubicación en Google Maps: ${mapa}`);
          if (s.telefono) partes.push(`  Teléfono: ${s.telefono}`);
          if (s.horario) partes.push(`  Horario: ${s.horario}`);

          const quienes = porSede.get(Number(s.id)) || [];
          if (quienes.length) {
            partes.push(
              `  Atienden aquí (${quienes.length} a la vez): ${quienes.join(', ')}`,
            );
          }
          return partes.join('\n');
        });

        bloque +=
          `🏢 Sedes donde atendemos (ÚNICAS ciudades con cobertura):\n${lineas.join('\n')}\n\n` +
          `Si la persona escribe desde una ciudad que NO está en esta lista, está fuera de cobertura.\n` +
          `Al agendar, usa el nombre EXACTO de la sede tal como aparece aquí.\n` +
          `Cuando pregunten cómo llegar, o al confirmar una cita, pega el enlace de ` +
          `Google Maps de esa sede tal cual, en su propia línea y sin acortarlo ni ` +
          `cambiarlo. Si una sede no tiene enlace, da la dirección y la referencia.\n` +
          (profesionales.length
            ? `Si la persona pide atenderse con alguien en particular, agrega al bloque ` +
              `de agendamiento una línea "👩 Atiende: <nombre exacto>". Si no pide a ` +
              `nadie, no la pongas: se le asigna quien esté libre.\n\n`
            : '\n');
        say(`✅ Contexto establecimientos inyectado (${sedes.length})`);
      } else {
        /* Sin sedes cargadas el silencio es la peor respuesta: el prompt sigue
           diciendo "si su ciudad no está en la lista, está fuera de cobertura"
           y una lista vacía deja fuera a todo el mundo. Se lo decimos explícito
           para que no descarte a nadie por ubicación. */
        bloque +=
          `🏢 Sedes: la cuenta todavía no tiene ninguna sede cargada.\n` +
          `NO clasifiques a nadie como fuera de cobertura ni preguntes por la ciudad ` +
          `como filtro: no tienes con qué compararla. Atiende la consulta normal y, ` +
          `si hace falta saber dónde atendemos, pásalo a un asesor.\n\n`;
        say(`⚠️ contexto_establecimientos activo pero sin sedes cargadas`);
      }
    } catch (err) {
      say(`⚠️ Error contexto_establecimientos: ${err.message}`);
    }
  }

  // ── Disponibilidad de la agenda ─────────────────────────────
  if (tiene('contexto_calendario')) {
    try {
      const {
        obtenerDatosCalendarioParaAssistant,
      } = require('./datosClienteAssistant');
      const datos = await obtenerDatosCalendarioParaAssistant(id_configuracion);
      if (datos?.bloque) {
        bloque += `📅 Información del calendario:\n${datos.bloque}\n\n`;
        say(`✅ Contexto calendario inyectado`);
      }
    } catch (err) {
      say(`⚠️ Error contexto_calendario: ${err.message}`);
    }
  }

  return bloque;
}

module.exports = { construirContextoColumna };
