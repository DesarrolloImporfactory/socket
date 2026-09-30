// Plantilla global "Agente de E-commerce MX" (id 25): en México la entrega es
// SIEMPRE a domicilio. No existe retiro en agencia ni "sucursal de la
// paquetería" donde el cliente pueda recoger (caso Global Outlet Mx, cfg 822,
// 2026-09-29: el bot de Pendiente Confirmación le dijo a un cliente sin
// cobertura "Sí, puedes recoger en la sucursal de la paquetería"). Cambios,
// versión +0.1 (6.3 → 6.4):
//   - Contacto Inicial: desaparece la pregunta "¿domicilio o sucursal?"
//     (INTERACCION 4 pasa a ser DATOS, el cierre a INTERACCION 5), el resumen
//     lleva siempre "🚚 Envio: domicilio", los ejemplos ya no preguntan
//     modalidad y la objeción "¿puedo retirar?" responde que el envío es
//     únicamente a domicilio, sin nombrar paqueterías.
//   - Pendiente Confirmación: objeción nueva para "¿puedo recoger el paquete?".
//   - De paso se repara la frase del precio del combo, que quedó rota desde el
//     script del 2026-09-08 ("$2" dentro de un replace se leyó como grupo de
//     captura y dejó "6. VARIEDAD0 y el combo de 2 cuesta 6. VARIEDAD5…").
//
// El runtime (Responses API) lee kanban_columnas.instrucciones, así que las
// cuentas que ya aplicaron la plantilla NO cambian solas. Con --resync se
// recompilan las columnas IA de las cuentas indicadas con el MISMO
// resincronizador del botón "Actualizar tablero" (kanban_plantillas
// _resincronizarUnaConfiguracion), en modo soloPrompts: recompila lo que ya
// existe, no crea columnas ni enciende bots apagados. La cuenta de --boton
// recibe además la instalación aditiva (_instalarFaltantes), exactamente lo
// que hace el botón en la vista de kanban_config. Además, la regla de
// entrega solo a domicilio viaja en el contexto de columna
// (utils/contextoColumna.js) para toda cuenta con Dropi MX, tenga o no el
// prompt nuevo.
//
//   node scripts/actualizarPlantillaMX_soloDomicilio.js                  → muestra los cambios
//   node scripts/actualizarPlantillaMX_soloDomicilio.js --aplicar        → escribe la plantilla global (v+0.1)
//   node scripts/actualizarPlantillaMX_soloDomicilio.js --resync 822,742 → resincroniza esas cuentas (solo prompts)
//   node scripts/actualizarPlantillaMX_soloDomicilio.js --resync 742 --boton 822 → la 822 con el botón completo
//
// Solo se pasan a --resync cuentas cuyo prompt sigue siendo el de la
// plantilla (sin edición manual): el resync PISA kanban_columnas.instrucciones.
const ROOT = require('path').join(__dirname, '..');
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });
const fs = require('fs');
const path = require('path');
const { db } = require(ROOT + '/src/database/config');

const args = process.argv.slice(2);
const APLICAR = args.includes('--aplicar');
const leerLista = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1]) return [];
  return args[i + 1]
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0);
};
const RESYNC = leerLista('--resync');
const BOTON = leerLista('--boton');
const ID_PLANTILLA_MX = 25;
const S = path.join(ROOT, 'logs', 'plantillas');
fs.mkdirSync(S, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');

/* [ancla vieja, texto nuevo, descripción]. Cada ancla debe aparecer
   exactamente una vez; se reemplaza por texto plano (split/join, sin
   regex: así "$20" se escribe tal cual). */
const CAMBIOS_CONTACTO_INICIAL = [
  [
    'la cantidad (unidades o combo), el tipo de envio, y la variedad si el producto es VARIABLE',
    'la cantidad (unidades o combo) y la variedad si el producto es VARIABLE',
    'REGLA #1: el "tipo de envio" deja de ser condición del cierre',
  ],
  [
    '(si 1 cuesta \n6. VARIEDAD0 y el combo de 2 cuesta \n6. VARIEDAD5, dos unidades = \n6. VARIEDAD5, NUNCA $40).',
    '(si 1 cuesta $20 y el combo de 2 cuesta $25, dos unidades = $25, NUNCA $40).',
    'frase del precio del combo reparada',
  ],
  [
    'INTERACCION 4 — ENVIO\n' +
      'Cuando el producto es simple y ya dijo la cantidad, o es variable y ya nombro la variedad:\n' +
      '"¿Te lo enviamos a tu domicilio o lo recoges en la sucursal de la paquetería? 📦"\n' +
      'Solo esa pregunta. NO pidas nombre/telefono/direccion todavia. NUNCA asumas domicilio por tu cuenta: el cliente debe responderlo.\n' +
      '\n' +
      'INTERACCION 5 — DATOS\n' +
      'Cuando ya respondio domicilio o agencia (NUNCA digas "Ultimo paso" ni pidas datos si aun no le preguntaste domicilio o agencia):\n' +
      '"Ultimo paso! Dame tu nombre completo, telefono, direccion exacta (calle, numero, colonia + referencia) y tu codigo postal. Pagas al recibir!"\n' +
      'Solo eso. Si el cliente manda los datos incompletos, pide SOLO lo que falta. PROHIBIDO escribir aqui el resumen o parte de el: el resumen existe UNICAMENTE en el cierre final.\n' +
      '\n' +
      'INTERACCION 6 — CIERRE FINAL',
    'INTERACCION 4 — DATOS (en Mexico el envio es SIEMPRE a domicilio)\n' +
      'Cuando el producto es simple y ya dijo la cantidad, o es variable y ya nombro la variedad:\n' +
      '"Ultimo paso! Dame tu nombre completo, telefono, direccion exacta (calle, numero, colonia + referencia) y tu codigo postal. Te lo enviamos a domicilio y pagas al recibir!"\n' +
      'Solo eso. NUNCA preguntes si prefiere domicilio o sucursal/agencia: en Mexico no existe retiro en sucursal ni punto de recogida, TODO se entrega a domicilio y no se nombra ninguna paqueteria. Si el cliente manda los datos incompletos, pide SOLO lo que falta. PROHIBIDO escribir aqui el resumen o parte de el: el resumen existe UNICAMENTE en el cierre final.\n' +
      '\n' +
      'INTERACCION 5 — CIERRE FINAL',
    'INTERACCION 4 pasa de "¿domicilio o sucursal?" a pedir los datos; el cierre es la INTERACCION 5',
  ],
  [
    '¿su codigo postal (5 digitos, escrito por el cliente)? ¿ya respondio domicilio o agencia? Si alguna',
    '¿su codigo postal (5 digitos, escrito por el cliente)? Si alguna',
    'la revisión previa al cierre ya no pregunta por la modalidad',
  ],
  [
    'Si tiene Nombre + Telefono + Direccion + Codigo postal COMPLETOS, la cantidad, el envio, y la variedad si es VARIABLE:',
    'Si tiene Nombre + Telefono + Direccion + Codigo postal COMPLETOS, la cantidad y la variedad si es VARIABLE:',
    'condición del cierre sin "el envio"',
  ],
  [
    '🚚 Envio: [domicilio  |  agencia]',
    '🚚 Envio: domicilio',
    'el formato del resumen lleva "Envio: domicilio" fijo',
  ],
  [
    '🚚 Envio: escribe "agencia" SOLO si el cliente pidio retirar en una agencia/oficina; en cualquier otro caso escribe "domicilio". El sistema usa esto para elegir la transportadora correcta.',
    '🚚 Envio: escribe SIEMPRE "domicilio". En Mexico el envio es unicamente a domicilio: no existe retiro en agencia, sucursal ni punto de recogida.',
    'regla de la línea Envio',
  ],
  [
    '[NOMBRE_ASISTENTE]: "Buenisima eleccion! ¿Te las enviamos a tu domicilio o lo recoges en la sucursal de la paquetería? 📦"\n' +
      'Cliente: "a domicilio"\n' +
      '[NOMBRE_ASISTENTE]: "Ultimo paso! Dame tu nombre completo, telefono, direccion exacta (calle, numero, colonia + referencia) y tu codigo postal. Pagas al recibir!"',
    '[NOMBRE_ASISTENTE]: "Buenisima eleccion! Ultimo paso: dame tu nombre completo, telefono, direccion exacta (calle, numero, colonia + referencia) y tu codigo postal. Te las enviamos a domicilio y pagas al recibir!"',
    'EJEMPLO A sin la pregunta de modalidad',
  ],
  [
    'en ese orden: ciudad → cantidad → variedad → envio → datos → cierre',
    'en ese orden: ciudad → cantidad → variedad → datos → cierre',
    'orden de pasos del EJEMPLO A',
  ],
  [
    'EJEMPLO B — producto SIMPLE (la ficha NO dice PRODUCTO VARIABLE): cuando diga la cantidad pasa DIRECTO al envio:\n' +
      'Cliente: "uno solo"\n' +
      '[NOMBRE_ASISTENTE]: "Perfecto! ¿Te lo enviamos a tu domicilio o lo recoges en la sucursal de la paquetería? 📦"\n' +
      '(despues del envio pide los datos igual que el ejemplo A, y el resumen final va SIN la linea 🎨. Si la ficha SI dice PRODUCTO VARIABLE, antes del envio va la pregunta de variedad, como en el ejemplo A)',
    'EJEMPLO B — producto SIMPLE (la ficha NO dice PRODUCTO VARIABLE): cuando diga la cantidad pasa DIRECTO a los datos:\n' +
      'Cliente: "uno solo"\n' +
      '[NOMBRE_ASISTENTE]: "Perfecto! Ultimo paso: dame tu nombre completo, telefono, direccion exacta (calle, numero, colonia + referencia) y tu codigo postal. Te lo enviamos a domicilio y pagas al recibir!"\n' +
      '(el resumen final va SIN la linea 🎨. Si la ficha SI dice PRODUCTO VARIABLE, antes de los datos va la pregunta de variedad, como en el ejemplo A)',
    'EJEMPLO B sin la pregunta de modalidad',
  ],
  [
    'Contexto: ya se sabe producto, ciudad, cantidad y envio.',
    'Contexto: ya se sabe producto, ciudad y cantidad.',
    'EJEMPLO D sin "envio"',
  ],
  [
    'Cliente: "quiero 2, a domicilio. Michael Ordonez, 3312345678, calle A y calle B"',
    'Cliente: "quiero 2. Michael Ordonez, 3312345678, calle A y calle B"',
    'EJEMPLO E sin "a domicilio"',
  ],
  [
    '- Si el cliente pregunta si puede retirar en agencia / oficina / punto de retiro:\n' +
      '"¡Claro! Puedes retirarlo en la sucursal de la paquetería y pagas al momento de recogerlo 😊 ¿Prefieres retirarlo ahí o que te lo enviemos a tu domicilio?"\n' +
      'No le pidas datos hasta que elija. Si elige retiro, pídele el nombre o una referencia (ciudad y colonia o calle) de la sucursal donde quiere retirar; nunca digas "la más cercana" sin saber cuál es. Al cerrar pon 🚚 Envio: agencia.',
    '- Si el cliente pregunta si puede retirar o recoger en una agencia, oficina, sucursal o punto de retiro:\n' +
      '"En Mexico el envio es unicamente a domicilio 🚚 Te lo llevamos hasta tu puerta y pagas al recibir. ¿Me confirmas tu direccion completa y tu codigo postal?"\n' +
      'NUNCA ofrezcas retiro en sucursal ni nombres una paqueteria o transportadora. Si dice que no puede recibir en su domicilio, ofrecele que reciba otra persona en esa misma direccion o en otra (casa de un familiar o su trabajo). Al cerrar pon SIEMPRE 🚚 Envio: domicilio.',
    'objeción "¿puedo retirar?": solo a domicilio, sin paqueterías',
  ],
];

const CAMBIOS_PENDIENTE_CONFIRMACION = [
  [
    '- Pregunta por el producto (fotos, dudas): responde con los datos del pedido o file_search y\n' +
      '  vuelve a pedir la confirmación.\n',
    '- Pregunta por el producto (fotos, dudas): responde con los datos del pedido o file_search y\n' +
      '  vuelve a pedir la confirmación.\n' +
      '- Pregunta si puede recoger o retirar el paquete en una sucursal, oficina, agencia o punto de\n' +
      '  entrega: en México el envío es únicamente a domicilio; no hay punto de recogida ni cambio a\n' +
      '  retiro. Díselo amable, sin nombrar ninguna paquetería, confirma la dirección registrada (o\n' +
      '  toma la correcta como en el Caso 2) y vuelve a pedir la confirmación.\n',
    'objeción "¿puedo recoger el paquete?" en Pendiente Confirmación',
  ],
];

function aplicarCambios(texto, cambios) {
  let t = texto;
  const hechos = [];
  const faltantes = [];
  for (const [vieja, nueva, desc] of cambios) {
    const n = t.split(vieja).length - 1;
    if (n !== 1) {
      faltantes.push(`${desc} (ancla encontrada ${n} veces)`);
      continue;
    }
    t = t.split(vieja).join(nueva);
    hechos.push(desc);
  }
  return { texto: t, hechos, faltantes };
}

const YA_APLICADO =
  /INTERACCION 4 — DATOS \(en Mexico el envio es SIEMPRE a domicilio\)/;

async function actualizarPlantilla() {
  const [p] = await db.query(
    `SELECT id, nombre, pais, version, data FROM kanban_plantillas_globales WHERE id = ? LIMIT 1`,
    { replacements: [ID_PLANTILLA_MX], type: db.QueryTypes.SELECT },
  );
  if (!p) throw new Error(`No existe la plantilla ${ID_PLANTILLA_MX}`);
  if (String(p.pais).toUpperCase() !== 'MX')
    throw new Error(`La plantilla ${p.id} es de ${p.pais}, no de MX`);

  const data = JSON.parse(p.data);
  const ci = data.columnas.find((c) => c.estado_db === 'contacto_inicial');
  const pc = data.columnas.find(
    (c) => c.estado_db === 'pendiente_confirmacion',
  );
  if (!ci?.instrucciones) throw new Error('Contacto Inicial sin instrucciones');
  if (!pc?.instrucciones)
    throw new Error('Pendiente Confirmacion sin instrucciones');

  if (YA_APLICADO.test(ci.instrucciones)) {
    console.log(
      `La plantilla ${p.id} (v${p.version}) YA es solo a domicilio. Nada que hacer en la global.`,
    );
    return p;
  }

  const rCI = aplicarCambios(ci.instrucciones, CAMBIOS_CONTACTO_INICIAL);
  const rPC = aplicarCambios(pc.instrucciones, CAMBIOS_PENDIENTE_CONFIRMACION);
  const faltantes = [...rCI.faltantes, ...rPC.faltantes];
  if (faltantes.length)
    throw new Error(
      `Plantilla ${p.id}: anclas no encontradas → ${faltantes.join(' | ')}`,
    );

  /* Nada de agencia/sucursal/paquetería puede quedar en el prompt nuevo,
     salvo la propia objeción que las prohíbe. */
  const sobras = rCI.texto
    .split('\n')
    .filter((l) => /agencia|sucursal|paqueter|servientrega|retir/i.test(l))
    .filter(
      (l) =>
        !/^- Si el cliente pregunta si puede retirar|^NUNCA ofrezcas retiro|^🚚 Envio: escribe SIEMPRE|^Solo eso\. NUNCA preguntes/.test(
          l,
        ),
    );
  if (sobras.length)
    throw new Error(
      `Quedan menciones de retiro en Contacto Inicial:\n${sobras.join('\n')}`,
    );

  fs.writeFileSync(
    path.join(S, `mx_${p.id}_solo_domicilio_antes_CI.txt`),
    ci.instrucciones,
  );
  fs.writeFileSync(
    path.join(S, `mx_${p.id}_solo_domicilio_despues_CI.txt`),
    rCI.texto,
  );
  fs.writeFileSync(
    path.join(S, `mx_${p.id}_solo_domicilio_antes_PC.txt`),
    pc.instrucciones,
  );
  fs.writeFileSync(
    path.join(S, `mx_${p.id}_solo_domicilio_despues_PC.txt`),
    rPC.texto,
  );
  const versionNueva = Math.round((Number(p.version) + 0.1) * 10) / 10;
  console.log(
    `Plantilla ${p.id} ${p.pais} v${p.version} → v${versionNueva}\n` +
      `   Contacto Inicial ${ci.instrucciones.length} → ${rCI.texto.length} chars\n   - ${rCI.hechos.join('\n   - ')}\n` +
      `   Pendiente Confirmacion ${pc.instrucciones.length} → ${rPC.texto.length} chars\n   - ${rPC.hechos.join('\n   - ')}`,
  );
  if (!APLICAR) {
    console.log(
      '   (sin --aplicar: no se escribió nada; textos nuevos en logs/plantillas/)',
    );
    return p;
  }
  ci.instrucciones = rCI.texto;
  pc.instrucciones = rPC.texto;
  await db.query(
    `UPDATE kanban_plantillas_globales SET data = ?, version = ROUND(version + 0.1, 1) WHERE id = ?`,
    { replacements: [JSON.stringify(data), p.id], type: db.QueryTypes.UPDATE },
  );
  console.log(`   ✔ plantilla global actualizada a v${versionNueva}`);
  return { ...p, version: versionNueva };
}

async function resincronizar(ids, conBoton) {
  const ctrl = require(ROOT + '/src/controllers/kanban_plantillas.controller');
  const respaldo = [];
  const resumen = { ok: [], error: [] };
  for (const id of ids) {
    const [cfg] = await db.query(
      `SELECT id, nombre_configuracion, kanban_global_id, prompt_version FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id], type: db.QueryTypes.SELECT },
    );
    if (!cfg || Number(cfg.kanban_global_id) !== ID_PLANTILLA_MX) {
      resumen.error.push({
        id,
        error: `no existe o no usa la plantilla ${ID_PLANTILLA_MX}`,
      });
      continue;
    }
    const cols = await db.query(
      `SELECT id, estado_db, instrucciones, modelo, max_tokens FROM kanban_columnas
        WHERE id_configuracion = ? AND activo = 1 AND assistant_id IS NOT NULL`,
      { replacements: [id], type: db.QueryTypes.SELECT },
    );
    respaldo.push({ cfg, columnas: cols });
    fs.writeFileSync(
      path.join(S, `solo_domicilio_resync_${ts}.json`),
      JSON.stringify(respaldo, null, 2),
    );

    const boton = conBoton.includes(id);
    const r = await ctrl._resincronizarUnaConfiguracion(id, {
      soloPrompts: !boton,
    });
    let instalado = null;
    if (boton && r.success) {
      try {
        instalado = await ctrl._instalarFaltantes(id);
      } catch (e) {
        instalado = { error: e.message };
      }
    }
    const linea =
      `${id} ${cfg.nombre_configuracion} v${cfg.prompt_version} → ${r.success ? `v${r.version}` : 'ERROR'}: ` +
      (r.resultados_columnas
        ? r.resultados_columnas
            .map(
              (c) => `${c.nombre}:${c.status}${c.error ? `(${c.error})` : ''}`,
            )
            .join(' ')
        : r.error) +
      (boton
        ? ` · botón: ${r.estructura?.agregadas?.length || 0} col nuevas, ${r.estructura?.actualizadas?.length || 0} encendidas` +
          (instalado?.error
            ? ` · instalarFaltantes ERROR ${instalado.error}`
            : ` · ${(instalado?.templates_meta || []).filter((t) => t.status === 'success').length} plantillas Meta, ${(instalado?.dropi_estados || []).length} estados Dropi, ${(instalado?.remarketing_estados || []).length} secuencias`)
        : '');
    console.log('   ' + linea);
    (r.success ? resumen.ok : resumen.error).push({ id, linea });
  }
  console.log(
    `\nResync: ${resumen.ok.length} ok · ${resumen.error.length} con error (respaldo de los prompts anteriores en logs/plantillas/solo_domicilio_resync_${ts}.json)`,
  );
  for (const e of resumen.error)
    console.log(`   ✖ ${e.id}: ${e.error || e.linea}`);
}

(async () => {
  const p = await actualizarPlantilla();
  if (RESYNC.length) {
    if (!YA_APLICADO.test(JSON.stringify(p.data || '')) && !APLICAR) {
      const [fresca] = await db.query(
        `SELECT data FROM kanban_plantillas_globales WHERE id = ? LIMIT 1`,
        { replacements: [ID_PLANTILLA_MX], type: db.QueryTypes.SELECT },
      );
      if (!YA_APLICADO.test(String(fresca?.data || '')))
        throw new Error(
          'La plantilla global todavía no está actualizada: corre primero con --aplicar',
        );
    }
    console.log(
      `\nResincronizando ${RESYNC.length} cuenta(s)${BOTON.length ? ` (botón completo: ${BOTON.join(', ')})` : ''}…`,
    );
    await resincronizar(RESYNC, BOTON);
  }
  await db.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
