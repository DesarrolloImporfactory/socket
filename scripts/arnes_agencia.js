/* Arnés del tablero "Agencia de Marketing" (utils/kanban_catalogo_agencia).

   Corre conversaciones completas columna por columna con los prompts del
   módulo (compilados como al aplicar la plantilla), el contexto real de la
   cfg 10 (calendario, sede) y la Responses API, siguiendo los tags igual que
   el motor. No escribe nada en la BD. Gasta la api key de la cfg 10.

   Uso: node scripts/arnes_agencia.js [escenario] [modo=solicitud|auto]  */
require('dotenv').config();
const { db } = require('../src/database/config');
const { ejecutarConResponsesAPI, limpiarTagsAcciones } = require('../src/services/kanban_ia.service');
const { construirContextoColumna } = require('../src/utils/contextoColumna');
const { sanitizarRespuestaAgente } = require('../src/utils/openia/sanitizador_agente');
const { limpiarColetillas } = require('../src/utils/limpiarColetillas');
const { limpiarMarkdown } = require('../src/utils/formatoWhatsapp');
const { leerApiKeyOpenAI } = require('../src/utils/openia/apiKeyOpenAI');
const { compilarPromptFinal } = require('../src/utils/promptCompiler');
const { COLUMNAS_AGENCIA } = require('../src/utils/kanban_catalogo_agencia.data');

const SOLO = process.argv[2] && process.argv[2] !== 'todos' ? process.argv[2] : null;
const MODO = process.argv[3] === 'auto' ? 'auto' : 'solicitud';
const CFG = 10;

const porEstado = new Map(COLUMNAS_AGENCIA.map((c) => [c.estado_db, c]));
const RE_FICHA = /🔖\s*Segmento:/;
const RE_BLOQUE = /🕒\s*Fecha y hora:\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
const RE_PRECIO = /\$\s?\d/;

/* Cada turno: { estado (donde respondió), texto, crudo, tags, destino } */
const ESCENARIOS = [
  {
    nombre: 'precio_directo_y_diagnostico_completo',
    mensajes: [
      'hola cuanto cobran por manejar redes?',
      'tengo una tienda de ropa femenina, vendo por instagram @moda.andrea',
      'ya vendo, pero quiero vender mas',
      'pauta en meta mas que nada',
      'unos 600 al mes',
      'este mes',
      'yo sola',
    ],
    checks: (t) => [
      !t.some((x) => x.estado === 'diagnostico') && 'nunca pasó a diagnóstico',
      t.some((x) => RE_PRECIO.test(x.texto) && x.estado !== 'diagnostico') && 'dio un precio',
      !t.some((x) => RE_FICHA.test(x.crudo)) && 'nunca escribió la ficha',
      !t.some((x) => x.destino === 'agendar') && 'nunca pasó a agendar',
      t.filter((x) => /\?/.test(x.texto) && (x.texto.match(/\?/g) || []).length > 2).length && 'hizo varias preguntas en un mensaje',
    ],
  },
  {
    nombre: 'pide_reunion_directo_y_agenda',
    mensajes: [
      'hola, tengo una clinica dental y quiero una reunion para ver lo de publicidad',
      'virtual',
      'la primera opcion',
      'Carlos Mena, 0991234567, carlos@clinicamena.com',
    ],
    checks: (t) => [
      !t.some((x) => x.destino === 'agendar') && 'no pasó a agendar pese a pedir reunión',
      !t.some((x) => RE_BLOQUE.test(x.crudo)) && 'nunca escribió el bloque de reunión',
      !t.some((x) => /Correo:\s*carlos@clinicamena\.com/i.test(x.crudo)) && 'bloque sin el correo',
      !t.some((x) => /\(virtual\)/i.test(x.crudo)) && 'bloque sin modalidad virtual',
      MODO === 'solicitud' && t.some((x) => /qued[oó] agendad|nos vemos el/i.test(x.texto) && x.estado === 'agendar' && RE_BLOQUE.test(x.crudo)) &&
        'en modo solicitud dio la reunión por confirmada',
    ],
  },
  {
    nombre: 'curioso_para_mas_adelante',
    mensajes: [
      'hola quiero info de sus servicios',
      'todavia no tengo negocio, es una idea de vender postres',
      'no se, la idea es arrancar el otro año, ahorita solo averiguo precios',
    ],
    checks: (t) => [
      t.some((x) => x.destino === 'agendar') && 'mandó a agendar a un curioso sin negocio',
      !t.some((x) => x.destino === 'madurar') && 'no lo mandó a madurar',
    ],
  },
  {
    nombre: 'busca_empleo',
    mensajes: ['buenas, soy community manager y quisiera saber si tienen vacantes'],
    checks: ([t]) => [t.destino !== 'no_aplica' && `fue a ${t.destino || 'ninguna'}, debía ir a no_aplica`],
  },
  {
    nombre: 'cliente_actual',
    mensajes: ['hola, soy cliente de ustedes, necesito el reporte de la campaña de septiembre'],
    checks: ([t]) => [t.destino !== 'asesor' && `fue a ${t.destino || 'ninguna'}, debía ir a asesor`],
  },
  {
    nombre: 'solo_saluda',
    mensajes: ['hola'],
    checks: ([t]) => [t.tags.length && `clasificó un saludo (${t.tags})`],
  },
  {
    nombre: 'promete_resultados',
    mensajes: [
      'tengo un restaurante en quito, si les contrato cuantas ventas me garantizan? y cuanto cuesta el paquete basico?',
    ],
    checks: (t) => [
      t.some((x) => /garantiz(amos|o)|duplica|triplica|\d+\s*%/i.test(x.texto) && !/no (podemos|puedo) garantizar|no garantiz/i.test(x.texto)) &&
        'prometió resultados',
      t.some((x) => RE_PRECIO.test(x.texto)) && 'dio un precio',
    ],
  },
  {
    nombre: 'todo_en_un_mensaje',
    mensajes: [
      'Hola! tengo una ferreteria en Guayaquil, ya vendemos en local y queremos vender online con pauta en google y meta, tenemos unos 1500 al mes para invertir, queremos empezar este mes y decido yo como gerente',
    ],
    checks: (t) => [
      !t.some((x) => x.destino === 'agendar' || x.destino === 'diagnostico') && 'no avanzó un lead completo',
    ],
  },
  {
    nombre: 'insiste_precio_en_diagnostico',
    mensajes: [
      'hola quiero que me manejen el instagram de mi gimnasio',
      'pero dime el precio primero, no quiero perder tiempo',
      'ok, el gimnasio ya funciona hace 2 años en Quito',
    ],
    checks: (t) => [
      t.some((x) => RE_PRECIO.test(x.texto)) && 'inventó un precio',
      t.some((x) => /\b(no s[eé]|no puedo ayudarte)\b/i.test(x.texto)) && 'respondió "no sé"',
    ],
  },
  {
    nombre: 'agendar_pide_cotizacion_por_chat',
    desde: 'agendar',
    mensajes: [
      'mejor mandame la cotizacion por aqui, no tengo tiempo para reuniones',
      'bueno ok, virtual entonces',
    ],
    checks: (t) => [
      t.some((x) => RE_PRECIO.test(x.texto)) && 'mandó precios en vez de agendar',
      !t.some((x) => /\b\d{1,2}(:\d{2})?\b/.test(x.texto)) && 'no propuso horarios concretos',
    ],
  },
  {
    nombre: 'presencial',
    desde: 'agendar',
    mensajes: [
      'prefiero ir a su oficina',
      'el primero que me dijiste',
      'Lucia Torres, 0987654321',
    ],
    checks: (t) => [
      !t.some((x) => /\(presencial\)/i.test(x.crudo)) && 'bloque sin modalidad presencial',
      t.some((x) => RE_BLOQUE.test(x.crudo) && /Correo:/.test(x.crudo) && !/@/.test(x.crudo.match(/Correo:.*$/m)?.[0] || '')) &&
        'puso una línea Correo vacía o inventada',
    ],
  },
  {
    nombre: 'no_asistio_reagenda',
    desde: 'no_asistio',
    mensajes: ['perdon no pude conectarme a la reunion de ayer, se me complico'],
    checks: ([t]) => [
      /te estuvimos esperando|no te conectaste/i.test(t.texto) && 'reprochó',
      !/\b\d{1,2}(:\d{2})\b/.test(t.texto) && 'no propuso horarios nuevos',
    ],
  },
  {
    nombre: 'asistio_quiere_propuesta',
    desde: 'asistio',
    mensajes: ['hola, me gustó mucho la reunión, cuando me mandan la propuesta?'],
    checks: ([t]) => [t.destino !== 'propuesta' && `fue a ${t.destino || 'ninguna'}, debía ir a propuesta`],
  },
  {
    nombre: 'asistio_eligio_otra',
    desde: 'asistio',
    mensajes: ['gracias por la reunion pero al final contratamos otra agencia'],
    checks: ([t]) => [t.destino !== 'perdidos' && `fue a ${t.destino || 'ninguna'}, debía ir a perdidos`],
  },
  {
    nombre: 'madurar_vuelve_listo',
    desde: 'madurar',
    mensajes: ['hola! ya abrimos el local y ahora si queremos empezar con publicidad, podemos reunirnos?'],
    checks: ([t]) => [t.destino !== 'agendar' && `fue a ${t.destino || 'ninguna'}, debía ir a agendar`],
  },
  {
    nombre: 'seguimiento_ok',
    desde: 'remarketing',
    mensajes: ['ok'],
    checks: ([t]) => [t.destino === 'perdidos' && 'tomó un "ok" como rechazo'],
  },
  {
    nombre: 'seguimiento_rechazo',
    desde: 'remarketing',
    mensajes: ['ya no me escriban por favor, no me interesa'],
    checks: ([t]) => [t.destino !== 'perdidos' && `fue a ${t.destino || 'ninguna'}, debía ir a perdidos`],
  },
  {
    nombre: 'audio_ilegible',
    mensajes: ['[El cliente envió un audio que no se pudo transcribir]'],
    checks: ([t]) => [t.destino === 'diagnostico' && 'clasificó un audio que no entendió'],
  },
  {
    nombre: 'ofrece_servicio_a_la_agencia',
    mensajes: ['buenas, somos una empresa de software de CRM y queremos ofrecerles nuestro sistema para su agencia'],
    checks: ([t]) => [t.destino !== 'no_aplica' && `fue a ${t.destino || 'ninguna'}, debía ir a no_aplica`],
  },
];

function checksGlobales(t) {
  const e = [];
  t.forEach((x, i) => {
    if (/\*\*|^#{1,6}\s/m.test(x.crudo)) e.push(`turno ${i + 1}: markdown`);
    if (/\[[a-z_]+\]:\s*true/i.test(x.texto)) e.push(`turno ${i + 1}: tag visible`);
    if (/\(pendiente\)|<[a-z ]+>/i.test(x.crudo)) e.push(`turno ${i + 1}: placeholder en ficha/bloque`);
    if (/no dudes|quedo atent|estoy aqu[ií] para/i.test(x.texto)) e.push(`turno ${i + 1}: coletilla`);
    if (['contacto_inicial', 'diagnostico'].includes(x.estado) && /\b\d{1,2}:\d{2}\b/.test(x.texto))
      e.push(`turno ${i + 1}: propuso horarios sin tener el calendario (${x.estado})`);
  });
  return e;
}

(async () => {
  const [c] = await db.query(`SELECT api_key_openai FROM configuraciones WHERE id = ?`, {
    replacements: [CFG],
    type: db.QueryTypes.SELECT,
  });
  const api_key_openai = leerApiKeyOpenAI(c?.api_key_openai);
  const perso = { nombre_tienda: 'Impulso Digital', nombre_asistente_publico: 'Sofía' };

  let fallas = 0;
  for (const esc of ESCENARIOS) {
    if (SOLO && esc.nombre !== SOLO) continue;
    process.stdout.write(`▶ ${esc.nombre} `);
    let estado = esc.desde || 'contacto_inicial';
    let prev = null;
    const historial = [];
    const turnos = [];
    try {
      for (const mensaje of esc.mensajes) {
        const col = porEstado.get(estado);
        if (!col?.activa_ia) {
          turnos.push({ estado, texto: '(columna sin IA)', crudo: '', tags: [], destino: null });
          break;
        }
        // Las acciones en el modo pedido (como si el switch de cuenta estuviera así).
        const acciones = col.acciones.map((a) =>
          a.tipo_accion === 'agendar_cita'
            ? { ...a, config: JSON.stringify({ ...a.config, modo: MODO }) }
            : { ...a, config: JSON.stringify(a.config) },
        );
        const contexto = await construirContextoColumna(CFG, acciones, null, {
          mensaje,
          id_cliente: 0,
          historial: [{ rol_mensaje: 0, texto_mensaje: mensaje }, ...historial],
        });
        const input = String(contexto || '').trim()
          ? `🧾 Contexto adicional:\n\n${contexto.trim()}\n\n💬 MENSAJE ACTUAL DEL CLIENTE (responde a ESTO):\n${mensaje}`
          : mensaje;
        const r = await ejecutarConResponsesAPI({
          previous_response_id: prev,
          instructions: compilarPromptFinal(col.instrucciones, perso),
          additional_instructions: null,
          input,
          model: col.modelo,
          max_tokens: col.max_tokens,
          vector_store_id: null,
          api_key_openai,
          id_configuracion: CFG,
        });
        prev = r.response_id || prev;
        const crudo = sanitizarRespuestaAgente(r.respuesta || '');
        const triggers = col.acciones
          .filter((a) => a.tipo_accion === 'cambiar_estado' || a.tipo_accion === 'agendar_cita')
          .map((a) => a.config);
        const tags = [...new Set(triggers.map((t) => t.trigger).filter((tg) => crudo.toLowerCase().includes(tg)))];
        let destino = null;
        if (tags.includes('[cita_confirmada]:true') && RE_BLOQUE.test(crudo)) {
          destino = MODO === 'solicitud' ? 'por_agendar' : 'cita_agendada';
        } else {
          const t = triggers.find((x) => x.estado_destino && tags.includes(x.trigger));
          destino = t?.estado_destino || null;
        }
        const texto = limpiarMarkdown(limpiarColetillas(limpiarTagsAcciones(crudo)));
        turnos.push({ estado, texto, crudo, tags, destino });
        historial.unshift({ rol_mensaje: 0, texto_mensaje: mensaje });
        historial.unshift({ rol_mensaje: 1, texto_mensaje: texto });
        if (destino) estado = destino;
        process.stdout.write('.');
      }
    } catch (err) {
      console.log(` ✖ error: ${err.response?.data?.error?.message || err.message}`);
      fallas += 1;
      continue;
    }
    const f = [...esc.checks(turnos), ...checksGlobales(turnos)].filter(Boolean);
    console.log(f.length ? ` ✖ ${f.length}` : ' ✔');
    f.forEach((x) => console.log(`     - ${x}`));
    fallas += f.length;
    if (f.length || SOLO) {
      turnos.forEach((x, i) => {
        console.log(`   [cliente] ${esc.mensajes[i]}`);
        console.log(`   [${x.estado}${x.destino ? ' → ' + x.destino : ''}] ${x.texto.replace(/\n/g, '\n      ')}`);
        if (process.env.CRUDO && x.tags.length) console.log(`   CRUDO=${JSON.stringify(x.crudo)}`);
      });
    }
  }
  console.log(fallas ? `\n❌ ${fallas} fallas` : '\n✅ TODOS LOS ESCENARIOS PASAN');
  await db.close();
  process.exit(fallas ? 1 : 0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
