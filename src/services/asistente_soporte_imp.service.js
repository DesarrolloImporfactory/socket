/**
 * asistente_soporte_imp.service.js
 *
 * Herramientas del asistente flotante SOLO para la cuenta "Soporte
 * Importaciones Expertos" (id_configuracion 265). A diferencia del asistente
 * de cuenta normal (guías Dropi, productos), aquí el equipo pregunta por su
 * cartera de importaciones: oportunidades comerciales, cargas en curso y
 * clientes en riesgo.
 *
 * Datos: BD del ERP (db_2 / imporsuitpro_new), tablas cotizadorpro_*.
 *
 * Alcance por persona (lo decide el backend, nunca el modelo):
 * - El sub-usuario del chat center se cruza con users del ERP por correo o
 *   usuario; ese id_users es su id_asesor en las cotizaciones.
 * - Un asesor solo ve lo suyo, aunque pida los datos de otro.
 * - Los roles administrador y admin_limitado ven todo, o el asesor que pidan.
 * - Quien no cruza con el ERP no es asesor: no ve cartera de nadie.
 */

const { db, db_2 } = require('../database/config');

// La cuenta a la que aplica este asistente. Si mañana hay otra sucursal, se
// agrega aquí y en el controlador.
const ID_CONFIG_SOPORTE = Number(process.env.ASISTENTE_SOPORTE_ID_CONFIG || 265);

const ROLES_ADMIN = ['administrador', 'admin_limitado', 'super_administrador'];

// Días sin moverse para considerar una cotización estancada.
const DIAS_ESTANCADA = 7;
const LIMITE_FILAS = 10;
const MAX_MENSAJES_CHAT = 6;

// Estados de cotizadorpro_cotizaciones (enum de la tabla).
const ESTADOS_ABIERTOS = ['borrador', 'generado', 'aprobado', 'contactado'];
const ESTADOS_EN_CURSO = ['bodega', 'transito', 'carga', 'proximo'];
const ESTADOS_PERDIDOS = ['rechazado', 'anulado'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const dinero = (v) => Math.round(num(v) * 100) / 100;

function normalizar(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/* ─── Quién pregunta ─── */

/**
 * Cruza el sub-usuario del chat center con el asesor del ERP.
 * Devuelve { esAdmin, idAsesor, nombre } — idAsesor null si no es asesor.
 */
async function perfilSoporte(sessionUser) {
  const rol = String(sessionUser?.rol || '').toLowerCase();
  const esAdmin = ROLES_ADMIN.includes(rol);
  const email = sessionUser?.email || '';
  const usuario = sessionUser?.usuario || '';

  let asesor = null;
  if (email || usuario) {
    const [row] = await db_2.query(
      `SELECT id_users, nombre_users
         FROM users
        WHERE (email_users = :email AND :email <> '')
           OR (usuario_users = :usuario AND :usuario <> '')
        LIMIT 1`,
      { replacements: { email, usuario }, type: db_2.QueryTypes.SELECT },
    );
    if (row) asesor = { id: num(row.id_users), nombre: row.nombre_users };
  }

  return {
    esAdmin,
    idAsesor: asesor?.id || null,
    nombre: asesor?.nombre || sessionUser?.nombre_encargado || 'tú',
    nombreChat: sessionUser?.nombre_encargado || '',
  };
}

/**
 * Asesores con cartera, para que un admin pueda pedir "las de Johan".
 *
 * Se agrega el nombre del chat center como alias: en el ERP varios están
 * guardados a medias ("Belen", "Chico"), y el equipo los nombra como aparecen
 * en el chat ("Belen Garcia ImporFactory").
 */
async function asesoresConCartera() {
  const [asesores, subs] = await Promise.all([
    db_2.query(
      `SELECT c.id_asesor AS id, u.nombre_users AS nombre,
              u.email_users AS email, u.usuario_users AS usuario,
              COUNT(*) AS cotizaciones
         FROM cotizadorpro_cotizaciones c
         JOIN users u ON u.id_users = c.id_asesor
        GROUP BY c.id_asesor, u.nombre_users, u.email_users, u.usuario_users
        ORDER BY cotizaciones DESC`,
      { type: db_2.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT s.nombre_encargado, s.email, s.usuario
         FROM sub_usuarios_chat_center s
         JOIN configuraciones c ON c.id_usuario = s.id_usuario
        WHERE c.id = :cfg`,
      { replacements: { cfg: ID_CONFIG_SOPORTE }, type: db.QueryTypes.SELECT },
    ),
  ]);

  const porCorreo = new Map();
  for (const s of subs) {
    for (const clave of [s.email, s.usuario]) {
      if (clave) porCorreo.set(normalizar(clave), s.nombre_encargado || '');
    }
  }

  return asesores.map((a) => ({
    id: num(a.id),
    nombre: a.nombre,
    alias:
      porCorreo.get(normalizar(a.email)) ||
      porCorreo.get(normalizar(a.usuario)) ||
      '',
    cotizaciones: num(a.cotizaciones),
  }));
}

/**
 * Asesor sobre el que se consulta. Un asesor queda fijado a sí mismo; el
 * admin puede nombrar a alguien y, si no, ve el equipo completo.
 */
async function resolverAlcance(perfil, nombrePedido) {
  if (!perfil.esAdmin) {
    return perfil.idAsesor
      ? { idAsesor: perfil.idAsesor, etiqueta: `tu cartera (${perfil.nombre})` }
      : { sinAcceso: true };
  }
  const buscado = normalizar(nombrePedido);
  if (!buscado || ['todos', 'equipo', 'general'].includes(buscado)) {
    return { idAsesor: null, etiqueta: 'todo el equipo' };
  }
  const asesores = await asesoresConCartera();

  // Se cuenta cuántas palabras del nombre pedido aparecen en el nombre del ERP
  // o en el del chat: pedir "Belen Garcia" cuando en el ERP dice solo "Belen"
  // debe funcionar igual. Gana el de más coincidencias.
  const palabras = buscado.split(/\s+/).filter((p) => p.length >= 3);
  const puntuados = asesores
    .map((a) => {
      const nombres = `${normalizar(a.nombre)} ${normalizar(a.alias)}`;
      const aciertos = palabras.filter((p) => nombres.includes(p)).length;
      return { a, aciertos };
    })
    .filter((x) => x.aciertos > 0)
    .sort((b, c) => c.aciertos - b.aciertos);

  if (!puntuados.length) {
    return {
      error: `No encontré un asesor que se llame "${nombrePedido}".`,
      asesores_disponibles: asesores.map((a) => a.alias || a.nombre),
    };
  }

  const mejor = puntuados[0];
  const empatados = puntuados.filter((x) => x.aciertos === mejor.aciertos);
  if (empatados.length > 1) {
    return {
      error: `Hay varios asesores que coinciden con "${nombrePedido}". ¿Cuál de estos?`,
      coincidencias: empatados.map(
        (x) => `${x.a.alias || x.a.nombre} (${x.a.cotizaciones} cotizaciones)`,
      ),
    };
  }

  const nombreMostrado = mejor.a.alias || mejor.a.nombre;
  return {
    idAsesor: num(mejor.a.id),
    etiqueta: `cartera de ${nombreMostrado}`,
  };
}

/* ─── Consultas al ERP ─── */

// Monto de la cotización = Σ precio × cantidad de sus productos.
const SELECT_BASE = `
  SELECT c.id_cotizacion,
         c.estado,
         c.subestado,
         c.codigo_interno,
         c.fecha_creacion,
         c.fecha_aprobacion,
         c.fecha_coordinada,
         c.fecha_recibida,
         DATEDIFF(NOW(), c.fecha_creacion) AS dias,
         u.nombre_users  AS cliente,
         ua.nombre_users AS asesor,
         d.telefono,
         d.tipo_transporte,
         d.tipo_envio,
         d.pais_destino,
         (SELECT SUM(p.precio * p.cant) FROM cotizadorpro_productos_cot p
           WHERE p.id_cotizacion = c.id_cotizacion) AS monto,
         EXISTS(SELECT 1 FROM cotizador_solicitudes s
                 WHERE s.id_cotizacion = c.id_cotizacion
                   AND s.estado IN ('pendiente', 'espera_asesor')) AS solicitud_proveedor_pendiente
    FROM cotizadorpro_cotizaciones c
    LEFT JOIN cotizadorpro_detalle_cot d ON d.id_cotizacion = c.id_cotizacion
    LEFT JOIN users u  ON u.id_users = d.id_users
    LEFT JOIN users ua ON ua.id_users = c.id_asesor`;

const MODALIDADES = { grupal: 'grupal', individual: 'individual' };
const DESTINOS = { ec: 'ec', mx: 'mx' };
// Hay cotizaciones con el campo vacío en el ERP: se pueden pedir aparte.
const SIN_ESPECIFICAR = 'sin_especificar';

const COLUMNA_ENVIO = {
  transporte: 'd.tipo_transporte',
  modalidad: 'd.tipo_envio',
  destino: 'd.pais_destino',
};

function valorFiltro(eje, valor) {
  const v = String(valor || '').toLowerCase();
  if (!v) return null;
  if (v === SIN_ESPECIFICAR) return SIN_ESPECIFICAR;
  if (eje === 'transporte') {
    return ['aereo', 'maritimo', 'terrestre'].includes(v) ? v : null;
  }
  if (eje === 'modalidad') return MODALIDADES[v] || null;
  return DESTINOS[v] || null;
}

/** Filtros opcionales que comparten las consultas de cartera. */
function filtrosEnvio(args, repl) {
  const where = [];
  const aplicados = {};
  for (const eje of ['transporte', 'modalidad', 'destino']) {
    const valor = valorFiltro(eje, args?.[eje]);
    aplicados[eje] = valor;
    if (!valor) continue;
    const col = COLUMNA_ENVIO[eje];
    if (valor === SIN_ESPECIFICAR) {
      where.push(`(${col} IS NULL OR TRIM(${col}) = '')`);
    } else {
      repl[eje] = valor;
      where.push(`${col} = :${eje}`);
    }
  }
  return { where, aplicados };
}

/**
 * Cotizaciones que el filtro dejó fuera solo porque el ERP tiene ese campo
 * vacío. Se informan para que nadie crea que no existen.
 */
async function contarNoEspecificadas(aplicados, whereComun, repl) {
  const ejes = Object.entries(aplicados).filter(
    ([, v]) => v && v !== SIN_ESPECIFICAR,
  );
  if (!ejes.length) return null;

  const vacios = ejes
    .map(([eje]) => `(${COLUMNA_ENVIO[eje]} IS NULL OR TRIM(${COLUMNA_ENVIO[eje]}) = '')`)
    .join(' OR ');
  const [row] = await db_2.query(
    `SELECT COUNT(*) AS n
       FROM cotizadorpro_cotizaciones c
       LEFT JOIN cotizadorpro_detalle_cot d ON d.id_cotizacion = c.id_cotizacion
      WHERE ${whereComun.join(' AND ')} AND (${vacios})`,
    { replacements: repl, type: db_2.QueryTypes.SELECT },
  );
  const n = num(row?.n);
  if (!n) return null;
  return {
    cotizaciones: n,
    campos: ejes.map(([eje]) => eje),
    nota: `Hay ${n} cotización(es) que no entran en este filtro porque en el ERP tienen ${ejes
      .map(([eje]) => eje)
      .join(' o ')} sin especificar. Menciónalo al final en una línea.`,
  };
}

function filtroAsesor(idAsesor, repl) {
  if (!idAsesor) return '1=1';
  repl.asesor = idAsesor;
  return 'c.id_asesor = :asesor';
}

function filaCotizacion(r) {
  const senales = [];
  if (num(r.solicitud_proveedor_pendiente)) senales.push('sin proveedor');
  if (
    ['borrador', 'generado'].includes(r.estado) &&
    num(r.dias) >= DIAS_ESTANCADA
  ) {
    senales.push(`sin avanzar hace ${num(r.dias)} días`);
  }
  if (r.estado === 'generado' && !r.fecha_aprobacion) senales.push('no aceptada');
  return {
    cotizacion: num(r.id_cotizacion),
    codigo: r.codigo_interno || null,
    cliente: r.cliente || 'Sin nombre',
    asesor: r.asesor || null,
    monto: dinero(r.monto),
    estado: r.estado,
    subestado: r.subestado,
    transporte: r.tipo_transporte || null,
    // "grupal" es carga consolidada; "individual", contenedor propio.
    modalidad: r.tipo_envio || null,
    destino: r.pais_destino ? String(r.pais_destino).toUpperCase() : null,
    dias_desde_creacion: num(r.dias),
    telefono: r.telefono || null,
    senales,
  };
}

/**
 * Oportunidades: cartera abierta ordenada por monto (lo más grande primero),
 * con las señales que pidió el equipo — sin proveedor, sin avanzar, no
 * aceptada.
 */
async function oportunidadesComerciales(alcance, args) {
  const repl = {};
  const where = [filtroAsesor(alcance.idAsesor, repl)];
  where.push(`c.estado IN (${ESTADOS_ABIERTOS.map((e) => db_2.escape(e)).join(',')})`);

  const filtros = filtrosEnvio(args, repl);
  const whereComun = [...where];
  where.push(...filtros.where);

  const minMonto = Number(args?.min_monto);
  const señal = args?.senal;
  if (señal === 'sin_proveedor') {
    where.push(`EXISTS(SELECT 1 FROM cotizador_solicitudes s
                        WHERE s.id_cotizacion = c.id_cotizacion
                          AND s.estado IN ('pendiente','espera_asesor'))`);
  } else if (señal === 'sin_avanzar') {
    where.push(`c.estado IN ('borrador','generado')
                AND c.fecha_creacion < (NOW() - INTERVAL ${DIAS_ESTANCADA} DAY)`);
  } else if (señal === 'no_aceptada') {
    where.push(`c.estado = 'generado' AND c.fecha_aprobacion IS NULL`);
  }

  const limite = Math.min(Math.max(Number(args?.limite) || LIMITE_FILAS, 1), 25);
  const filas = await db_2.query(
    `${SELECT_BASE}
      WHERE ${where.join(' AND ')}
      HAVING monto IS NOT NULL ${Number.isFinite(minMonto) && minMonto > 0 ? 'AND monto >= :minMonto' : ''}
      ORDER BY monto DESC
      LIMIT ${limite}`,
    {
      replacements: { ...repl, minMonto: minMonto || 0 },
      type: db_2.QueryTypes.SELECT,
    },
  );

  const oportunidades = filas.map(filaCotizacion);
  // La línea de cajas/externas tiene tickets mucho menores: va aparte para no
  // desplazar a las importaciones en el ranking.
  const directas = (
    await consultarDirectas({
      idAsesor: alcance.idAsesor,
      estados: ESTADOS_DIRECTAS_ABIERTAS,
      limite: 5,
    })
  ).map(filaDirecta);
  const noEspecificadas = await contarNoEspecificadas(
    filtros.aplicados,
    whereComun,
    repl,
  );
  return {
    alcance: alcance.etiqueta,
    criterio: 'cartera abierta ordenada por monto, de mayor a menor',
    filtros: filtros.aplicados,
    ...(noEspecificadas && { no_especificadas: noEspecificadas }),
    total_mostrado: oportunidades.length,
    monto_sumado: dinero(oportunidades.reduce((s, o) => s + o.monto, 0)),
    oportunidades,
    ...(directas.length && {
      directas_cajas_externas: {
        nota: 'Línea aparte (cajas y externas), de ticket mucho menor. No sumes estos montos con los de arriba.',
        monto_sumado: dinero(directas.reduce((s, d) => s + d.total, 0)),
        items: directas,
      },
    }),
  };
}

/** Cargas en curso: lo que ya está en bodega, tránsito, carga o próximo. */
async function cargasEnCurso(alcance, args) {
  const repl = {};
  const where = [filtroAsesor(alcance.idAsesor, repl)];
  where.push(`c.estado IN (${ESTADOS_EN_CURSO.map((e) => db_2.escape(e)).join(',')})`);

  const filtros = filtrosEnvio(args, repl);
  const whereComun = [...where];
  where.push(...filtros.where);

  const limite = Math.min(Math.max(Number(args?.limite) || LIMITE_FILAS, 1), 25);
  const filas = await db_2.query(
    `SELECT t.*, g.nombre AS carga, g.estado AS estado_carga,
            g.fecha_estimada, g.destino
       FROM (${SELECT_BASE} WHERE ${where.join(' AND ')}) t
       LEFT JOIN cotizacion_carga cc ON cc.id_cotizacion = t.id_cotizacion
       LEFT JOIN cotizadorpro_cargas g ON g.id_carga = cc.id_carga
      ORDER BY t.monto DESC
      LIMIT ${limite}`,
    { replacements: repl, type: db_2.QueryTypes.SELECT },
  );

  const noEspecificadas = await contarNoEspecificadas(
    filtros.aplicados,
    whereComun,
    repl,
  );
  return {
    alcance: alcance.etiqueta,
    filtros: filtros.aplicados,
    ...(noEspecificadas && { no_especificadas: noEspecificadas }),
    nota: 'Casi todo es marítimo grupal (consolidado) con destino Ecuador; aéreo, individual (contenedor propio) y México son minoría.',
    cargas: filas.map((r) => ({
      ...filaCotizacion(r),
      carga_consolidada: r.carga || null,
      estado_carga: r.estado_carga || null,
      fecha_estimada: r.fecha_estimada || null,
      destino: r.destino || null,
    })),
  };
}

/**
 * Clientes en riesgo: primero el dato duro (cotización trabada, rechazada o
 * anulada) y, sobre esos pocos, los últimos mensajes de su chat para que el
 * modelo juzgue el tono. El chat se busca por los últimos 9 dígitos del
 * teléfono (celular_last9 está indexado).
 */
async function clientesEnRiesgo(alcance, args) {
  const repl = {};
  const where = [filtroAsesor(alcance.idAsesor, repl)];
  where.push(`(
      c.estado IN (${ESTADOS_PERDIDOS.map((e) => db_2.escape(e)).join(',')})
      OR (c.estado IN ('borrador','generado')
          AND c.fecha_creacion < (NOW() - INTERVAL ${DIAS_ESTANCADA * 2} DAY))
      OR (c.estado IN ('bodega','transito')
          AND c.fecha_creacion < (NOW() - INTERVAL 45 DAY))
    )`);

  const limite = Math.min(Math.max(Number(args?.limite) || 6, 1), 10);
  const filas = await db_2.query(
    `${SELECT_BASE}
      WHERE ${where.join(' AND ')}
      ORDER BY monto DESC
      LIMIT ${limite}`,
    { replacements: repl, type: db_2.QueryTypes.SELECT },
  );

  const casos = [];
  for (const r of filas) {
    const base = filaCotizacion(r);
    const motivo = ESTADOS_PERDIDOS.includes(r.estado)
      ? `cotización ${r.estado}`
      : ESTADOS_EN_CURSO.includes(r.estado)
        ? `lleva ${base.dias_desde_creacion} días en ${r.estado}`
        : `sin avanzar hace ${base.dias_desde_creacion} días`;

    let mensajes = [];
    const last9 = String(r.telefono || '').replace(/\D/g, '').slice(-9);
    if (last9.length === 9) {
      try {
        // El mensaje apunta al contacto por celular_recibe (id_cliente guarda
        // el contacto del negocio). rol 0 = cliente, 1 = nosotros; el 3 son
        // notas del sistema (chat cerrado, transferencias) y no sirven.
        const chats = await db.query(
          `SELECT m.texto_mensaje, m.rol_mensaje, m.created_at
             FROM clientes_chat_center cl
             JOIN mensajes_clientes m ON m.celular_recibe = cl.id
            WHERE cl.id_configuracion = :cfg
              AND cl.celular_last9 = :last9
              AND m.rol_mensaje IN (0, 1)
              AND m.texto_mensaje IS NOT NULL AND m.texto_mensaje <> ''
            ORDER BY m.created_at DESC
            LIMIT :limite`,
          {
            replacements: {
              cfg: ID_CONFIG_SOPORTE,
              last9,
              limite: MAX_MENSAJES_CHAT * 4,
            },
            type: db.QueryTypes.SELECT,
          },
        );
        // El tono lo marca lo que escribió el cliente; las últimas líneas del
        // chat suelen ser mensajes automáticos nuestros, así que se priorizan
        // los del cliente y se deja un par de los nuestros como contexto.
        const delCliente = chats.filter((m) => num(m.rol_mensaje) === 0);
        const nuestros = chats.filter((m) => num(m.rol_mensaje) === 1);
        mensajes = [
          ...delCliente.slice(0, MAX_MENSAJES_CHAT - 2),
          ...nuestros.slice(0, 2),
        ]
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
          .map((m) => ({
            de: num(m.rol_mensaje) === 1 ? 'nosotros' : 'cliente',
            texto: String(m.texto_mensaje).slice(0, 300),
            fecha: m.created_at,
          }));
      } catch (err) {
        console.error('[AsistenteSoporte] chat del cliente:', err.message);
      }
    }

    casos.push({ ...base, motivo_riesgo: motivo, ultimos_mensajes: mensajes });
  }

  return {
    alcance: alcance.etiqueta,
    criterio:
      'cotizaciones trabadas, rechazadas o anuladas; los mensajes son del chat de la cuenta',
    // El modelo tiende a listar los casos sin leer el chat: se le pide aquí.
    instruccion:
      'Para CADA caso, lee ultimos_mensajes y di en pocas palabras cómo suena el cliente (molesto, impaciente, dudando, tranquilo o sin señales) citando algo de lo que escribió. Ordénalos poniendo primero a los que se ven molestos. Si un caso no tiene mensajes, dilo.',
    casos,
  };
}

/* ─── Cotizaciones directas: la línea de cajas y externas ─────────────────
   Flujo aparte del contenedor: ticket más chico, anticipo del 50 %, vigencia
   corta y guía propia. Se informa separada para no mezclar los montos. */

const ESTADOS_DIRECTAS_ABIERTAS = ['pendiente', 'aprobado', 'liquidado'];

function filaDirecta(r) {
  const senales = [];
  if (r.estado === 'pendiente' && r.vencida) senales.push('vigencia vencida');
  if (r.estado === 'aprobado' && !r.guia_numero) senales.push('aprobada sin guía');
  if (r.estado === 'anulado') {
    senales.push(r.motivo_anulacion ? `anulada: ${r.motivo_anulacion}` : 'anulada');
  }
  return {
    codigo: r.codigo,
    modo: r.modo, // cajas | externa
    cliente: r.cliente_nombre || 'Sin nombre',
    asesor: r.asesor || null,
    destino: r.pais ? String(r.pais).toUpperCase() : null,
    total: dinero(r.total),
    abono: dinero(r.abono_monto),
    estado: r.estado,
    guia: r.guia_numero || null,
    valida_hasta: r.valida_hasta || null,
    dias_desde_creacion: num(r.dias),
    telefono: r.cliente_telefono || null,
    senales,
  };
}

async function consultarDirectas({ idAsesor, estados, modo, pais, limite = LIMITE_FILAS }) {
  const repl = {};
  const where = [];
  if (idAsesor) {
    repl.asesor = idAsesor;
    where.push('d.id_asesor = :asesor');
  }
  if (estados?.length) {
    where.push(`d.estado IN (${estados.map((e) => db_2.escape(e)).join(',')})`);
  }
  if (['cajas', 'externa'].includes(modo)) {
    repl.modo = modo;
    where.push('d.modo = :modo');
  }
  if (DESTINOS[String(pais || '').toLowerCase()]) {
    repl.pais = DESTINOS[String(pais).toLowerCase()];
    where.push('d.pais = :pais');
  }

  return db_2.query(
    `SELECT d.codigo, d.modo, d.pais, d.estado, d.cliente_nombre, d.cliente_telefono,
            d.total, d.abono_monto, d.guia_numero, d.valida_hasta, d.motivo_anulacion,
            DATEDIFF(NOW(), d.fecha_creacion) AS dias,
            (d.valida_hasta IS NOT NULL AND d.valida_hasta < CURDATE()) AS vencida,
            u.nombre_users AS asesor
       FROM cotizaciones_directas d
       LEFT JOIN users u ON u.id_users = d.id_asesor
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.total DESC
      LIMIT ${Math.min(Math.max(Number(limite) || LIMITE_FILAS, 1), 25)}`,
    { replacements: repl, type: db_2.QueryTypes.SELECT },
  );
}

async function cotizacionesDirectas(alcance, args) {
  const estados = ['pendiente', 'aprobado', 'liquidado', 'enviado', 'anulado'].includes(
    args?.estado,
  )
    ? [args.estado]
    : ESTADOS_DIRECTAS_ABIERTAS;

  const filas = await consultarDirectas({
    idAsesor: alcance.idAsesor,
    estados,
    modo: args?.modo,
    pais: args?.destino,
    limite: args?.limite,
  });
  const directas = filas.map(filaDirecta);

  return {
    alcance: alcance.etiqueta,
    linea: 'cotizaciones directas (cajas y externas)',
    estados_consultados: estados,
    total_mostrado: directas.length,
    monto_sumado: dinero(directas.reduce((s, d) => s + d.total, 0)),
    directas,
  };
}

/** Resumen de cartera: cuántas cotizaciones y cuánto suman, por estado. */
async function resumenCartera(alcance) {
  const repl = {};
  const filas = await db_2.query(
    `SELECT c.estado,
            COUNT(*) AS cotizaciones,
            SUM((SELECT SUM(p.precio * p.cant) FROM cotizadorpro_productos_cot p
                  WHERE p.id_cotizacion = c.id_cotizacion)) AS monto
       FROM cotizadorpro_cotizaciones c
      WHERE ${filtroAsesor(alcance.idAsesor, repl)}
      GROUP BY c.estado
      ORDER BY monto DESC`,
    { replacements: repl, type: db_2.QueryTypes.SELECT },
  );

  const porEstado = filas.map((r) => ({
    estado: r.estado,
    cotizaciones: num(r.cotizaciones),
    monto: dinero(r.monto),
  }));
  const abierto = porEstado.filter((e) => ESTADOS_ABIERTOS.includes(e.estado));
  const enCurso = porEstado.filter((e) => ESTADOS_EN_CURSO.includes(e.estado));

  const directas = await db_2.query(
    `SELECT d.estado, COUNT(*) AS n, SUM(d.total) AS monto
       FROM cotizaciones_directas d
      WHERE ${alcance.idAsesor ? 'd.id_asesor = :asesor' : '1=1'}
      GROUP BY d.estado
      ORDER BY monto DESC`,
    {
      replacements: alcance.idAsesor ? { asesor: alcance.idAsesor } : {},
      type: db_2.QueryTypes.SELECT,
    },
  );

  return {
    alcance: alcance.etiqueta,
    por_estado: porEstado,
    directas_cajas_externas: {
      nota: 'Línea aparte: cotizaciones directas (cajas y externas).',
      por_estado: directas.map((d) => ({
        estado: d.estado,
        cotizaciones: num(d.n),
        monto: dinero(d.monto),
      })),
    },
    cartera_abierta: {
      cotizaciones: abierto.reduce((s, e) => s + e.cotizaciones, 0),
      monto: dinero(abierto.reduce((s, e) => s + e.monto, 0)),
    },
    en_curso: {
      cotizaciones: enCurso.reduce((s, e) => s + e.cotizaciones, 0),
      monto: dinero(enCurso.reduce((s, e) => s + e.monto, 0)),
    },
  };
}

/* ─── Tools para OpenAI ─── */

const PARAM_ENVIO = {
  transporte: {
    type: 'string',
    enum: ['aereo', 'maritimo', 'terrestre', 'sin_especificar'],
    description:
      'Medio de transporte. sin_especificar = las que en el ERP no tienen transporte cargado.',
  },
  modalidad: {
    type: 'string',
    enum: ['grupal', 'individual', 'sin_especificar'],
    description:
      'grupal = carga consolidada con otros clientes; individual = contenedor propio del cliente; sin_especificar = sin modalidad cargada en el ERP.',
  },
  destino: {
    type: 'string',
    enum: ['ec', 'mx', 'sin_especificar'],
    description:
      'País de destino: ec (Ecuador), mx (México) o sin_especificar = sin destino cargado en el ERP.',
  },
};

const PARAM_ASESOR = {
  asesor: {
    type: 'string',
    description:
      'Solo para administradores: nombre del asesor a consultar, o "todos" para el equipo completo. Un asesor normal no puede usarlo: siempre ve su propia cartera.',
  },
};

function construirToolsSoporte(perfil) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'oportunidades_comerciales',
        description:
          'Cartera abierta ordenada por monto (mayor primero): quién tiene cotizaciones grandes y qué les falta. Se puede filtrar por transporte (aéreo, marítimo, terrestre), modalidad (grupal = consolidado, individual = contenedor propio) y destino (Ecuador o México). Marca las señales "sin proveedor" (solicitud al proveedor pendiente), "sin avanzar" (lleva días en borrador o generado) y "no aceptada" (generada sin aprobación).',
        parameters: {
          type: 'object',
          properties: {
            ...PARAM_ASESOR,
            ...PARAM_ENVIO,
            senal: {
              type: 'string',
              enum: ['todas', 'sin_proveedor', 'sin_avanzar', 'no_aceptada'],
            },
            min_monto: {
              type: 'number',
              description: 'Monto mínimo en dólares, si piden "más de X".',
            },
            limite: { type: 'integer', minimum: 1, maximum: 25 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cargas_en_curso',
        description:
          'Importaciones en movimiento (bodega, tránsito, carga o próximo) con su carga consolidada, estado y fecha estimada. Permite filtrar por transporte (aéreo, marítimo, terrestre), modalidad (grupal = consolidado, individual = contenedor propio) y destino (Ecuador o México).',
        parameters: {
          type: 'object',
          properties: {
            ...PARAM_ASESOR,
            ...PARAM_ENVIO,
            limite: { type: 'integer', minimum: 1, maximum: 25 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'clientes_en_riesgo',
        description:
          'Clientes que probablemente estén molestos: cotizaciones rechazadas, anuladas o muy trabadas, con los últimos mensajes de su chat para evaluar el tono.',
        parameters: {
          type: 'object',
          properties: {
            ...PARAM_ASESOR,
            limite: { type: 'integer', minimum: 1, maximum: 10 },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'resumen_cartera',
        description:
          'Resumen de la cartera: cuántas cotizaciones hay en cada estado y cuánto suman en dólares.',
        parameters: {
          type: 'object',
          properties: { ...PARAM_ASESOR },
          additionalProperties: false,
        },
      },
    },
  ];

  tools.push({
    type: 'function',
    function: {
      name: 'cotizaciones_directas',
      description:
        'Línea de cotizaciones directas: compras por cajas y externas, con anticipo del 50 %, vigencia corta y guía propia. Estados: pendiente, aprobado, liquidado, enviado, anulado. Es un flujo distinto al de contenedor, con tickets mucho menores.',
      parameters: {
        type: 'object',
        properties: {
          ...PARAM_ASESOR,
          estado: {
            type: 'string',
            enum: ['pendiente', 'aprobado', 'liquidado', 'enviado', 'anulado'],
          },
          modo: { type: 'string', enum: ['cajas', 'externa'] },
          destino: { type: 'string', enum: ['ec', 'mx'] },
          limite: { type: 'integer', minimum: 1, maximum: 25 },
        },
        additionalProperties: false,
      },
    },
  });

  if (perfil.esAdmin) {
    tools.push({
      type: 'function',
      function: {
        name: 'asesores_del_equipo',
        description:
          'Lista de asesores con cartera y cuántas cotizaciones tiene cada uno. Solo para administradores.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    });
  }

  return tools;
}

async function ejecutarToolSoporte(nombre, args, { perfil }) {
  if (nombre === 'asesores_del_equipo') {
    if (!perfil.esAdmin) return { error: 'Solo los administradores ven el equipo.' };
    const asesores = await asesoresConCartera();
    return {
      asesores: asesores.map((a) => ({
        nombre: a.alias || a.nombre,
        nombre_erp: a.nombre,
        cotizaciones: a.cotizaciones,
      })),
    };
  }

  // El alcance lo fija el backend: un asesor no puede consultar otra cartera.
  const alcance = await resolverAlcance(perfil, args?.asesor);
  if (alcance.sinAcceso) {
    return {
      error:
        'Tu usuario no está registrado como asesor en el ERP, así que no tienes cartera asignada. Si debería tenerla, pide que revisen tu correo en el ERP.',
    };
  }
  if (alcance.error) return alcance;

  switch (nombre) {
    case 'oportunidades_comerciales':
      return oportunidadesComerciales(alcance, args);
    case 'cargas_en_curso':
      return cargasEnCurso(alcance, args);
    case 'clientes_en_riesgo':
      return clientesEnRiesgo(alcance, args);
    case 'cotizaciones_directas':
      return cotizacionesDirectas(alcance, args);
    case 'resumen_cartera':
      return resumenCartera(alcance);
    default:
      return { error: `Herramienta no disponible: ${nombre}` };
  }
}

module.exports = {
  ID_CONFIG_SOPORTE,
  DIAS_ESTANCADA,
  perfilSoporte,
  construirToolsSoporte,
  ejecutarToolSoporte,
};
