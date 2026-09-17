/**
 * asistente_cuenta.service.js
 *
 * Herramientas (function calling) del asistente flotante "de la cuenta":
 * responde preguntas sobre las guías Dropi, los productos más vendidos y los
 * pedidos Aliclik de UNA configuración.
 *
 * Regla de seguridad: el modelo nunca escribe SQL ni elige el tenant. Solo
 * elige entre consultas fijas y sus parámetros (fechas, agrupación, límite);
 * el id_configuracion lo pone el backend, ya validado por protectConfigOwner.
 */

const { db, db_2 } = require('../database/config');

const MAX_DIAS_RANGO = 366;
const DIAS_POR_DEFECTO = 30;
// Debajo de esto una tasa de entrega (entregadas / finalizadas) no dice nada.
const MIN_FINALIZADAS_TASA = 5;

// Vocabulario de dropi_orders_cache.classified_status (ver classifyDropiStatus
// en dropi_notifier.service.js).
const ESTADOS_DROPI = {
  pendiente: 'Pendiente / por confirmar',
  guia_generada: 'Guía generada',
  en_transito: 'En tránsito (recolectado, en bodega, despachado)',
  en_reparto: 'En reparto',
  novedad: 'Novedad',
  retiro_agencia: 'Retiro en agencia',
  entregada: 'Entregada',
  devolucion: 'Devolución',
  cancelada: 'Cancelada',
  indemnizada: 'Indemnizada / siniestro',
  otro: 'Otro',
};

/* ─── Fechas (la BD guarda hora de Ecuador, -05:00) ─── */

function hoyEcuador() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function sumarDias(ymd, dias) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function fechaValida(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v
    ? null
    : v;
}

// Normaliza el rango que pidió el modelo: por defecto últimos 30 días,
// invierte si viene al revés y lo recorta a un año.
function resolverRango(args) {
  const hoy = hoyEcuador();
  let hasta = fechaValida(args?.hasta) || hoy;
  let desde = fechaValida(args?.desde) || sumarDias(hasta, -(DIAS_POR_DEFECTO - 1));
  if (desde > hasta) [desde, hasta] = [hasta, desde];
  if (sumarDias(desde, MAX_DIAS_RANGO) < hasta) {
    desde = sumarDias(hasta, -MAX_DIAS_RANGO);
  }
  return {
    desde,
    hasta,
    from: `${desde} 00:00:00`,
    until: `${hasta} 23:59:59`,
  };
}

function limiteEntre(v, min, max, porDefecto) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(max, Math.max(min, n));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dinero(v) {
  return Math.round(num(v) * 100) / 100;
}

function tasa(parte, total) {
  return total > 0 ? Math.round((parte / total) * 1000) / 10 : null;
}

/* ─── Integraciones de la cuenta ─── */

async function integracionesActivas(idConfiguracion) {
  const [row] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM dropi_integrations
         WHERE id_configuracion = :cfg AND is_active = 1 AND deleted_at IS NULL) AS dropi,
       (SELECT COUNT(*) FROM aliclik_integrations
         WHERE id_configuracion = :cfg AND is_active = 1 AND deleted_at IS NULL) AS aliclik,
       (SELECT COUNT(*) FROM shopify_configuraciones
         WHERE id_configuracion = :cfg AND activo = 1) AS shopify,
       EXISTS(SELECT 1 FROM dropi_orders_cache
         WHERE id_configuracion = :cfg AND id_usuario = 0) AS dropi_historial,
       EXISTS(SELECT 1 FROM aliclik_orders_cache
         WHERE id_configuracion = :cfg) AS aliclik_historial`,
    { replacements: { cfg: idConfiguracion }, type: db.QueryTypes.SELECT },
  );
  const dropi = num(row?.dropi) > 0;
  const aliclik = num(row?.aliclik) > 0;
  return {
    // Conectada hoy: decide recomendaciones y enlaces de registro.
    dropi,
    aliclik,
    // Shopify no tiene tools de métricas; solo informa la recomendación.
    shopify: num(row?.shopify) > 0,
    // Con datos consultables: decide qué tools se ofrecen. Si la cuenta
    // desvincula Dropi, sus órdenes siguen en el cache y el historial debe
    // seguir respondiendo.
    datosDropi: dropi || num(row?.dropi_historial) > 0,
    datosAliclik: aliclik || num(row?.aliclik_historial) > 0,
  };
}

/* ─── Dropi ─── */

// Filas de la cuenta: las órdenes de una integración ligada a configuración
// se guardan con id_usuario = 0 (igual que getDailyMetrics). REEMPLAZADA es la
// orden vieja de un cambio de transportadora: contarla duplicaría la venta.
const WHERE_DROPI = `c.id_configuracion = :cfg
  AND c.id_usuario = 0
  AND c.order_created_at BETWEEN :from AND :until
  AND (c.status <> 'REEMPLAZADA' OR c.status IS NULL)`;

async function guiasDropiResumen(idConfiguracion, args) {
  const rango = resolverRango(args);
  const agruparPor = [
    'estado',
    'estado_detallado',
    'transportadora',
    'ciudad',
  ].includes(args?.agrupar_por)
    ? args.agrupar_por
    : 'estado';
  const repl = { cfg: idConfiguracion, from: rango.from, until: rango.until };

  const [tot] = await db.query(
    `SELECT COUNT(*) AS ordenes,
            SUM(c.shipping_guide IS NOT NULL AND TRIM(c.shipping_guide) <> '') AS con_guia,
            SUM(c.classified_status = 'entregada')  AS entregadas,
            SUM(c.classified_status = 'devolucion') AS devoluciones,
            SUM(c.total_order) AS monto_total,
            SUM(CASE WHEN c.classified_status = 'entregada' THEN c.total_order ELSE 0 END) AS monto_entregado
       FROM dropi_orders_cache c
      WHERE ${WHERE_DROPI}`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );

  const entregadas = num(tot?.entregadas);
  const devoluciones = num(tot?.devoluciones);
  const resumen = {
    periodo: { desde: rango.desde, hasta: rango.hasta },
    total_ordenes: num(tot?.ordenes),
    ordenes_con_guia: num(tot?.con_guia),
    entregadas,
    devoluciones,
    // Sobre finalizadas: las que siguen en camino todavía no cuentan.
    tasa_entrega_pct: tasa(entregadas, entregadas + devoluciones),
    ...(entregadas + devoluciones < MIN_FINALIZADAS_TASA && {
      aviso_tasa: `Tasa poco confiable: solo ${entregadas + devoluciones} órdenes finalizadas.`,
    }),
    monto_total: dinero(tot?.monto_total),
    monto_entregado: dinero(tot?.monto_entregado),
  };

  let grupos;
  if (agruparPor === 'estado') {
    const rows = await db.query(
      `SELECT COALESCE(c.classified_status, 'otro') AS estado,
              COUNT(*) AS ordenes, SUM(c.total_order) AS monto
         FROM dropi_orders_cache c
        WHERE ${WHERE_DROPI}
        GROUP BY estado
        ORDER BY ordenes DESC`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    );
    grupos = rows.map((r) => ({
      clave: r.estado,
      estado: ESTADOS_DROPI[r.estado] || r.estado,
      ordenes: num(r.ordenes),
      monto: dinero(r.monto),
    }));
  } else if (agruparPor === 'estado_detallado') {
    // El texto crudo de Dropi/transportadora (p. ej. "RECOLECTADO").
    const rows = await db.query(
      `SELECT COALESCE(NULLIF(TRIM(c.status), ''), 'SIN ESTADO') AS estado,
              COUNT(*) AS ordenes
         FROM dropi_orders_cache c
        WHERE ${WHERE_DROPI}
        GROUP BY estado
        ORDER BY ordenes DESC
        LIMIT 40`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    );
    grupos = rows.map((r) => ({ estado: r.estado, ordenes: num(r.ordenes) }));
  } else {
    const expr =
      agruparPor === 'transportadora'
        ? `COALESCE(NULLIF(UPPER(TRIM(c.shipping_company)), ''), 'SIN TRANSPORTADORA')`
        : `COALESCE(NULLIF(UPPER(TRIM(c.city)), ''), 'SIN CIUDAD')`;
    const rows = await db.query(
      `SELECT ${expr} AS nombre,
              COUNT(*) AS ordenes,
              SUM(c.classified_status = 'entregada')  AS entregadas,
              SUM(c.classified_status = 'devolucion') AS devoluciones,
              SUM(c.classified_status = 'novedad')    AS novedades
         FROM dropi_orders_cache c
        WHERE ${WHERE_DROPI}
        GROUP BY nombre
        ORDER BY ordenes DESC
        LIMIT 20`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    );
    grupos = rows.map((r) => {
      const ent = num(r.entregadas);
      const dev = num(r.devoluciones);
      return {
        [agruparPor]: r.nombre,
        ordenes: num(r.ordenes),
        entregadas: ent,
        devoluciones: dev,
        novedades: num(r.novedades),
        finalizadas: ent + dev,
        tasa_entrega_pct: tasa(ent, ent + dev),
        ...(ent + dev < MIN_FINALIZADAS_TASA && {
          aviso: `Tasa poco confiable: solo ${ent + dev} órdenes finalizadas.`,
        }),
      };
    });
  }

  return { ...resumen, agrupado_por: agruparPor, grupos };
}

const ORDEN_PRODUCTOS = {
  unidades_entregadas: 'unidades_entregadas',
  ordenes: 'ordenes',
  venta_entregada: 'venta_entregada',
};

// Mismo cálculo que getProductMetrics (dropi_integrations.controller.js): la
// venta de cada producto es su porción del total de la orden según qty × precio.
async function productosMasVendidos(idConfiguracion, args) {
  const rango = resolverRango(args);
  const ordenarPor =
    ORDEN_PRODUCTOS[args?.ordenar_por] || ORDEN_PRODUCTOS.unidades_entregadas;
  const limite = limiteEntre(args?.limite, 1, 20, 10);

  const rows = await db.query(
    `WITH ordenes AS (
       SELECT c.id AS order_id, c.classified_status, c.total_order,
              (SELECT SUM(x.qty * x.sp) FROM JSON_TABLE(c.order_data, '$.orderdetails[*]' COLUMNS (
                 qty INT PATH '$.quantity',
                 sp DECIMAL(10,2) PATH '$.product.sale_price'
               )) AS x) AS subtotal_items
         FROM dropi_orders_cache c
        WHERE ${WHERE_DROPI}
     )
     SELECT jt.product_name AS producto,
            jt.sku,
            COUNT(DISTINCT o.order_id) AS ordenes,
            SUM(jt.quantity) AS unidades,
            SUM(CASE WHEN o.classified_status = 'entregada' THEN jt.quantity ELSE 0 END) AS unidades_entregadas,
            SUM(CASE WHEN o.classified_status = 'entregada' THEN 1 ELSE 0 END) AS ordenes_entregadas,
            SUM(CASE WHEN o.classified_status = 'devolucion' THEN 1 ELSE 0 END) AS devoluciones,
            SUM(CASE WHEN o.classified_status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
            SUM(CASE WHEN o.classified_status = 'entregada' AND o.subtotal_items > 0
                     THEN o.total_order * ((jt.quantity * jt.sale_price) / o.subtotal_items)
                     ELSE 0 END) AS venta_entregada
       FROM ordenes o,
            JSON_TABLE(
              (SELECT order_data FROM dropi_orders_cache WHERE id = o.order_id),
              '$.orderdetails[*]' COLUMNS (
                product_name VARCHAR(300) PATH '$.product.name',
                sku VARCHAR(100) PATH '$.product.sku',
                sale_price DECIMAL(10,2) PATH '$.product.sale_price',
                quantity INT PATH '$.quantity'
              )
            ) AS jt
      GROUP BY jt.product_name, jt.sku
      ORDER BY ${ordenarPor} DESC
      LIMIT ${limite}`,
    {
      replacements: {
        cfg: idConfiguracion,
        from: rango.from,
        until: rango.until,
      },
      type: db.QueryTypes.SELECT,
    },
  );

  return {
    periodo: { desde: rango.desde, hasta: rango.hasta },
    ordenado_por: ordenarPor,
    nota: 'Solo cuenta órdenes Dropi con detalle de productos sincronizado.',
    productos: rows.map((r) => ({
      producto: r.producto || '(sin nombre)',
      sku: r.sku || null,
      ordenes: num(r.ordenes),
      unidades: num(r.unidades),
      unidades_entregadas: num(r.unidades_entregadas),
      ordenes_entregadas: num(r.ordenes_entregadas),
      devoluciones: num(r.devoluciones),
      canceladas: num(r.canceladas),
      venta_entregada: dinero(r.venta_entregada),
    })),
  };
}

// Palabras del nombre buscado: cada una debe aparecer en el nombre del
// producto ("audifonos m27" encuentra "AUDÍFONOS BLUETOOTH M27").
function tokensBusqueda(texto) {
  return String(texto || '')
    .toLowerCase()
    .replace(/[%_\\]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}-]/gu, ''))
    .filter((t) => t.length >= 2)
    .slice(0, 6);
}

function condicionTokens(columna, tokens, repl) {
  return tokens
    .map((t, i) => {
      repl[`tok${i}`] = `%${t}%`;
      // Sin distinguir mayúsculas ni tildes.
      return `${columna} COLLATE utf8mb4_unicode_ci LIKE :tok${i}`;
    })
    .join(' AND ');
}

// Ventas de un producto puntual: unidades, entregas y a qué precio se le
// cobra al cliente (su porción del total de la orden / unidades), con el
// precio de catálogo y la última venta si en el periodo no vendió.
async function ventasProducto(idConfiguracion, args, integraciones) {
  const tokens = tokensBusqueda(args?.nombre);
  if (!tokens.length) {
    return { error: 'Indica el nombre del producto que quieres consultar.' };
  }
  const rango = resolverRango(args);
  const buscado = String(args.nombre).slice(0, 120);
  const resultado = {
    producto_buscado: buscado,
    periodo: { desde: rango.desde, hasta: rango.hasta },
    productos: [],
  };

  if (integraciones.datosDropi) {
    const repl = { cfg: idConfiguracion, from: rango.from, until: rango.until };
    const filtro = condicionTokens('jt.product_name', tokens, repl);
    const detalle = `JSON_TABLE(
              (SELECT order_data FROM dropi_orders_cache WHERE id = o.order_id),
              '$.orderdetails[*]' COLUMNS (
                product_name VARCHAR(300) PATH '$.product.name',
                sku VARCHAR(100) PATH '$.product.sku',
                sale_price DECIMAL(10,2) PATH '$.product.sale_price',
                quantity INT PATH '$.quantity'
              )
            ) AS jt`;
    const ordenesCte = (where) => `WITH ordenes AS (
       SELECT c.id AS order_id, c.classified_status, c.total_order, c.order_created_at,
              (SELECT SUM(x.qty * x.sp) FROM JSON_TABLE(c.order_data, '$.orderdetails[*]' COLUMNS (
                 qty INT PATH '$.quantity',
                 sp DECIMAL(10,2) PATH '$.product.sale_price'
               )) AS x) AS subtotal_items
         FROM dropi_orders_cache c
        WHERE ${where}
     )`;

    const rows = await db.query(
      `${ordenesCte(WHERE_DROPI)}
       SELECT jt.product_name AS producto,
              jt.sku,
              COUNT(DISTINCT o.order_id) AS ordenes,
              SUM(jt.quantity) AS unidades,
              SUM(CASE WHEN o.classified_status = 'entregada' THEN jt.quantity ELSE 0 END) AS unidades_entregadas,
              SUM(CASE WHEN o.classified_status = 'devolucion' THEN 1 ELSE 0 END) AS devoluciones,
              SUM(CASE WHEN o.classified_status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
              SUM(CASE WHEN o.classified_status = 'entregada' AND o.subtotal_items > 0
                       THEN o.total_order * ((jt.quantity * jt.sale_price) / o.subtotal_items)
                       ELSE 0 END) AS venta_entregada,
              SUM(CASE WHEN o.classified_status <> 'cancelada' AND o.subtotal_items > 0
                       THEN o.total_order * ((jt.quantity * jt.sale_price) / o.subtotal_items)
                       ELSE 0 END) AS cobrado_no_cancelado,
              SUM(CASE WHEN o.classified_status <> 'cancelada' AND o.subtotal_items > 0
                       THEN jt.quantity ELSE 0 END) AS unidades_no_canceladas,
              MIN(CASE WHEN o.classified_status <> 'cancelada' AND o.subtotal_items > 0
                       THEN o.total_order * (jt.sale_price / o.subtotal_items) END) AS precio_min,
              MAX(CASE WHEN o.classified_status <> 'cancelada' AND o.subtotal_items > 0
                       THEN o.total_order * (jt.sale_price / o.subtotal_items) END) AS precio_max,
              AVG(jt.sale_price) AS costo_proveedor,
              MAX(o.order_created_at) AS ultima_venta
         FROM ordenes o, ${detalle}
        WHERE ${filtro}
        GROUP BY jt.product_name, jt.sku
        ORDER BY unidades DESC
        LIMIT 8`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    );

    resultado.productos = rows.map((r) => {
      const unidades = num(r.unidades_no_canceladas);
      return {
        plataforma: 'Dropi',
        producto: r.producto || '(sin nombre)',
        sku: r.sku || null,
        ordenes: num(r.ordenes),
        unidades: num(r.unidades),
        unidades_entregadas: num(r.unidades_entregadas),
        devoluciones: num(r.devoluciones),
        canceladas: num(r.canceladas),
        venta_entregada: dinero(r.venta_entregada),
        precio_venta_promedio: unidades ? dinero(num(r.cobrado_no_cancelado) / unidades) : null,
        precio_venta_min: r.precio_min === null ? null : dinero(r.precio_min),
        precio_venta_max: r.precio_max === null ? null : dinero(r.precio_max),
        costo_proveedor: r.costo_proveedor === null ? null : dinero(r.costo_proveedor),
        ultima_venta: r.ultima_venta,
      };
    });

    // Sin ventas en el periodo: ¿vendió antes? (último año)
    if (!resultado.productos.length) {
      const replH = { cfg: idConfiguracion };
      const filtroH = condicionTokens('jt.product_name', tokens, replH);
      const [hist] = await db.query(
        `${ordenesCte(`c.id_configuracion = :cfg
            AND c.id_usuario = 0
            AND c.order_created_at >= (NOW() - INTERVAL 365 DAY)
            AND (c.status <> 'REEMPLAZADA' OR c.status IS NULL)`)}
         SELECT COUNT(DISTINCT o.order_id) AS ordenes, MAX(o.order_created_at) AS ultima_venta
           FROM ordenes o, ${detalle}
          WHERE ${filtroH}`,
        { replacements: replH, type: db.QueryTypes.SELECT },
      );
      if (num(hist?.ordenes) > 0) {
        resultado.historico_ultimo_anio = {
          ordenes: num(hist.ordenes),
          ultima_venta: hist.ultima_venta,
        };
      }
    }
  }

  if (integraciones.datosAliclik) {
    const repl = { cfg: idConfiguracion, from: rango.from, until: rango.until };
    const filtro = condicionTokens('a.product_detail', tokens, repl);
    const [ali] = await db.query(
      `SELECT COUNT(*) AS pedidos,
              SUM(a.estado_config = 'ENTREGADA') AS entregados,
              SUM(a.total) AS monto
         FROM aliclik_orders_cache a
        WHERE ${WHERE_ALICLIK} AND ${filtro}`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    );
    if (num(ali?.pedidos) > 0) {
      resultado.aliclik = {
        pedidos: num(ali.pedidos),
        entregados: num(ali.entregados),
        monto_total: dinero(ali.monto),
      };
    }
  }

  // Precio configurado en el catálogo de ImporChat (el que usa el bot).
  const replCat = { cfg: idConfiguracion };
  const filtroCat = condicionTokens('p.nombre', tokens, replCat);
  const catalogo = await db.query(
    `SELECT p.nombre, p.precio
       FROM productos_chat_center p
      WHERE p.id_configuracion = :cfg
        AND (p.eliminado = 0 OR p.eliminado IS NULL)
        AND ${filtroCat}
      LIMIT 5`,
    { replacements: replCat, type: db.QueryTypes.SELECT },
  );
  if (catalogo.length) {
    resultado.catalogo = catalogo.map((c) => ({
      nombre: c.nombre,
      precio: c.precio === null ? null : dinero(c.precio),
    }));
  }

  if (!resultado.productos.length && !resultado.aliclik) {
    resultado.mensaje = `No hay ventas de "${buscado}" en el periodo consultado.`;
  }
  return resultado;
}

/* ─── Aliclik ─── */

const WHERE_ALICLIK = `a.id_configuracion = :cfg
  AND a.order_created_at BETWEEN :from AND :until`;

async function pedidosAliclikResumen(idConfiguracion, args) {
  const rango = resolverRango(args);
  const agruparPor = ['estado', 'ciudad', 'producto'].includes(
    args?.agrupar_por,
  )
    ? args.agrupar_por
    : 'estado';
  const repl = { cfg: idConfiguracion, from: rango.from, until: rango.until };

  const [tot] = await db.query(
    `SELECT COUNT(*) AS pedidos,
            SUM(a.estado_config = 'ENTREGADA')  AS entregados,
            SUM(a.estado_config = 'DEVOLUCION') AS devoluciones,
            SUM(a.total) AS monto_total,
            SUM(CASE WHEN a.estado_config = 'ENTREGADA' THEN a.total ELSE 0 END) AS monto_entregado
       FROM aliclik_orders_cache a
      WHERE ${WHERE_ALICLIK}`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );

  const expr = {
    estado: `COALESCE(NULLIF(a.estado_config, ''), 'SIN ESTADO NOTIFICABLE')`,
    ciudad: `COALESCE(NULLIF(UPPER(TRIM(a.city)), ''), 'SIN CIUDAD')`,
    producto: `COALESCE(NULLIF(TRIM(a.product_detail), ''), '(sin detalle)')`,
  }[agruparPor];

  const rows = await db.query(
    `SELECT LEFT(${expr}, 200) AS nombre,
            COUNT(*) AS pedidos,
            SUM(a.estado_config = 'ENTREGADA') AS entregados,
            SUM(a.total) AS monto
       FROM aliclik_orders_cache a
      WHERE ${WHERE_ALICLIK}
      GROUP BY nombre
      ORDER BY pedidos DESC
      LIMIT 20`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );

  const entregados = num(tot?.entregados);
  const devoluciones = num(tot?.devoluciones);
  return {
    periodo: { desde: rango.desde, hasta: rango.hasta },
    total_pedidos: num(tot?.pedidos),
    entregados,
    devoluciones,
    tasa_entrega_pct: tasa(entregados, entregados + devoluciones),
    monto_total: dinero(tot?.monto_total),
    monto_entregado: dinero(tot?.monto_entregado),
    agrupado_por: agruparPor,
    grupos: rows.map((r) => ({
      [agruparPor]: r.nombre,
      pedidos: num(r.pedidos),
      entregados: num(r.entregados),
      monto: dinero(r.monto),
    })),
  };
}

/* ─── Videos tutoriales (curso de Imporsuit, BD db_2) ─── */

// Curso 32, módulo 136 "Crea y configura el agente de IA": los videos de
// configuración de ImporChat. Se reproducen con el embed de Bunny Stream, igual
// que en imporsuit-pro (Views/templates/nova/nova-player.js).
const ID_MODULO_TUTORIALES = 136;
const CACHE_VIDEOS_MS = 10 * 60 * 1000;
const MAX_VIDEOS_RESPUESTA = 3;
let cacheVideos = { at: 0, videos: null };

// Solo embeds de Bunny Stream: la URL termina en un iframe del front.
const RE_EMBED_BUNNY =
  /^https:\/\/(?:player|iframe)\.mediadelivery\.net\/embed\/(\d+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function embedBunny(url) {
  const m = RE_EMBED_BUNNY.exec(String(url || '').trim());
  return m ? `https://player.mediadelivery.net/embed/${m[1]}/${m[2]}` : null;
}

function normalizarTexto(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// Palabras que no ayudan a elegir video ("cómo conecto mi Dropi con ImporChat").
const PALABRAS_VACIAS = new Set(
  'a al como con cual cuales de del donde el en es esta este hacer hago la las lo los me mi mis para por puedo que quiero se si su sus tu tus un una uno y o video videos tutorial tutoriales imporchat ver ensena ensenar explica explicame necesito ayuda'.split(
    ' ',
  ),
);

async function videosTutoriales() {
  if (cacheVideos.videos && Date.now() - cacheVideos.at < CACHE_VIDEOS_MS) {
    return cacheVideos.videos;
  }
  const rows = await db_2.query(
    `SELECT id_contenido, orden, titulo, video_descripcion, video_url,
            thumbnail, duracion_segundos
       FROM cursos_contenidos
      WHERE id_modulo = :modulo AND tipo = 'video' AND visible = 1
      ORDER BY orden, id_contenido`,
    { replacements: { modulo: ID_MODULO_TUTORIALES }, type: db_2.QueryTypes.SELECT },
  );
  const videos = rows
    .map((r) => ({
      id: Number(r.id_contenido),
      orden: num(r.orden),
      titulo: String(r.titulo || '').trim(),
      descripcion: String(r.video_descripcion || '').trim(),
      embed_url: embedBunny(r.video_url),
      thumbnail: /^https:\/\//i.test(r.thumbnail || '') ? r.thumbnail : null,
      duracion_segundos: num(r.duracion_segundos) || null,
    }))
    .filter((v) => v.embed_url && v.titulo);
  cacheVideos = { at: Date.now(), videos };
  return videos;
}

// Compara por raíz de 5 letras para cubrir conjugaciones ("conectar" ~
// "conecta", "productos" ~ "producto").
const raizPalabra = (p) => (p.length > 5 ? p.slice(0, 5) : p);

// Puntaje: la palabra en el título vale 3 y en la descripción 1, dividido por
// cuántos videos la contienen. Así "dropi" (pocos videos) pesa más que
// "conectar" (muchos) y "conectar dropi" no trae el video de WhatsApp.
function puntajesVideos(videos, palabras) {
  const textos = videos.map((v) => ({
    titulo: normalizarTexto(v.titulo),
    desc: normalizarTexto(v.descripcion),
  }));
  const frecuencia = palabras.map((p) => {
    const raiz = raizPalabra(p);
    return textos.filter((t) => t.titulo.includes(raiz) || t.desc.includes(raiz)).length;
  });
  return textos.map((t) =>
    palabras.reduce((total, p, i) => {
      if (!frecuencia[i]) return total;
      const raiz = raizPalabra(p);
      const peso = t.titulo.includes(raiz) ? 3 : t.desc.includes(raiz) ? 1 : 0;
      return total + peso / frecuencia[i];
    }, 0),
  );
}

async function buscarVideosTutoriales(args) {
  const videos = await videosTutoriales();
  const publico = (v) => ({
    id: v.id,
    titulo: v.titulo,
    descripcion: v.descripcion.slice(0, 300),
    duracion_segundos: v.duracion_segundos,
    thumbnail: v.thumbnail,
    embed_url: v.embed_url,
  });

  const ids = Array.isArray(args?.ids)
    ? args.ids.map(Number).filter(Number.isFinite).slice(0, MAX_VIDEOS_RESPUESTA)
    : [];
  if (ids.length) {
    const elegidos = ids
      .map((id) => videos.find((v) => v.id === id))
      .filter(Boolean)
      .map(publico);
    return { videos: elegidos };
  }

  const palabras = [
    ...new Set(
      normalizarTexto(args?.tema)
        .split(/[^a-z0-9]+/)
        .filter((p) => p.length >= 3 && !PALABRAS_VACIAS.has(p)),
    ),
  ];

  let encontrados = [];
  if (palabras.length) {
    const puntos = puntajesVideos(videos, palabras);
    encontrados = videos
      .map((v, i) => ({ v, puntos: puntos[i] }))
      .filter((x) => x.puntos > 0)
      .sort((a, b) => b.puntos - a.puntos || a.v.orden - b.v.orden);
    // Solo los que están cerca del mejor: evita rellenar con coincidencias
    // de una palabra genérica.
    const mejor = encontrados[0]?.puntos || 0;
    encontrados = encontrados.filter((x) => x.puntos >= mejor * 0.6);
  }

  if (encontrados.length) {
    return {
      videos: encontrados.slice(0, MAX_VIDEOS_RESPUESTA).map((x) => publico(x.v)),
    };
  }

  // Sin coincidencias: se devuelve el índice (sin URLs) para que el modelo
  // elija por título y vuelva a llamar con ids, o diga que no hay video.
  return {
    videos: [],
    mensaje: 'No hay coincidencia directa por palabras. Estos son todos los videos disponibles:',
    indice: videos.map((v) => ({ id: v.id, titulo: v.titulo })),
  };
}

/* ─── Búsqueda puntual ─── */

async function buscarPedido(idConfiguracion, args, integraciones) {
  const q = String(args?.numero || '')
    .trim()
    .slice(0, 60);
  if (q.length < 3) {
    return { error: 'Indica un número de guía o de pedido (mínimo 3 caracteres).' };
  }

  const resultados = [];

  if (integraciones.datosDropi) {
    const idOrden = /^\d+$/.test(q) ? q : '0';
    const rows = await db.query(
      `SELECT c.dropi_order_id, c.shipping_guide, c.status, c.classified_status,
              c.shipping_company, c.city, c.total_order, c.order_created_at,
              c.name, c.product_names
         FROM dropi_orders_cache c
        WHERE c.id_configuracion = :cfg AND c.id_usuario = 0
          AND (c.shipping_guide = :q OR c.dropi_order_id = :idOrden)
        ORDER BY c.order_created_at DESC
        LIMIT 5`,
      {
        replacements: { cfg: idConfiguracion, q, idOrden },
        type: db.QueryTypes.SELECT,
      },
    );
    for (const r of rows) {
      resultados.push({
        plataforma: 'Dropi',
        orden: String(r.dropi_order_id),
        guia: r.shipping_guide || null,
        estado: r.status,
        estado_general: ESTADOS_DROPI[r.classified_status] || r.classified_status,
        transportadora: r.shipping_company || null,
        ciudad: r.city || null,
        total: dinero(r.total_order),
        fecha: r.order_created_at,
        cliente: r.name || null,
        productos: r.product_names ? String(r.product_names).slice(0, 200) : null,
      });
    }
  }

  if (integraciones.datosAliclik) {
    const rows = await db.query(
      `SELECT a.order_number, a.estado_config, a.call_status, a.status,
              a.dispatch_status, a.city, a.total, a.order_created_at, a.name,
              a.product_detail
         FROM aliclik_orders_cache a
        WHERE a.id_configuracion = :cfg AND a.order_number = :q
        LIMIT 5`,
      {
        replacements: { cfg: idConfiguracion, q },
        type: db.QueryTypes.SELECT,
      },
    );
    for (const r of rows) {
      resultados.push({
        plataforma: 'Aliclik',
        orden: r.order_number,
        estado: r.estado_config || 'Sin estado notificable',
        detalle_estado: {
          llamada: r.call_status,
          entrega: r.status,
          despacho: r.dispatch_status,
        },
        ciudad: r.city || null,
        total: dinero(r.total),
        fecha: r.order_created_at,
        cliente: r.name || null,
        productos: r.product_detail ? String(r.product_detail).slice(0, 200) : null,
      });
    }
  }

  return resultados.length
    ? { resultados }
    : { resultados: [], mensaje: 'No se encontró ningún pedido con ese número.' };
}

/* ─── Definición de tools para OpenAI ─── */

const PARAM_FECHAS = {
  desde: {
    type: 'string',
    description:
      'Fecha inicial YYYY-MM-DD (fecha de creación del pedido). Si el usuario no indica periodo, omítela: se usan los últimos 30 días.',
  },
  hasta: {
    type: 'string',
    description: 'Fecha final YYYY-MM-DD, inclusive. Por defecto hoy.',
  },
};

function construirTools(integraciones) {
  // Los tutoriales no dependen de integraciones: sirven justo a quien empieza.
  const tools = [
    {
      type: 'function',
      function: {
        name: 'buscar_videos_tutoriales',
        description:
          'Busca videos tutoriales oficiales de ImporChat (crear cuenta, conectar WhatsApp/Meta, OpenAI, métodos de pago, páginas de Facebook e Instagram, vincular Dropi, catálogos, plantillas kanban, personalizar el bot y el prompt, remarketing, orden automática de Dropi, errores en pedidos automáticos, plantillas y respuestas rápidas, productos variables y combos, Aliclik, anuncios de Meta, mensajes masivos, etc.). Úsala cuando pregunten cómo hacer o configurar algo. Los videos se muestran al usuario con reproductor.',
        parameters: {
          type: 'object',
          properties: {
            tema: {
              type: 'string',
              description:
                'Palabras clave de lo que quiere aprender (p. ej. "conectar dropi", "remarketing", "mensajes masivos").',
            },
            ids: {
              type: 'array',
              items: { type: 'integer' },
              description:
                'IDs de videos elegidos del índice que devolvió una búsqueda anterior sin coincidencias (máximo 3).',
            },
          },
          additionalProperties: false,
        },
      },
    },
  ];

  if (integraciones.datosDropi) {
    tools.push(
      {
        type: 'function',
        function: {
          name: 'guias_dropi_resumen',
          description:
            'Cuenta las órdenes/guías Dropi de la cuenta en un periodo: totales, entregadas, devoluciones, tasa de entrega y monto, agrupadas por estado general, estado detallado de la transportadora (p. ej. RECOLECTADO), transportadora o ciudad.',
          parameters: {
            type: 'object',
            properties: {
              ...PARAM_FECHAS,
              agrupar_por: {
                type: 'string',
                enum: ['estado', 'estado_detallado', 'transportadora', 'ciudad'],
                description:
                  'estado = categorías generales; estado_detallado = texto exacto de Dropi/transportadora.',
              },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'productos_mas_vendidos',
          description:
            'Ranking general de los productos más vendidos por Dropi en un periodo. Úsala solo cuando pidan el ranking o los más vendidos; para un producto concreto usa ventas_producto.',
          parameters: {
            type: 'object',
            properties: {
              ...PARAM_FECHAS,
              ordenar_por: {
                type: 'string',
                enum: ['unidades_entregadas', 'ordenes', 'venta_entregada'],
              },
              limite: { type: 'integer', minimum: 1, maximum: 20 },
            },
            additionalProperties: false,
          },
        },
      },
    );
  }

  if (integraciones.datosAliclik) {
    tools.push({
      type: 'function',
      function: {
        name: 'pedidos_aliclik_resumen',
        description:
          'Cuenta los pedidos Aliclik de la cuenta en un periodo: totales, entregados, devoluciones, tasa de entrega y monto, agrupados por estado, ciudad o producto.',
        parameters: {
          type: 'object',
          properties: {
            ...PARAM_FECHAS,
            agrupar_por: {
              type: 'string',
              enum: ['estado', 'ciudad', 'producto'],
            },
          },
          additionalProperties: false,
        },
      },
    });
  }

  if (integraciones.datosDropi || integraciones.datosAliclik) {
    tools.push({
      type: 'function',
      function: {
        name: 'ventas_producto',
        description:
          'Ventas de UN producto específico por su nombre (o parte del nombre): órdenes, unidades, entregas, devoluciones, precio al que se vende al cliente (promedio, mínimo y máximo), costo del proveedor, precio del catálogo y última venta. Úsala siempre que pregunten por un producto concreto.',
        parameters: {
          type: 'object',
          properties: {
            ...PARAM_FECHAS,
            nombre: {
              type: 'string',
              description:
                'Nombre o palabras clave del producto tal como lo escribió el usuario (p. ej. "audifonos m27").',
            },
          },
          required: ['nombre'],
          additionalProperties: false,
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'buscar_pedido',
        description:
          'Busca un pedido puntual por número de guía o número de orden y devuelve su estado actual.',
        parameters: {
          type: 'object',
          properties: {
            numero: { type: 'string', description: 'Número de guía u orden.' },
          },
          required: ['numero'],
          additionalProperties: false,
        },
      },
    });
  }

  return tools;
}

async function ejecutarTool(nombre, args, { idConfiguracion, integraciones }) {
  switch (nombre) {
    case 'guias_dropi_resumen':
      if (!integraciones.datosDropi) break;
      return guiasDropiResumen(idConfiguracion, args);
    case 'productos_mas_vendidos':
      if (!integraciones.datosDropi) break;
      return productosMasVendidos(idConfiguracion, args);
    case 'pedidos_aliclik_resumen':
      if (!integraciones.datosAliclik) break;
      return pedidosAliclikResumen(idConfiguracion, args);
    case 'buscar_videos_tutoriales':
      return buscarVideosTutoriales(args);
    case 'ventas_producto':
      return ventasProducto(idConfiguracion, args, integraciones);
    case 'buscar_pedido':
      return buscarPedido(idConfiguracion, args, integraciones);
    default:
      break;
  }
  return { error: `Herramienta no disponible: ${nombre}` };
}

module.exports = {
  ESTADOS_DROPI,
  hoyEcuador,
  integracionesActivas,
  construirTools,
  ejecutarTool,
};
