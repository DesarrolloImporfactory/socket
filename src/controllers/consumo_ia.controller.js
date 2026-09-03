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
    tk_entrada: 0,
    tk_cache: 0,
    tk_salida: 0,
    costo_usd: 0,
    costo_entrada_usd: 0,
    costo_cache_usd: 0,
    costo_salida_usd: 0,
    costo_exacto_msgs: 0,
  };
  const precioRef = PRECIOS[modeloRef] || PRECIOS['gpt-4o-mini'];
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
        tk_entrada: 0,
        tk_cache: 0,
        tk_salida: 0,
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
    /* Desglose por TIPO de gasto. Con analytics es exacto (entrada sin
       caché, caché y salida por separado, con el precio del modelo real);
       los mensajes viejos sin desglose se reparten 95/5 entrada/salida —
       el mismo supuesto de costoEstimadoPorTokens. La caché es donde vive
       el ahorro real: cuesta ~10x menos que la entrada normal. */
    const a = leerAnalytics(f.json_analytics_mensaje);
    let costo = 0;
    if (a) {
      const p = PRECIOS[normalizarModelo(a.modelo)] || precioRef;
      const cached = Number(a.cached) || 0;
      const entrada = Math.max(0, (Number(a.input) || 0) - cached);
      const salida = Number(a.output) || 0;
      const cEntrada = (entrada * p.input) / 1e6;
      const cCache = (cached * p.cached) / 1e6;
      const cSalida = (salida * p.output) / 1e6;
      costo = cEntrada + cCache + cSalida;
      d.tk_entrada += entrada;
      d.tk_cache += cached;
      d.tk_salida += salida;
      tot.tk_entrada += entrada;
      tot.tk_cache += cached;
      tot.tk_salida += salida;
      tot.costo_entrada_usd += cEntrada;
      tot.costo_cache_usd += cCache;
      tot.costo_salida_usd += cSalida;
      tot.costo_exacto_msgs += 1;
    } else if (tokens > 0) {
      const entrada = Math.round(tokens * 0.95);
      const salida = tokens - entrada;
      const cEntrada = (entrada * precioRef.input) / 1e6;
      const cSalida = (salida * precioRef.output) / 1e6;
      costo = cEntrada + cSalida;
      d.tk_entrada += entrada;
      d.tk_salida += salida;
      tot.tk_entrada += entrada;
      tot.tk_salida += salida;
      tot.costo_entrada_usd += cEntrada;
      tot.costo_salida_usd += cSalida;
    }
    d.costo_usd += costo;
    tot.costo_usd += costo;
  }

  const diasOrdenados = [...porDia.values()].sort((a, b) =>
    a.dia < b.dia ? 1 : -1,
  );

  /* ¿Desde cuándo hay registro de consumo para esta cuenta? El desglose de
     tokens por respuesta se guarda desde que se instrumentó la medición
     (mediados de 2026); un bot que trabaja desde antes tiene meses SIN
     registro, y mostrar "$X en 90 días" sin aclararlo hace parecer que el
     bot costaba cero. El front usa esto para avisar que el rango pedido
     empieza antes del primer dato. */
  let medicion_desde = null;
  try {
    const [primera] = await db.query(
      `SELECT MIN(created_at) AS d FROM mensajes_clientes
        WHERE id_configuracion = ? AND rol_mensaje = 1
          AND total_tokens_openai_mensaje > 0`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    if (primera?.d) {
      const d = new Date(primera.d);
      if (!Number.isNaN(d.getTime()))
        medicion_desde = d.toISOString().slice(0, 10);
    }
  } catch (_) {
    /* dato informativo: sin él la vista funciona igual */
  }
  const inicioRango = new Date(Date.now() - dias * 86400000)
    .toISOString()
    .slice(0, 10);
  const rango_incompleto = Boolean(
    medicion_desde && medicion_desde > inicioRango,
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
      medicion_desde,
      rango_incompleto,
      nota:
        'Costo estimado con los precios públicos de OpenAI. Las respuestas que guardan modelo y tokens se calculan exactas; las anteriores se estiman con el modelo de la columna. La factura real es la de tu cuenta de OpenAI.',
    },
  });
});
