/* Ficha del pedido: lo que el CLIENTE ya dijo, leído por el sistema.
 *
 * EL PROBLEMA
 * El modelo (gpt-4o-mini) pierde el hilo de los datos que el cliente ya dio.
 * Casos reales del 19 y 20 de agosto de 2026:
 *
 *  - Cfg 360 (Delfin, retiro en agencia): el bot pidió "dirección exacta (2
 *    calles + referencia)" SIETE veces a alguien que retiraba en Servientrega,
 *    y cuando por fin cerró, el resumen traía solo Producto/Precio/Envío —sin
 *    la línea Nombre ni Teléfono, que el cliente ya había escrito—. El
 *    validador bloqueó el cierre y la petición de datos le volvió a pedir al
 *    cliente lo que ya había dado. Tres veces. Terminó en asesor.
 *  - Cfg 302 (Josué): el cliente dio "Josué yumbulema" y el resumen decía
 *    "Nombre: Josué". Además el modelo dio la venta por cerrada sin escribir
 *    el tag, así que el chat nunca se movió y repitió el "resumen final"
 *    cuatro veces.
 *
 * El prompt de cada cuenta no se toca: esto es una red del código, igual para
 * todas. La ficha se arma desde mensajes_clientes —que es donde de verdad
 * vive la conversación— y sirve para tres cosas:
 *
 *  1. CONTEXTO DEL TURNO: se le dicta al modelo qué datos YA tiene (no se
 *     vuelven a pedir ni a confirmar), qué falta (se pide SOLO eso) y, si no
 *     falta nada, que su mensaje ES el cierre con el tag.
 *  2. COMPLETAR EL RESUMEN: si el cierre trae un dato ausente, de relleno o a
 *     medias ("Nombre: Josué") y la ficha lo tiene, el código completa la
 *     línea antes de validar. El cierre pasa, la orden sale con los datos
 *     correctos y al cliente no se le pide nada que ya dio. La petición de
 *     datos queda para lo que de verdad NO está en la conversación.
 *  3. RESCATE: detectar que el turno anterior "narró" el cierre sin el tag.
 *
 * ANTI-INVENTO
 * El extractor corre con la regla "solo lo que escribió el CLIENTE", y encima
 * cada valor se verifica LITERALMENTE contra los mensajes del cliente: un
 * nombre, teléfono, ciudad o dirección que no aparezca en sus palabras se
 * descarta. La provincia es la única excepción (se deduce de la ciudad, es
 * geografía). Una ubicación GPS compartida se geocodifica y cuenta como texto
 * del cliente, igual que hace el auto-orden.
 *
 * COSTO
 * Una llamada corta a gpt-4o-mini (≈1.5–3k tokens, temperatura 0) por turno
 * en la fase de datos, frente a los 20–40k del turno principal. Se cachea por
 * cliente mientras no haya mensajes nuevos del cliente. */

const axios = require('axios');
const { db } = require('../database/config');
const { parseUbicacionJson, geocodificarMensaje } = require('./geoUbicacion');

const CACHE = new Map(); // id_cliente → { firma, ficha, ts }
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRADAS = 5000;

const PAIS_POR_PREFIJO = {
  593: 'Ecuador',
  57: 'Colombia',
  52: 'México',
  51: 'Perú',
  56: 'Chile',
  502: 'Guatemala',
  507: 'Panamá',
  54: 'Argentina',
};
const PAIS_POR_ISO = {
  EC: 'Ecuador',
  CO: 'Colombia',
  MX: 'México',
  PE: 'Perú',
  CL: 'Chile',
  GT: 'Guatemala',
  PA: 'Panamá',
  AR: 'Argentina',
};

function nombrePaisDe({ pais_plantilla, telefono }) {
  const iso = String(pais_plantilla || '')
    .trim()
    .toUpperCase();
  if (PAIS_POR_ISO[iso]) return PAIS_POR_ISO[iso];
  const d = String(telefono || '').replace(/\D/g, '');
  for (const p of ['593', '502', '507', '57', '52', '51', '56', '54']) {
    if (d.startsWith(p)) return PAIS_POR_PREFIJO[p];
  }
  return 'Ecuador';
}

const normalizar = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/* ¿El valor aparece en lo que escribió el cliente? Se exige que TODAS las
   palabras de 3+ letras del valor estén en sus mensajes (sin tildes ni
   mayúsculas). Para el teléfono se comparan los últimos 9 dígitos. */
function aparecioEnCliente(valor, textoCliente, { esTelefono = false } = {}) {
  if (!valor) return false;
  if (esTelefono) {
    const d = String(valor).replace(/\D/g, '');
    if (d.length < 9) return false;
    return String(textoCliente).replace(/\D/g, '').includes(d.slice(-9));
  }
  const base = normalizar(textoCliente);
  const palabras = normalizar(valor)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length >= 3);
  if (!palabras.length) return false;
  return palabras.every((w) => base.includes(w));
}

function limpiarTexto(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') v = String(v);
  const t = v.replace(/[*_]/g, '').trim();
  return /^(null|n\/a|s\/d|ninguno|ninguna|no|-|—)$/i.test(t) ? '' : t;
}

/* Transcript de la conversación: los últimos mensajes con texto, del más viejo
   al más nuevo, rotulados CLIENTE / ASISTENTE (la IA) / VENDEDOR (una persona
   del negocio). La ubicación GPS se traduce con la geocodificación cacheada. */
async function cargarTranscript(id_configuracion, id_cliente, limite = 30) {
  /* Solo la conversación ACTUAL: desde el último "reiniciar conversación"
     (mismo corte que usa el recap) y, en todo caso, de las últimas 72 horas.
     Sin el corte, un cliente que vuelve a comprar heredaría en la ficha la
     dirección de su pedido anterior como si la acabara de dar. */
  let desdeReinicio = null;
  try {
    const [cli] = await db.query(
      `SELECT reinicio_conversacion_at FROM clientes_chat_center
        WHERE id = ? LIMIT 1`,
      { replacements: [id_cliente], type: db.QueryTypes.SELECT },
    );
    desdeReinicio = cli?.reinicio_conversacion_at || null;
  } catch (_) {}

  const msgs = await db.query(
    `SELECT id, rol_mensaje, tipo_mensaje, texto_mensaje, responsable
       FROM mensajes_clientes
      WHERE celular_recibe = ? AND id_configuracion = ?
        AND deleted_at IS NULL
        AND created_at >= NOW() - INTERVAL 72 HOUR
        ${desdeReinicio ? 'AND created_at > ?' : ''}
      ORDER BY id DESC LIMIT ?`,
    {
      replacements: desdeReinicio
        ? [String(id_cliente), id_configuracion, desdeReinicio, limite]
        : [String(id_cliente), id_configuracion, limite],
      type: db.QueryTypes.SELECT,
    },
  );
  msgs.reverse();

  const lineas = [];
  const items = []; // [{ rol: 'CLIENTE'|'ASISTENTE'|'VENDEDOR', texto }] en orden
  const textosCliente = [];
  const idsCliente = [];
  for (const m of msgs) {
    let texto = String(m.texto_mensaje || '').trim();
    if (!texto) continue;
    const esCliente = String(m.rol_mensaje) === '0';
    if (esCliente && parseUbicacionJson(texto)) {
      const geo = await geocodificarMensaje(texto).catch(() => null);
      texto = geo
        ? `[UBICACIÓN GPS COMPARTIDA] Dirección: ${
            geo.direccion || 'sin calle identificable'
          } | Ciudad: ${geo.ciudad || 's/d'} | Provincia: ${
            geo.provincia || 's/d'
          }`
        : '[UBICACIÓN GPS COMPARTIDA]';
    }
    if (esCliente) {
      idsCliente.push(m.id);
      textosCliente.push(texto);
      items.push({ rol: 'CLIENTE', texto });
      lineas.push(`CLIENTE: ${texto.slice(0, 500)}`);
    } else if (/^IA_/i.test(String(m.responsable || ''))) {
      items.push({ rol: 'ASISTENTE', texto });
      lineas.push(`ASISTENTE: ${texto.slice(0, 300)}`);
    } else {
      items.push({ rol: 'VENDEDOR', texto });
      lineas.push(`VENDEDOR (persona): ${texto.slice(0, 300)}`);
    }
  }
  return {
    transcript: lineas.join('\n').slice(-9000),
    textoCliente: textosCliente.join('\n'),
    items,
    firma: `${idsCliente.length}:${idsCliente[idsCliente.length - 1] || 0}`,
    nCliente: idsCliente.length,
  };
}

/* El apellido que llegó en un mensaje aparte. Caso 610/302 (prueba del
   2026-08-20): "Josué" → el bot pide el apellido → "Yumbulema, mi teléfono es
   0995438411", y el extractor dejó "Josué" solo. Si el asistente pidió el
   apellido y el cliente respondió con una o dos palabras (sin dígitos), eso
   ES el apellido. Determinista, para no depender del humor del extractor. */
function completarApellido(nombre, items = []) {
  const n = String(nombre || '').trim();
  if (!n || nombreCompleto(n)) return n;
  for (let i = 0; i < items.length - 1; i += 1) {
    if (items[i].rol !== 'ASISTENTE' || !/apellido/i.test(items[i].texto)) continue;
    const sig = items.slice(i + 1).find((it) => it.rol === 'CLIENTE');
    if (!sig) continue;
    const txt = sig.texto
      .replace(/^(?:mi\s+apellido\s+es|apellido\s*:?|es|soy)\s+/i, '')
      .trim();
    const m = txt.match(/^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}(?:\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,})?)(?=$|[\s,.;:!?]|\s+(?:mi|y|tel|cel|celular|n[uú]mero))/);
    if (!m) continue;
    const apellido = m[1].trim();
    if (normalizar(apellido) === normalizar(n)) continue;
    if (/^(?:hola|gracias|listo|si|sí|ok|dale|bueno|claro|quito|domicilio|agencia|servientrega|uno|una|dos|tres)$/i.test(apellido)) continue;
    return `${n} ${apellido}`;
  }
  return n;
}

function purgarCache(ahora) {
  if (CACHE.size <= MAX_ENTRADAS) return;
  for (const [k, v] of CACHE) if (ahora - v.ts >= TTL_MS) CACHE.delete(k);
}

/**
 * Extrae la ficha del pedido. Devuelve null si no hay nada que extraer.
 *
 * @returns {Promise<null|{
 *   nombre:string, telefono:string, ciudad:string, provincia:string,
 *   direccion:string, referencia:string, entrega:''|'domicilio'|'agencia',
 *   agencia:string, producto:string, cantidad:string, variedad:string,
 *   confirmo_pedido:boolean, _firma:string }>}
 */
async function extraerFichaPedido({
  id_configuracion,
  id_cliente,
  api_key_openai,
  paisNombre = 'Ecuador',
  log = async () => {},
  /* Transcript armado por quien llama (simulador del wizard de producto: la
     conversación vive en memoria, no en mensajes_clientes). Mismo formato que
     devuelve cargarTranscript: { transcript, textoCliente, items, firma,
     nCliente }. Si no viene, se lee la BD como siempre. */
  transcriptExterno = null,
}) {
  if (!api_key_openai) return null;
  const ahora = Date.now();
  const { transcript, textoCliente, items, firma, nCliente } =
    transcriptExterno || (await cargarTranscript(id_configuracion, id_cliente));
  if (!nCliente) return null;

  const clave = String(id_cliente);
  const enCache = CACHE.get(clave);
  if (enCache && enCache.firma === firma && ahora - enCache.ts < TTL_MS) {
    return enCache.ficha;
  }

  let ia = {};
  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              `Lees una conversación de ventas por WhatsApp (pago contra entrega, ${paisNombre}) y extraes los datos del pedido que el CLIENTE ya dio. ` +
              'Responde SOLO un JSON con las claves: nombre, telefono, ciudad, provincia, direccion, referencia, entrega, agencia, producto, cantidad, variedad, confirmo_pedido. ' +
              'REGLA DE ORO: cada valor tiene que salir de un mensaje del CLIENTE, escrito por él. Lo que diga el ASISTENTE o el VENDEDOR no vale como dato del cliente (el vendedor a veces escribe la dirección de una agencia: eso NO es la dirección del cliente). Si el cliente no lo dijo, null. NO inventes ni completes. ' +
              'nombre = el nombre completo que el cliente dio para el pedido, UNIENDO nombre y apellido aunque los haya escrito en mensajes distintos (escribió "Josué" y después, cuando le pidieron el apellido, "Yumbulema" → "Josué Yumbulema"). Si solo dio el nombre de pila, solo ese; no le inventes apellido. ' +
              'telefono = el número que el cliente escribió como suyo (solo dígitos). ' +
              'ciudad = la ciudad o cantón que el cliente escribió. ' +
              `provincia = provincia/departamento/estado de ${paisNombre} al que pertenece esa ciudad; dedúcela de la ciudad (única excepción al "no inventes"); null si no hay ciudad. ` +
              'direccion = la dirección de entrega que el cliente escribió (calles, barrio, número); null si no dio. referencia = la referencia para llegar que dio (negocio cercano, color de casa); null si no dio. ' +
              'entrega = "agencia" si el cliente pidió retirar en una agencia/oficina (Servientrega, courier); "domicilio" si pidió que se lo lleven a su casa/dirección; null si no se sabe todavía. ' +
              'agencia = el nombre/ciudad de la agencia que el cliente nombró, si nombró una; null si no. ' +
              'producto = el producto que el cliente quiere, con el nombre que usa el ASISTENTE para ese producto (acá sí vale el asistente porque es el nombre del catálogo). cantidad = número de unidades que el cliente eligió ("uno", "solo uno", "una" = 1; "combo de dos", "el de 2", "dos unidades" = 2); null si no eligió. variedad = color/talla/modelo que el cliente eligió, si el producto lo pide; null si no. ' +
              'confirmo_pedido = true SOLO si el asistente ya le mostró un resumen del pedido y el cliente respondió afirmando que está correcto ("sí", "correcto", "así es", "listo", "dale", "está bien"); false en cualquier otro caso.',
          },
          { role: 'user', content: transcript },
        ],
      },
      { headers: { Authorization: `Bearer ${api_key_openai}` }, timeout: 15000 },
    );
    ia = JSON.parse(data?.choices?.[0]?.message?.content || '{}') || {};
  } catch (err) {
    await log(`⚠️ fichaPedido: extractor falló (${err?.message}); sin ficha`);
    return enCache?.ficha || null;
  }

  // Verificación literal: si no está en las palabras del cliente, no existe.
  const v = (k) => limpiarTexto(ia[k]);
  let nombre = aparecioEnCliente(v('nombre'), textoCliente) ? v('nombre') : '';
  // Nombre de pila + apellido que llegó en otro mensaje → nombre completo.
  nombre = completarApellido(nombre, items);
  /* "Confirmó el resumen" solo vale si el asistente mostró un resumen (línea
     Producto:) ANTES: un "sí, está correcto" suelto no es confirmación del
     pedido y no puede empujar el cierre. */
  const huboResumen = items.some(
    (it) => it.rol === 'ASISTENTE' && /(?:^|\n)[^\n]{0,6}?Producto\s*:/i.test(it.texto),
  );
  const telefono = aparecioEnCliente(v('telefono'), textoCliente, {
    esTelefono: true,
  })
    ? v('telefono').replace(/\D/g, '')
    : '';
  const ciudad = aparecioEnCliente(v('ciudad'), textoCliente) ? v('ciudad') : '';
  const direccion = aparecioEnCliente(v('direccion'), textoCliente)
    ? v('direccion')
    : '';
  const referencia = aparecioEnCliente(v('referencia'), textoCliente)
    ? v('referencia')
    : '';
  const agencia = aparecioEnCliente(v('agencia'), textoCliente)
    ? v('agencia')
    : '';
  const entregaRaw = normalizar(v('entrega'));
  const entrega = /agencia|oficina|servientrega|retir/.test(entregaRaw)
    ? 'agencia'
    : /domicilio|casa|direcc/.test(entregaRaw)
      ? 'domicilio'
      : '';
  const cantidadNum = parseInt(String(ia.cantidad ?? '').replace(/\D/g, ''), 10);

  const ficha = {
    nombre,
    telefono,
    ciudad,
    provincia: ciudad ? v('provincia') : '',
    direccion,
    referencia,
    entrega,
    agencia,
    producto: v('producto'),
    cantidad: Number.isFinite(cantidadNum) && cantidadNum > 0 ? String(cantidadNum) : '',
    variedad: aparecioEnCliente(v('variedad'), textoCliente) ? v('variedad') : '',
    confirmo_pedido: ia.confirmo_pedido === true && huboResumen,
    _firma: firma,
    /* Lo que escribió el CLIENTE, para el candado anti-invento del cierre: un
       dato del resumen (ciudad, teléfono) que no esté acá lo inventó el modelo. */
    _textoCliente: textoCliente,
  };

  CACHE.set(clave, { firma, ficha, ts: ahora });
  purgarCache(ahora);
  return ficha;
}

/* ¿Hay algo en la ficha? (para no inyectar un bloque vacío) */
function fichaTieneDatos(ficha) {
  if (!ficha) return false;
  return Boolean(
    ficha.nombre ||
      ficha.telefono ||
      ficha.ciudad ||
      ficha.direccion ||
      ficha.entrega ||
      ficha.agencia,
  );
}

const nombreCompleto = (n) => /\s/.test(String(n || '').trim());

/* "Agencia Servientrega <la que nombró>" sin duplicar la palabra cuando el
   cliente ya dijo "Servientrega del Coca"; sin agencia nombrada, "por
   confirmar" (el validador acepta ese valor en la línea de dirección). */
function etiquetaAgencia(f) {
  const ag = String((f && f.agencia) || '').trim();
  if (!ag) return 'Agencia Servientrega por confirmar';
  if (/^agencia/i.test(ag)) return ag;
  return /servientrega/i.test(ag) ? `Agencia ${ag}` : `Agencia Servientrega ${ag}`;
}

/* Qué falta según la ficha — EL MISMO criterio que camposFaltantesCierre del
   servicio (nombre con apellido; ciudad si no hay dirección ni agencia
   concreta; dirección o agencia). El teléfono no se exige: el auto-orden usa
   el número desde el que escribe. Si acá se exigiera algo que el validador no
   exige, el bot pediría datos que el cierre no necesita. */
function faltantesFicha(ficha) {
  const f = ficha || {};
  const faltan = [];
  if (!f.nombre) faltan.push('Nombre completo');
  else if (!nombreCompleto(f.nombre))
    faltan.push(`Apellido (solo dio el nombre "${f.nombre}")`);

  const agenciaOk = f.entrega === 'agencia';
  if (!f.ciudad && !f.direccion && !agenciaOk) faltan.push('Ciudad');
  if (!f.direccion && !agenciaOk) {
    faltan.push(
      f.entrega === 'domicilio'
        ? 'Dirección exacta (dos calles y una referencia)'
        : 'Dirección exacta (dos calles y una referencia), o si prefiere retirar en una agencia Servientrega',
    );
  }
  // Retiro en agencia sin ciudad: la ciudad es el único dato de destino.
  if (agenciaOk && !f.ciudad && !f.agencia) faltan.push('Ciudad (para la agencia)');
  return faltan;
}

/**
 * El bloque de contexto que se le inyecta al modelo en el turno.
 * @param {object} ficha
 * @param {{ trigger: string }} opts  el tag de cierre de la columna
 */
function bloqueFichaPedido(ficha, { trigger = '[generar_guia]:true' } = {}) {
  if (!fichaTieneDatos(ficha)) return '';
  const f = ficha;
  const lineas = [];
  if (f.nombre) {
    lineas.push(
      `✅ Nombre: ${f.nombre}` +
        (nombreCompleto(f.nombre)
          ? ''
          : ' (solo el nombre de pila: pide el APELLIDO, no el nombre otra vez)'),
    );
  }
  if (f.telefono) lineas.push(`✅ Teléfono: ${f.telefono}`);
  if (f.ciudad)
    lineas.push(`✅ Ciudad: ${f.ciudad}${f.provincia ? ` (${f.provincia})` : ''}`);
  if (f.entrega === 'agencia') {
    lineas.push(
      `✅ Entrega: RETIRO EN AGENCIA Servientrega${f.agencia ? ` (${f.agencia})` : f.ciudad ? ` (${f.ciudad})` : ''}. ` +
        `Para retiro en agencia NO existe dirección de domicilio: NO se la pidas, ni "dos calles", ni "referencia". ` +
        `En el resumen escribe la línea de dirección como "🏡 Direccion: ${etiquetaAgencia(f)} — ${f.ciudad || 'su ciudad'}" y "🚚 Envio: agencia servientrega".`,
    );
  } else if (f.entrega === 'domicilio') {
    lineas.push(`✅ Entrega: a domicilio`);
  }
  if (f.direccion)
    lineas.push(
      `✅ Dirección: ${f.direccion}${f.referencia ? ` — referencia: ${f.referencia}` : ''}`,
    );
  else if (f.referencia) lineas.push(`✅ Referencia: ${f.referencia}`);
  if (f.producto)
    lineas.push(
      `✅ Producto: ${f.producto}${f.cantidad ? ` x${f.cantidad}` : ''}${f.variedad ? ` (${f.variedad})` : ''}`,
    );
  else if (f.cantidad) lineas.push(`✅ Cantidad: ${f.cantidad}`);

  const faltan = faltantesFicha(f);

  let txt =
    `📋 FICHA DEL PEDIDO — lo que el cliente YA DIJO en esta conversación. La leyó el sistema de SUS mensajes y manda sobre tu memoria:\n` +
    lineas.join('\n') +
    '\n';
  if (faltan.length) {
    txt += `❌ FALTA: ${faltan.join(' · ')}\n`;
  } else {
    txt += `✔️ No falta ningún dato del pedido.\n`;
  }
  if (f.confirmo_pedido) {
    txt += `✔️ El cliente YA CONFIRMÓ que los datos están correctos.\n`;
  }
  txt +=
    `REGLAS DE LA FICHA:\n` +
    `- Lo marcado ✅ NO se vuelve a pedir, ni a confirmar, ni "por si acaso". Si el cliente lo repite, agradece y avanza.\n` +
    (faltan.length
      ? `- Tu mensaje pide SOLO lo que está en ❌ (una pregunta corta y natural). Nada de resumen todavía.\n`
      : `- Ya no hay nada que preguntar: si tu flujo muestra el resumen y pide confirmarlo, hazlo UNA sola vez; ` +
        `si el cliente ya confirmó (o tu flujo cierra directo), tu mensaje ES el cierre: el resumen COMPLETO con estos valores tal cual ` +
        `(todas las líneas de tu formato: Nombre, Teléfono, Provincia, Ciudad, Dirección, Producto, Cantidad, Precio total, Envío) ` +
        `y en la ÚLTIMA línea, sola, ${trigger}.\n`) +
    `- NUNCA digas "gracias por tu compra", "pedido registrado/confirmado" ni "resumen final" sin ${trigger} en ESE MISMO mensaje: sin el tag el sistema no registra nada y la venta se pierde.\n\n`;
  return txt;
}

/* ── Cierre narrado sin tag ──
   El modelo da la venta por cerrada ("¡Gracias por tu compra!", "Tu pedido ha
   sido registrado") pero no escribe el tag. Sin tag el chat no se mueve y al
   siguiente "gracias" del cliente vuelve a cerrar. */
const RE_CIERRE_NARRADO =
  /gracias por (?:tu|su) compra|pedido (?:ha sido |qued[oó]a? |est[aá] |fue |ya (?:est[aá]|qued[oó]) )?(?:registrad|confirmad|procesad|tomad|listo)|hemos registrado (?:tu|su) pedido|(?:tu|su) pedido (?:ya )?(?:est[aá]|qued[oó]) (?:listo|registrado|confirmado)|listo!? pedido confirmado|resumen final/i;

function esCierreNarrado(texto) {
  const t = String(texto || '');
  // "gracias por tu compra anterior" (cliente recurrente) no es un cierre.
  if (/compra (?:anterior|pasada|previa)|[uú]ltima compra/i.test(t)) return false;
  return RE_CIERRE_NARRADO.test(t);
}

/* ¿El texto trae un resumen de pedido reconocible? (3+ rótulos conocidos al
   inicio de línea, incluido Producto). Es el requisito para INFERIR el tag. */
const ROTULOS = [
  /(?:^|\n)[^\n]{0,6}?Nombre(?:\s+completo)?\s*:/i,
  /(?:^|\n)[^\n]{0,6}?Tel[eé]fono\s*:/i,
  /(?:^|\n)[^\n]{0,6}?Ciudad\s*:/i,
  /(?:^|\n)[^\n]{0,6}?Direcci[oó]n[^:\n]{0,25}:/i,
  /(?:^|\n)[^\n]{0,6}?Producto\s*:/i,
  /(?:^|\n)[^\n]{0,6}?(?:Precio\s+total|\bTotal|Precio)\s*:/i,
  /(?:^|\n)[^\n]{0,6}?Agencia[^:\n]*:/i,
  /(?:^|\n)[^\n]{0,6}?Env[ií]o\s*:/i,
  /(?:^|\n)[^\n]{0,6}?Cantidad\s*:/i,
];
const RE_PRODUCTO = /(?:^|\n)[^\n]{0,6}?Producto\s*:/i;
function pareceResumenDePedido(texto) {
  const t = String(texto || '');
  const n = ROTULOS.filter((re) => re.test(t)).length;
  return n >= 3 && RE_PRODUCTO.test(t);
}

/* ── Completar el resumen con la ficha ──
   Antes de validar el cierre: lo que el modelo omitió o escribió a medias se
   completa con lo que el cliente SÍ dijo. Devuelve el texto nuevo y qué campos
   se completaron (vacío = no se tocó nada). */
const REL = /necesito|ind[ií]ca|ind[ií]que|proporcion|por favor|pendiente|falta|\bdime\b|d[ií]game|seg[uú]n tu elecci[oó]n|no registra|confirmar|\[|\]|^\(.+\)$|x{2,}/i;
const esRelleno = (v) => {
  const t = String(v || '')
    .replace(/[*_]/g, '')
    .trim();
  return !t || REL.test(t);
};

function completarResumenConFicha(texto, ficha) {
  const original = String(texto || '');
  /* Hace falta al menos una línea de resumen reconocible (idealmente la de
     Producto) para saber DÓNDE insertar: sin eso no hay resumen que
     completar. No se exige el resumen entero a propósito —el caso 360 traía
     solo Producto/Precio/Envío y justo por eso había que completarlo. */
  if (!ficha || !ROTULOS.some((re) => re.test(original))) {
    return { texto: original, completados: [] };
  }
  const lineas = original.split('\n');
  const completados = [];

  const idxDe = (re) => lineas.findIndex((l) => re.test(l));
  const valorDe = (i) => {
    if (i < 0) return null;
    const m = lineas[i].match(/:\s*(.*)$/);
    return m ? m[1].replace(/[*_]/g, '').trim() : '';
  };
  /* Se conserva el rótulo tal como lo escribió el modelo, incluida la negrita
     que cierra después de los dos puntos ("🧑 **Nombre:** Josué"). */
  const reemplazarValor = (i, valor) => {
    const m = lineas[i].match(/^([^:]*:)\s*(\**)\s*(.*)$/);
    if (!m) return;
    lineas[i] = `${m[1]}${m[2]} ${valor}`;
  };
  /* Las líneas nuevas van después de la última línea del resumen, con el
     mismo estilo de rótulo que el formato estándar (emoji + rótulo). */
  const ultimaLineaResumen = () => {
    let ult = -1;
    lineas.forEach((l, i) => {
      if (ROTULOS.some((re) => re.test(`\n${l}`))) ult = i;
    });
    return ult;
  };
  const insertar = (linea) => {
    const i = ultimaLineaResumen();
    lineas.splice(i + 1, 0, linea);
  };

  // Nombre: ausente, de relleno o de una sola palabra → el de la ficha (si es completo).
  const reNombre = /^[^\n]{0,6}?Nombre(?:\s+completo)?\s*:/i;
  let iN = idxDe(reNombre);
  const vN = valorDe(iN);
  if (ficha.nombre && nombreCompleto(ficha.nombre)) {
    if (iN < 0) {
      insertar(`🧑 Nombre: ${ficha.nombre}`);
      completados.push('nombre');
    } else if (esRelleno(vN) || !nombreCompleto(vN)) {
      /* Solo se pisa si el de la ficha CONTIENE lo que el modelo puso
         ("Josué" ⊂ "Josué Yumbulema"): si el modelo escribió otro nombre
         distinto, mejor no tocarlo y que el validador decida. */
      if (esRelleno(vN) || normalizar(ficha.nombre).includes(normalizar(vN))) {
        reemplazarValor(iN, ficha.nombre);
        completados.push('nombre');
      }
    }
  }

  // Teléfono: solo si la línea vino de relleno/enmascarada.
  const iT = idxDe(/^[^\n]{0,6}?Tel[eé]fono\s*:/i);
  if (iT >= 0) {
    const vT = valorDe(iT);
    const digitos = (vT.match(/\d/g) || []).length;
    if (esRelleno(vT) || digitos < 9) {
      if (ficha.telefono) {
        reemplazarValor(iT, ficha.telefono);
        completados.push('telefono');
      } else {
        // Sin teléfono del cliente: se quita la línea falsa; el auto-orden
        // usa el número desde el que escribe.
        lineas.splice(iT, 1);
        completados.push('telefono');
      }
    }
  }

  // Provincia y ciudad (en ese orden, como el formato estándar).
  const iP = idxDe(/^[^\n]{0,6}?(?:Provincia|Departamento|Depto\.?|Estado|Regi[oó]n)\s*:/i);
  if (ficha.provincia && (iP < 0 || esRelleno(valorDe(iP)))) {
    if (iP < 0) insertar(`📍 Provincia: ${ficha.provincia}`);
    else reemplazarValor(iP, ficha.provincia);
    completados.push('provincia');
  }
  const iC = idxDe(/^[^\n]{0,6}?Ciudad\s*:/i);
  if (ficha.ciudad) {
    if (iC < 0) {
      insertar(`📍 Ciudad: ${ficha.ciudad}`);
      completados.push('ciudad');
    } else if (esRelleno(valorDe(iC))) {
      reemplazarValor(iC, ficha.ciudad);
      completados.push('ciudad');
    }
  }

  // Dirección o agencia.
  const iD = idxDe(/^[^\n]{0,6}?Direcci[oó]n[^:\n]{0,25}:/i);
  const iA = idxDe(/^[^\n]{0,6}?Agencia[^:\n]*:/i);
  const dirOk = iD >= 0 && !esRelleno(valorDe(iD));
  const ageOk = iA >= 0 && (!esRelleno(valorDe(iA)) || /por confirmar/i.test(valorDe(iA)));
  if (!dirOk && !ageOk) {
    if (ficha.direccion) {
      const val =
        ficha.direccion + (ficha.referencia ? ` (${ficha.referencia})` : '');
      if (iD >= 0) reemplazarValor(iD, val);
      else insertar(`🏡 Direccion: ${val}`);
      completados.push('direccion');
    } else if (ficha.entrega === 'agencia') {
      const val = `${etiquetaAgencia(ficha)} — ${ficha.ciudad || 'ciudad por confirmar'}`;
      if (iD >= 0) reemplazarValor(iD, val);
      else insertar(`🏡 Direccion: ${val}`);
      completados.push('agencia');
    }
  }

  // Envío: para retiro en agencia el auto-orden necesita saberlo.
  if (ficha.entrega === 'agencia') {
    const iE = idxDe(/^[^\n]{0,6}?Env[ií]o\s*:/i);
    if (iE < 0) {
      insertar(`🚚 Envio: agencia servientrega`);
      completados.push('envio');
    } else if (!/agencia|servientrega|oficina/i.test(valorDe(iE))) {
      reemplazarValor(iE, 'agencia servientrega');
      completados.push('envio');
    }
  }

  return { texto: lineas.join('\n'), completados };
}

function limpiarCacheFicha(id_cliente) {
  if (id_cliente === undefined) CACHE.clear();
  else CACHE.delete(String(id_cliente));
}

module.exports = {
  extraerFichaPedido,
  bloqueFichaPedido,
  faltantesFicha,
  fichaTieneDatos,
  completarResumenConFicha,
  esCierreNarrado,
  pareceResumenDePedido,
  aparecioEnCliente,
  completarApellido,
  nombrePaisDe,
  limpiarCacheFicha,
  RE_CIERRE_NARRADO,
};
