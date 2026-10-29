/* ═══════════════════════════════════════════════════════════
   Ajustes del bot a nivel de cuenta (configuraciones.ia_ajustes, JSON)

   Perillas que antes eran una sola para todas las cuentas y que una cuenta de
   SOPORTE necesita distintas a una tienda (caso cfg 261, manual de Evelyn del
   2026-10-05):

   - espera_rafaga_seg   segundos que el bot espera al cliente antes de
                         contestar (fijo, reemplaza la ventana adaptativa de
                         utils/agruparRafaga). Un dropshipper escribe "buen día"
                         / "una consulta" / foto / "el ID es…" y el bot le
                         contestaba cada pedazo.
   - mensaje_fallback    texto que SÍ se le manda al cliente cuando el bot no
                         pudo responder (OpenAI sin saldo o caído). Sin esto el
                         cliente no recibe nada y el equipo solo ve el cartel.
   - numeros_excluidos   teléfonos del propio equipo (bodega, asesores) a los
                         que el bot nunca les contesta.
   - pausa_humano        { minutos, estados }: en esas columnas el bot calla si
                         una persona del equipo escribió hace menos de N
                         minutos — el chat lo está atendiendo alguien.
   - horario             { desde: "16:00", hasta: "08:00", dias_completos: [0],
                         utc: -5 }: el bot solo contesta dentro de esa franja.
                         Fuera de ella calla y el chat queda para el equipo,
                         como si el bot no existiera. Si `desde` es mayor que
                         `hasta` la franja cruza la medianoche (16:00 → 08:00).
                         `dias_completos` (0 = domingo … 6 = sábado) son días
                         en que contesta las 24 horas. `utc` es el desfase de
                         la cuenta en horas (por defecto -5, Ecuador). Nació
                         con la línea de soporte 265 (2026-10-12): de día
                         atiende el equipo y el bot cubre la noche.
   - solo_numeros        lista blanca para probar un bot en una línea real: si
                         trae teléfonos, el bot SOLO les contesta a esos y
                         calla con todos los demás. Vacía = sin efecto.
   - soporte_expertos    true o { cargas, fichas, guardia }: enciende lo que
                         el bot de soporte de la 265 hace alrededor del modelo
                         (utils/soporteExpertos/turno.js): busca la carga del
                         cliente por su teléfono, trae las fichas de la base
                         más cercanas a lo que escribió, lee qué adjuntos
                         llegaron y pasa la respuesta por la guardia. Cada
                         parte se apaga poniéndola en false. Sin este ajuste
                         nada de eso corre.

   Va en un JSON y no en cuatro columnas porque son ajustes de pocas cuentas y
   van a aparecer más. Si la columna todavía no existe (falta aplicar
   ia_ajustes_migration.sql) se responde "sin ajustes": el bot queda
   exactamente como estaba.
   ═══════════════════════════════════════════════════════════ */
const { db } = require('../database/config');

const TTL_MS = 60 * 1000;
const ESPERA_MIN_SEG = 2;
const ESPERA_MAX_SEG = 45; // más que eso ya es un bot que no contesta

const SIN_AJUSTES = Object.freeze({
  espera_rafaga_ms: null,
  mensaje_fallback: null,
  numeros_excluidos: [],
  pausa_humano: null,
  horario: null,
  solo_numeros: [],
  soporte_expertos: null,
});

// id_configuracion → { ts, valor }
const cache = new Map();
let avisoSinMigrar = false;

const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');

const UTC_POR_DEFECTO = -5; // Ecuador, sin horario de verano

/* "16:00" / "8:30" / "8" → minutos desde la medianoche; null si no es una hora. */
function minutosDelDia(v) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(String(v ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return (h % 24) * 60 + min;
}

/* Un horario mal escrito NO puede terminar en "bot las 24 horas": si la franja
   no se entiende se devuelve null y, para que eso no pase desapercibido, queda
   anotado `horario_invalido` (quien lea los ajustes calla el bot). */
function normalizarHorario(h) {
  if (h === undefined || h === null) return { horario: null, invalido: false };
  if (typeof h !== 'object') return { horario: null, invalido: true };
  const desde = minutosDelDia(h.desde);
  const hasta = minutosDelDia(h.hasta);
  const dias = (Array.isArray(h.dias_completos) ? h.dias_completos : [])
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const utc = Number(h.utc);
  const hayFranja = desde !== null && hasta !== null && desde !== hasta;
  if (!hayFranja && !dias.length) return { horario: null, invalido: true };
  return {
    horario: {
      desde_min: hayFranja ? desde : null,
      hasta_min: hayFranja ? hasta : null,
      dias_completos: [...new Set(dias)],
      utc: Number.isFinite(utc) && utc >= -12 && utc <= 14 ? utc : UTC_POR_DEFECTO,
    },
    invalido: false,
  };
}

/* true → todo encendido (menos las herramientas); un objeto apaga lo que traiga en false. */
function normalizarSoporteExpertos(v) {
  if (v === true)
    return {
      cargas: true,
      fichas: true,
      guardia: true,
      herramientas: false,
      diagnostico: false,
      pagos: false,
      agenda: false,
      cotizacion_mx: false,
      objecion_precio: false,
      novedad: false,
      proveedores: false,
      dropi: false,
      membresia: false,
      callar_bots: true,
      callar_acuses: true,
      decir_apertura: false,
      escalar: false,
      seguimiento: false,
      callar_al_pasar: false,
      proactivo: false,
      pausa_persona: null,
    };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return {
    cargas: v.cargas !== false,
    fichas: v.fichas !== false,
    guardia: v.guardia !== false,
    // Herramientas de Claude (consultar la carga, pasar a un asesor): apagadas
    // salvo que la cuenta las pida explícito. Ver utils/claude/herramientas.js.
    herramientas: v.herramientas === true,
    // Revisar la cuenta IMPORCHAT del que escribe (revisar_mi_imporchat): solo
    // con herramientas y pedido explícito. Ver soporteExpertos/diagnosticoCuenta.js.
    diagnostico: v.herramientas === true && v.diagnostico === true,
    // Cuotas, saldo, pagos registrados y facturas del que escribe (ver_mis_pagos):
    // solo con herramientas y pedido explícito. Ver soporteExpertos/pagosCliente.js.
    pagos: v.herramientas === true && v.pagos === true,
    // Reuniones agendadas y sesión de implementación del que escribe
    // (ver_mi_reunion, solo lee): solo con herramientas y pedido explícito.
    // Ver soporteExpertos/reunionCliente.js.
    agenda: v.herramientas === true && v.agenda === true,
    // Cotización nueva a México armada por el bot, en BORRADOR para el asesor
    // (armar_cotizacion_mexico): solo con herramientas y pedido explícito.
    // Ver soporteExpertos/cotizacionMexico.js.
    cotizacion_mx: v.herramientas === true && v.cotizacion_mx === true,
    // «Me sale muy caro»: explica el desglose y, si insiste, pasa al líder
    // comercial; nunca baja el precio. Solo con pedido explícito y con los
    // textos aprobados (textos.OBJECION_APROBADO). Ver soporteExpertos/objecionPrecio.js.
    objecion_precio: v.objecion_precio === true,
    // «¿Hay novedad de mi caso?» (ver_novedad_de_mi_caso, solo lee las notas y
    // mensajes del equipo en ese chat): solo con herramientas y pedido
    // explícito. Ver soporteExpertos/novedadCaso.js.
    novedad: v.herramientas === true && v.novedad === true,
    // Proveedores de Yiwu con su tarjeta (buscar_proveedor, solo lee el
    // directorio): solo con herramientas y pedido explícito.
    // Ver soporteExpertos/proveedoresYiwu.js.
    proveedores: v.herramientas === true && v.proveedores === true,
    // Pedidos de Dropi de la tienda del alumno, del caché de IMPORCHAT (no
    // consulta Dropi en vivo). Ver soporteExpertos/pedidosDropi.js.
    dropi: v.herramientas === true && v.dropi === true,
    // Membresía de Imporsuit del que escribe (ver_mi_membresia, solo lee y
    // solo de su número). Ver soporteExpertos/membresiaAlumno.js.
    membresia: v.herramientas === true && v.membresia === true,
    // No contestarle al bot de la tienda del alumno ni a un «ok / gracias»:
    // encendidos salvo que la cuenta los apague (senales.js).
    callar_bots: v.callar_bots !== false,
    callar_acuses: v.callar_acuses !== false,
    // Horario del equipo (soporteExpertos/horario.js): solo si la cuenta lo trae.
    ...(v.horario_equipo && typeof v.horario_equipo === 'object' ? { horario_equipo: v.horario_equipo } : {}),
    // Horario de ecommerce (con el sábado 08:00-12:00): solo si la cuenta lo trae.
    ...(v.horario_ecommerce && typeof v.horario_ecommerce === 'object' ? { horario_ecommerce: v.horario_ecommerce } : {}),
    // Fuera de horario, «apenas abramos» → «el lunes desde las 8:00»: apagado salvo pedido explícito.
    decir_apertura: v.decir_apertura === true,
    // A quién va el caso (soporteExpertos/escalado.js): apagado salvo 'simulado' o 'real'.
    escalar: v.escalar === 'simulado' || v.escalar === 'real' ? v.escalar : false,
    // Seguimiento al que quedó esperando (soporteExpertos/seguimiento.js): igual.
    seguimiento: v.seguimiento === 'simulado' || v.seguimiento === 'real' ? v.seguimiento : false,
    // Al pasar el chat a una persona, el bot se calla ahí hasta «Devolver al
    // bot» en Team (escalado.js): solo con escalar 'real' y pedido explícito.
    callar_al_pasar: v.escalar === 'real' && v.callar_al_pasar === true,
    // Bot proactivo (soporteExpertos/proactivo.js, tramo 5): pide el dato que
    // falta, no pasa lo que ya resolvió, dice quién y cuándo, y no vuelve a
    // pasar un caso que ya espera. Solo con escalar 'real' (nombra a la persona
    // que recibe el chat) y pedido explícito.
    proactivo: v.escalar === 'real' && v.proactivo === true,
    // Una persona ya contesta el chat (pedido de Johan, 28-oct;
    // soporteExpertos/pausaYAcuse.js): el bot calla en oficina y, si el
    // cliente espera `minutos` de oficina sin respuesta, manda un solo T8.
    pausa_persona: normalizarPausaPersona(v.pausa_persona),
  };
}

/* true → 60 min de oficina y una persona en las últimas 24 h. Un objeto puede
   cambiar los dos, dentro de un rango sensato. Sin el campo: apagado. */
function normalizarPausaPersona(v) {
  if (v === true) return { minutos: 60, horas: 24 };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const n = (x, def, min, max) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.min(Math.max(Math.round(Number(x)), min), max) : def);
  return { minutos: n(v.minutos, 60, 15, 480), horas: n(v.horas, 24, 1, 72) };
}

function normalizar(raw) {
  let c = raw;
  try {
    while (typeof c === 'string') c = JSON.parse(c);
  } catch {
    /* JSON roto. Sin horario eso es "sin ajustes", como siempre. Pero si el
       texto traía un horario, caer a "sin ajustes" sería soltar al bot las 24
       horas en una cuenta que lo quería solo de noche: ahí se calla. */
    return /"horario"/.test(String(raw))
      ? { ...SIN_AJUSTES, horario_invalido: true }
      : SIN_AJUSTES;
  }
  if (!c || typeof c !== 'object') return SIN_AJUSTES;

  const espera = Number(c.espera_rafaga_seg);
  const fallback = String(c.mensaje_fallback || '').trim();
  const minutos = Number(c.pausa_humano?.minutos);
  const estados = Array.isArray(c.pausa_humano?.estados)
    ? c.pausa_humano.estados.map((e) => String(e).toLowerCase().trim()).filter(Boolean)
    : [];
  const { horario, invalido: horarioInvalido } = normalizarHorario(c.horario);

  return {
    espera_rafaga_ms:
      Number.isFinite(espera) && espera > 0
        ? Math.min(Math.max(espera, ESPERA_MIN_SEG), ESPERA_MAX_SEG) * 1000
        : null,
    mensaje_fallback: fallback || null,
    numeros_excluidos: (Array.isArray(c.numeros_excluidos) ? c.numeros_excluidos : [])
      .map(soloDigitos)
      .filter((n) => n.length >= 7),
    pausa_humano:
      Number.isFinite(minutos) && minutos > 0 && estados.length
        ? { minutos: Math.min(minutos, 24 * 60), estados }
        : null,
    horario,
    horario_invalido: horarioInvalido,
    solo_numeros: (Array.isArray(c.solo_numeros) ? c.solo_numeros : [])
      .map(soloDigitos)
      .filter((n) => n.length >= 7),
    soporte_expertos: normalizarSoporteExpertos(c.soporte_expertos),
  };
}

async function getAjustesIA(id_configuracion) {
  const id = Number(id_configuracion);
  if (!id) return SIN_AJUSTES;

  const enCache = cache.get(id);
  if (enCache && Date.now() - enCache.ts < TTL_MS) return enCache.valor;

  let valor = SIN_AJUSTES;
  try {
    const [row] = await db.query(
      `SELECT ia_ajustes FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id], type: db.QueryTypes.SELECT },
    );
    valor = normalizar(row?.ia_ajustes);
  } catch (err) {
    if (!avisoSinMigrar) {
      avisoSinMigrar = true;
      console.warn(
        '[ajustesIA] No se pudo leer ia_ajustes (¿falta la migración?):',
        err.message,
      );
    }
  }
  cache.set(id, { ts: Date.now(), valor });
  return valor;
}

function invalidarAjustesIA(id_configuracion) {
  cache.delete(Number(id_configuracion));
}

/* El mismo número llega con y sin código de país según el canal ("0991234567",
   "593991234567"): se compara por los últimos 9 dígitos. */
function esNumeroExcluido(ajustes, telefono) {
  const tel = soloDigitos(telefono);
  if (tel.length < 7 || !ajustes?.numeros_excluidos?.length) return false;
  const cola = (n) => n.slice(-9);
  return ajustes.numeros_excluidos.some((n) => cola(n) === cola(tel));
}

/* ¿El bot puede contestar a esta hora? Sin `horario` siempre puede. Con un
   horario que no se pudo leer, NO: es preferible un bot callado a uno que le
   contesta a toda la cuenta a mediodía por un error de tipeo. */
function dentroDeHorario(ajustes, ahora = new Date()) {
  if (ajustes?.horario_invalido) return false;
  const h = ajustes?.horario;
  if (!h) return true;

  // Hora local de la cuenta sin depender de la zona del servidor.
  const local = new Date(ahora.getTime() + h.utc * 60 * 60 * 1000);
  if (h.dias_completos.includes(local.getUTCDay())) return true;
  if (h.desde_min === null) return false;

  const m = local.getUTCHours() * 60 + local.getUTCMinutes();
  return h.desde_min < h.hasta_min
    ? m >= h.desde_min && m < h.hasta_min
    : m >= h.desde_min || m < h.hasta_min; // cruza la medianoche
}

/* Lista blanca de pruebas: vacía deja pasar a todos. Misma comparación por los
   últimos 9 dígitos que `esNumeroExcluido`. */
function esNumeroPermitido(ajustes, telefono) {
  if (!ajustes?.solo_numeros?.length) return true;
  const tel = soloDigitos(telefono);
  if (tel.length < 7) return false;
  const cola = (n) => n.slice(-9);
  return ajustes.solo_numeros.some((n) => cola(n) === cola(tel));
}

/* ¿El horario o la lista blanca van a callar al bot con este teléfono ahora?
   Es la misma pregunta que hace kanban_ia al entrar, puesta aparte para que el
   webhook la haga ANTES de gastar en transcribir un audio o leer una imagen:
   con el bot de la 265 encendido solo de noche, sin esto se transcribía y se
   describía todo lo que llega de día, que nadie del bot va a usar. Una cuenta
   sin `horario` ni `solo_numeros` responde siempre false: queda como estaba. */
function calladoPorHorarioOLista(ajustes, telefono, ahora = new Date()) {
  if (!ajustes) return false;
  const tieneCandado =
    Boolean(ajustes.horario) || Boolean(ajustes.horario_invalido) || Boolean(ajustes.solo_numeros?.length);
  if (!tieneCandado) return false;
  return !esNumeroPermitido(ajustes, telefono) || !dentroDeHorario(ajustes, ahora);
}

/* `responsable` trae el nombre de quien escribió. Lo que empieza con IA_, cron_
   o es un emisor del sistema (encuesta, notifier, respondedor) no es una
   persona. "Whatsapp Business" sí: es el eco de la app de coexistencia, o sea
   alguien del equipo escribiendo desde el teléfono. */
function esResponsableHumano(responsable) {
  const resp = String(responsable || '').trim();
  return Boolean(
    resp &&
      !/^(IA_|IA$|cron_|dropi|aliclik|sistema|instagram|messenger|respondedor|encuesta|bot\b)/i.test(
        resp,
      ),
  );
}

module.exports = {
  getAjustesIA,
  invalidarAjustesIA,
  esNumeroExcluido,
  esNumeroPermitido,
  dentroDeHorario,
  esResponsableHumano,
  calladoPorHorarioOLista,
  normalizar,
};
