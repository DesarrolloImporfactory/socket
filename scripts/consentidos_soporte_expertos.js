/* «Consentidos» — ENSAYO (tramo 1). Lee lo que pasó un día en Imporsuit
   (cargas, pagos, clases, reuniones), decide con soporteExpertos/consentidos.js
   a qué alumno de la línea le escribiría y qué, y arma el resumen para Daniel.

   NO LE ESCRIBE A NADIE: este archivo no tiene código de envío ni escribe en la
   base (solo consultas de lectura). Lo único que guarda es `--estado`: claves
   cifradas del chat (sha256 cortado) con el momento y la hora, para simular
   el tope semanal. Ni teléfonos ni nombres.

   Uso (en el servidor; la base sale del .env de /var/www/socket):
     node scripts/consentidos_soporte_expertos.js --config 265
         [--fecha 2026-10-24]      día de referencia (por defecto, ayer en Ecuador)
         [--salida /ruta/msg.txt]  deja ahí el resumen para el WhatsApp de Daniel
         [--estado /ruta/estado.json]
*/

'use strict';

require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { db, db_2 } = require('../src/database/config');
const C = require('../src/utils/soporteExpertos/consentidos');
const { mismoTelefono, soloDigitos } = require('../src/utils/soporteExpertos/telefono');
const { esCorreoDePrueba } = require('../src/utils/soporteExpertos/cargaCliente');

const ROLES_ALUMNO = [3, 4, 14, 16, 18];
const MODULOS_IMPLEMENTACION = [135, 136];
const SIN_CARGA = ['borrador', 'anulado', 'rechazado'];
const VENTANA_CAMINO_DIAS = 150;
const DIA_MS = 24 * 3600 * 1000;

const valor = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const leer = (con, sql, replacements = {}) => con.query(sql, { replacements, type: con.QueryTypes.SELECT });
const cola9 = (v) => soloDigitos(v).slice(-9);
const clave = (id) => crypto.createHash('sha256').update(`consentidos:${id}`).digest('hex').slice(0, 16);
const sumarDias = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * DIA_MS).toISOString().slice(0, 10);
const enLotes = async (ids, tam, fn) => {
  const out = [];
  for (let i = 0; i < ids.length; i += tam) out.push(...(await fn(ids.slice(i, i + tam))));
  return out;
};

/* ── 1. Cargas: cotizaciones con algo nuevo el día `ref` ───────────────── */
async function momentosDeCargas(ref) {
  const r = { ref, desde: sumarDias(ref, -VENTANA_CAMINO_DIAS) };
  const ids = (
    await leer(
      db_2,
      `SELECT id_cotizacion FROM cotizadorpro_codigo_proveedores WHERE DATE(fecha_recibida) = :ref
       UNION SELECT id_cotizacion FROM cotizacion_carga WHERE DATE(created_at) = :ref
       UNION SELECT id_cotizacion FROM cotizacion_entregas WHERE DATE(fecha_entrega) = :ref
       UNION SELECT cc.id_cotizacion FROM cotizacion_carga cc
               INNER JOIN cotizadorpro_cargas g ON g.id_carga = cc.id_carga
              WHERE DATE(g.fecha_cierre) = :ref OR DATE(g.fecha_salida) = :ref OR DATE(g.fecha_puerto) = :ref
                 OR DATE(g.fecha_bodega_destino) = :ref OR DATE(g.nota_cliente_at) = :ref
                 OR (g.fecha_cierre IS NOT NULL AND DATE(g.fecha_cierre) >= :desde
                     AND g.fecha_bodega_destino IS NULL AND g.fecha_puerto IS NULL
                     AND DATEDIFF(:ref, DATE(COALESCE(g.fecha_salida, g.fecha_cierre))) > 0
                     AND MOD(DATEDIFF(:ref, DATE(COALESCE(g.fecha_salida, g.fecha_cierre))), 10) = 0)`,
      r,
    )
  ).map((x) => x.id_cotizacion);
  if (!ids.length) return [];

  const cots = await enLotes(ids, 400, (lote) =>
    leer(
      db_2,
      `SELECT c.id_cotizacion, c.estado, c.fecha_anulacion, d.id_users, d.telefono, d.pais_destino,
              u.nombre_users AS nombre, u.email_users AS email
         FROM cotizadorpro_cotizaciones c
         INNER JOIN cotizadorpro_detalle_cot d ON d.id_cotizacion = c.id_cotizacion
         LEFT JOIN users u ON u.id_users = d.id_users
        WHERE c.id_cotizacion IN (:lote)`,
      { lote },
    ),
  );
  const marcas = await enLotes(ids, 400, (lote) =>
    leer(
      db_2,
      `SELECT id_cotizacion, codigo, numero_cajas AS cajas, DATE_FORMAT(fecha_recibida, '%Y-%m-%d') AS fecha_recibida
         FROM cotizadorpro_codigo_proveedores WHERE id_cotizacion IN (:lote)`,
      { lote },
    ),
  );
  const conts = await enLotes(ids, 400, (lote) =>
    leer(
      db_2,
      `SELECT cc.id_cotizacion, DATE_FORMAT(cc.created_at, '%Y-%m-%d') AS asignada, g.nombre, g.destino, g.estado,
              DATE_FORMAT(g.fecha_cierre, '%Y-%m-%d') AS fecha_cierre, DATE_FORMAT(g.fecha_salida, '%Y-%m-%d') AS fecha_salida,
              DATE_FORMAT(g.fecha_puerto, '%Y-%m-%d') AS fecha_puerto, DATE_FORMAT(g.fecha_bodega_destino, '%Y-%m-%d') AS fecha_bodega_destino,
              DATE_FORMAT(g.fecha_estimada, '%Y-%m-%d') AS fecha_estimada, g.nota_cliente,
              DATE_FORMAT(g.nota_cliente_at, '%Y-%m-%d') AS nota_cliente_at
         FROM cotizacion_carga cc INNER JOIN cotizadorpro_cargas g ON g.id_carga = cc.id_carga
        WHERE cc.id_cotizacion IN (:lote)`,
      { lote },
    ),
  );
  const entregas = await enLotes(ids, 400, (lote) =>
    leer(
      db_2,
      `SELECT id_cotizacion, estado, DATE_FORMAT(fecha_entrega, '%Y-%m-%d') AS fecha_entrega
         FROM cotizacion_entregas WHERE id_cotizacion IN (:lote)`,
      { lote },
    ),
  );

  const de = (lista, id) => lista.filter((x) => x.id_cotizacion === id);
  const out = [];
  const vistos = new Set();
  for (const c of cots) {
    if (vistos.has(c.id_cotizacion)) continue; // una fila de detalle por cotización
    vistos.add(c.id_cotizacion);
    if (SIN_CARGA.includes(String(c.estado || '').toLowerCase()) || c.fecha_anulacion || esCorreoDePrueba(c.email)) continue;
    const ms = de(marcas, c.id_cotizacion);
    const cs = de(conts, c.id_cotizacion);
    const entrega = de(entregas, c.id_cotizacion)[0] || null;
    const base = { marcas: ms, entrega };
    const lista = cs.length
      ? cs.flatMap((k, i) => C.momentosDeCarga({ ...base, marcas: i === 0 ? ms : [], entrega: i === 0 ? entrega : null, asignada: k.asignada, contenedor: k }, ref))
      : C.momentosDeCarga(base, ref);
    for (const m of lista)
      out.push({ ...m, fuente: 'carga', id_users: c.id_users, telefono: c.telefono, destino: c.pais_destino, nombre: c.nombre });
  }
  return out;
}

/* Contenedores que vencieron AYER su fecha estimada sin llegar (para el equipo) y los vencidos hoy. */
async function vencidos(ref) {
  const filas = await leer(
    db_2,
    `SELECT nombre, DATE_FORMAT(fecha_estimada, '%Y-%m-%d') AS fecha_estimada, DATE_FORMAT(fecha_cierre, '%Y-%m-%d') AS fecha_cierre,
            DATE_FORMAT(fecha_bodega_destino, '%Y-%m-%d') AS fecha_bodega_destino
       FROM cotizadorpro_cargas
      WHERE fecha_cierre IS NOT NULL AND fecha_bodega_destino IS NULL AND fecha_estimada IS NOT NULL
        AND DATE(fecha_estimada) < :ref AND DATE(fecha_cierre) >= :desde`,
    { ref, desde: sumarDias(ref, -VENTANA_CAMINO_DIAS) },
  );
  return { ayer: filas.filter((f) => C.estimadaVencida(f, ref)).map((f) => f.nombre), total: filas.length };
}

/* ── 2. Alumnos: pagos, logro, clases ──────────────────────────────────── */
async function momentosDeAlumnos(ref) {
  const porUsuario = new Map();
  const de = (id) => {
    if (!porUsuario.has(id)) porUsuario.set(id, { pagos: [], reuniones: [] });
    return porUsuario.get(id);
  };

  for (const p of await leer(
    db_2,
    `SELECT ca.id_users, cp.monto_pagado AS monto, cp.moneda, DATE_FORMAT(cp.fecha_pago, '%Y-%m-%d') AS fecha
       FROM cartera_pagos cp
       INNER JOIN cuenta_por_pagar cpp ON cpp.id_cpp = cp.id_cpp
       INNER JOIN carteras ca ON ca.id_cartera = cpp.id_cartera
      WHERE DATE(cp.fecha_pago) = :ref`,
    { ref },
  ))
    de(p.id_users).pagos.push(p);

  const [{ total }] = await leer(db_2, `SELECT COUNT(*) AS total FROM cursos_contenidos WHERE id_modulo IN (:mods) AND visible = 1`, { mods: MODULOS_IMPLEMENTACION });
  for (const l of await leer(
    db_2,
    `SELECT p.id_users, COUNT(DISTINCT c.id_contenido) AS hechos, DATE_FORMAT(MAX(p.updated_at), '%Y-%m-%d') AS ultimo
       FROM cursos_contenido_progreso p
       INNER JOIN cursos_contenidos c ON c.id_contenido = p.id_contenido
      WHERE c.id_modulo IN (:mods) AND c.visible = 1 AND p.completado = 1
        AND p.id_users IN (SELECT DISTINCT p2.id_users FROM cursos_contenido_progreso p2
                             INNER JOIN cursos_contenidos c2 ON c2.id_contenido = p2.id_contenido
                            WHERE c2.id_modulo IN (:mods) AND p2.completado = 1 AND DATE(p2.updated_at) = :ref)
      GROUP BY p.id_users`,
    { mods: MODULOS_IMPLEMENTACION, ref },
  ))
    if (Number(l.hechos) >= Number(total) && Number(total) > 0) de(l.id_users).modulosListosEl = l.ultimo;

  for (const u of await leer(
    db_2,
    `SELECT u.id_users, DATE_FORMAT(u.date_added, '%Y-%m-%d') AS alta
       FROM users u
      WHERE u.id_rol IN (:roles) AND DATE(u.date_added) = :d
        AND NOT EXISTS (SELECT 1 FROM cursos_contenido_progreso p WHERE p.id_users = u.id_users)`,
    { roles: ROLES_ALUMNO, d: sumarDias(ref, -3) },
  ))
    Object.assign(de(u.id_users), { alta: u.alta, lecciones: 0 });

  for (const u of await leer(
    db_2,
    `SELECT x.id_users, x.lecciones, DATE_FORMAT(x.ultimo, '%Y-%m-%d') AS ultimo,
            (SELECT CONCAT(p.id_contenido, '|', m.id_curso, '|', c.titulo)
               FROM cursos_contenido_progreso p
               INNER JOIN cursos_contenidos c ON c.id_contenido = p.id_contenido
               INNER JOIN cursos_modulos m ON m.id_modulo = c.id_modulo
              WHERE p.id_users = x.id_users ORDER BY p.updated_at DESC LIMIT 1) AS ultima
       FROM (SELECT id_users, COUNT(*) AS lecciones, MAX(updated_at) AS ultimo
               FROM cursos_contenido_progreso GROUP BY id_users
             HAVING COUNT(*) >= 5 AND DATE(MAX(updated_at)) = :d) x`,
    { d: sumarDias(ref, -14) },
  )) {
    const [idc, curso, ...titulo] = String(u.ultima || '').split('|');
    Object.assign(de(u.id_users), {
      lecciones: Number(u.lecciones),
      ultimoAvance: u.ultimo,
      ultimaLeccion: idc && curso ? { titulo: titulo.join('|').trim(), enlace: `https://imporfactory.app/cursos/${curso}?contenido=${idc}` } : null,
    });
  }

  if (!porUsuario.size) return [];
  const ids = [...porUsuario.keys()];
  const usuarios = await enLotes(ids, 400, (lote) =>
    leer(
      db_2,
      `SELECT u.id_users, u.nombre_users AS nombre, u.email_users AS email, u.id_rol, p.whatsapp, p.pais
         FROM users u
         LEFT JOIN usuario_plataforma up ON up.id_usuario = u.id_users
              AND up.id_plataforma = (SELECT MIN(x.id_plataforma) FROM usuario_plataforma x WHERE x.id_usuario = u.id_users)
         LEFT JOIN plataformas p ON p.id_plataforma = up.id_plataforma
        WHERE u.id_users IN (:lote)`,
      { lote },
    ),
  );
  const out = [];
  for (const u of usuarios) {
    if (!ROLES_ALUMNO.includes(Number(u.id_rol)) || esCorreoDePrueba(u.email)) continue;
    for (const m of C.momentosDeAlumno(porUsuario.get(u.id_users), ref))
      out.push({ ...m, fuente: 'alumno', id_users: u.id_users, telefono: u.whatsapp, destino: u.pais, nombre: u.nombre });
  }
  return out;
}

/* Reuniones de la cuenta ese día (hora de Ecuador = UTC − 5). */
async function momentosDeReuniones(cuenta, ref) {
  const filas = await leer(
    db,
    `SELECT a.id, a.status, DATE_FORMAT(a.start_utc - INTERVAL 5 HOUR, '%Y-%m-%d') AS inicio, i.phone, i.name
       FROM appointments a
       INNER JOIN calendars c ON c.id = a.calendar_id AND c.account_id = :cuenta
       INNER JOIN appointment_invitees i ON i.appointment_id = a.id
      WHERE DATE(a.start_utc - INTERVAL 5 HOUR) = :ref`,
    { cuenta, ref },
  );
  const out = [];
  for (const f of filas)
    for (const m of C.momentosDeAlumno({ reuniones: [{ inicio: f.inicio, estado: f.status }] }, ref))
      out.push({ ...m, fuente: 'reunion', telefono: f.phone, destino: null, nombre: f.name });
  return out;
}

/* ── 3. ¿Qué chat de la línea es? ──────────────────────────────────────── */
async function chatsDe(cuenta, telefonos) {
  const colas = [...new Set(telefonos.map(cola9).filter((c) => c.length === 9))];
  if (!colas.length) return [];
  return enLotes(colas, 500, (lote) =>
    leer(
      db,
      `SELECT id, celular_cliente, bot_openia, nombre_cliente, ultimo_mensaje_at
         FROM clientes_chat_center
        WHERE id_configuracion = :cuenta AND deleted_at IS NULL AND propietario <> 1
          AND (celular_last9 IN (:lote) OR RIGHT(REGEXP_REPLACE(COALESCE(celular_cliente, ''), '[^0-9]', ''), 9) IN (:lote))`,
      { cuenta, lote },
    ),
  );
}
function chatDe(chats, telefono, destino) {
  const c9 = cola9(telefono);
  if (c9.length !== 9) return null;
  const candidatos = chats.filter((c) => cola9(c.celular_cliente) === c9 && mismoTelefono(c.celular_cliente, telefono, destino || null));
  const ms = (v) => (v ? new Date(v).getTime() || 0 : 0);
  candidatos.sort((a, b) => ms(b.ultimo_mensaje_at) - ms(a.ultimo_mensaje_at));
  return candidatos[0] || null;
}

/* ── Resumen para Daniel ───────────────────────────────────────────────── */
const EMOJI = {
  bodega_destino: '🎉', puerto: '⚓', zarpo: '🚢', novedad: '📣', contenedor_cerrado: '✅', en_contenedor: '📦',
  recibido_china: '🇨🇳', entregada: '🏁', sigue_en_camino: '🧭', pago_recibido: '💳', logro: '👏',
  post_reunion: '🤝', primera_clase: '🎓', te_guarde: '🔖',
};
const RAZONES = {
  'lo atiende una persona (bot apagado en el chat)': 'Lo atiende un asesor (se le avisaría a él)',
  'tiene una gestión abierta con un asesor': 'Lo atiende un asesor (se le avisaría a él)',
  'hoy le llegó otro mensaje automático': 'Ya le llegó otro automático (pasa al día siguiente)',
  'ya recibió uno esta semana': 'Ya recibió uno esta semana',
  'no tiene chat en la línea': 'No tiene chat en la 265',
  'pidió que no le escriban': 'Pidió que no le escriban',
};
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fechaCorta = (d) => `${DIAS[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${Number(d.slice(8, 10))}-${['', 'ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(d.slice(5, 7))]}`;

function ejemplo(r) {
  const datos = { ...r.datos };
  if (datos.marca) datos.marca = String(datos.marca).replace(/[0-9A-Za-z]{2,}$/g, (s) => '*'.repeat(s.length));
  if (datos.monto) datos.monto = '$***';
  const texto = C.textoDe(r.momento, datos, r.nombre);
  const n = C.primerNombre(r.nombre);
  return n ? texto.replace(n, C.enmascarar(r.nombre)) : texto;
}

function resumen({ ref, decididos, venc, ms }) {
  const escribir = decididos.filter((d) => d.decision.accion === 'escribir');
  const porMomento = {};
  for (const d of escribir) porMomento[d.momento] = (porMomento[d.momento] || 0) + 1;
  const frenos = {};
  for (const d of decididos.filter((x) => x.decision.accion !== 'escribir')) {
    const k = RAZONES[d.decision.razon] || d.decision.razon;
    frenos[k] = (frenos[k] || 0) + 1;
  }
  const texto = escribir.filter((d) => d.decision.via === 'texto').length;
  const l = [];
  l.push(`🫶 *Consentidos · ensayo del ${fechaCorta(ref)}*`);
  l.push('_Lo que pasó ese día en Ecuador. NO se le escribió a nadie._');
  l.push('');
  if (escribir.length) {
    l.push(`Si estuviera encendido, al día siguiente les escribiría a *${escribir.length} alumnos*:`);
    for (const k of Object.keys(C.MOMENTOS)) if (porMomento[k]) l.push(`• ${EMOJI[k]} ${C.NOMBRE_MOMENTO[k]}: ${porMomento[k]}`);
    l.push(`De ellos, ${texto} con texto libre (escribieron en 24 h) y ${escribir.length - texto} necesitan plantilla de Meta.`);
  } else l.push('Ese día no hubo a quién escribirle.');
  if (Object.keys(frenos).length) {
    l.push('');
    l.push('*Frenados por los candados:*');
    for (const [k, n] of Object.entries(frenos).sort((a, b) => b[1] - a[1])) l.push(`• ${k}: ${n}`);
  }
  l.push('');
  l.push('*Para el equipo de logística:*');
  l.push(venc.ayer.length ? `• ${venc.ayer.length} contenedor(es) vencieron ayer su fecha estimada sin llegar: ${venc.ayer.join(', ')}` : '• Ningún contenedor venció ayer su fecha estimada.');
  l.push(`• Hoy hay ${venc.total} contenedor(es) con la fecha estimada vencida y sin llegada registrada.`);
  const vistos = new Set();
  const ejemplos = [];
  for (const d of escribir) {
    if (vistos.has(d.momento) || ejemplos.length >= 4) continue;
    vistos.add(d.momento);
    ejemplos.push(`${EMOJI[d.momento]} _${C.NOMBRE_MOMENTO[d.momento]}_\n“${ejemplo(d)}”`);
  }
  if (ejemplos.length) {
    l.push('');
    l.push('*Así le llegaría (nombres ocultos):*');
    l.push(ejemplos.join('\n\n'));
  }
  l.push('');
  l.push(`_Textos sin aprobar todavía. Revisé ${decididos.length} momentos en ${Math.round(ms / 1000)} s._`);
  return l.join('\n');
}

/* ── Principal ─────────────────────────────────────────────────────────── */
async function main() {
  const t0 = Date.now();
  const cuenta = Number(valor('--config'));
  if (!cuenta) throw new Error('falta --config <id>');
  const [{ ayer, ahora }] = await leer(db, `SELECT DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d') AS ayer, UNIX_TIMESTAMP() * 1000 AS ahora`);
  const ref = valor('--fecha', ayer);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ref)) throw new Error('--fecha va como AAAA-MM-DD');
  const rutaEstado = valor('--estado', null);
  let estado = [];
  try {
    if (rutaEstado && fs.existsSync(rutaEstado)) estado = JSON.parse(fs.readFileSync(rutaEstado, 'utf8'));
  } catch {
    estado = [];
  }
  estado = estado.filter((e) => e.t >= Number(ahora) - 8 * DIA_MS);

  const momentos = [...(await momentosDeCargas(ref)), ...(await momentosDeAlumnos(ref)), ...(await momentosDeReuniones(cuenta, ref))];
  const chats = await chatsDe(cuenta, momentos.map((m) => m.telefono));

  // Un alumno = un chat (o, sin chat, su usuario o su número). Le toca el momento de más prioridad.
  const porAlumno = new Map();
  for (const m of momentos) {
    const chat = chatDe(chats, m.telefono, m.destino);
    const k = chat ? `c${chat.id}` : m.id_users ? `u${m.id_users}` : `t${cola9(m.telefono)}`;
    const previo = porAlumno.get(k);
    if (!previo || C.elegir([previo, m]) === m) porAlumno.set(k, { ...m, chat, nombre: m.nombre || chat?.nombre_cliente });
  }

  const decididos = [];
  for (const a of porAlumno.values()) {
    let mensajes = [];
    let bajas = false;
    if (a.chat) {
      const filas = await leer(
        db,
        `SELECT rol_mensaje AS rol, responsable AS resp, texto_mensaje AS tx, UNIX_TIMESTAMP(created_at) * 1000 AS t
           FROM mensajes_clientes
          WHERE celular_recibe = :chat AND id_configuracion = :cuenta AND deleted_at IS NULL
            AND created_at >= NOW() - INTERVAL 120 DAY
            AND (created_at >= NOW() - INTERVAL 8 DAY OR rol_mensaje = 0)
          ORDER BY id`,
        { chat: String(a.chat.id), cuenta },
      );
      const todos = filas.map((f) => ({ ...f, rol: Number(f.rol), t: Number(f.t) }));
      mensajes = todos.filter((m) => m.t >= Number(ahora) - 8 * DIA_MS);
      bajas = C.aplicarCandados({ momento: a.momento, chat: a.chat, mensajes: todos.filter((m) => m.rol === 0), ahora: Number(ahora) }).razon === 'pidió que no le escriban';
    }
    const enviados = a.chat ? estado.filter((e) => e.h === clave(a.chat.id)) : [];
    const decision = C.aplicarCandados({ momento: a.momento, chat: a.chat, mensajes, bajas, enviados, ahora: Number(ahora) });
    decididos.push({ ...a, decision });
    if (decision.accion === 'escribir' && a.chat) estado.push({ h: clave(a.chat.id), momento: a.momento, t: Number(ahora) });
  }

  const venc = await vencidos(ref);
  const texto = resumen({ ref, decididos, venc, ms: Date.now() - t0 });
  console.log(texto);
  const salida = valor('--salida', null);
  if (salida) fs.writeFileSync(salida, `${texto}\n`);
  if (rutaEstado) fs.writeFileSync(rutaEstado, JSON.stringify(estado));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
