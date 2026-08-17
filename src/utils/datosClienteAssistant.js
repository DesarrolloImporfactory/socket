// utils/datosClienteAssistant.js
const { db, db_2 } = require('../database/config');
const moment = require('moment-timezone');
const {
  obtenerTrackingGuia,
  obtenerUrlDescargaGuia,
  obtenerEstadoGuia,
} = require('./openai_helpers');

const obtenerDatosClienteParaAssistant = async (
  id_plataforma,
  telefono,
  id_thread
) => {
  // Consulta combinada para obtener datos con guía o pedido
  const sql = `
    SELECT 
      fc.numero_factura AS numero_factura,
      fc.monto_factura AS monto_factura,
      fc.nombre AS nombre_cliente,
      fc.telefono,
      fc.c_principal AS calle_principal,
      fc.c_secundaria AS calle_secundaria,
      fc.referencia,
      fc.numero_guia,
      fc.transporte AS transportadora,
      fc.costo_flete,
      fc.estado_guia_sistema,
      cc.ciudad, 
      cc.provincia, 
      b.nombre AS nombre_bodega, 
      b.direccion AS direccion_bodega,
      (
        SELECT GROUP_CONCAT(CONCAT(p.nombre_producto, ' x', dfc.cantidad, ' - $', dfc.precio_venta) SEPARATOR ', ')
        FROM detalle_fact_cot dfc
        INNER JOIN productos p ON p.id_producto = dfc.id_producto
        WHERE dfc.numero_factura = fc.numero_factura
      ) AS detalle_productos
    FROM facturas_cot fc
    LEFT JOIN ciudad_cotizacion cc ON cc.id_cotizacion = fc.ciudad_cot
    LEFT JOIN bodega b ON b.id = fc.id_bodega
    WHERE 
      fc.anulada = 0  
      AND (fc.id_plataforma = ? OR fc.id_propietario = ? OR b.id_plataforma = ?)
      AND (fc.telefono = ? OR fc.celular_cliente = ?)
      AND (TRIM(fc.numero_guia) <> '' AND fc.numero_guia IS NOT NULL AND fc.numero_guia <> '0'
           OR (TRIM(fc.numero_guia) = '' OR fc.numero_guia IS NULL OR fc.numero_guia = '0'))
    ORDER BY fc.fecha_guia DESC, fc.fecha_factura DESC
    LIMIT 1
  `;

  const [factura] = await db_2.query(sql, {
    replacements: [
      id_plataforma,
      id_plataforma,
      id_plataforma,
      telefono,
      telefono,
    ],
    type: db_2.QueryTypes.SELECT,
  });

  if (!factura) {
    return {
      bloque: null,
    };
  }

  let tipoDato = factura.numero_guia ? 'datos_guia' : 'datos_pedido';
  let datos = factura;

  let bloque = `🧾 ${tipoDato.toUpperCase()} DETECTADO:\n\n`;
  bloque += `Número factura: ${datos.numero_factura}\n`;
  bloque += `Monto factura: $${datos.monto_factura}\n`;
  bloque += `Nombre cliente: ${datos.nombre_cliente}\n`;
  bloque += `Teléfono: ${datos.telefono}\n`;
  bloque += `Dirección de entrega: ${datos.calle_principal} y ${datos.calle_secundaria}\n`;
  bloque += `Referencia: ${datos.referencia}\n`;

  if (datos.numero_guia) {
    bloque += `Número guía: ${datos.numero_guia || 'Sin asignar'}\n`;
    bloque += `Transporte: ${datos.transportadora || 'Sin asignar'}\n`;

    const estadoGuia = obtenerEstadoGuia(
      datos.transportadora,
      datos.estado_guia_sistema
    );
    const urlTracking = obtenerTrackingGuia(
      datos.transportadora,
      datos.numero_guia
    );
    const urlDescargaGuia = obtenerUrlDescargaGuia(
      datos.transportadora,
      datos.numero_guia
    );

    bloque += `Estado de la guía: ${estadoGuia}\n`;
    bloque += `Link de tracking guía: ${urlTracking}\n`;
    bloque += `Link de descarga guía: ${urlDescargaGuia}\n`;
  }

  bloque += `Costo flete: $${datos.costo_flete}\n`;
  bloque += `Ciudad: ${datos.ciudad}\n`;
  bloque += `Provincia: ${datos.provincia}\n`;
  bloque += `Bodega: ${datos.nombre_bodega}\n`;
  bloque += `Dirección bodega: ${datos.direccion_bodega}\n`;
  bloque += `Detalle productos: ${datos.detalle_productos}\n`;

  // Actualizar tabla openai_threads con numero_factura y numero_guia
  const updateSql = `
    UPDATE openai_threads
    SET numero_factura = ?, numero_guia = ?
    WHERE thread_id = ?
  `;
  await db.query(updateSql, {
    replacements: [datos.numero_factura, datos.numero_guia, id_thread],
    type: db.QueryTypes.UPDATE,
  });

  return {
    bloque,
    tipo: tipoDato,
  };
};

const obtenerDatosCalendarioParaAssistant = async (id_configuracion) => {
  /* La zona del calendario, no una fija: el bloque se lee en hora local del
     negocio y hay cuentas fuera de Ecuador. */
  const [cal] = await db.query(
    `SELECT time_zone FROM calendars
      WHERE account_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const tz = cal?.time_zone || 'America/Guayaquil';

  const sql = `
  SELECT
    ap.start_utc AS inicio_cita,
    ap.end_utc AS fin_cita,
    ap.id_establecimiento,
    est.nombre AS sede
  FROM calendars ca
  LEFT JOIN appointments ap ON ap.calendar_id = ca.id
  LEFT JOIN establecimientos_chat_center est ON est.id = ap.id_establecimiento
  WHERE
    ca.account_id = ?
    AND ap.start_utc > UTC_TIMESTAMP()
    AND ap.status NOT IN ('Completado', 'Cancelado', 'Bloqueado')
  ORDER BY ap.start_utc ASC
`;

  // Ejecutar la consulta SQL
  const calendario = await db.query(sql, {
    replacements: [id_configuracion],
    type: db.QueryTypes.SELECT,
  });

  /* Cuánta gente atiende en cada sede. Es lo que convierte "ese horario está
     ocupado" en "de tres esteticistas, dos están ocupadas": sin esto el bot
     descartaba una hora en la que todavía quedaban cupos. */
  const capacidad = new Map();
  const profs = await db.query(
    `SELECT id_establecimiento, COUNT(*) AS n
       FROM profesionales_chat_center
      WHERE id_configuracion = ? AND activo = 1 AND eliminado = 0
      GROUP BY id_establecimiento`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  profs.forEach((p) => capacidad.set(Number(p.id_establecimiento), Number(p.n)));

  /* Qué día es hoy. Va SIEMPRE, con citas o sin ellas.
     Antes solo se incluía cuando había citas agendadas, así que una agenda
     recién creada dejaba al asistente sin ninguna referencia temporal: al
     pedirle "el martes" resolvía con la fecha que le quedara del entrenamiento
     y agendaba en un año pasado, sin que nada fallara al crearse. */
  const ahora = moment().tz(tz);
  const DIAS = [
    'domingo',
    'lunes',
    'martes',
    'miércoles',
    'jueves',
    'viernes',
    'sábado',
  ];

  /* ── Días que el local NO abre ───────────────────────────────────
     El horario de la sede se guarda como texto libre ("Lunes a viernes
     09:00-19:00 · Sábados 09:00-14:00") y solo llegaba dentro de la ficha de la
     sede, como un dato más entre la dirección y el teléfono. El modelo lo leía
     y agendaba domingo igual. Acá se traduce a días concretos y se marca CERRADO
     en la misma lista de fechas que el bot usa para proponer, que es donde
     mira.

     La lectura es conservadora: si el texto no se entiende, no se marca nada.
     Cerrar un día por una mala interpretación es peor que no marcarlo. */
  const sedes = await db.query(
    `SELECT nombre, horario, horario_json,
            buffer_minutos, anticipacion_minima_horas, max_citas_dia
       FROM establecimientos_chat_center
      WHERE id_configuracion = ? AND activo = 1 AND eliminado = 0
      ORDER BY orden ASC, id ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const {
    diasAbiertos,
    diasAbiertosDesdeTexto,
    franjasDelDia,
  } = require('./horarioSede');

  /* Un día está cerrado solo si NINGUNA sede abre: con dos sucursales, que una
     descanse el lunes no puede bloquear a la otra.
     Se prefiere el horario estructurado; el texto libre es el respaldo de las
     sedes que todavía no se editaron desde el panel nuevo. */
  const horariosLeidos = sedes.map(
    (s) => diasAbiertos(s.horario_json) || diasAbiertosDesdeTexto(s.horario),
  );
  const algunoLegible = horariosLeidos.some(Boolean);
  const cerrado = (dia) =>
    algunoLegible &&
    horariosLeidos.every((set) => (set ? !set.has(dia) : false));

  /* Los próximos días, ya resueltos. El modelo calcula fechas fatal: con solo
     "hoy es jueves 30" ofrecía "lunes 2026-08-01" (que es sábado) y armaba
     citas en días que no existen. Dándole la tabla hecha no tiene que sumar. */
  const proximos = [];
  for (let i = 0; i <= 13; i += 1) {
    const d = ahora.clone().add(i, 'day');
    const etiqueta = i === 0 ? ' (hoy)' : i === 1 ? ' (mañana)' : '';
    /* Hasta qué hora atienden ESE día, al lado de la fecha. Con solo el rango
       general el bot ofrecía las 18:00 de un sábado que cierra a las 14:00: el
       horario estaba escrito, pero en otra parte del mensaje. */
    const franjas = sedes
      .map((s) => franjasDelDia(s.horario_json, d.day()))
      .filter((f) => f && f.length);
    const horas = franjas.length
      ? `  (${franjas[0].map((f) => `${f.desde}-${f.hasta}`).join(' y ')})`
      : '';

    const marca = cerrado(d.day()) ? '  ← CERRADO, no lo ofrezcas' : horas;
    proximos.push(
      `${DIAS[d.day()]} ${d.format('YYYY-MM-DD')}${etiqueta}${marca}`,
    );
  }

  let bloque =
    `🗓️ HOY es ${DIAS[ahora.day()]} ${ahora.format('YYYY-MM-DD')} y son las ` +
    `${ahora.format('HH:mm')} (hora de ${tz}).\n` +
    `Los próximos días son exactamente estos — úsalos tal cual, no calcules ` +
    `fechas por tu cuenta ni inventes el día de la semana:\n` +
    proximos.map((d) => `  ${d}`).join('\n') +
    `\n\nCualquier fecha relativa que diga el cliente ("mañana", "el martes", ` +
    `"la próxima semana") la resuelves con esa lista, y siempre hacia ` +
    `adelante. Nunca propongas ni agendes una fecha que no esté ahí.\n\n`;

  /* El horario, otra vez y en el sitio donde se decide. Ya viaja en la ficha de
     la sede, pero ahí queda entre la dirección y el teléfono; acá está pegado a
     las fechas que el bot va a proponer. */
  const conHorario = sedes.filter((s) => String(s.horario || '').trim());
  if (conHorario.length) {
    bloque +=
      `⏰ Horario de atención (fuera de esto el local está cerrado):\n` +
      conHorario.map((s) => `  - ${s.nombre}: ${s.horario}`).join('\n') +
      `\n\nNunca ofrezcas ni aceptes una hora fuera de ese horario, aunque la ` +
      `agenda se vea libre: la agenda solo sabe qué citas hay, no cuándo abre el ` +
      `local. Si la persona pide un día u hora en que está cerrado, dile hasta ` +
      `qué hora atienden ese día y ofrécele la opción más cercana que sí exista.` +
      `\n\n`;
  }

  if (!calendario || calendario.length === 0) {
    return {
      bloque:
        `${bloque}La agenda está COMPLETAMENTE LIBRE: no hay ninguna cita ` +
        `todavía. Cualquier hora dentro del horario de la sede está disponible, ` +
        `así que nunca digas que no tienes cupo.`,
      tipo: 'datos_servicio',
    };
  }

  /* Se agrupan las citas que caen en el mismo horario y la misma sede: lo que
     el bot necesita saber no es cuántas citas hay, sino si queda alguien libre. */
  const franjas = new Map();
  calendario.forEach((cita) => {
    // start_utc llega como texto UTC: hay que convertirlo, no leerlo como local.
    const ini = moment.utc(cita.inicio_cita).tz(tz);
    const fin = moment.utc(cita.fin_cita).tz(tz);
    const sedeId = Number(cita.id_establecimiento) || 0;
    const clave = `${ini.format('YYYY-MM-DD HH:mm')}|${fin.format('HH:mm')}|${sedeId}`;

    if (!franjas.has(clave)) {
      franjas.set(clave, {
        ini,
        fin,
        sedeId,
        sede: cita.sede || null,
        ocupadas: 0,
      });
    }
    franjas.get(clave).ocupadas += 1;
  });

  /* El encabezado importa tanto como la lista: cuando decía "Ocupación de la
     agenda", el modelo leía las dos filas como "estos son los horarios que
     tengo" y daba por lleno todo lo demás. Le pedían las 11:00 —libre— y
     contestaba que no había cupo. Ahora la regla va ANTES de la lista. */
  bloque +=
    `🚫 CITAS YA TOMADAS. Esto es lo ÚNICO ocupado: cualquier otra hora dentro ` +
    `del horario de atención está LIBRE y la puedes agendar. Si te piden una ` +
    `hora que no aparece en esta lista, está disponible — nunca digas que está ` +
    `llena.\n`;

  for (const f of franjas.values()) {
    const total = capacidad.get(f.sedeId) || 1;
    const libres = Math.max(0, total - f.ocupadas);
    const cuando = `${DIAS[f.ini.day()]} ${f.ini.format('YYYY-MM-DD')} de ${f.ini.format('HH:mm')} a ${f.fin.format('HH:mm')}`;
    const donde = f.sede ? ` · ${f.sede}` : '';

    bloque +=
      libres > 0
        ? `- ${cuando}${donde}: ${f.ocupadas} de ${total} ocupadas, quedan ${libres} — SÍ puedes agendar\n`
        : `- ${cuando}${donde}: LLENO (${total} de ${total}) — no lo ofrezcas\n`;
  }

  if (capacidad.size) {
    bloque +=
      `\nVarias personas atienden a la vez, así que un horario con citas NO ` +
      `está necesariamente lleno: fíjate en cuántos cupos quedan.\n`;
  }

  /* Los huecos LIBRES, ya calculados.
     Decirle "todo lo que no está en la lista de ocupados está libre" no alcanza:
     el modelo prefiere no arriesgarse y contesta "esa hora ya está llena" para
     una hora que nadie tomó. Razonar por ausencia no es lo suyo. Acá se le
     entrega el horario del local menos lo ocupado, resuelto: elige de una lista
     en vez de deducir. */
  const aMin = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  };
  const aHHMM = (min) =>
    `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  const ocupadasPorFecha = new Map();
  const citasPorFecha = new Map();
  for (const f of franjas.values()) {
    const fecha = f.ini.format('YYYY-MM-DD');
    // Para el tope diario cuentan TODAS las citas, llenen o no la franja.
    citasPorFecha.set(fecha, (citasPorFecha.get(fecha) || 0) + f.ocupadas);

    const total = capacidad.get(f.sedeId) || 1;
    if (total - f.ocupadas > 0) continue; // todavía queda cupo: no bloquea
    if (!ocupadasPorFecha.has(fecha)) ocupadasPorFecha.set(fecha, []);
    ocupadasPorFecha
      .get(fecha)
      .push({ desde: aMin(f.ini.format('HH:mm')), hasta: aMin(f.fin.format('HH:mm')) });
  }

  /* Las citas de hoy que ya pasaron. La consulta de arriba solo trae las
     futuras —para saber qué está ocupado, mirar hacia atrás no sirve—, pero
     para el tope del día sí cuentan: si el tope son 4 y ya atendió 3 esta
     mañana, queda 1, no 4. Solo se pregunta si alguna sede tiene tope puesto. */
  if (sedes.some((s) => Number(s.max_citas_dia) > 0)) {
    try {
      const [hoy] = await db.query(
        `SELECT COUNT(*) AS n
           FROM appointments ap
           JOIN calendars ca ON ca.id = ap.calendar_id
          WHERE ca.account_id = ?
            AND ap.start_utc <= UTC_TIMESTAMP()
            AND DATE(CONVERT_TZ(ap.start_utc, '+00:00', ?)) = ?
            AND ap.status NOT IN ('Cancelado', 'Bloqueado')`,
        {
          replacements: [
            id_configuracion,
            ahora.format('Z'),
            ahora.format('YYYY-MM-DD'),
          ],
          type: db.QueryTypes.SELECT,
        },
      );
      const fechaHoy = ahora.format('YYYY-MM-DD');
      citasPorFecha.set(
        fechaHoy,
        (citasPorFecha.get(fechaHoy) || 0) + Number(hoy?.n || 0),
      );
    } catch (_) {
      /* Sin este conteo el tope del día es optimista, no roto: se sigue. */
    }
  }

  const lineasLibres = [];
  for (let i = 0; i <= 6; i += 1) {
    const d = ahora.clone().add(i, 'day');
    const fecha = d.format('YYYY-MM-DD');

    for (const s of sedes) {
      const franjasDia = franjasDelDia(s.horario_json, d.day());
      if (!franjasDia || !franjasDia.length) continue;

      const colchon = Math.max(0, Number(s.buffer_minutos) || 0);
      const donde = sedes.length > 1 ? ` · ${s.nombre}` : '';

      /* Tope de citas del día. Sirve para el que no quiere una agenda llena de
         punta a punta aunque técnicamente le quepan: con visitas a domicilio,
         seis en un día es un día imposible por más que los huecos existan. */
      const tope = Number(s.max_citas_dia) || 0;
      if (tope && (citasPorFecha.get(fecha) || 0) >= tope) {
        lineasLibres.push(
          `- ${DIAS[d.day()]} ${fecha}${donde}: sin cupo (ya tiene ${tope} citas, que es el tope del día)`,
        );
        continue;
      }

      /* Desde cuándo se puede ofrecer. Antes solo se cuidaba el día de hoy y
         por media hora: bastaba con que la persona pidiera "mañana a las 8" para
         que el bot lo aceptara a las 11 de la noche. Con anticipación mínima
         configurada, el corte se arrastra a los días siguientes — que es de lo
         que se trata: quien se mueve por la ciudad necesita saberlo con horas de
         anticipación, no con minutos. */
      const minAviso = Math.max(
        30,
        Math.max(0, Number(s.anticipacion_minima_horas) || 0) * 60,
      );
      const desdeCuando = ahora.clone().add(minAviso, 'minutes');

      if (d.isBefore(desdeCuando, 'day')) continue;

      const piso = d.isSame(desdeCuando, 'day')
        ? Math.ceil(aMin(desdeCuando.format('HH:mm')) / 30) * 30
        : 0;

      let libres = franjasDia
        .map((f) => ({ desde: Math.max(aMin(f.desde), piso), hasta: aMin(f.hasta) }))
        .filter((f) => f.hasta - f.desde >= 30);

      for (const oc of ocupadasPorFecha.get(fecha) || []) {
        /* El traslado se descuenta a los dos lados de cada cita ya tomada: si
           hay una a las 15:00 y hacen falta 45 minutos para cruzar la ciudad,
           las 15:45 no son un hueco aunque la agenda las muestre vacías. */
        const ocDesde = oc.desde - colchon;
        const ocHasta = oc.hasta + colchon;

        const nuevas = [];
        for (const l of libres) {
          if (ocHasta <= l.desde || ocDesde >= l.hasta) {
            nuevas.push(l);
            continue;
          }
          if (ocDesde - l.desde >= 30)
            nuevas.push({ desde: l.desde, hasta: ocDesde });
          if (l.hasta - ocHasta >= 30)
            nuevas.push({ desde: ocHasta, hasta: l.hasta });
        }
        libres = nuevas;
      }

      const texto = libres
        .map((l) => `${aHHMM(l.desde)}-${aHHMM(l.hasta)}`)
        .join(', ');

      lineasLibres.push(
        texto
          ? `- ${DIAS[d.day()]} ${fecha}${donde}: ${texto}`
          : `- ${DIAS[d.day()]} ${fecha}${donde}: sin cupo`,
      );
    }
  }

  if (lineasLibres.length) {
    const conTraslado = sedes.filter((s) => Number(s.buffer_minutos) > 0);
    const conAviso = sedes.filter((s) => Number(s.anticipacion_minima_horas) > 0);

    bloque +=
      `\n✅ HORAS LIBRES (ya descontadas las citas y el horario del local). ` +
      `Ofrece SIEMPRE de acá, y si te piden una hora que cae dentro de estos ` +
      `rangos, acéptala: está disponible.\n` +
      lineasLibres.join('\n') +
      `\n`;

    /* Por qué estos rangos son más chicos de lo que la agenda sugiere. Sin
       explicarlo, el modelo "corrige" el hueco que ve raro y ofrece la hora que
       acabamos de descartar: le parece que hay espacio de sobra. */
    if (conTraslado.length) {
      const min = Math.max(...conTraslado.map((s) => Number(s.buffer_minutos)));
      bloque +=
        `\nEstos rangos YA tienen descontado el tiempo de traslado (${min} min ` +
        `entre una cita y la siguiente): quien atiende se mueve de un lugar a ` +
        `otro y necesita ese margen para llegar. NO ofrezcas una hora pegada a ` +
        `una cita existente aunque te parezca que cabe, y si la persona la pide, ` +
        `explícale que necesitas dejar ese espacio y ofrécele la más cercana de ` +
        `la lista.\n`;
    }

    if (conAviso.length) {
      const horas = Math.max(
        ...conAviso.map((s) => Number(s.anticipacion_minima_horas)),
      );
      bloque +=
        `\nNo se agenda nada dentro de las próximas ${horas} horas: hace falta ` +
        `ese aviso para organizar el día. Si piden algo antes, ofréceles lo ` +
        `primero que sí aparezca en la lista.\n`;
    }
  }

  return {
    bloque,
    tipo: 'datos_servicio',
  };
};

const obtenerCalendarioClasImporfactory = async () => {
  // Consulta combinada para obtener datos con guía o pedido
  const sql = `
    SELECT 
      title, description, event_date, target_url
    FROM banner_calendar_events 
    WHERE
    active = 1 AND
    event_date > NOW()
    ORDER BY event_date DESC 
  `;

  // Ejecutar la consulta SQL
  const calendario = await db_2.query(sql, {
    type: db_2.QueryTypes.SELECT,
  });

  // Verificar si no hay datos
  if (!calendario || calendario.length === 0) {
    return {
      bloque: 'No hay clases programadas.',
      tipo: 'datos_clases',
    };
  }

  // Crear un bloque organizado con las citas
  let tipoDato = 'datos_clases';
  let fechaActual = moment()
    .tz('America/Guayaquil')
    .format('YYYY-MM-DD HH:mm:ss');
  let bloque = `🧾 **Fecha actual es decir la fecha de hoy(${fechaActual}), Clases programadas datos_clases detectadas:**\n\n`;

  // Formatear y agregar cada cita al bloque
  calendario.forEach((cita, index) => {
    // Convertir las fechas a un formato legible
    const inicioCita = new Date(cita.event_date).toLocaleString();

    bloque += `Clase ${cita.title}:\n`;
    bloque += `- **Fecha:** ${inicioCita}\n`;
    bloque += `- **titulo:** ${cita.title}\n`;
    bloque += `- **Descripcion:** ${cita.description}\n`;
    bloque += `- **URL:** ${cita.target_url}\n`;
  });

  return {
    bloque,
    tipo: tipoDato,
  };
};

const informacionProductos = async (productos) => {
  let bloqueProductos =
    '📦 Información de todos los productos que ofrecemos pero que no necesariamente estan en el pedido:\n\n';

  for (const id of productos) {
    console.log('id: ' + id);
    /* const sqlProducto = `
      SELECT 
        p.nombre_producto AS nombre_producto,
        p.descripcion_producto AS descripcion_producto,
        ib.pvp AS precio_producto,
        p.image_path AS image_path
      FROM inventario_bodegas ib
      INNER JOIN productos p ON ib.id_producto = p.id_producto
      WHERE ib.id_inventario = ?
      LIMIT 1
    `; */

    const sqlProducto = `
      SELECT 
        pc.nombre AS nombre_producto,
        pc.descripcion AS descripcion_producto,
        pc.tipo AS tipo,
        pc.precio AS precio_producto,
        pc.imagen_url AS image_path,
        pc.video_url AS video_path,
        cc.nombre AS nombre_categoria
      FROM productos_chat_center pc
      INNER JOIN categorias_chat_center cc ON cc.id = pc.id_categoria
      WHERE pc.id = ?
      LIMIT 1
    `;

    const [infoProducto] = await db.query(sqlProducto, {
      replacements: [id],
      type: db.QueryTypes.SELECT,
    });

    if (infoProducto) {
      bloqueProductos += `🛒 Producto: ${infoProducto.nombre_producto}\n`;
      bloqueProductos += `📃 Descripción: ${infoProducto.descripcion_producto}\n`;
      bloqueProductos += ` Precio: ${infoProducto.precio_producto}\n`;
      /* bloqueProductos += `🖼️ Imagen: ${infoProducto.image_path}\n\n`; */ // esta forma la incluye la url de la imagen como texto solido
      bloqueProductos += `[producto_imagen_url]: ${infoProducto.image_path}\n\n`; //esta forma sirve como recurso para el asistente (no visible para el cliente en el bloque)
      bloqueProductos += `[producto_video_url]: ${infoProducto.video_path}\n\n`; //esta forma sirve como recurso para el asistente (no visible para el cliente en el bloque)
      bloqueProductos += ` tipo: ${infoProducto.tipo}\n`;
      bloqueProductos += ` Categoría: ${infoProducto.nombre_categoria}\n`;
      bloqueProductos += `\n`;
    }
  }

  return bloqueProductos;
};

const informacionProductosVinculado = async (productos) => {
  let bloqueProductos =
    '📦 Información de todos los productos que ofrecemos pero que no necesariamente estan en el pedido:\n\n';

  for (const id of productos) {
    console.log('id: ' + id);
    const sqlProducto = `
      SELECT 
        p.nombre_producto AS nombre_producto,
        p.descripcion_producto AS descripcion_producto,
        ib.pvp AS precio_producto,
        p.image_path AS image_path,
        l.nombre_linea AS nombre_categoria
      FROM inventario_bodegas ib
      INNER JOIN productos p ON ib.id_producto = p.id_producto 
      INNER JOIN lineas l ON l.id_linea = p.id_linea_producto
      WHERE ib.id_inventario = ?
      LIMIT 1
    `;

    const [infoProducto] = await db_2.query(sqlProducto, {
      replacements: [id],
      type: db_2.QueryTypes.SELECT,
    });

    if (infoProducto) {
      bloqueProductos += `🛒 Producto: ${infoProducto.nombre_producto}\n`;
      bloqueProductos += `📃 Descripción: ${infoProducto.descripcion_producto}\n`;
      bloqueProductos += ` Precio: ${infoProducto.precio_producto}\n`;
      /* bloqueProductos += `🖼️ Imagen: ${infoProducto.image_path}\n\n`; */ // esta forma la incluye la url de la imagen como texto solido
      bloqueProductos += `[producto_imagen_url]: ${infoProducto.image_path}\n\n`; //esta forma sirve como recurso para el asistente (no visible para el cliente en el bloque)
      bloqueProductos += ` Categoría: ${infoProducto.nombre_categoria}\n`;
      bloqueProductos += `\n`;
    }
  }

  return bloqueProductos;
};

const obtenerDatosClienteParaAssistant_viejo = async (
  id_plataforma,
  telefono
) => {
  // Consulta para obtener datos con guía
  const sqlGuia = `
    SELECT 
      fc.numero_factura AS numero_factura,
      fc.monto_factura AS monto_factura,
      fc.nombre AS nombre_cliente,
      fc.telefono,
      fc.c_principal AS calle_principal,
      fc.c_secundaria AS calle_secundaria,
      fc.referencia,
      fc.numero_guia,
      fc.transporte AS transportadora,
      fc.costo_flete,
      fc.estado_guia_sistema,
      cc.ciudad, 
      cc.provincia, 
      b.nombre AS nombre_bodega, 
      b.direccion AS direccion_bodega,
      (
        SELECT GROUP_CONCAT(CONCAT(p.nombre_producto, ' x', dfc.cantidad, ' - $', dfc.precio_venta) SEPARATOR ', ')
        FROM detalle_fact_cot dfc
        INNER JOIN productos p ON p.id_producto = dfc.id_producto
        WHERE dfc.numero_factura = fc.numero_factura
      ) AS detalle_productos
    FROM facturas_cot fc
    LEFT JOIN ciudad_cotizacion cc ON cc.id_cotizacion = fc.ciudad_cot
    LEFT JOIN bodega b ON b.id = fc.id_bodega
    WHERE 
      TRIM(fc.numero_guia) <> '' AND fc.numero_guia IS NOT NULL AND fc.numero_guia <> '0'
      AND fc.anulada = 0  
      AND (fc.id_plataforma = ? OR fc.id_propietario = ? OR b.id_plataforma = ?)
      AND fc.telefono = ?
    ORDER BY fc.fecha_guia DESC 
    LIMIT 1
  `;

  const [facturaGuia] = await db_2.query(sqlGuia, {
    replacements: [id_plataforma, id_plataforma, id_plataforma, telefono],
    type: db_2.QueryTypes.SELECT,
  });

  let tipoDato = 'datos_guia';
  let datos = facturaGuia;

  // Si no hay guía, consulta como pedido
  if (!datos) {
    tipoDato = 'datos_pedido';
    const sqlPedido = `
      SELECT 
        fc.numero_factura AS numero_factura,
        fc.monto_factura AS monto_factura,
        fc.nombre AS nombre_cliente,
        fc.telefono,
        fc.c_principal AS calle_principal,
        fc.c_secundaria AS calle_secundaria,
        fc.referencia,
        fc.numero_guia,
        fc.transporte,
        fc.costo_flete,
        cc.ciudad, 
        cc.provincia, 
        b.nombre AS nombre_bodega, 
        b.direccion AS direccion_bodega,
        (
          SELECT GROUP_CONCAT(CONCAT(p.nombre_producto, ' x', dfc.cantidad, ' - $', dfc.precio_venta) SEPARATOR ', ')
          FROM detalle_fact_cot dfc
          INNER JOIN productos p ON p.id_producto = dfc.id_producto
          WHERE dfc.numero_factura = fc.numero_factura
        ) AS detalle_productos
      FROM facturas_cot fc
      LEFT JOIN ciudad_cotizacion cc ON cc.id_cotizacion = fc.ciudad_cot
      LEFT JOIN bodega b ON b.id = fc.id_bodega
      WHERE 
        (TRIM(fc.numero_guia) = '' OR fc.numero_guia IS NULL OR fc.numero_guia = '0')
        AND fc.anulada = 0  
        AND fc.id_plataforma = ?
        AND fc.telefono = ?
      ORDER BY fc.fecha_factura DESC 
      LIMIT 1
    `;

    const [facturaPedido] = await db_2.query(sqlPedido, {
      replacements: [id_plataforma, telefono],
      type: db_2.QueryTypes.SELECT,
    });

    datos = facturaPedido;
  }

  if (datos) {
    let bloque = `🧾 ${tipoDato.toUpperCase()} DETECTADO:\n\n`;
    bloque += `Número factura: ${datos.numero_factura}\n`;
    bloque += `Monto factura: $${datos.monto_factura}\n`;
    bloque += `Nombre cliente: ${datos.nombre_cliente}\n`;
    bloque += `Teléfono: ${datos.telefono}\n`;
    bloque += `Dirección de entrega: ${datos.calle_principal} y ${datos.calle_secundaria}\n`;
    bloque += `Referencia: ${datos.referencia}\n`;

    if (datos.numero_guia) {
      bloque += `Número guía: ${datos.numero_guia || 'Sin asignar'}\n`;
      bloque += `Transporte: ${datos.transportadora || 'Sin asignar'}\n`;

      const estadoGuia = obtenerEstadoGuia(
        datos.transportadora,
        datos.estado_guia_sistema
      );
      const urlTracking = obtenerTrackingGuia(
        datos.transportadora,
        datos.numero_guia
      );
      const urlDescargaGuia = obtenerUrlDescargaGuia(
        datos.transportadora,
        datos.numero_guia
      );

      bloque += `Estado de la guía: ${estadoGuia}\n`;
      bloque += `Link de tracking guía: ${urlTracking}\n`;
      bloque += `Link de descarga guía: ${urlDescargaGuia}\n`;
    }

    bloque += `Costo flete: $${datos.costo_flete}\n`;
    bloque += `Ciudad: ${datos.ciudad}\n`;
    bloque += `Provincia: ${datos.provincia}\n`;
    bloque += `Bodega: ${datos.nombre_bodega}\n`;
    bloque += `Dirección bodega: ${datos.direccion_bodega}\n`;
    bloque += `Detalle productos: ${datos.detalle_productos}\n`;

    return {
      bloque,
      tipo: tipoDato,
    };
  }

  return {
    bloque: null,
  };
};

const procesarCombosParaIA = (combos_producto) => {
  let combos = [];

  // -------- 1. Normalizar el valor que viene desde la BD -------- //
  try {
    if (!combos_producto) {
      combos = [];
    } else if (typeof combos_producto === 'string') {
      combos = JSON.parse(combos_producto);
    } else if (Array.isArray(combos_producto)) {
      combos = combos_producto;
    } else {
      combos = [];
    }
  } catch (error) {
    combos = [];
  }

  // Asegurar que combos sea siempre un array
  if (!Array.isArray(combos)) combos = [];

  // -------- 2. Filtrar combos válidos (no vacíos) -------- //
  const combosValidos = combos.filter((c) => {
    return (
      c &&
      (String(c.cantidad || '').trim() !== '' ||
        String(c.precio || '').trim() !== '')
    );
  });

  // -------- 3. Crear bloque legible para IA -------- //
  let bloqueCombos = '';

  if (combosValidos.length > 0) {

    combosValidos.forEach((c, index) => {
      const cantidad = c.cantidad || '0';
      const precio = c.precio || '0.00';

      bloqueCombos += `   • Combo ${
        index + 1
      }: ${cantidad} unidades por $${precio}\n`;
    });

    bloqueCombos += '\n';
  }

  // -------- 4. Retornar resultado -------- //
  return {
    combosNormalizados: combos, // útil si lo quieres loguear, guardar o reutilizar
    bloqueCombos, // listo para insertar en tu prompt IA
  };
};

module.exports = {
  obtenerDatosClienteParaAssistant,
  obtenerDatosCalendarioParaAssistant,
  informacionProductos,
  informacionProductosVinculado,
  obtenerCalendarioClasImporfactory,
  procesarCombosParaIA,
};
