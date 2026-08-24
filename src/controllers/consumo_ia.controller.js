// controllers/consumo_ia.controller.js
// Consumo del asistente por cuenta: cuántas respuestas salieron con IA, cuántas
// sin IA (mensaje fijo y respuestas rápidas del wizard), tokens y costo
// estimado por día. Los mensajes nuevos guardan modelo + desglose de tokens en
// `json_analytics_mensaje` (costo exacto); los anteriores solo traen el total
// de tokens y se estiman con el modelo de la columna.
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const {
  ACTUALIZADO,
  normalizarModelo,
  costoUSD,
  costoEstimadoPorTokens,
  costoTipicoPorRespuesta,
  PRECIOS,
} = require('../utils/preciosOpenAI');

const SIN_IA = ['IA_wizard', 'IA_mensaje_fijo', 'IA_respuesta_rapida'];

function leerAnalytics(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && typeof o === 'object' && o.modelo ? o : null;
  } catch {
    return null;
  }
}

/** Modelo más usado en las columnas con IA de la cuenta (para estimar). */
async function modeloReferencia(id_configuracion) {
  try {
    const filas = await db.query(
      `SELECT modelo, COUNT(*) n FROM kanban_columnas
        WHERE id_configuracion = ? AND activo = 1 AND activa_ia = 1
        GROUP BY modelo ORDER BY n DESC LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    return normalizarModelo(filas[0]?.modelo);
  } catch {
    return normalizarModelo(null);
  }
}

exports.resumen = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.body?.id_configuracion);
  let dias = Number(req.body?.dias) || 30;
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'id_configuracion es obligatorio.' });
  }
  dias = Math.min(Math.max(dias, 1), 90);

  const modeloRef = await modeloReferencia(id_configuracion);

  /* Una sola pasada por los mensajes salientes del bot en el rango. Se traen
     solo los campos necesarios; el desglose por día se arma en JS para poder
     calcular el costo exacto donde hay analytics y estimado donde no. */
  const filas = await db.query(
    `SELECT DATE(created_at) AS dia, responsable,
            COALESCE(total_tokens_openai_mensaje, 0) AS tokens,
            json_analytics_mensaje
       FROM mensajes_clientes
      WHERE id_configuracion = ?
        AND rol_mensaje = 1
        AND responsable LIKE 'IA\\_%'
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    { replacements: [id_configuracion, dias], type: db.QueryTypes.SELECT },
  );

  const porDia = new Map();
  const tot = {
    msgs_ia: 0,
    msgs_sin_ia: 0,
    msgs_fijo: 0,
    msgs_rapida: 0,
    tokens: 0,
    costo_usd: 0,
    costo_exacto_msgs: 0,
  };
  for (const f of filas) {
    const dia =
      f.dia instanceof Date ? f.dia.toISOString().slice(0, 10) : String(f.dia).slice(0, 10);
    if (!porDia.has(dia)) {
      porDia.set(dia, {
        dia,
        msgs_ia: 0,
        msgs_sin_ia: 0,
        msgs_fijo: 0,
        msgs_rapida: 0,
        tokens: 0,
        costo_usd: 0,
      });
    }
    const d = porDia.get(dia);
    if (SIN_IA.includes(f.responsable)) {
      d.msgs_sin_ia += 1;
      tot.msgs_sin_ia += 1;
      if (f.responsable === 'IA_respuesta_rapida') {
        d.msgs_rapida += 1;
        tot.msgs_rapida += 1;
      } else {
        d.msgs_fijo += 1;
        tot.msgs_fijo += 1;
      }
      continue;
    }
    d.msgs_ia += 1;
    tot.msgs_ia += 1;
    const tokens = Number(f.tokens) || 0;
    d.tokens += tokens;
    tot.tokens += tokens;
    const a = leerAnalytics(f.json_analytics_mensaje);
    let costo = 0;
    if (a) {
      costo = costoUSD({
        modelo: a.modelo,
        input: a.input,
        cached: a.cached,
        output: a.output,
      });
      tot.costo_exacto_msgs += 1;
    } else if (tokens > 0) {
      costo = costoEstimadoPorTokens(modeloRef, tokens);
    }
    d.costo_usd += costo;
    tot.costo_usd += costo;
  }

  const diasOrdenados = [...porDia.values()].sort((a, b) =>
    a.dia < b.dia ? 1 : -1,
  );

  /* Cuánto habría costado responder con IA lo que salió sin IA: mismo costo
     promedio por respuesta con IA del período (o el típico del modelo si no
     hubo ninguna). Es la cifra de "ahorro" que se muestra. */
  const promedioIA =
    tot.msgs_ia > 0
      ? tot.costo_usd / tot.msgs_ia
      : costoTipicoPorRespuesta(modeloRef);
  const ahorro_usd = tot.msgs_sin_ia * promedioIA;

  res.status(200).json({
    status: 'success',
    data: {
      dias: diasOrdenados,
      totales: {
        ...tot,
        costo_promedio_ia_usd: promedioIA,
        ahorro_estimado_usd: ahorro_usd,
      },
      modelo_referencia: modeloRef,
      precio_referencia: PRECIOS[modeloRef],
      precios_actualizados: ACTUALIZADO,
      rango_dias: dias,
      nota:
        'Costo estimado con los precios públicos de OpenAI. Las respuestas que guardan modelo y tokens se calculan exactas; las anteriores se estiman con el modelo de la columna. La factura real es la de tu cuenta de OpenAI.',
    },
  });
});
