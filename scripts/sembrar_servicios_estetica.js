'use strict';

/**
 * Deja el catálogo de un centro de estética listo para operar: categorías,
 * servicios con su copy, precios y duración, y la personalización de la cuenta.
 *
 *   node scripts/sembrar_servicios_estetica.js 840
 *   node scripts/sembrar_servicios_estetica.js 840 --aplicar
 *
 * Hace cuatro cosas, y las cuatro importan para que el bot no improvise:
 *
 *  1. Crea las CATEGORÍAS y les cuelga cada servicio. Sin categoría el catálogo
 *     se le presenta al asistente como una lista plana y el cliente no puede
 *     filtrar nada en el panel.
 *
 *  2. Inserta los servicios con tipo = 'servicio'. Ese campo NO es decorativo:
 *     syncCatalogoKanbanColumna separa productos de servicios y, si hay al menos
 *     un producto, IGNORA los servicios. Una cuenta de estética con un producto
 *     suelto se queda sin catálogo.
 *
 *  3. Completa la personalización de la cuenta con reglas GENÉRICAS. El horario
 *     y las ciudades NO van aquí: viven en `establecimientos_chat_center` y se
 *     inyectan solos. Esa separación es lo que permite montar el centro número
 *     100 sin reescribir el prompt de las 6 columnas.
 *
 *  4. Vuelve a sincronizar el catálogo con los asistentes que lo consumen.
 *
 * La DURACIÓN va en MINUTOS. Es lo que usa el bot para calcular a qué hora
 * termina la cita.
 */

require('dotenv').config();
const { db } = require('../src/database/config');
const {
  syncCatalogoTodasColumnasConfig,
} = require('../src/services/syncCatalogoKanbanColumna.service');

const OK = '✅';
const NO = '❌';
const WARN = '⚠️ ';
const SIN_CAMBIO = '·';

const flag = (n) => process.argv.includes(`--${n}`);
const arg = (n, def = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const CATEGORIAS = [
  {
    nombre: 'Faciales',
    descripcion: 'Limpieza, hidratación y tratamientos para el rostro',
  },
  {
    nombre: 'Corporales',
    descripcion: 'Tratamientos reductores y de modelado corporal',
  },
  {
    nombre: 'Depilación',
    descripcion: 'Depilación láser y definitiva por zonas',
  },
  {
    nombre: 'Manos y pies',
    descripcion: 'Manicure, pedicure y cuidado de uñas',
  },
  {
    nombre: 'Valoraciones',
    descripcion: 'Diagnóstico inicial y planes de tratamiento',
  },
  {
    nombre: 'Productos para llevar',
    descripcion: 'Equipos y cosmética que el cliente compra y se lleva',
  },
];

/* Casi ninguna estética vive solo de servicios: venden la crema que usaron en
   cabina, la plancha, la máquina. Van con tipo 'producto' y el asistente los
   trata distinto — se venden y se despachan, no se agenda una cita para
   comprarlos. */
const PRODUCTOS = [
  {
    nombre: 'Máquina cortadora de cabello profesional',
    categoria: 'Productos para llevar',
    precio: 85,
    stock: 6,
    material: 'Cuchilla de titanio, batería recargable',
    descripcion:
      '✂️ La misma que usamos en cabina. Cuchilla de titanio, 6 peines guía y batería que aguanta 3 horas de uso continuo.\n\n🔋 Se carga en 2 horas y funciona también conectada\n💪 Corta cabello grueso sin tironear\n📦 Incluye estuche, aceite y cepillo de limpieza\n\n🛡️ 6 meses de garantía. Te la entregamos en el local o la enviamos a tu ciudad.',
  },
  {
    nombre: 'Plancha alisadora de cerámica',
    categoria: 'Productos para llevar',
    precio: 45,
    stock: 10,
    material: 'Placas de cerámica con control de temperatura',
    descripcion:
      '💇‍♀️ Placas de cerámica que reparten el calor parejo, para que no tengas que pasar dos veces por el mismo mechón.\n\n🌡️ Temperatura regulable de 120° a 230°\n⏱️ Calienta en 30 segundos\n🔌 Apagado automático a los 30 minutos\n\nIdeal si te alisas seguido: el control de temperatura es lo que evita el daño.',
  },
  {
    nombre: 'Kit de mantenimiento facial en casa',
    categoria: 'Productos para llevar',
    precio: 38,
    stock: 15,
    material: 'Limpiador, tónico y protector solar',
    descripcion:
      '🧴 Lo que necesitas para sostener en casa lo que hicimos en cabina: limpiador suave, tónico equilibrante y protector solar facial.\n\n📅 Rinde entre 2 y 3 meses\n☀️ El protector es el que más importa: sin él, cualquier tratamiento facial se pierde\n\nTe explicamos el orden de aplicación al entregártelo.',
  },
];

/* El copy es el que el asistente le lee al cliente: cada servicio dice qué
   resuelve, qué se siente y qué esperar después. Los emojis van con medida —
   uno o dos por bloque, para que se lea en WhatsApp sin parecer publicidad. */
const SERVICIOS = [
  {
    nombre: 'Valoración facial',
    categoria: 'Valoraciones',
    precio: 20,
    duracion: 30,
    material: 'Diagnóstico con especialista',
    descripcion:
      '✨ El punto de partida. Una especialista revisa tu piel de cerca, identifica qué la está afectando (manchas, acné, resequedad, flacidez) y arma contigo un plan realista.\n\n🕐 Dura 30 minutos\n💵 Cuesta $20 y se te descuenta del primer tratamiento que te realices\n\nSi nunca te has hecho nada, empieza por aquí: evita que gastes en algo que tu piel no necesita.',
    nombre_upsell: 'Plan de 3 sesiones',
    descripcion_upsell:
      'Si en la valoración sale que necesitas más de una sesión, armamos el plan completo con precio preferencial.',
    precio_upsell: 0,
  },
  {
    nombre: 'Limpieza facial profunda',
    categoria: 'Faciales',
    precio: 35,
    duracion: 60,
    material: 'Vapor, extracción manual y mascarilla',
    descripcion:
      '🧖‍♀️ La favorita de la casa. Desmaquillamos, exfoliamos, abrimos el poro con vapor y sacamos una por una las impurezas. Cerramos con mascarilla calmante y protector solar.\n\n🕐 Dura 1 hora\n✅ Ideal para puntos negros, poros abiertos y piel apagada\n😌 Sales el mismo día sin marcas: puedes volver a tu rutina normal\n\nRecomendada cada 4 a 6 semanas.',
    nombre_upsell: 'Hidratación con ácido hialurónico',
    descripcion_upsell:
      'Sumada a la limpieza, deja la piel luminosa el mismo día. Perfecta antes de un evento.',
    precio_upsell: 25,
  },
  {
    nombre: 'Hidratación facial profunda',
    categoria: 'Faciales',
    precio: 45,
    duracion: 60,
    material: 'Ácido hialurónico y vitaminas',
    descripcion:
      '💧 Para piel que se siente tirante, opaca o cansada. Aplicamos ácido hialurónico y vitaminas en capas, con masaje de absorción.\n\n🕐 Dura 1 hora\n✨ El brillo se nota al salir, no a los días\n💍 Es la que más piden antes de una boda, grabación o viaje\n\nSin descamación ni tiempo de recuperación.',
    nombre_upsell: null,
    descripcion_upsell: null,
    precio_upsell: null,
  },
  {
    nombre: 'Peeling químico',
    categoria: 'Faciales',
    precio: 60,
    duracion: 45,
    material: 'Ácidos de grado médico',
    descripcion:
      '🍋 Renovación real de la piel. Trabajamos manchas, marcas de acné y textura irregular con ácidos de grado médico, graduados según tu caso.\n\n🕐 Dura 45 minutos\n📋 Requiere valoración previa: no todas las pieles admiten la misma concentración\n🧴 Puede haber descamación leve los primeros 3 a 5 días — es parte del proceso\n☀️ Protector solar obligatorio durante el tratamiento',
    nombre_upsell: null,
    descripcion_upsell: null,
    precio_upsell: null,
  },
  {
    nombre: 'Radiofrecuencia facial',
    categoria: 'Faciales',
    precio: 50,
    duracion: 45,
    material: 'Equipo de radiofrecuencia',
    descripcion:
      '🔥 Tensado sin cirugía. El calor controlado estimula tu propio colágeno para trabajar flacidez leve en rostro, papada y cuello.\n\n🕐 Dura 45 minutos\n📆 Se hace por sesiones, normalmente entre 6 y 8, una por semana\n😊 No duele: se siente como un masaje tibio\n🚶‍♀️ Sales y sigues tu día con normalidad',
    nombre_upsell: 'Paquete de 8 sesiones',
    descripcion_upsell:
      'El tratamiento completo con precio preferencial, para quienes ya decidieron hacer el proceso entero.',
    precio_upsell: 340,
  },
  {
    nombre: 'Masaje reductor',
    categoria: 'Corporales',
    precio: 25,
    duracion: 60,
    material: 'Maniobras manuales y gel frío',
    descripcion:
      '💆‍♀️ Masaje manual firme para moldear abdomen, piernas o brazos, y ayudar a movilizar la retención de líquidos.\n\n🕐 Dura 1 hora\n📆 Se recomienda en paquetes de 10 sesiones, 2 o 3 por semana\n🥗 Los resultados dependen también de alimentación y actividad física: te lo decimos de frente\n\nNo es un tratamiento para bajar de peso, es para moldear.',
    nombre_upsell: 'Paquete de 10 sesiones',
    descripcion_upsell:
      'El plan completo que de verdad da resultados, con precio preferencial por sesión.',
    precio_upsell: 200,
  },
  {
    nombre: 'Depilación láser · zona pequeña',
    categoria: 'Depilación',
    precio: 30,
    duracion: 30,
    material: 'Láser diodo',
    descripcion:
      '⚡ Para axilas, bozo, mentón o línea del bikini. El láser trabaja sobre el folículo y va reduciendo el vello sesión a sesión.\n\n🕐 Dura 30 minutos\n📆 Entre 6 y 8 sesiones, separadas de 4 a 6 semanas\n\n⚠️ Importante antes de venir:\n• Rasura la zona 24 horas antes (nunca cera ni depiladora)\n• No vengas con la piel bronceada o quemada por el sol\n• No apliques cremas ni desodorante ese día',
    nombre_upsell: 'Zona grande (piernas o espalda)',
    descripcion_upsell:
      'Si además quieres piernas completas o espalda, la sesión combinada sale más conveniente.',
    precio_upsell: 60,
  },
  {
    nombre: 'Manicure y pedicure spa',
    categoria: 'Manos y pies',
    precio: 25,
    duracion: 90,
    material: 'Exfoliación, parafina y esmaltado',
    descripcion:
      '💅 El combo completo, con calma. Retiro de cutícula, exfoliación, hidratación con parafina, masaje de manos y pies, y esmaltado a tu gusto.\n\n🕐 Dura 1 hora y media\n🛋️ Pensado para que sea un momento tuyo, no un trámite\n\nSi quieres esmaltado semipermanente, avísanos al agendar para reservarte el tiempo extra.',
    nombre_upsell: 'Esmaltado semipermanente',
    descripcion_upsell:
      'Dura de 2 a 3 semanas sin descascararse. Suma 30 minutos al servicio.',
    precio_upsell: 12,
  },
];

/* Reglas de negocio GENÉRICAS, iguales para cualquier centro. El horario, la
   dirección y las ciudades con cobertura NO van aquí: viven en
   `establecimientos_chat_center`. */
const REGLAS_GENERICAS = `POLÍTICA DE ATENCIÓN
- La atención es PRESENCIAL en nuestras sedes: no hacemos visitas a domicilio ni atención en línea.
- Solo agendamos dentro del horario de la sede que corresponda.
- La valoración se paga al reservar y se descuenta del tratamiento.
- Se recibe efectivo, transferencia y tarjeta.
- Si el cliente necesita cancelar, pedimos avisar con al menos 4 horas de anticipación.`;

(async () => {
  const aplicar = flag('aplicar');
  const id_configuracion = process.argv.slice(2).map(Number).filter(Boolean)[0];

  if (!id_configuracion) {
    console.log(
      'Uso: node scripts/sembrar_servicios_estetica.js <id_configuracion> [--aplicar] [--asistente "<nombre>"]',
    );
    process.exit(1);
  }

  const [cfg] = await db.query(
    `SELECT id, nombre_configuracion FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg) {
    console.log(`${NO} la configuración ${id_configuracion} no existe`);
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(66)}`);
  console.log(`CONFIG ${cfg.id} — ${cfg.nombre_configuracion}`);
  console.log('═'.repeat(66));

  // ── 1. Categorías ──
  const catsExistentes = await db.query(
    `SELECT id, nombre FROM categorias_chat_center WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const catPorNombre = new Map(
    catsExistentes.map((c) => [c.nombre.toLowerCase(), c.id]),
  );

  for (const cat of CATEGORIAS) {
    if (catPorNombre.has(cat.nombre.toLowerCase())) {
      console.log(`${SIN_CAMBIO} categoría "${cat.nombre}": ya existe`);
      continue;
    }
    console.log(`+ categoría "${cat.nombre}"`);
    if (!aplicar) continue;
    const [id] = await db.query(
      `INSERT INTO categorias_chat_center (id_configuracion, nombre, descripcion)
       VALUES (?, ?, ?)`,
      {
        replacements: [id_configuracion, cat.nombre, cat.descripcion],
        type: db.QueryTypes.INSERT,
      },
    );
    catPorNombre.set(cat.nombre.toLowerCase(), id);
  }

  // ── 2. Servicios ──
  const existentes = await db.query(
    `SELECT id, nombre, tipo FROM productos_chat_center
      WHERE id_configuracion = ? AND eliminado = 0`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const porNombre = new Map(existentes.map((p) => [p.nombre.toLowerCase(), p]));

  /* Nombres que cambiaron entre versiones del catálogo. Sin esto, renombrar un
     servicio crea uno nuevo y deja el viejo colgando: el cliente termina con
     "Masaje reductor" y "Masaje reductor (sesión)" en el mismo listado. */
  const RENOMBRADOS = {
    'masaje reductor (sesión)': 'Masaje reductor',
    'depilación láser (zona pequeña)': 'Depilación láser · zona pequeña',
  };
  for (const [viejo, nuevo] of Object.entries(RENOMBRADOS)) {
    const fila = porNombre.get(viejo);
    if (!fila || porNombre.has(nuevo.toLowerCase())) continue;
    console.log(`~ renombrando "${fila.nombre}" → "${nuevo}"`);
    if (aplicar) {
      await db.query(
        `UPDATE productos_chat_center SET nombre = ? WHERE id = ?`,
        { replacements: [nuevo, fila.id], type: db.QueryTypes.UPDATE },
      );
    }
    fila.nombre = nuevo;
    porNombre.set(nuevo.toLowerCase(), fila);
  }


  for (const s of SERVICIOS) {
    const idCat = catPorNombre.get(s.categoria.toLowerCase()) || null;
    const ya = porNombre.get(s.nombre.toLowerCase());

    const campos = {
      descripcion: s.descripcion,
      material: s.material,
      precio: s.precio,
      duracion: s.duracion,
      id_categoria: idCat,
      nombre_upsell: s.nombre_upsell,
      descripcion_upsell: s.descripcion_upsell,
      precio_upsell: s.precio_upsell,
    };

    if (ya) {
      console.log(
        `~ "${s.nombre}": actualizando copy, categoría (${s.categoria}) y duración (${s.duracion} min)`,
      );
      if (!aplicar) continue;
      await db.query(
        `UPDATE productos_chat_center
            SET descripcion = ?, material = ?, precio = ?, duracion = ?,
                id_categoria = ?, nombre_upsell = ?, descripcion_upsell = ?,
                precio_upsell = ?, tipo = 'servicio',
                fecha_actualizacion = NOW()
          WHERE id = ?`,
        {
          replacements: [
            campos.descripcion,
            campos.material,
            campos.precio,
            campos.duracion,
            campos.id_categoria,
            campos.nombre_upsell,
            campos.descripcion_upsell,
            campos.precio_upsell,
            ya.id,
          ],
          type: db.QueryTypes.UPDATE,
        },
      );
      continue;
    }

    console.log(
      `+ "${s.nombre}" · ${s.categoria} · $${s.precio} · ${s.duracion} min`,
    );
    if (!aplicar) continue;
    await db.query(
      `INSERT INTO productos_chat_center
         (id_configuracion, nombre, descripcion, material, tipo, es_variable,
          precio, duracion, id_categoria, nombre_upsell, descripcion_upsell,
          precio_upsell, stock, eliminado, fecha_creacion, fecha_actualizacion)
       VALUES (?, ?, ?, ?, 'servicio', 0, ?, ?, ?, ?, ?, ?, 0, 0, NOW(), NOW())`,
      {
        replacements: [
          id_configuracion,
          s.nombre,
          campos.descripcion,
          campos.material,
          campos.precio,
          campos.duracion,
          campos.id_categoria,
          campos.nombre_upsell,
          campos.descripcion_upsell,
          campos.precio_upsell,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }

  // ── 2b. Productos de venta ──
  for (const p of PRODUCTOS) {
    const idCat = catPorNombre.get(p.categoria.toLowerCase()) || null;
    const ya = porNombre.get(p.nombre.toLowerCase());

    if (ya) {
      console.log(`~ producto "${p.nombre}": actualizando`);
      if (!aplicar) continue;
      await db.query(
        `UPDATE productos_chat_center
            SET descripcion = ?, material = ?, precio = ?, stock = ?,
                id_categoria = ?, tipo = 'producto', duracion = 0,
                fecha_actualizacion = NOW()
          WHERE id = ?`,
        {
          replacements: [
            p.descripcion,
            p.material,
            p.precio,
            p.stock,
            idCat,
            ya.id,
          ],
          type: db.QueryTypes.UPDATE,
        },
      );
      continue;
    }

    console.log(`+ producto "${p.nombre}" · $${p.precio} · stock ${p.stock}`);
    if (!aplicar) continue;
    await db.query(
      `INSERT INTO productos_chat_center
         (id_configuracion, nombre, descripcion, material, tipo, es_variable,
          precio, duracion, id_categoria, stock, eliminado,
          fecha_creacion, fecha_actualizacion)
       VALUES (?, ?, ?, ?, 'producto', 0, ?, 0, ?, ?, 0, NOW(), NOW())`,
      {
        replacements: [
          id_configuracion,
          p.nombre,
          p.descripcion,
          p.material,
          p.precio,
          idCat,
          p.stock,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }

  // ── 3. Personalización de la cuenta ──
  const asistente = arg('asistente', 'Sofía');
  const persos = await db.query(
    `SELECT id, nombre_asistente_publico, instrucciones_extra
       FROM kanban_columnas_personalizaciones WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const faltantes = persos.filter(
    (p) => !p.nombre_asistente_publico || !p.instrucciones_extra,
  );
  console.log(
    faltantes.length
      ? `+ personalización: asistente ("${asistente}") y reglas genéricas en ${faltantes.length} columna(s)`
      : `${SIN_CAMBIO} personalización: ya está completa`,
  );
  if (aplicar && faltantes.length) {
    await db.query(
      `UPDATE kanban_columnas_personalizaciones
          SET nombre_asistente_publico = COALESCE(NULLIF(nombre_asistente_publico, ''), ?),
              instrucciones_extra = COALESCE(NULLIF(instrucciones_extra, ''), ?)
        WHERE id_configuracion = ?`,
      {
        replacements: [asistente, REGLAS_GENERICAS, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
  }

  if (!aplicar) {
    console.log(`\n${WARN}SIMULACIÓN — nada se escribió (agrega --aplicar)\n`);
    process.exit(0);
  }

  // ── 4. Subir el catálogo a los asistentes ──
  console.log('\nSincronizando catálogo con los asistentes…');
  const r = await syncCatalogoTodasColumnasConfig(id_configuracion, {
    logger: async (...a) => console.log('   ', ...a),
  });
  const okCols = (r?.resultados || []).filter((x) => x.ok).length;
  const falló = (r?.resultados || []).filter((x) => !x.ok);
  console.log(
    `   ${okCols} columna(s) sincronizada(s)${falló.length ? ` · ${falló.length} con error (reintenta el script)` : ''}`,
  );

  console.log(
    `\n${OK} catálogo listo. Los textos son de EJEMPLO:` +
      `\n   reemplázalos por los del centro real antes de mostrárselo a la clienta.\n`,
  );
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.response?.data?.error?.message || e.message);
  process.exit(1);
});
