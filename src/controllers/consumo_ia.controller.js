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
  costoEscrituraCache,
  costoEstimadoPorTokens,
  costoTipicoPorRespuesta,
  PRECIOS,
} = require('../utils/preciosOpenAI');

// Salen con prefijo IA_ pero NO llaman al modelo (texto fijo): no cuestan.
const SIN_IA = [
  'IA_wizard',
  'IA_mensaje_fijo',
  'IA_respuesta_rapida',
  'IA_colchon',
  'IA_respaldo',
  'IA_flujo_venta',
];
/* Recordatorios de remarketing redactados por la IA (cron). Cada uno es una
   llamada completa al modelo (prompt + catálogo + recap) y NO lleva prefijo
   IA_: hasta 2026-11-12 no se medían ni se mostraban, y en cuentas con
   remarketing activo eran la mayor parte de la factura (cfg 1512: 373
   recordatorios en dos días contra 153 respuestas del bot). Los nuevos
   guardan tokens; los anteriores se ESTIMAN. */
const REMARKETING_IA = 'cron_remarketing_ia';

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

/**
 * Consumo de una cuenta en los últimos `dias` (0 = solo hoy). Lo usan el
 * panel (`resumen`) y el asesor de gasto (`diagnostico`).
 */
async function calcularConsumo({
  id_configuracion,
  dias,
  proveedor,
  // El asesor no necesita «desde cuándo hay medición»: es un MIN sin filtro
  // de fecha sobre mensajes_clientes, lento en cuentas con mucho historial.
  sinMedicionDesde = false,
}) {
  /* Filtro por proveedor: 'openai' | 'claude' | '' (todos). Una cuenta con las
     dos llaves puede haber respondido un tramo con cada uno; sin esto, para
     ver cuánto le costó Claude tendría que dejar el bot respondiendo con
     Claude. El proveedor de cada respuesta sale del modelo guardado en
     json_analytics_mensaje (claude-* → Claude; lo demás, y lo viejo sin
     analytics, OpenAI). Las respuestas sin IA no tienen proveedor y se
     cuentan siempre. */
  const proveedorFiltro = ['openai', 'claude'].includes(
    String(proveedor || '').toLowerCase(),
  )
    ? String(proveedor).toLowerCase()
    : '';
  const proveedorDe = (a) =>
    a && /^claude-/i.test(String(a.modelo || '')) ? 'claude' : 'openai';

  let modeloRef = await modeloReferencia(id_configuracion);
  if (proveedorFiltro === 'claude' && !/^claude-/i.test(modeloRef)) {
    modeloRef = 'claude-opus-5-5';
  }
  // Proveedor actual de la cuenta: a él se atribuyen los recordatorios de
  // remarketing viejos, que no guardaron con qué modelo salieron.
  let proveedorCuenta = 'openai';
  try {
    const [cfg] = await db.query(
      `SELECT proveedor_ia FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    if (cfg?.proveedor_ia === 'claude') proveedorCuenta = 'claude';
  } catch (_) {
    /* sin la columna se asume OpenAI */
  }

  /* Una sola pasada por los mensajes salientes del bot en el rango. Se traen
     solo los campos necesarios; el desglose por día se arma en JS para poder
     calcular el costo exacto donde hay analytics y estimado donde no. */
  /* Va en dos mitades (vivos + borrados) a propósito: los índices de la tabla
     llevan deleted_at ANTES de created_at, así que sin fijar deleted_at MySQL
     no puede acotar por fecha y recorre todos los salientes de la cuenta
     (cfg 322: 300.000 filas para devolver 615). Con las dos mitades entra por
     el rango de fechas. Los borrados se cuentan igual: sus tokens se pagaron. */
  const CAMPOS_CONSUMO = `DATE(created_at) AS dia, responsable, celular_recibe,
            COALESCE(total_tokens_openai_mensaje, 0) AS tokens,
            json_analytics_mensaje`;
  const FILTRO_CONSUMO = `id_configuracion = ?
        AND rol_mensaje = 1
        AND (responsable LIKE 'IA\\_%' OR responsable = ?)
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`;
  const filas = await db.query(
    `SELECT ${CAMPOS_CONSUMO}
       FROM mensajes_clientes
      WHERE ${FILTRO_CONSUMO}
        AND deleted_at IS NULL
      UNION ALL
     SELECT ${CAMPOS_CONSUMO}
       FROM mensajes_clientes
      WHERE ${FILTRO_CONSUMO}
        AND deleted_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    {
      replacements: [
        id_configuracion,
        REMARKETING_IA,
        dias,
        id_configuracion,
        REMARKETING_IA,
        dias,
        dias,
      ],
      type: db.QueryTypes.SELECT,
    },
  );

  /* Costo exacto de una respuesta con desglose guardado. La escritura en
     caché de Claude (1,25x) se suma a «entrada»: es entrada que se pagó cara
     para que las siguientes salgan baratas. */
  const costoExacto = (a) => {
    const p = PRECIOS[normalizarModelo(a.modelo)] || precioRef;
    const cached = Number(a.cached) || 0;
    const escrita = Math.min(
      Number(a.cache_write) || 0,
      Math.max(0, (Number(a.input) || 0) - cached),
    );
    const entrada = Math.max(0, (Number(a.input) || 0) - cached);
    const salida = Number(a.output) || 0;
    const cEntrada =
      ((entrada - escrita) * p.input) / 1e6 +
      costoEscrituraCache(a.modelo, escrita);
    const cCache = (cached * p.cached) / 1e6;
    const cSalida = (salida * p.output) / 1e6;
    return { entrada, cached, salida, cEntrada, cCache, cSalida };
  };

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
    // Remarketing con IA: va DENTRO de costo_usd y además aparte.
    msgs_remarketing: 0,
    msgs_remarketing_estimados: 0,
    costo_remarketing_usd: 0,
  };
  // Recordatorios medidos (para estimar los que no guardaron tokens).
  let rmkMedidos = 0;
  let rmkCostoMedido = 0;
  // Suma de las respuestas del bot con desglose guardado (llamadas reales al
  // modelo; msgs_ia cuenta además las fotos adjuntas, que no cuestan).
  let costoExactoRespuestas = 0;
  // Cuántas respuestas con IA salieron con cada proveedor en el período, sin
  // aplicar el filtro: el front muestra el selector solo si hubo de los dos.
  const porProveedor = { openai: 0, claude: 0 };
  const precioRef = PRECIOS[modeloRef] || PRECIOS['gpt-4o-mini'];
  // Clientes distintos a los que el asistente les escribió en el período.
  const clientes = new Set();
  for (const f of filas) {
    if (f.celular_recibe != null) clientes.add(String(f.celular_recibe));
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
        msgs_remarketing: 0,
        costo_remarketing_usd: 0,
        rmk_sin_medir: 0,
      });
    }
    const d = porDia.get(dia);
    if (f.responsable === REMARKETING_IA) {
      const a = leerAnalytics(f.json_analytics_mensaje);
      const prov = a ? proveedorDe(a) : proveedorCuenta;
      if (proveedorFiltro && prov !== proveedorFiltro) continue;
      d.msgs_remarketing += 1;
      tot.msgs_remarketing += 1;
      if (!a) {
        d.rmk_sin_medir += 1; // se estima al final, con el promedio medido
        continue;
      }
      const c = costoExacto(a);
      const costo = c.cEntrada + c.cCache + c.cSalida;
      const tokens = Number(f.tokens) || 0;
      d.tokens += tokens;
      tot.tokens += tokens;
      d.tk_entrada += c.entrada;
      d.tk_cache += c.cached;
      d.tk_salida += c.salida;
      tot.tk_entrada += c.entrada;
      tot.tk_cache += c.cached;
      tot.tk_salida += c.salida;
      tot.costo_entrada_usd += c.cEntrada;
      tot.costo_cache_usd += c.cCache;
      tot.costo_salida_usd += c.cSalida;
      d.costo_usd += costo;
      d.costo_remarketing_usd += costo;
      tot.costo_usd += costo;
      tot.costo_remarketing_usd += costo;
      rmkMedidos += 1;
      rmkCostoMedido += costo;
      continue;
    }
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
    const a = leerAnalytics(f.json_analytics_mensaje);
    const prov = proveedorDe(a);
    porProveedor[prov] += 1;
    if (proveedorFiltro && prov !== proveedorFiltro) continue;
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
    let costo = 0;
    if (a) {
      const { entrada, cached, salida, cEntrada, cCache, cSalida } =
        costoExacto(a);
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
      costoExactoRespuestas += costo;
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

  /* Costo promedio de una RESPUESTA del bot (sin remarketing): es la base del
     «ahorro» y, a falta de recordatorios medidos, de la estimación de abajo. */
  const costoRespuestas = tot.costo_usd - tot.costo_remarketing_usd;
  const promedioIA =
    tot.msgs_ia > 0
      ? costoRespuestas / tot.msgs_ia
      : costoTipicoPorRespuesta(modeloRef);

  /* Recordatorios de remarketing sin tokens guardados (anteriores a la
     medición): se estiman con el promedio de los ya medidos en el período o,
     si aún no hay ninguno, con el de una respuesta del bot — misma llamada:
     prompt + catálogo + recap. Es un piso: el recordatorio aprovecha menos la
     caché que una conversación en vivo. */
  const unitarioRmk =
    rmkMedidos > 0
      ? rmkCostoMedido / rmkMedidos
      : tot.costo_exacto_msgs > 0
        ? costoExactoRespuestas / tot.costo_exacto_msgs
        : costoTipicoPorRespuesta(
            proveedorCuenta === 'claude' && !/^claude-/i.test(modeloRef)
              ? 'claude-opus-5-5'
              : modeloRef,
          );
  for (const d of porDia.values()) {
    if (!d.rmk_sin_medir) continue;
    const est = d.rmk_sin_medir * unitarioRmk;
    d.costo_usd += est;
    d.costo_remarketing_usd += est;
    tot.costo_usd += est;
    tot.costo_remarketing_usd += est;
    tot.msgs_remarketing_estimados += d.rmk_sin_medir;
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
    /* Siempre con fecha: el MIN sin filtro recorría todo el historial y en
       cuentas grandes (cfg 285) tardaba minutos y el panel no cargaba. Solo
       importa si la medición empezó DENTRO del rango pedido: primero se mira
       si ya había algo medido en los 30 días anteriores al rango (entonces el
       rango está completo) y, si no, se busca el primer dato dentro del rango. */
    let primera = null;
    if (!sinMedicionDesde && dias > 0) {
      const [antes] = await db.query(
        `SELECT 1 AS hay FROM mensajes_clientes
          WHERE id_configuracion = ? AND rol_mensaje = 1
            AND total_tokens_openai_mensaje > 0
            AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND created_at < DATE_SUB(CURDATE(), INTERVAL ? DAY)
          LIMIT 1`,
        {
          replacements: [id_configuracion, dias + 30, dias],
          type: db.QueryTypes.SELECT,
        },
      );
      if (!antes) {
        [primera] = await db.query(
          `SELECT MIN(created_at) AS d FROM mensajes_clientes
            WHERE id_configuracion = ? AND rol_mensaje = 1
              AND total_tokens_openai_mensaje > 0
              AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
          { replacements: [id_configuracion, dias], type: db.QueryTypes.SELECT },
        );
      }
    }
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
  const ahorro_usd = tot.msgs_sin_ia * promedioIA;

  return {
      dias: diasOrdenados,
      proveedor_cuenta: proveedorCuenta,
      totales: {
        ...tot,
        clientes_atendidos: clientes.size,
        costo_promedio_ia_usd: promedioIA,
        ahorro_estimado_usd: ahorro_usd,
      },
      modelo_referencia: modeloRef,
      precio_referencia: PRECIOS[modeloRef],
      proveedor: proveedorFiltro || 'todos',
      por_proveedor: porProveedor,
      precios_actualizados: ACTUALIZADO,
      rango_dias: dias,
      medicion_desde,
      rango_incompleto,
      nota_remarketing:
        tot.msgs_remarketing_estimados > 0
          ? `${tot.msgs_remarketing_estimados} recordatorios de remarketing con IA de este período son anteriores a la medición y su costo está estimado con el promedio por respuesta; los nuevos se miden exactos.`
          : null,
      nota:
        proveedorFiltro === 'claude'
          ? 'Costo calculado con los precios públicos de Anthropic y el modelo real de cada respuesta. La factura real es la de tu cuenta de Anthropic.'
          : 'Costo estimado con los precios públicos de OpenAI y Anthropic. Las respuestas que guardan modelo y tokens se calculan exactas; las anteriores se estiman con el modelo de la columna. La factura real es la de tu cuenta de OpenAI o de Anthropic.',
  };
}

exports.resumen = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.body?.id_configuracion);
  // dias = 0 → solo HOY (desde las 00:00). Sin valor → 30.
  const diasPedidos = req.body?.dias;
  let dias =
    diasPedidos === 0 || diasPedidos === '0' ? 0 : Number(diasPedidos) || 30;
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'id_configuracion es obligatorio.' });
  }
  dias = Math.min(Math.max(dias, 0), 90);
  const data = await calcularConsumo({
    id_configuracion,
    dias,
    proveedor: req.body?.proveedor,
  });
  res.status(200).json({ status: 'success', data });
});

/* ════════════════════════════════════════════════════════════════════
   Asesor de gasto: reglas fijas sobre el consumo de los últimos 7 días y la
   configuración de la cuenta. Le dice al cliente, en orden de impacto, qué
   le está costando y qué puede hacer ÉL (remarketing por producto, mensaje
   fijo y respuestas rápidas, modelos premium que eligió a mano). Lo que es
   responsabilidad nuestra —modelo equivalente cuando la columna trae uno de
   OpenAI, recordatorios con el modelo económico, caché del prompt— ya corre
   solo y se lista aparte en `automatico`, para que se vea que está hecho.
   POST /api/v1/consumo_ia/diagnostico { id_configuracion }
   ════════════════════════════════════════════════════════════════════ */
const { modeloClaude, MODELO_REMARKETING } = require('../utils/claude/claude');

const NOMBRE_MODELO = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'gpt-5': 'GPT-5',
  'gpt-5-mini': 'GPT-5 mini',
  'gpt-5-nano': 'GPT-5 nano',
  'gpt-4.1': 'GPT-4.1',
  'gpt-4.1-mini': 'GPT-4.1 mini',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o mini',
};
const nombreModelo = (m) => NOMBRE_MODELO[m] || m;
// Modelos «premium»: cuestan varias veces más que el recomendado del proveedor.
const PREMIUM = {
  claude: ['claude-opus-5-5'],
  openai: ['gpt-5', 'gpt-4.1', 'gpt-4o'],
};
const ECONOMICO = { claude: 'claude-haiku-5-5', openai: 'gpt-5-mini' };

const consulta = (sql, replacements) =>
  db
    .query(sql, { replacements, type: db.QueryTypes.SELECT })
    .catch(() => []);

exports.diagnostico = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.body?.id_configuracion);
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'id_configuracion es obligatorio.' });
  }
  const DIAS = 7;
  const DIAS_PAUTA = 28;
  const [semana, hoy] = await Promise.all([
    // DIAS - 1: hoy + los 6 anteriores = 7 días de calendario.
    calcularConsumo({ id_configuracion, dias: DIAS - 1, sinMedicionDesde: true }),
    calcularConsumo({ id_configuracion, dias: 0, sinMedicionDesde: true }),
  ]);
  const t = semana.totales;
  const proveedor = semana.proveedor_cuenta;
  const esClaude = proveedor === 'claude';

  // Ritmo: promedio de los días en que el bot trabajó (no de los 7 de
  // calendario: una cuenta que arrancó ayer no promedia contra cinco ceros).
  const diasActivos = semana.dias.filter(
    (d) => d.msgs_ia + d.msgs_remarketing > 0,
  ).length;
  const promedioDiario = diasActivos ? t.costo_usd / diasActivos : 0;
  const pctRemarketing = t.costo_usd > 0 ? t.costo_remarketing_usd / t.costo_usd : 0;
  const totalRespuestas = t.msgs_ia + t.msgs_sin_ia;
  const pctSinIA = totalRespuestas ? t.msgs_sin_ia / totalRespuestas : 0;

  const [
    columnas,
    pasosRmk,
    productosTodos,
    wizard,
    rmkProducto,
    tablero,
    clientesPorAnuncio,
    anunciosProducto,
  ] = await Promise.all([
    consulta(
      `SELECT id, nombre, estado_db, modelo, es_principal,
              COALESCE(catalogo_inline_tokens, 0) AS catalogo_tokens,
              CHAR_LENGTH(COALESCE(instrucciones, '')) AS prompt_chars
         FROM kanban_columnas
        WHERE id_configuracion = ? AND activo = 1 AND activa_ia = 1
        ORDER BY orden`,
      [id_configuracion],
    ),
    consulta(
      `SELECT estado_contacto, COUNT(*) AS pasos
         FROM configuracion_remarketing
        WHERE id_configuracion = ? AND activo = 1 AND metodo_dentro_24h = 'ia'
        GROUP BY estado_contacto`,
      [id_configuracion],
    ),
    consulta(
      `SELECT id, nombre FROM productos_chat_center
        WHERE id_configuracion = ? AND COALESCE(eliminado, 0) = 0`,
      [id_configuracion],
    ),
    consulta(
      `SELECT id_producto, wizard_completado, usar_respuestas_rapidas,
              CHAR_LENGTH(COALESCE(mensaje_inicial, '')) AS fijo_chars
         FROM productos_wizard WHERE id_configuracion = ? AND activo = 1`,
      [id_configuracion],
    ),
    consulta(
      `SELECT id_producto FROM remarketing_producto
        WHERE id_configuracion = ? AND activo = 1`,
      [id_configuracion],
    ),
    // Plantilla global instalada: su versión y el modelo que trae por columna.
    consulta(
      `SELECT c.prompt_version, p.nombre, p.version, p.data
         FROM configuraciones c
         JOIN kanban_plantillas_globales p ON p.id = c.kanban_global_id
        WHERE c.id = ? LIMIT 1`,
      [id_configuracion],
    ),
    /* Productos EN PAUTA: los que recibieron clientes desde un anuncio en las
       últimas 4 semanas (mismo cruce que el filtro por producto del kanban:
       cliente_productos_ad × anuncios_producto). Una cuenta puede tener 80
       productos cargados y pautar 3: solo esos gastan IA. El cruce se hace
       en JS con dos consultas chicas: el JOIN en SQL saltaba fila por fila
       entre las dos tablas y en frío tardó 15 s en la cfg 285. */
    consulta(
      `SELECT source_id, COUNT(*) AS clientes
         FROM cliente_productos_ad
        WHERE id_configuracion = ?
          AND created_at >= DATE_SUB(NOW(), INTERVAL ${DIAS_PAUTA} DAY)
        GROUP BY source_id`,
      [id_configuracion],
    ),
    consulta(
      `SELECT source_id, id_producto FROM anuncios_producto
        WHERE id_configuracion = ?`,
      [id_configuracion],
    ),
  ]);

  /* Solo se le reclama al cliente lo que está vendiendo hoy. Si el cruce con
     anuncios no devuelve nada (cuenta sin anuncios enlazados a productos) no
     se puede saber qué pauta: se revisan todos y el texto lo aclara. */
  const productoDelAnuncio = new Map(
    anunciosProducto.map((r) => [String(r.source_id), Number(r.id_producto)]),
  );
  const clientesPorProducto = new Map();
  for (const r of clientesPorAnuncio) {
    const idProducto = productoDelAnuncio.get(String(r.source_id));
    if (!idProducto) continue;
    clientesPorProducto.set(
      idProducto,
      (clientesPorProducto.get(idProducto) || 0) + (Number(r.clientes) || 0),
    );
  }
  const productosEnPauta = productosTodos
    .filter((p) => clientesPorProducto.has(Number(p.id)))
    .sort(
      (a, b) =>
        clientesPorProducto.get(Number(b.id)) - clientesPorProducto.get(Number(a.id)),
    );
  const pautaDetectada = productosEnPauta.length > 0;
  const productos = pautaDetectada ? productosEnPauta : productosTodos;
  const clientesAtendidos = Number(t.clientes_atendidos) || 0;

  /* Modelo que la plantilla global trae para cada columna. Una columna que
     sigue con el modelo de su plantilla NUNCA se le reclama al cliente: ese
     modelo lo elegimos nosotros. Si está caro, se corrige en la plantilla. */
  const plantilla = tablero[0] || null;
  const modeloDePlantilla = new Map();
  if (plantilla) {
    try {
      const data =
        typeof plantilla.data === 'string' ? JSON.parse(plantilla.data) : plantilla.data;
      for (const col of data?.columnas || []) {
        if (col?.estado_db) {
          modeloDePlantilla.set(String(col.estado_db), String(col.modelo || '').trim());
        }
      }
    } catch (_) {
      // plantilla con data ilegible: se trata como si no hubiera
    }
  }
  const versionUltima = plantilla ? Number(plantilla.version) || null : null;
  // Sin versión guardada (instalada antes del versionado) no se marca nada.
  const versionAplicada =
    plantilla && plantilla.prompt_version != null
      ? Number(plantilla.prompt_version)
      : versionUltima;
  const tableroDesactualizado =
    versionUltima != null && versionAplicada != null && versionAplicada < versionUltima;

  // Con qué modelo responde DE VERDAD cada columna.
  const columnasInfo = columnas.map((c) => {
    const configurado = String(c.modelo || '').trim() || 'gpt-4o-mini';
    const efectivo = esClaude ? modeloClaude(configurado) : normalizarModelo(configurado);
    const dePlantilla = modeloDePlantilla.get(String(c.estado_db || ''));
    return {
      // true = es el modelo que trae nuestra plantilla para esa columna.
      de_plantilla: Boolean(dePlantilla) && dePlantilla === configurado,
      id: c.id,
      nombre: c.nombre,
      es_principal: Boolean(c.es_principal),
      modelo_configurado: configurado,
      modelo_efectivo: efectivo,
      modelo_nombre: nombreModelo(efectivo),
      // true = la columna trae un modelo de OpenAI y nosotros le pusimos el
      // equivalente de Claude: el cliente no tiene que tocar nada.
      equivalente_automatico: esClaude && configurado !== efectivo,
      costo_tipico_usd: costoTipicoPorRespuesta(efectivo),
      premium: PREMIUM[proveedor].includes(efectivo),
    };
  });

  const idsProductos = new Set(productos.map((p) => Number(p.id)));
  const conRmkProducto = new Set(
    rmkProducto.map((r) => Number(r.id_producto)).filter((id) => idsProductos.has(id)),
  );
  const conFijo = new Set(
    wizard
      .filter((w) => Number(w.wizard_completado) === 1 && Number(w.fijo_chars) > 0)
      .map((w) => Number(w.id_producto))
      .filter((id) => idsProductos.has(id)),
  );
  const conRapidas = new Set(
    wizard
      .filter((w) => Number(w.usar_respuestas_rapidas) === 1)
      .map((w) => Number(w.id_producto))
      .filter((id) => idsProductos.has(id)),
  );
  const sinRmkProducto = productos.filter((p) => !conRmkProducto.has(Number(p.id)));
  const sinFijo = productos.filter(
    (p) => !conFijo.has(Number(p.id)) || !conRapidas.has(Number(p.id)),
  );
  const pasosIA = pasosRmk.reduce((s, r) => s + Number(r.pasos || 0), 0);
  const lista = (arr) => {
    const nombres = arr.slice(0, 3).map((p) => `«${String(p.nombre).trim().slice(0, 40)}»`);
    return nombres.join(', ') + (arr.length > 3 ? ` y ${arr.length - 3} más` : '');
  };
  const usd = (v) => `$${(Number(v) || 0).toFixed(2)}`;
  // Qué productos se revisaron, dicho al cliente para que no se asuste con
  // los que tiene cargados y no está vendiendo.
  const alcanceProductos = pautaDetectada
    ? productosTodos.length > productos.length
      ? ` Solo revisamos ${productos.length === 1 ? 'el producto' : `los ${productos.length} productos`} que ${productos.length === 1 ? 'recibió' : 'recibieron'} clientes por anuncios en las últimas 4 semanas; los otros ${productosTodos.length - productos.length} que tienes cargados no te generan gasto y no hace falta tocarlos.`
      : ''
    : productosTodos.length > 3
      ? ' No pudimos detectar cuáles estás pautando: empieza por los que tienen anuncios activos; los que no estás pautando no te generan gasto y puedes dejarlos como están.'
      : '';

  /* ── Reglas, de mayor a menor impacto ─────────────────────────────── */
  const recomendaciones = [];
  /* Ahorro mensual de cada recomendación: es un «hasta», calculado al ritmo
     de los días con actividad. Sirve para ordenar y para el simulador de
     recarga del front; no es una promesa. */
  const alMes = (usdPeriodo) => (diasActivos ? (usdPeriodo / diasActivos) * 30 : 0);
  const fraccionSinRmk = productos.length ? sinRmkProducto.length / productos.length : 0;

  // 1) Remarketing con IA: cada recordatorio es una llamada al modelo.
  if (t.msgs_remarketing > 0 && pctRemarketing >= 0.25) {
    recomendaciones.push({
      id: 'remarketing_ia',
      ahorro_mensual_usd: sinRmkProducto.length
        ? alMes(t.costo_remarketing_usd) * fraccionSinRmk
        : null,
      nivel: pctRemarketing >= 0.5 ? 'alto' : 'medio',
      icono: 'bx-alarm',
      titulo: `El ${Math.round(pctRemarketing * 100)}% de tu gasto son recordatorios de remarketing escritos por la IA`,
      detalle:
        `En los últimos ${DIAS} días salieron ${t.msgs_remarketing} recordatorios con IA (${usd(t.costo_remarketing_usd)} de ${usd(t.costo_usd)}). ` +
        `Cada uno hace que la IA lea todo tu guion y la conversación para escribir dos líneas.` +
        (sinRmkProducto.length
          ? ` Con el remarketing por producto el recordatorio es un texto con botones que escribes una sola vez: sale sin IA y no cuesta nada. Te falta activarlo en ${sinRmkProducto.length === productos.length && !pautaDetectada ? 'tus productos' : lista(sinRmkProducto)}.${alcanceProductos}`
          : ''),
      pasos: sinRmkProducto.length
        ? [
            'Entra a [Remarketing por producto](/remarketing).',
            'En el producto que estás pautando pulsa «Configurar».',
            'Escribe hasta 3 recordatorios; a cada uno le puedes poner foto y botones.',
            'Revisa en «Así se enviará» que el mensaje se vea como quieres.',
            'Deja el interruptor en «Activo» y pulsa «Guardar»: desde ahí ese producto ya no usa la IA para recordar.',
          ]
        : [
            'Tus productos ya tienen remarketing propio. Los recordatorios con IA que quedan son de clientes sin producto identificado o de otras columnas (confirmación, retiro en agencia).',
          ],
      accion: sinRmkProducto.length
        ? { texto: 'Configurar remarketing por producto', ruta: '/remarketing' }
        : null,
    });
  }

  // 2) Preguntas frecuentes que podrían salir sin IA.
  if (productos.length && sinFijo.length && t.msgs_ia > 0) {
    recomendaciones.push({
      id: 'sin_ia_productos',
      nivel: sinFijo.length === productos.length ? 'alto' : 'medio',
      icono: 'bx-message-square-check',
      titulo: pautaDetectada
        ? `${sinFijo.length} de ${productos.length === 1 ? 'tu producto en pauta' : `tus ${productos.length} productos en pauta`} no ${sinFijo.length === 1 ? 'tiene' : 'tienen'} mensaje de bienvenida y respuestas rápidas completos`
        : `${sinFijo.length} de ${productos.length} productos no tienen mensaje de bienvenida y respuestas rápidas completos`,
      detalle:
        `El mensaje de bienvenida y las respuestas rápidas (precio, envío, cómo se usa) salen sin IA: son gratis e instantáneos. ` +
        `Hoy el ${Math.round(pctSinIA * 100)}% de tus respuestas sale así; el resto lo contesta la IA (≈ ${usd(t.costo_promedio_ia_usd * 100)} cada 100 respuestas). ` +
        `Revisa: ${lista(sinFijo)}.${alcanceProductos}`,
      pasos: [
        'Entra al [listado de productos](/productos).',
        'Busca el producto y pulsa el botón de editar (el lápiz).',
        'Pulsa «Ajustes avanzados» y luego «Completar con IA»: la IA escribe el mensaje de bienvenida y las respuestas rápidas.',
        'Pulsa «Ver vista previa» y asegúrate de que el producto tenga la información correcta (precio, envío y fotos).',
        'Pulsa «Guardar y activar flujo».',
      ],
      accion: { texto: 'Ir a mis productos', ruta: '/productos' },
    });
  }

  // 3) Modelo premium elegido a mano en una columna.
  const premium = columnasInfo.filter(
    (c) => c.premium && !c.equivalente_automatico && !c.de_plantilla,
  );
  if (premium.length) {
    const eco = ECONOMICO[proveedor];
    const veces = Math.max(
      2,
      Math.round(premium[0].costo_tipico_usd / costoTipicoPorRespuesta(eco)),
    );
    recomendaciones.push({
      id: 'modelo_premium',
      // Reparto parejo entre columnas: no sabemos cuánto responde cada una.
      ahorro_mensual_usd:
        alMes(t.costo_usd - t.costo_remarketing_usd) *
        (premium.length / Math.max(1, columnasInfo.length)) *
        (1 - 1 / veces),
      nivel: 'medio',
      icono: 'bx-chip',
      titulo:
        premium.length === 1
          ? `La columna «${premium[0].nombre}» usa ${premium[0].modelo_nombre}, el modelo más caro`
          : `${premium.length} columnas usan el modelo más caro`,
      detalle:
        `${premium.map((c) => `«${c.nombre}» (${c.modelo_nombre}, ≈ ${usd(c.costo_tipico_usd * 100)} cada 100 respuestas)`).join(', ')}. ` +
        `${nombreModelo(eco)} cuesta unas ${veces} veces menos y es el que dejamos por defecto. ` +
        `Usa el modelo caro solo si ya comprobaste que vende más en esa columna.`,
      pasos: [
        'Entra a la [configuración del Kanban](/kanban_config).',
        `Abre la columna${premium.length === 1 ? ` «${premium[0].nombre}»` : ''} y ve a la pestaña «Asistente».`,
        `En el modelo elige ${nombreModelo(eco)} y guarda.`,
      ],
      accion: { texto: 'Abrir configuración del Kanban', ruta: '/kanban_config' },
    });
  }

  // 4) Guion + catálogo muy pesados: se pagan completos en cada respuesta.
  const tokensPorRespuesta =
    t.costo_exacto_msgs > 0 ? (t.tk_entrada + t.tk_cache) / Math.max(1, t.costo_exacto_msgs + t.msgs_remarketing - t.msgs_remarketing_estimados) : 0;
  // Solo con Claude: ahí la entrada es guion + catálogo + documentos + recap.
  // Con OpenAI la cadena de la conversación infla la entrada (casi toda en
  // caché) y quitar documentos no la baja: el consejo sería falso.
  if (esClaude && tokensPorRespuesta > 25000) {
    recomendaciones.push({
      id: 'contexto_pesado',
      nivel: 'medio',
      icono: 'bx-file',
      titulo: `Cada respuesta le hace leer a la IA unos ${Math.round(tokensPorRespuesta / 1000)} mil tokens de contexto`,
      detalle:
        'El guion de la columna, el catálogo y los documentos de conocimiento se envían completos en cada respuesta. Lo normal es entre 10 y 20 mil. Quita documentos que el bot no necesita y productos que ya no vendes.',
      pasos: [
        'Entra a la [configuración del Kanban](/kanban_config) y, en la pestaña «Asistente», quita los documentos de conocimiento que el bot no necesita.',
        'En el [listado de productos](/productos) elimina o marca como privados los que ya no vendes.',
      ],
      accion: { texto: 'Abrir configuración del Kanban', ruta: '/kanban_config' },
    });
  }

  // 5) Tablero en una versión vieja de la plantilla: las mejoras (guion y
  //    modelo recomendado por columna) llegan con «Actualizar tablero».
  if (tableroDesactualizado) {
    recomendaciones.push({
      id: 'tablero_desactualizado',
      ahorro_mensual_usd: null,
      nivel: 'info',
      icono: 'bx-refresh',
      titulo: `Tu tablero está en la versión ${versionAplicada} y ya publicamos la ${versionUltima}`,
      detalle: `Cada versión de «${plantilla.nombre}» trae el guion afinado y el modelo recomendado para cada columna. Al actualizar, tu tablero queda como lo dejamos hoy para una cuenta nueva; tus productos y tus conversaciones no cambian.`,
      pasos: [
        'Entra a la [configuración del Kanban](/kanban_config).',
        'Pulsa «Actualizar tablero» en el aviso de nueva versión y confirma.',
      ],
      accion: { texto: 'Actualizar mi tablero', ruta: '/kanban_config' },
    });
  }

  /* Puntaje de eficiencia (0-100): qué tan cerca está la cuenta de gastar
     solo lo necesario. Cada regla que salta descuenta según su peso. */
  let eficiencia = 100;
  for (const rec of recomendaciones) {
    if (rec.id === 'remarketing_ia') eficiencia -= Math.round(pctRemarketing * 50);
    else if (rec.id === 'sin_ia_productos')
      eficiencia -= Math.round((sinFijo.length / Math.max(1, productos.length)) * 20);
    else if (rec.id === 'modelo_premium') eficiencia -= 15;
    else if (rec.id === 'contexto_pesado') eficiencia -= 10;
    else if (rec.id === 'tablero_desactualizado') eficiencia -= 5;
  }
  eficiencia = Math.max(5, Math.min(100, eficiencia));
  const proyeccionMensual = promedioDiario * 30;
  // Nunca más del 90% de lo proyectado: las respuestas de venta siguen costando.
  const ahorroPosible = Math.min(
    proyeccionMensual * 0.9,
    recomendaciones.reduce((s, rec) => s + (Number(rec.ahorro_mensual_usd) || 0), 0),
  );

  /* ── Lo que ya hacemos solos ───────────────────────────────────────── */
  const automatico = [];
  const equivalentes = columnasInfo.filter((c) => c.equivalente_automatico);
  if (equivalentes.length) {
    automatico.push({
      icono: 'bx-chip',
      titulo: 'Modelo equivalente en cada columna',
      detalle: `${equivalentes.length} ${equivalentes.length === 1 ? 'columna tiene' : 'columnas tienen'} el modelo recomendado de la plantilla; con Claude ${equivalentes.length === 1 ? 'responde' : 'responden'} con su equivalente en precio (${[...new Set(equivalentes.map((c) => c.modelo_nombre))].join(', ')}), no con el más caro.`,
    });
  }
  if (pasosIA > 0 && esClaude) {
    automatico.push({
      icono: 'bx-alarm',
      titulo: 'Recordatorios con el modelo económico',
      detalle: `Los recordatorios de remarketing con IA se escriben con ${nombreModelo(MODELO_REMARKETING)}, sin importar el modelo de la columna: son mensajes cortos y no necesitan el modelo de ventas.`,
    });
  }
  automatico.push({
    icono: 'bx-data',
    titulo: 'Guion en caché',
    detalle:
      'Tu guion y tu catálogo se guardan en caché entre respuestas: cuando hay conversaciones seguidas, releerlos cuesta hasta 10 veces menos.',
  });
  if (t.msgs_sin_ia > 0) {
    automatico.push({
      icono: 'bx-bolt-circle',
      titulo: 'Respuestas sin IA',
      detalle: `${t.msgs_sin_ia} respuestas de los últimos ${DIAS} días salieron sin IA (mensaje de bienvenida y respuestas rápidas): te ahorraron ≈ ${usd(t.ahorro_estimado_usd)}.`,
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      proveedor,
      rango_dias: DIAS,
      resumen: {
        // El día de hoy tal como sale en la serie de la semana (misma
        // estimación de lo no medido), para que la cifra y la gráfica coincidan.
        gasto_hoy_usd:
          semana.dias.find((d) => d.dia === hoy.dias[0]?.dia)?.costo_usd ??
          hoy.totales.costo_usd,
        gasto_periodo_usd: t.costo_usd,
        dias_activos: diasActivos,
        promedio_diario_usd: promedioDiario,
        proyeccion_mensual_usd: proyeccionMensual,
        ahorro_posible_mensual_usd: ahorroPosible,
        eficiencia,
        // Cuántos días dura una recarga de $5 / $10 a este ritmo.
        dias_por_5_usd: promedioDiario > 0 ? 5 / promedioDiario : null,
        dias_por_10_usd: promedioDiario > 0 ? 10 / promedioDiario : null,
        pct_remarketing: pctRemarketing,
        pct_sin_ia: pctSinIA,
        costo_remarketing_usd: t.costo_remarketing_usd,
        costo_respuestas_usd: t.costo_usd - t.costo_remarketing_usd,
        msgs_ia: t.msgs_ia,
        msgs_sin_ia: t.msgs_sin_ia,
        msgs_remarketing: t.msgs_remarketing,
        hay_estimados: t.msgs_remarketing_estimados > 0,
        // Lo medido, sin proyectar: cuánto costó atender a cada cliente.
        clientes_atendidos: clientesAtendidos,
        costo_por_cliente_usd: clientesAtendidos ? t.costo_usd / clientesAtendidos : null,
        costo_por_respuesta_usd: t.msgs_ia
          ? (t.costo_usd - t.costo_remarketing_usd) / t.msgs_ia
          : null,
        costo_por_recordatorio_usd: t.msgs_remarketing
          ? t.costo_remarketing_usd / t.msgs_remarketing
          : null,
      },
      productos: {
        cargados: productosTodos.length,
        en_pauta: pautaDetectada ? productos.length : null,
        dias_pauta: DIAS_PAUTA,
      },
      // Gasto por día del período, del más viejo al más nuevo (para la gráfica).
      serie: [...semana.dias]
        .sort((a, b) => String(a.dia).localeCompare(String(b.dia)))
        .map((d) => ({
          dia: d.dia,
          costo_usd: d.costo_usd,
          costo_remarketing_usd: d.costo_remarketing_usd,
          respuestas: d.msgs_ia,
          recordatorios: d.msgs_remarketing,
        })),
      tablero: plantilla
        ? {
            plantilla: plantilla.nombre,
            version_aplicada: versionAplicada,
            version_ultima: versionUltima,
            desactualizado: tableroDesactualizado,
          }
        : null,
      recomendaciones,
      automatico,
      columnas: columnasInfo,
      remarketing: {
        pasos_con_ia: pasosIA,
        productos: productos.length,
        productos_con_remarketing_propio: conRmkProducto.size,
      },
    },
  });
});

/* ════════════════════════════════════════════════════════════════════
   Caché en memoria con vencimiento. El panel y el asesor recorren los
   mensajes del período en cada entrada a la pestaña (segundos en cuentas
   grandes) y el gasto no cambia de un minuto a otro: se guarda la respuesta
   unos minutos por cuenta y período. `refrescar: true` en el body (botón
   «Actualizar») la salta. Es por proceso: con varios procesos cada uno
   tiene la suya, que para un dato informativo alcanza.
   ════════════════════════════════════════════════════════════════════ */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();

function conCache(clavePara, handler) {
  return (req, res, next) => {
    const clave = clavePara(req.body || {});
    const ahora = Date.now();
    const guardado = clave ? cache.get(clave) : null;
    const refrescar = req.body?.refrescar === true || req.body?.refrescar === 'true';
    if (guardado && !refrescar && ahora - guardado.t < CACHE_TTL_MS) {
      return res.status(200).json({
        ...guardado.cuerpo,
        cache: { desde: new Date(guardado.t).toISOString(), ttl_s: CACHE_TTL_MS / 1000 },
      });
    }
    // Se guarda lo que el handler responde con 200; un error no se cachea.
    let codigo = 200;
    const status = res.status.bind(res);
    const json = res.json.bind(res);
    res.status = (c) => {
      codigo = c;
      return status(c);
    };
    res.json = (cuerpo) => {
      if (clave && codigo === 200 && cuerpo?.status === 'success') {
        if (cache.size >= CACHE_MAX) {
          for (const [k, v] of cache) {
            if (ahora - v.t >= CACHE_TTL_MS || cache.size >= CACHE_MAX) cache.delete(k);
            if (cache.size < CACHE_MAX / 2) break;
          }
        }
        cache.set(clave, { t: Date.now(), cuerpo });
      }
      return json(cuerpo);
    };
    return handler(req, res, next);
  };
}

exports.resumen = conCache(
  (b) =>
    Number(b.id_configuracion)
      ? `resumen|${Number(b.id_configuracion)}|${b.dias}|${b.proveedor || ''}`
      : null,
  exports.resumen,
);
exports.diagnostico = conCache(
  (b) => (Number(b.id_configuracion) ? `diagnostico|${Number(b.id_configuracion)}` : null),
  exports.diagnostico,
);
