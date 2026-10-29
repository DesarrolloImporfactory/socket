/* Pruebas del tramo 4 del bot de Expertos (27-oct):
     1. buscar la carga y los pagos con el N.º de cotización, la marca o el
        correo cuando el número no trae nada (identidadPorDato.js), sin
        entregar nunca datos de otra persona (casos 113, 140, 182, 206, 208, 209);
     2. IMPORCHAT con la cuenta suspendida: lo dice y suma su saldo (caso 153);
     3. «¿hay novedad de mi caso?» (novedadCaso.js, casos 201 y 203).
   Sin red ni base: las bases son dobles y todos los datos son inventados.
     node scripts/probar_soporte_expertos_dato.js */

'use strict';

const path = require('path');
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };
// El diagnóstico carga los estados de WhatsApp de este servicio (que necesita axios).
const { ESTADOS_RECONECTAR } = require('./soporte_expertos/cuenta_imporchat_de_mentira');
const rutaSalud = require.resolve(path.join(__dirname, '../src/services/whatsapp_numero_health.service'));
require.cache[rutaSalud] = { id: rutaSalud, filename: rutaSalud, loaded: true, exports: { ESTADOS_RECONECTAR } };

const ident = require('../src/utils/soporteExpertos/identidadPorDato');
const { duenoPorDato, leerDato, datoEscrito, olvidarTodo } = ident;
const { crearHerramientas, sumarHechosHerramientas } = require('../src/utils/soporteExpertos/herramientas');
const { novedadDelCaso, bloqueNovedad, pideNovedad } = require('../src/utils/soporteExpertos/novedadCaso');
const { diagnosticarCuenta } = require('../src/utils/soporteExpertos/diagnosticoCuenta');
const { prepararTurno, olvidarTodo: olvidarTurnos } = require('../src/utils/soporteExpertos/turno');
const { buscadorDeArchivo } = require('../src/utils/soporteExpertos/fichas');
const T = require('../src/utils/soporteExpertos/textos');
const { baseDeMentira, DATOS, TEL: TEL_CARGA, HOY } = require('./soporte_expertos/base_de_mentira');
const imporchat = require('./soporte_expertos/cuenta_imporchat_de_mentira');
require('../src/utils/soporteExpertos/horario').fijarHoraParaPruebas(Date.parse('2026-10-24T21:00:00-05:00'));

let ok = 0;
let fallos = 0;
function prueba(nombre, pasa, detalle = '') {
  if (pasa) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    fallos++;
    console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

/* ── Base de Imporsuit de mentira: la de cargas + lo que consulta identidadPorDato y pagos ── */
const OTRO = '593987000222'; // escribe desde un número que no está en ninguna cuenta
const SEGUNDO_DE_ANA = '593987000333'; // otro WhatsApp de Ana, guardado en una de sus plataformas
const USERS = [
  { id_users: 701, email_users: 'ana.ejemplo@gmail.com', id_rol: 3 },
  { id_users: 702, email_users: 'bruno.ejemplo@gmail.com', id_rol: 3 },
  { id_users: 706, email_users: 'fabian.ejemplo@gmail.com', id_rol: 4 },
  { id_users: 790, email_users: 'equipo@imporfactory.app', id_rol: 1 },
];
const PLATAFORMAS_DE = { 701: ['0901234501', '+593 98 700 0333'], 702: ['0901234502'], 706: ['55 0123 4506'] };
const CUOTAS = [
  { id_cpp: 1, id_users: 701, concepto: 'Programa Expertos', estado: 0, monto_original: 500, monto_pendiente: 250,
    fecha_limite: '2026-11-05', num_cuota: 2, total_cuotas: 6, id_cotizacion: null, moneda: 'USD' },
  { id_cpp: 2, id_users: 702, concepto: 'Programa Expertos', estado: 0, monto_original: 900, monto_pendiente: 900,
    fecha_limite: '2026-11-01', num_cuota: 1, total_cuotas: 3, id_cotizacion: null, moneda: 'USD' },
];

function base() {
  const cargas = baseDeMentira(DATOS);
  const sqls = [];
  const consultar = async (sql, rep = []) => {
    sqls.push({ sql, rep });
    if (/FROM users u\s+WHERE u\.email_users = \?/.test(sql)) return USERS.filter((u) => u.email_users === rep[0]);
    if (/FROM cotizadorpro_detalle_cot d\s+LEFT JOIN users u/.test(sql)) {
      return DATOS.cotizaciones
        .filter((c) => rep[0].includes(c.id_cotizacion))
        .map((c) => {
          const u = USERS.find((x) => x.id_users === c.id_users) || {};
          return { id_cotizacion: c.id_cotizacion, id_users: c.id_users, pais_destino: c.pais_destino, email_users: u.email_users, id_rol: u.id_rol };
        });
    }
    if (/FROM cotizadorpro_codigo_proveedores cp\s+WHERE cp\.codigo = \?/.test(sql))
      return DATOS.marcas.filter((m) => m.codigo === rep[0]).map((m) => ({ id_cotizacion: m.id_cotizacion }));
    if (/WHERE up\.id_usuario = \?/.test(sql)) return (PLATAFORMAS_DE[rep[0]] || []).map((telefono) => ({ telefono }));
    if (/SELECT d\.telefono\s+FROM cotizadorpro_detalle_cot d\s+WHERE d\.id_users = \?/.test(sql))
      return DATOS.cotizaciones.filter((c) => c.id_users === rep[0]).map((c) => ({ telefono: c.telefono }));
    if (/FROM cotizadorpro_cotizaciones c[\s\S]*WHERE d\.id_users = \?/.test(sql))
      return DATOS.cotizaciones
        .filter((c) => c.id_users === rep[0])
        .sort((a, b) => String(b.fecha_creacion).localeCompare(String(a.fecha_creacion)))
        .map((c) => ({ ...c }));
    // Pagos (pagosCliente.js)
    if (/FROM plataformas p[\s\S]*INNER JOIN users u/.test(sql)) return [];
    if (/FROM carteras/.test(sql)) return CUOTAS.filter((c) => rep[0].includes(c.id_users));
    if (/FROM cartera_pagos|FROM facturas_electronicas/.test(sql)) return [];
    return cargas.consultar(sql, rep);
  };
  return { consultar, sqls };
}

const herramientas = (mensaje, telefono, b, extra = {}) =>
  crearHerramientas({ telefono, mensaje, canalVerificable: true, pagos: true, deps: { consultar: b.consultar, hoy: HOY }, ...extra });
const usar = (h, nombre, input = {}) => h.lista.find((x) => x.definicion.name === nombre).ejecutar(input);
const NO_DE_ANA = /EC-PRUEBA|EC-9001|Ana Ejemplo|9001|tránsito|transito|24 de octubre/i;
const NO_DE_BRUNO = /EC-PRUEBA-SEP-B|EC-9002|Bruno|\b9002\b|\b900[,.]00/i;

(async () => {
  console.log('1. Leer el dato');
  prueba('«1867» es una cotización', JSON.stringify(leerDato('1867')) === '{"tipo":"cotizacion","valor":"1867"}', JSON.stringify(leerDato('1867')));
  prueba('«MX-002026» es una marca', leerDato('MX-002026')?.tipo === 'marca' && leerDato('MX-002026').valor === 'MX-002026');
  prueba('«ana.ejemplo@gmail.com» es un correo', leerDato(' Ana.Ejemplo@Gmail.com ')?.tipo === 'correo');
  prueba('un teléfono no es un dato válido', leerDato('0987123456') === null);
  prueba('«1867» escrito con texto alrededor cuenta', datoEscrito(leerDato('1867'), 'mi cotización es la 1867, gracias'));
  prueba('«1867» no cuenta dentro de «18670» ni de «$1.867»', !datoEscrito(leerDato('1867'), 'pagué 18670') && !datoEscrito(leerDato('1867'), 'son $1.867'));

  console.log('\n2. ver_mi_carga con el dato (casos 113, 140, 182, 206, 208, 209)');
  {
    olvidarTodo();
    let b = base();
    let h = herramientas('mi cotización es la 9001', OTRO, b);
    let t = await usar(h, 'ver_mi_carga', { dato: '9001' });
    prueba('cotización de otra cuenta desde un número que no es suyo: pide el correo', t.includes(T.MENSAJE_DATO_PIDE_CORREO), t.slice(0, 160));
    prueba('🔒 …y no muestra nada de esa carga', !NO_DE_ANA.test(t.replace(T.MENSAJE_DATO_PIDE_CORREO, '')), t);
    prueba('🔒 …ni la deja para la guardia', h.cargaConsultada() === null && h.identidadConsultada()?.estado === 'pide_otro');

    olvidarTodo();
    b = base();
    h = herramientas('mi cotización es la 9999', OTRO, b);
    const t2 = await usar(h, 'ver_mi_carga', { dato: '9999' });
    prueba('🔒 una cotización que no existe da el MISMO texto (no se sabe si existe)', t2 === t, t2.slice(0, 120));

    // Turno siguiente: escribe el correo de la dueña → dos datos de la misma cuenta.
    olvidarTodo();
    b = base();
    await usar(herramientas('mi cotización es la 9001', OTRO, b), 'ver_mi_carga', { dato: '9001' });
    h = herramientas('ana.ejemplo@gmail.com', OTRO, b);
    t = await usar(h, 'ver_mi_carga', { dato: 'ana.ejemplo@gmail.com' });
    prueba('cotización + correo de la misma cuenta: muestra su carga', /EC-PRUEBA-OCT-A|tránsito|transito/i.test(t) && h.cargaConsultada()?.por === 'dato', t.slice(0, 200));
    prueba('…y dice que buscó en su cuenta, no con este número', /en su cuenta|con el dato/i.test(t) && !/con este número/i.test(t.split('\n')[0]), t.split('\n')[0]);
    prueba('🔒 nada de otra persona', !NO_DE_BRUNO.test(t));

    // Escribe desde otro WhatsApp suyo (guardado en una de sus plataformas): basta el código.
    olvidarTodo();
    b = base();
    h = herramientas('mi marca es EC-9001001', SEGUNDO_DE_ANA, b);
    t = await usar(h, 'ver_mi_carga', { dato: 'EC-9001001' });
    prueba('marca + escribe desde otro WhatsApp de su cuenta: muestra su carga', /EC-PRUEBA-OCT-A|tránsito|transito/i.test(t), t.slice(0, 160));
    prueba('…verificado por teléfono', h.identidadConsultada()?.estado === 'verificado' && h.identidadConsultada()?.por === 'telefono');

    // Datos de dos personas distintas.
    olvidarTodo();
    b = base();
    h = herramientas('mi cotización es 9002 y mi correo ana.ejemplo@gmail.com', OTRO, b);
    t = await usar(h, 'ver_mi_carga', { dato: '9002' });
    prueba('🔒 cotización de Bruno + correo de Ana: no coincide', t.includes(T.MENSAJE_DATO_NO_COINCIDE), t.slice(0, 160));
    prueba('🔒 …sin nada de ninguno de los dos', !NO_DE_BRUNO.test(t.replace(T.MENSAJE_DATO_NO_COINCIDE, '')) && !NO_DE_ANA.test(t.replace(T.MENSAJE_DATO_NO_COINCIDE, '')));

    // Un dato que no escribió.
    olvidarTodo();
    h = herramientas('hola, ¿en qué va lo mío?', OTRO, base());
    t = await usar(h, 'ver_mi_carga', { dato: '9001' });
    prueba('🔒 el modelo pone un dato que el cliente no escribió: no busca', !NO_DE_ANA.test(t) && h.identidadConsultada()?.estado === 'dato_no_escrito', t.slice(0, 120));

    // Sin dato: pide el dato para buscar (no pasa el caso).
    olvidarTodo();
    h = herramientas('cuándo llega mi carga?', OTRO, base());
    t = await usar(h, 'ver_mi_carga');
    prueba('sin carga con su número y sin dato: pide la cotización o la marca para buscar', t.includes(T.MENSAJE_SIN_CARGA_PIDE_DATO) && /ver_mi_carga con ese dato/.test(t), t.slice(0, 200));
    prueba('…y ese texto no es un paso a asesor', !/asesor te escrib|lo revisa/i.test(T.MENSAJE_SIN_CARGA_PIDE_DATO));

    // Tope de datos por día.
    olvidarTodo();
    b = base();
    for (const d of ['9002', '9003', '9005']) await usar(herramientas(`la ${d}`, OTRO, b), 'ver_mi_carga', { dato: d });
    h = herramientas('la 9008', OTRO, b);
    t = await usar(h, 'ver_mi_carga', { dato: '9008' });
    prueba(`🔒 el ${ident.MAX_DATOS + 1}.º dato del día no se busca`, h.identidadConsultada()?.estado === 'limite' && t.includes(T.MENSAJE_DATO_NO_COINCIDE), h.identidadConsultada()?.estado);

    // MX-002026 = cotización 2026 hacia México (9006 en la base de mentira).
    olvidarTodo();
    b = base();
    let r = await duenoPorDato('5215501234506', { dato: 'MX-009006', mensaje: 'es la MX-009006', consultar: b.consultar });
    prueba('«MX-009006» sin marca registrada se lee como la cotización 9006 a México', r.estado === 'verificado' && r.idUsuario === 706, JSON.stringify(r));
    olvidarTodo();
    r = await duenoPorDato('5215501234506', { dato: 'EC-009006', mensaje: 'es la EC-009006', consultar: b.consultar });
    prueba('🔒 «EC-009006» no es la 9006 (va a México)', r.estado === 'pide_otro', JSON.stringify(r));

    // Cuenta del equipo: nunca es dueña.
    olvidarTodo();
    r = await duenoPorDato(OTRO, { dato: 'equipo@imporfactory.app', mensaje: 'equipo@imporfactory.app', consultar: b.consultar });
    prueba('🔒 el correo de una cuenta del equipo no da dueño', r.estado === 'pide_otro', JSON.stringify(r));

    // Base caída.
    olvidarTodo();
    r = await duenoPorDato(OTRO, { dato: '9001', mensaje: '9001', consultar: async () => { throw new Error('base caída'); } });
    prueba('base caída: error, sin tirar', r.estado === 'error');
  }

  console.log('\n3. En el turno (prepararTurno) y la memoria de 30 min');
  {
    olvidarTodo();
    olvidarTurnos?.();
    const real = buscadorDeArchivo();
    const b = base();
    const turno = (mensaje, tel, opciones = {}) =>
      prepararTurno({ mensaje, telefono: tel, tipo_mensaje: 'text', id_configuracion: 265, id_cliente: `${tel}-chat`, opciones, deps: { consultar: b.consultar, hoy: HOY, buscador: real } });
    let t = await turno('cuándo llega mi carga?', TEL_CARGA.sin_carga, { herramientas: true });
    prueba('con herramientas: el texto seguro pide el dato para buscar', t.hechos.textoSeguro === T.MENSAJE_SIN_CARGA_PIDE_DATO, t.hechos.textoSeguro);
    olvidarTurnos?.();
    t = await turno('cuándo llega mi carga?', TEL_CARGA.sin_carga);
    prueba('sin herramientas: queda como antes', t.hechos.textoSeguro === T.MENSAJE_SIN_CARGA, t.hechos.textoSeguro);

    // Se probó la cuenta con el dato: el turno siguiente ya trae su carga.
    olvidarTodo();
    olvidarTurnos?.();
    await usar(herramientas('mi marca es EC-9001001', SEGUNDO_DE_ANA, b), 'ver_mi_carga', { dato: 'EC-9001001' });
    t = await turno('y cuándo llega?', SEGUNDO_DE_ANA, { herramientas: true });
    prueba('dueño ya probado: el turno siguiente lee la carga de su cuenta', t.hechos.carga?.por === 'dato' && t.hechos.carga?.estado === 'encontradas', `${t.hechos.carga?.estado} ${t.hechos.carga?.por}`);
  }

  console.log('\n4. ver_mis_pagos con el dato');
  {
    olvidarTodo();
    let b = base();
    let h = herramientas('cuánto debo?', OTRO, b);
    let t = await usar(h, 'ver_mis_pagos');
    prueba('sin cartera con su número: pide el dato y no pasa el caso', /ver_mis_pagos con ese dato/.test(t) && /No pases el caso/.test(t), t.slice(0, 200));

    await usar(herramientas('mi cotización es 9001', OTRO, b), 'ver_mis_pagos', { dato: '9001' });
    h = herramientas('ana.ejemplo@gmail.com', OTRO, b);
    t = await usar(h, 'ver_mis_pagos', { dato: 'ana.ejemplo@gmail.com' });
    prueba('cotización + correo de la misma cuenta: muestra sus cuotas', /250/.test(t) && h.pagosConsultados()?.por === 'dato', t.slice(0, 200));
    prueba('🔒 sin las cuotas de otra persona', !/900/.test(t));

    olvidarTodo();
    b = base();
    h = herramientas('mi correo es bruno.ejemplo@gmail.com', OTRO, b);
    t = await usar(h, 'ver_mis_pagos', { dato: 'bruno.ejemplo@gmail.com' });
    prueba('solo el correo, desde un número que no es suyo: pide la cotización o la marca', t.includes(T.MENSAJE_DATO_PIDE_CODIGO) && !/900/.test(t), t.slice(0, 160));

    // Guardia: si rechaza al modelo, el texto seguro pide el otro dato (no «un asesor»).
    const hechos = { textoSeguro: T.MENSAJE_ASESOR, respaldo: { firme: '', estado: '' } };
    sumarHechosHerramientas(hechos, [t], null, { mensaje: 'mi correo es bruno.ejemplo@gmail.com', identidad: h.identidadConsultada() });
    prueba('guardia: el texto seguro pide el otro dato', hechos.textoSeguro === T.MENSAJE_DATO_PIDE_CODIGO, hechos.textoSeguro);
  }

  console.log('\n5. IMPORCHAT con la cuenta suspendida (caso 153)');
  {
    const { TEL, AHORA, escenario, baseFalsa, PERMITIDO, conexion } = imporchat;
    const conCuenta = (estado, cambios = {}) => {
      const b = baseFalsa(escenario(cambios));
      return async (sql, rep) => {
        if (/SELECT estado, permanente FROM usuarios_chat_center/.test(sql)) return [{ estado, permanente: 0 }];
        return b.consultar(sql, rep);
      };
    };
    const diag = (estado, extra = {}) =>
      diagnosticarCuenta(TEL, { consultar: conCuenta(estado, extra.cambios), verificarAcceso: PERMITIDO, ahora: AHORA, propia: 265, ...extra.o });
    let r = await diag('suspendido', { cambios: { conexiones: [conexion({ suspendido: 1 })], actividad: [] } });
    prueba('suspendida: lo dice', /está suspendida/.test(r.texto) && r.cuenta === 'cuenta_suspendido', r.texto);
    prueba('…y no dice «no tienes ningún número conectado»', !r.texto.includes(T.DIAGNOSTICO.sin_conexion.texto) && !/conect/i.test(r.texto), r.texto);
    prueba('…menciona el pago pendiente y cobranza', r.texto.includes(T.DIAGNOSTICO_FRASES.cuenta_por_pago) && r.texto.includes(T.DIAGNOSTICO_FRASES.cuenta_cierre));
    r = await diag('suspendido', { o: { saldoPendiente: async () => 'tu saldo pendiente es 250,00 USD.' } });
    prueba('con ver_mis_pagos: suma su saldo', r.texto.includes('En tu cartera, tu saldo pendiente es 250,00 USD.'), r.texto);
    r = await diag('suspendido', { o: { saldoPendiente: async () => { throw new Error('caída'); } } });
    prueba('si la cartera falla, igual dice que está suspendida', /está suspendida/.test(r.texto) && !/cartera/i.test(r.texto));
    r = await diag('cancelado');
    prueba('cancelada: lo dice, sin hablar de pagos', /está cancelada/.test(r.texto) && !r.texto.includes(T.DIAGNOSTICO_FRASES.cuenta_por_pago));
    r = await diag('activo');
    prueba('activa: sigue la revisión de siempre', !r.cuenta, r.cuenta);
    r = await diagnosticarCuenta(TEL, {
      consultar: async (sql, rep) =>
        /SELECT estado, permanente FROM usuarios_chat_center/.test(sql)
          ? [{ estado: 'suspendido', permanente: 1 }]
          : baseFalsa(escenario()).consultar(sql, rep),
      verificarAcceso: PERMITIDO, ahora: AHORA, propia: 265,
    });
    prueba('permanente: nunca se trata como suspendida', !r.cuenta);

    // Todas sus conexiones suspendidas por bajar de plan.
    const b = baseFalsa(escenario({ conexiones: [conexion({ suspendido: 1, suspended_reason: 'downgrade' }), conexion({ id: 102, suspendido: 1, suspended_reason: 'downgrade' })], actividad: [] }));
    r = await diagnosticarCuenta(TEL, { consultar: b.consultar, verificarAcceso: PERMITIDO, ahora: AHORA, propia: 265 });
    prueba('conexiones suspendidas por el plan: lo dice y no «no tienes número»', r.texto.includes(T.DIAGNOSTICO.conexiones_suspendidas_plan.texto) && !r.texto.includes(T.DIAGNOSTICO.sin_conexion.texto), r.texto);
    const b2 = baseFalsa(escenario({ conexiones: [conexion({ suspendido: 1, suspended_reason: 'panel' })], actividad: [] }));
    r = await diagnosticarCuenta(TEL, { consultar: b2.consultar, verificarAcceso: PERMITIDO, ahora: AHORA, propia: 265 });
    prueba('eliminada por el usuario: sigue siendo «no tienes número conectado»', r.texto.includes(T.DIAGNOSTICO.sin_conexion.texto));

    // Por la herramienta, con pagos: el saldo sale de la cartera de su número.
    olvidarTodo();
    const pagosDe = async (sql, rep) => {
      if (/FROM plataformas p[\s\S]*INNER JOIN users u/.test(sql)) return [{ id_users: 701, whatsapp: TEL, email: 'ana.ejemplo@gmail.com', nombre: 'Ana' }];
      if (/FROM carteras/.test(sql)) return CUOTAS.filter((c) => rep[0].includes(c.id_users));
      return [];
    };
    const h = crearHerramientas({
      telefono: TEL, mensaje: 'mi bot no responde', canalVerificable: true, diagnostico: true, pagos: true, idConfiguracionPropia: 265,
      deps: { consultar: pagosDe, consultarImporchat: conCuenta('suspendido'), verificarAcceso: PERMITIDO, ahora: AHORA },
    });
    const t = await usar(h, 'revisar_mi_imporchat');
    prueba('revisar_mi_imporchat suma el saldo de ver_mis_pagos', /suspendida/.test(t) && /En tu cartera, tu saldo pendiente es/.test(t) && /250/.test(t), t);
    prueba('…sin «Hola,» en medio del texto', !/cartera, hola/i.test(t));
    const hechos = { textoSeguro: T.MENSAJE_ASESOR, respaldo: { firme: '', estado: '' } };
    sumarHechosHerramientas(hechos, [t], null, { mensaje: 'mi bot no responde', diagnostico: h.diagnosticoConsultado(), pagos: h.pagosConsultados() });
    prueba('guardia: el texto seguro es el diagnóstico con el saldo', hechos.textoSeguro === t);
  }

  console.log('\n6. Novedad del caso (201, 203)');
  {
    const AHORA = '2026-10-26';
    const fila = (o) => ({ id: 1, descripcion: '', autor_nombre: 'Laura', cuando: `${AHORA} 10:00:00`, tipo: null, escalado_resuelto: 0, estado_caso: null,
      resolucion_comentario: null, resolucion_cuando: null, espera_comentario: null, espera_cuando: null, ...o });
    const msg = (o) => ({ texto_mensaje: 'Hola', responsable: 'Laura', cuando: '2026-10-24 09:00:00', ...o });
    const baseNovedad = ({ incidencias = [], mensajes = [], sinCasos = false, falla = null } = {}) => {
      const sqls = [];
      return {
        sqls,
        consultar: async (sql, rep) => {
          sqls.push({ sql, rep });
          if (falla) throw new Error(falla);
          if (/FROM incidencias_chat_center/.test(sql)) {
            if (sinCasos && /estado_caso/.test(sql)) throw new Error("Unknown column 'estado_caso' in 'field list'");
            return incidencias;
          }
          if (/FROM mensajes_clientes/.test(sql)) return mensajes;
          throw new Error(`consulta no prevista: ${sql.slice(0, 60)}`);
        },
      };
    };
    const BOT = fila({ id: 9, descripcion: 'Bot Expertos: pide logística. «hay novedad?»', autor_nombre: 'Bot Expertos', tipo: 'escalamiento', cuando: '2026-10-26 11:00:00' });

    // 201: la última es una nota interna de una persona.
    let b = baseNovedad({
      incidencias: [BOT, fila({ id: 8, descripcion: 'Laura: el proveedor reenvía la proforma el lunes; cliente molesto', cuando: '2026-10-25 16:00:00' })],
      mensajes: [msg({ texto_mensaje: 'Hola, ya estamos revisando tu caso', cuando: '2026-10-24 09:00:00' }), msg({ responsable: 'IA_265', texto_mensaje: 'Recibí tu mensaje.', cuando: '2026-10-26 11:00:00' })],
    });
    let r = await novedadDelCaso({ idCliente: 5001, idConfiguracion: 265, consultar: b.consultar });
    prueba('201: lee la nota interna más reciente', r.estado === 'leida' && r.items[0]?.tipo === 'nota', JSON.stringify(r.items));
    prueba('🔒 la fila del bot no es una novedad', !r.items.some((i) => /Bot Expertos/.test(i.texto)));
    prueba('🔒 el mensaje del bot (IA_) no cuenta como del equipo', !r.items.some((i) => i.texto === 'Recibí tu mensaje.'));
    prueba('texto seguro: hay novedad con su fecha, sin copiar la nota', r.texto.includes('25 de octubre') && !/proforma|molesto|Laura/.test(r.texto), r.texto);
    let bloque = bloqueNovedad(r);
    prueba('el bloque marca la nota como interna y pide no nombrar a nadie', /nota interna del equipo \(NO es para el cliente\)/.test(bloque) && /No nombres a nadie/.test(bloque));
    prueba('el caso abierto por el bot da el estado', /Estado del caso: abierto/.test(bloque), bloque.split('\n')[1]);
    prueba('solo lee este chat y esta cuenta', b.sqls.every((s) => (s.rep.cliente === 5001) || (s.rep.chat === '5001' && s.rep.cfg === 265)));
    prueba('🔒 solo SELECT', b.sqls.every((s) => /^\s*select/i.test(s.sql)));

    // 203: lo último es un mensaje que una persona le escribió.
    b = baseNovedad({ incidencias: [BOT], mensajes: [msg({ texto_mensaje: 'Tu reembolso se procesó, llega en 5 días hábiles.', cuando: '2026-10-26 12:00:00' })] });
    r = await novedadDelCaso({ idCliente: 5002, idConfiguracion: 265, consultar: b.consultar });
    prueba('203: cita lo último que le escribió el equipo, con fecha', r.texto === 'Lo último que te escribió el equipo fue el 26 de octubre: «Tu reembolso se procesó, llega en 5 días hábiles.». Si necesitas algo más sobre eso, cuéntame.', r.texto);

    // Nada de una persona: el texto fijo.
    b = baseNovedad({ incidencias: [BOT], mensajes: [msg({ responsable: 'cron_seguimiento', texto_mensaje: 'Recordatorio' }), msg({ texto_mensaje: 'Para confirmar tu pedido, ayúdame con tu nombre' })] });
    r = await novedadDelCaso({ idCliente: 5003, idConfiguracion: 265, consultar: b.consultar });
    prueba('sin nada de una persona: sin_novedad con el texto fijo', r.estado === 'sin_novedad' && r.texto === T.MENSAJE_SIN_NOVEDAD, `${r.estado} ${r.texto}`);
    prueba('…y el bloque manda responder ese texto', bloqueNovedad(r).includes(T.MENSAJE_SIN_NOVEDAD));

    // Caso resuelto.
    b = baseNovedad({ incidencias: [fila({ id: 3, autor_nombre: 'Bot Expertos', descripcion: 'Bot Expertos: pide cobranza.', tipo: 'escalamiento', escalado_resuelto: 1, estado_caso: 'resuelto', resolucion_cuando: '2026-10-25 18:00:00', cuando: '2026-10-24 08:00:00' })] });
    r = await novedadDelCaso({ idCliente: 5004, idConfiguracion: 265, consultar: b.consultar });
    prueba('caso resuelto sin notas: lo dice con la fecha', r.texto === 'Tu caso figura como resuelto desde el 25 de octubre. Si todavía te falta algo, cuéntame qué es.', r.texto);

    // Cuenta sin las migraciones de casos.
    b = baseNovedad({ sinCasos: true, incidencias: [fila({ descripcion: 'Se llamó al cliente', cuando: '2026-10-25 09:00:00' })] });
    r = await novedadDelCaso({ idCliente: 5005, idConfiguracion: 265, consultar: b.consultar });
    prueba('sin columnas de casos: lee la bitácora igual', r.estado === 'leida' && r.items[0]?.tipo === 'nota', r.estado);
    r = await novedadDelCaso({ idCliente: 5005, idConfiguracion: 265, consultar: baseNovedad({ falla: 'base caída' }).consultar });
    prueba('base caída: error y el bloque manda pasar el caso', r.estado === 'error' && /pasar_a_humano/.test(bloqueNovedad(r)));
    r = await novedadDelCaso({ idCliente: null, idConfiguracion: 265 });
    prueba('sin chat: no consulta nada', r.estado === 'sin_chat');

    // La herramienta y la guardia.
    b = baseNovedad({ mensajes: [msg({ texto_mensaje: 'Ya enviamos tu factura al correo.', cuando: '2026-10-26 12:00:00' })] });
    let h = crearHerramientas({ telefono: OTRO, mensaje: '¿hay alguna novedad de mi caso?', canalVerificable: true, novedad: true, idCliente: 5006, idConfiguracionPropia: 265, deps: { consultarImporchat: b.consultar } });
    prueba('con novedad e id del chat se ofrece ver_novedad_de_mi_caso', h.lista.some((x) => x.definicion.name === 'ver_novedad_de_mi_caso'));
    prueba('🔒 no recibe datos', JSON.stringify(h.lista.find((x) => x.definicion.name === 'ver_novedad_de_mi_caso').definicion.input_schema.properties) === '{}');
    const tn = await usar(h, 'ver_novedad_de_mi_caso');
    prueba('lee el chat que le pasa el motor', /Ya enviamos tu factura/.test(tn) && b.sqls.some((s) => s.rep.chat === '5006'));
    const hechos = { textoSeguro: T.MENSAJE_ASESOR, respaldo: { firme: '', estado: '' } };
    sumarHechosHerramientas(hechos, [tn], null, { mensaje: '¿hay alguna novedad de mi caso?', novedad: h.novedadConsultada() });
    prueba('guardia: el texto seguro es la novedad, no «un asesor»', hechos.textoSeguro === h.novedadConsultada().texto, hechos.textoSeguro);
    h = crearHerramientas({ telefono: OTRO, mensaje: 'hola', canalVerificable: true, novedad: true, idConfiguracionPropia: 265 });
    prueba('sin id del chat no se ofrece', !h.lista.some((x) => x.definicion.name === 'ver_novedad_de_mi_caso'));
    h = crearHerramientas({ telefono: OTRO, mensaje: 'hola', canalVerificable: true, idCliente: 5006, idConfiguracionPropia: 265 });
    prueba('sin la bandera no se ofrece', !h.lista.some((x) => x.definicion.name === 'ver_novedad_de_mi_caso'));

    for (const m of ['¿hay novedad de mi caso?', 'alguna noticia?', 'ya revisaron mi reclamo?', 'sigo esperando respuesta', 'cómo va mi caso'])
      prueba(`pideNovedad: «${m}»`, pideNovedad(m));
    for (const m of ['cuánto debo', 'quiero cotizar', 'hola buenas'])
      prueba(`pideNovedad no: «${m}»`, !pideNovedad(m));
  }

  console.log('\n7. Textos nuevos');
  {
    const VOSEO = /\b(Tocá|Tenés|Podés|Hacé|Mirá|Andá|Fijate|Dale|Entrá|Escribí|Elegí|Pegá|Usá|Revisá|Recargá|Subí|Creá|Encendé|Instalá|Querés|Sabés|vos)\b/;
    const nuevos = [
      ...Object.values(T.TEXTOS_DATO),
      T.DIAGNOSTICO_FRASES.cuenta_por_pago, T.DIAGNOSTICO_FRASES.cuenta_saldo, T.DIAGNOSTICO_FRASES.cuenta_cierre,
      T.DIAGNOSTICO.conexiones_suspendidas_plan.texto,
    ];
    prueba('tuteo, nunca voseo', nuevos.every((x) => !VOSEO.test(x)), nuevos.filter((x) => VOSEO.test(x)).join(' | '));
    prueba('🔒 ninguno trae un teléfono', nuevos.every((x) => !/\d{7,}/.test(x)));
    prueba('los que piden el segundo dato no son un paso a asesor', ![T.MENSAJE_DATO_PIDE_CORREO, T.MENSAJE_DATO_PIDE_CODIGO, T.MENSAJE_SIN_CARGA_PIDE_DATO].some((x) => /asesor/.test(x)));
  }

  console.log(`\n${fallos ? 'HAY FALLAS' : 'TODO BIEN'}: ${fallos ? `${fallos} fallan, ` : ''}${ok} pasan${fallos ? '' : ', 0 fallan'}`);
  process.exit(fallos ? 1 : 0);
})();
