'use strict';

/* Contexto que se le entrega al asistente de una columna antes de responder:
   sedes y disponibilidad del calendario.

   Vive aquí y no dentro de kanban_ia.service porque el chat de prueba
   (kanban_columnas/chat_prueba) mandaba SOLO las instrucciones, sin ninguno de
   estos bloques. El prompt le dice al bot "decide la cobertura con la lista de
   sedes que se te entrega" y en la prueba esa lista nunca llegaba: el bot daba
   por fuera de cobertura a todo el mundo, incluso a la ciudad donde el negocio
   sí tiene sede. Un solo constructor para los dos caminos evita que vuelvan a
   separarse. */

const { db } = require('../database/config');
const { enlaceUbicacionSede } = require('./ubicacionSede');
const { normalizarUrlMedia } = require('./urlsMedia');
const { ofrecerMedia, mediaYaEnviada } = require('./dedupeMedia');

/* Palabras que no distinguen un producto de otro. Sin esto, "quiero información
   del tratamiento facial" traería cualquier cosa que diga "facial". */
const VACIAS = new Set([
  'de','del','la','el','los','las','un','una','unos','unas','y','o','para','por',
  'con','sin','en','al','que','qué','me','mi','tu','su','es','son','the','info',
  'informacion','información','precio','precios','cuanto','cuánto','cuesta',
  'vale','quiero','necesito','busco','hola','buenas','tienen','tienes','hay',
  'sobre','favor','porfa','gracias','sesion','sesión','servicio','producto',
  /* "tipo" está en un montón de nombres de catálogo ("Cable Tipo C 240W") y no
     distingue nada por sí sola: como palabra de búsqueda ataba productos al
     azar. Las otras son relleno que escribe el sistema cuando llega un mensaje
     que no se puede leer, y con eso alcanzaba para inyectarle al bot la ficha
     de un producto que nadie mencionó. */
  'tipo','mensaje','mensajes','reconocido','eliminado','usuario',
  /* Demostrativos y muletillas de aceptación. Caso real (config 285): el
     cliente entró por la Máscara Táctica, aceptó el combo con un "Está bien" y
     el bot le cambió al "Deja de Roncar Desde ESTA Noche": la palabra "esta"
     coincidió con el nombre y se le inyectó la ficha completa —foto, video y
     precios— del producto equivocado justo al cierre. "Estas" repitió el match
     por el plural. Decir que sí a una compra no puede nombrar un producto. */
  'esta','este','esto','estas','estos','esa','ese','eso','esas','esos',
  'aquel','aquella','bien','bueno','buena','buenos','listo','lista','dale',
  'claro','mismo','misma','ahora','ahi','aqui','alli','asi','tambien',
  'entonces','quisiera','dame','deme',
]);

/* La lista de arriba es la base curada (cada palabra tiene su incidente). Esta
   otra es MEDIDA: scripts/generarPalabrasFrecuentes.js recorre los mensajes de
   clientes de todas las cuentas y trae las palabras que son frecuentes en la
   mayoría de ellas — gramática, cortesía, y las ciudades/couriers ("quito",
   "servientrega") que un cliente escribe como respuesta suelta. Una palabra
   frecuente en TODAS las verticales no distingue productos en ninguna; una que
   solo es frecuente donde se vende ese producto ("licuadora", "casa") no entra
   y sigue matcheando. Así la lista deja de curarse a mano: se regenera con el
   script cuando haga falta. Sin el JSON, el sistema funciona con la base. */
try {
  for (const p of require('./palabrasFrecuentesChat.json')) VACIAS.add(p);
} catch {
  /* sin lista generada: la base alcanza */
}

const normalizar = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const palabrasUtiles = (s) =>
  normalizar(s)
    .split(' ')
    .filter((t) => t.length > 2 && !VACIAS.has(t));

/* ¿Son la misma palabra, contando el plural?
   ─────────────────────────────────────────────────────────────
   Antes esto era "una empieza con la otra" (con mínimo de 5 letras), pensado
   para que "libro" y "libros" fueran lo mismo. Pero un prefijo NO es un
   plural: "cabeza" empieza a "cabezal", y con eso una clienta que preguntó si
   había protección "para la cabeza" (del bebé de la mochila antigolpes)
   recibió la ficha, la foto y los combos del "Cabezal de ducha masajeadora".
   Caso real de la config 285, con intervención humana para recuperar la venta.

   Ahora solo se aceptan iguales o formas de plural en s/es. Se compara
   quitando esa terminación de los DOS lados, así "mochilas" casa con
   "mochila" y "relojes" con "reloj", pero "cabeza" ya no casa con "cabezal":
   la 'l' final no es un plural. */
const raizSingular = (t) => {
  if (t.length >= 6 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length >= 5 && t.endsWith('s')) return t.slice(0, -1);
  return t;
};

const mismaPalabra = (a, b) =>
  a === b || (a.length >= 4 && b.length >= 4 && raizSingular(a) === raizSingular(b));

/**
 * @param {number} id_configuracion
 * @param {Array<{tipo_accion:string}>} acciones  acciones activas de la columna
 * @param {(msg:string)=>any} [log]
 * @param {{mensaje?:string}} [opts]  mensaje del cliente, para catálogos grandes
 * @returns {Promise<string>} bloque de contexto (puede venir vacío)
 */
async function construirContextoColumna(id_configuracion, acciones, log, opts) {
  const say = typeof log === 'function' ? log : () => {};
  const tiene = (t) => (acciones || []).some((a) => a.tipo_accion === t);
  const mensajeCliente = String(opts?.mensaje || '');
  let bloque = '';

  /* ── Regla de avance ────────────────────────────────────────
     El tic más reportado de los bots (todas las verticales, ~0.3% de los
     mensajes IA medido el 2026-08-18): re-confirmar lo ya aceptado — el
     cliente dice "sí" y el bot contesta "¿estás de acuerdo?", "¿procedo?",
     "¿me confirmas?", y la venta se queda dando vueltas hasta que el contador
     de turnos_sin_avance la escala a asesor. Los prompts ya lo prohíben y el
     modelo igual recae, así que la regla viaja acá: este bloque entra al
     INICIO del input de CADA turno, donde la atención del modelo es más
     fuerte que en un prompt de miles de tokens.

     La redacción es neutral de vertical a propósito ("el paso siguiente de tu
     flujo"): en ventas el paso final es el resumen de cierre con su tag, en
     citas es el bloque de agendamiento — cada prompt define el suyo. Cambiarla
     obliga a probar en las DOS verticales (dropshipping y servicios), como
     todo lo de este archivo. */
  bloque +=
    `[REGLA DE AVANCE — vale toda la conversación]\n` +
    `Cada mensaje tuyo AVANZA al paso siguiente de tu flujo. Cuando el ` +
    `cliente responde "sí", "ok", "dale", "esa" o similar a tu última ` +
    `pregunta, ese punto queda resuelto de forma DEFINITIVA: ejecuta el paso ` +
    `siguiente, sin repetir la información aceptada y sin volver a ` +
    `preguntarla con otras palabras ("¿estás de acuerdo?", "¿procedo?", ` +
    `"¿te parece bien?", "¿me confirmas?" después de un sí son errores). ` +
    `Cada dato o elección se pregunta y se acepta UNA sola vez. Si con esa ` +
    `respuesta ya no falta ningún dato, tu mensaje ES el paso final que ` +
    `dicta tu flujo (el resumen de cierre con su etiqueta, el bloque de ` +
    `agendamiento, o el que corresponda) — nunca una confirmación más.\n\n`;

  /* Dónde se hace la cita de esta columna. Es la misma llave que lee
     procesarAgendarCita, y se lee acá porque cambia lo que hay que contarle al
     modelo: con la cita en el local, la sede es el lugar; con la cita en el
     ítem —una visita a un inmueble— la sede es solo la oficina que coordina, y
     decirle que cite "en la sede" lo lleva a citar en la oficina a alguien que
     quiere ver una casa. */
  const configDe = (tipo) => {
    const accion = (acciones || []).find((a) => a.tipo_accion === tipo);
    try {
      let cfg = accion?.config;
      if (!cfg) return {};
      while (typeof cfg === 'string') cfg = JSON.parse(cfg);
      return cfg && typeof cfg === 'object' ? cfg : {};
    } catch {
      return {};
    }
  };
  const cfgCita = configDe('agendar_cita');
  const citaEnElItem = cfgCita.lugar_cita === 'item';
  const citaEsSolicitud = cfgCita.modo === 'solicitud';

  /* Con la cita en modo solicitud, lo que el bot NO puede hacer es darla por
     hecha. Escribe el mismo bloque de siempre —es lo que registra el pedido—
     pero su línea de cierre cambia por completo: prometer "nos vemos el
     jueves" y que después el horario no dé es plantar a alguien en una puerta.

     Va acá y no en el prompt porque el modo se cambia desde el editor de la
     acción con un selector. Si el texto viviera en las instrucciones, cambiar
     el selector dejaría al bot confirmando citas que ya nadie está creando. */
  if (citaEsSolicitud && tiene('agendar_cita')) {
    bloque +=
      `⏳ LAS CITAS DE ESTA ETAPA NO QUEDAN CONFIRMADAS EN EL ACTO.\n` +
      `Un asesor revisa el horario y lo confirma después. Tú levantas el pedido ` +
      `igual —mismo bloque, mismos datos, día y hora incluidos— pero tu línea de ` +
      `cierre NO puede dar la cita por hecha.\n` +
      `PROHIBIDO: "listo, nos vemos el jueves", "quedó agendada", "te espero a ` +
      `las 3", "confirmada".\n` +
      `ASÍ SÍ: "listo, ya quedó registrada tu solicitud para el jueves a las ` +
      `15:00; un asesor te confirma el horario en un rato".\n` +
      `Si te pregunta si ya está confirmada, dile la verdad: está en revisión y ` +
      `le confirman hoy. No inventes un plazo exacto que no controlas.\n\n`;
    say(`✅ Modo solicitud: instrucción de no confirmar inyectada`);
  }

  /* ── Quién está escribiendo ─────────────────────────────────
     El teléfono llega en el webhook: es el número desde el que la persona
     escribe. Pedírselo es absurdo —y peor, el bot terminaba escribiendo
     "Teléfono: no registra" en el bloque de agendamiento y la cita quedaba sin
     forma de contactar a nadie. Con el dato a la vista tampoco se traba cuando
     la clienta responde "a este mismo número". */
  if (opts?.id_cliente) {
    try {
      const [cli] = await db.query(
        `SELECT nombre_cliente, apellido_cliente, celular_cliente
           FROM clientes_chat_center WHERE id = ? LIMIT 1`,
        { replacements: [opts.id_cliente], type: db.QueryTypes.SELECT },
      );

      if (cli?.celular_cliente) {
        const nombre = [cli.nombre_cliente, cli.apellido_cliente]
          .filter(Boolean)
          .join(' ')
          .trim();

        /* Estos datos son el RESPALDO, no el atajo. El nombre de WhatsApp puede
           ser un apodo o el de quien le prestó el teléfono, y el número desde el
           que escribe no siempre es donde quiere que la llamen. Se preguntan
           igual; esto solo existe para cuando la persona contesta "a este mismo
           número" y hay que saber cuál es.

           ⚠️ CUIDADO CON LA REDACCIÓN de este texto: se re-inyecta EN CADA
           turno, al inicio del input, en TODAS las verticales. La versión
           anterior decía "PREGÚNTALE SIEMPRE su nombre y su teléfono antes de
           agendar. No los des por sabidos" y ese imperativo, releído turno a
           turno, hacía que el bot volviera a pedir y a confirmar datos que el
           cliente ya había dado — chocaba con la regla "cada dato se pide una
           sola vez" de los prompts, y de "agendar" salían frases de citas en
           flujos de venta ("voy a proceder a agendar tu pedido"). Medido: el
           tic de re-confirmación subió de ~0.21% a ~0.33% de los mensajes IA
           tras entrar esa línea el 2026-07-31, en todas las cuentas. Acá se
           describe QUÉ SON los datos, nunca se le ordena al bot preguntar. */
        bloque +=
          `\n\n[DATOS TÉCNICOS DEL CONTACTO — solo de respaldo]\n` +
          `Número desde el que escribe: ${cli.celular_cliente}\n` +
          (nombre ? `Nombre de su perfil de WhatsApp: ${nombre}\n` : '') +
          `Son datos del canal, NO confirmados por el cliente: el nombre del ` +
          `perfil puede ser un apodo y el número puede no ser donde quiere que ` +
          `la contacten, así que no los uses como si el cliente te los hubiera ` +
          `dicho. Su nombre y su teléfono se piden UNA sola vez, en el paso del ` +
          `flujo que corresponda — y si ya los dio en esta conversación, NO se ` +
          `los vuelvas a pedir ni a confirmar.\n` +
          `Estos datos de respaldo solo se usan cuando la persona misma diga ` +
          `"a este mismo número", "desde donde te escribo" o "el mismo de acá": ` +
          `ahí no preguntas de nuevo, usas el de arriba y sigues.\n\n`;
      }
    } catch (e) {
      say(`⚠️ contexto datos del cliente: ${e.message}`);
    }
  }

  // ── Sedes / sucursales ──────────────────────────────────────
  // Deja de ser criterio del modelo saber si alguien está dentro de cobertura:
  // se le entrega la lista real de sedes con su ciudad, dirección y horario.
  if (tiene('contexto_establecimientos')) {
    try {
      const sedes = await db.query(
        `SELECT id, nombre, ciudad, provincia, direccion, referencia,
                google_maps_url, telefono, horario
           FROM establecimientos_chat_center
          WHERE id_configuracion = ? AND activo = 1 AND eliminado = 0
          ORDER BY orden ASC, id ASC`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );

      if (sedes.length) {
        /* Quién atiende en cada sede. Es lo que le da capacidad a la agenda y,
           si el negocio les puso nombre, lo que permite que la clienta pida con
           quién quiere atenderse. */
        const profesionales = await db.query(
          `SELECT id_establecimiento, nombre FROM profesionales_chat_center
            WHERE id_configuracion = ? AND activo = 1 AND eliminado = 0
            ORDER BY orden ASC, id ASC`,
          { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
        );
        const porSede = new Map();
        profesionales.forEach((p) => {
          const k = Number(p.id_establecimiento);
          if (!porSede.has(k)) porSede.set(k, []);
          porSede.get(k).push(p.nombre);
        });

        const lineas = sedes.map((s) => {
          const partes = [
            `- ${s.nombre} (${s.ciudad}${s.provincia ? `, ${s.provincia}` : ''})`,
          ];
          if (s.direccion) partes.push(`  Dirección: ${s.direccion}`);
          if (s.referencia) partes.push(`  Referencia: ${s.referencia}`);
          const mapa = enlaceUbicacionSede(s);
          if (mapa) partes.push(`  Ubicación en Google Maps: ${mapa}`);
          if (s.telefono) partes.push(`  Teléfono: ${s.telefono}`);
          if (s.horario) partes.push(`  Horario: ${s.horario}`);

          const quienes = porSede.get(Number(s.id)) || [];
          if (quienes.length) {
            partes.push(
              `  Atienden aquí (${quienes.length} a la vez): ${quienes.join(', ')}`,
            );
          }
          return partes.join('\n');
        });

        bloque +=
          `🏢 ${citaEnElItem ? 'Nuestras oficinas' : 'Sedes donde atendemos'} ` +
          `(ÚNICAS ciudades con cobertura):\n${lineas.join('\n')}\n\n` +
          `Si la persona escribe desde una ciudad que NO está en esta lista, está fuera de cobertura.\n` +
          (citaEnElItem
            ? /* La oficina coordina; el lugar de la cita es el inmueble. Sin
                 decirlo así, el modelo cita en la oficina a quien quiere ver una
                 casa: es lo que dice la lista que tiene delante. */
              `OJO CON EL LUGAR: la cita NO se hace en la oficina. Se hace EN el ` +
              `inmueble que la persona va a ver, y el sistema le pone la ` +
              `dirección de ese inmueble a la cita. La oficina es solo la ` +
              `agenda de quien lo va a mostrar.\n` +
              `Por eso, al agendar, lo que importa es el nombre EXACTO del ` +
              `inmueble en "Servicio que desea": de ahí sale a dónde va a llegar ` +
              `la persona. La línea de la oficina puedes omitirla; si la pones, ` +
              `usa el nombre exacto de la lista.\n` +
              `Nunca escribas tú una dirección: la pone el sistema desde la ficha ` +
              `del inmueble. Una dirección inventada manda a alguien a otro barrio.\n`
            : `Al agendar, usa el nombre EXACTO de la sede tal como aparece aquí.\n` +
              `Cuando pregunten cómo llegar, o al confirmar una cita, pega el enlace de ` +
              `Google Maps de esa sede tal cual, en su propia línea y sin acortarlo ni ` +
              `cambiarlo. Si una sede no tiene enlace, da la dirección y la referencia.\n`) +
          (profesionales.length
            ? `Si la persona pide atenderse con alguien en particular, agrega al bloque ` +
              `de agendamiento una línea "👩 Atiende: <nombre exacto>". Si no pide a ` +
              `nadie, no la pongas: se le asigna quien esté libre.\n\n`
            : '\n');
        say(`✅ Contexto establecimientos inyectado (${sedes.length})`);
      } else {
        /* Sin sedes cargadas el silencio es la peor respuesta: el prompt sigue
           diciendo "si su ciudad no está en la lista, está fuera de cobertura"
           y una lista vacía deja fuera a todo el mundo. Se lo decimos explícito
           para que no descarte a nadie por ubicación. */
        bloque +=
          `🏢 Sedes: la cuenta todavía no tiene ninguna sede cargada.\n` +
          `NO clasifiques a nadie como fuera de cobertura ni preguntes por la ciudad ` +
          `como filtro: no tienes con qué compararla. Atiende la consulta normal y, ` +
          `si hace falta saber dónde atendemos, pásalo a un asesor.\n\n`;
        say(`⚠️ contexto_establecimientos activo pero sin sedes cargadas`);
      }
    } catch (err) {
      say(`⚠️ Error contexto_establecimientos: ${err.message}`);
    }
  }

  /* ── Productos que exigen variedad ──────────────────────────
     Qué producto es VARIABLE es un dato binario del que depende una regla
     absoluta del prompt ("jamás cierres sin la variedad"), pero hasta ahora ese
     dato solo viajaba dentro del catálogo que se consulta con file_search.
     Recuperar un fragmento es probabilístico: si el trozo que vuelve no incluye
     la línea "PRODUCTO VARIABLE" —o si el bot ya habló del producto antes y no
     vuelve a buscar al cerrar— concluye que es simple, cierra sin preguntar el
     color, y el auto-orden se cae con "falta elegir la variedad".

     Acá va por el canal determinista: la lista completa siempre viaja en el
     mensaje, cueste lo que cueste el retrieval. Es corta (son pocos productos
     variables por cuenta) y evita el modo de fallo más caro del sistema. */
  /* ── Lista de precios ────────────────────────────────────────
     Los precios viven en el catálogo que se consulta con file_search, y eso los
     vuelve una lotería: en la misma conversación el bot cotizó "$150 la
     espalda" (un servicio que no existe) y minutos después dijo que no tenía
     información de precios. Inventar un precio es peor que no darlo: el negocio
     queda obligado a sostenerlo o a desdecirse frente al cliente.

     Con pocos ítems la lista entra entera en el mensaje y deja de depender del
     retrieval. Con catálogos grandes (dropshipping) no cabe, así que ahí se
     mantiene file_search como hasta ahora. */
  if (tiene('contexto_productos')) {
    try {
      const items = await db.query(
        `SELECT id, nombre, tipo, precio, duracion, descripcion,
                imagen_url, video_url, sesiones_min, sesiones_max,
                combos_producto, direccion, sector, ciudad, google_maps_url,
                galeria_url, atributos_json
           FROM productos_chat_center
          WHERE id_configuracion = ? AND eliminado = 0
          ORDER BY tipo DESC, nombre`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );

      /* Qué ficha usa esta cuenta. Sin preset configurado devuelve vacío y
         `atributos_json` no se mira siquiera: un catálogo de dropshipping no
         tiene por qué recibir "Dormitorios" en el prompt. */
      const { fichaLegible, resolverPreset } = require('./fichaPresets');
      const presetFicha = await resolverPreset(db, id_configuracion);
      const fichaDelItem = (raw) =>
        presetFicha ? fichaLegible(presetFicha, raw) : '';

      /* Precios por cantidad. En dropshipping el combo ES el negocio: se vende
         "2 x $28.99" y no una unidad suelta. La lista salía solo con el precio
         unitario y encima decía que era lo ÚNICO cotizable, así que el bot
         dejaba de ofrecer los combos que el cliente tiene cargados. */
      const combosDe = (raw) => {
        if (!raw) return [];
        try {
          const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!Array.isArray(arr)) return [];
          return arr
            .map((c) => ({
              cantidad: Number(c?.cantidad),
              precio: Number(c?.precio),
            }))
            .filter((c) => c.cantidad > 1 && c.precio > 0)
            .sort((a, b) => a.cantidad - b.cantidad);
        } catch {
          return [];
        }
      };

      /* Con catálogo chico va la lista entera. Con uno grande no cabe —200
         productos son ~3.000 tokens en CADA mensaje— así que se mandan solo los
         que la persona nombró en su mensaje. Es el mismo principio: que el dato
         que se necesita ahora llegue seguro, en vez de esperar que el retrieval
         lo encuentre. Lo que no se nombró sigue estando en file_search. */
      const TOPE_LISTA_INLINE = 40;
      const TOPE_COINCIDENCIAS = 6;

      let seleccion = items;
      let parcial = false;

      /* Lo que la persona nombró en ESTE mensaje. De esos se manda además la
         descripción completa: beneficios, qué incluye, garantía. Sin esto el bot
         solo tenía nombre y precio, así que respondía "cuesta $85, ¿la
         compras?" y quedaba en manos de file_search si mencionaba o no los 6
         meses de garantía que están escritos en el catálogo. Justo lo que cierra
         una venta se lo estábamos dejando al azar. */
      const palabrasMsg = palabrasUtiles(mensajeCliente);

      /* Dedupe por nombre: hay catálogos con el mismo producto cargado dos
         veces (la 285 tiene el antironquidos duplicado) y sin esto la ficha y
         la advertencia del 🎯 lo repetían al modelo como si fueran dos. */
      const vistosNombre = new Set();
      const nombrados = (
        palabrasMsg.length
          ? items.filter((i) => {
              const tokens = palabrasUtiles(i.nombre);
              return palabrasMsg.some((p) =>
                tokens.some((t) => mismaPalabra(t, p)),
              );
            })
          : []
      ).filter((i) => {
        const n = normalizar(i.nombre);
        if (vistosNombre.has(n)) return false;
        vistosNombre.add(n);
        return true;
      });

      if (items.length > TOPE_LISTA_INLINE) {
        const palabras = palabrasUtiles(mensajeCliente);
        if (!palabras.length) {
          seleccion = [];
        } else {
          /* Se comparan PALABRAS COMPLETAS, no subcadenas: buscar "set" dentro
             del nombre hacía coincidir "camiSETa" y "corSET", y el bot recibía
             precios de ropa cuando le preguntaban por un juego de cuchillos.
             El plural también cuenta (mismaPalabra): "libro" y "libros" son lo
             mismo, pero "cabeza" y "cabezal" ya no. */
          seleccion = items
            .map((i) => {
              const tokens = palabrasUtiles(i.nombre);
              const aciertos = palabras.filter((p) =>
                tokens.some((t) => mismaPalabra(t, p)),
              ).length;
              return { item: i, aciertos };
            })
            .filter((x) => x.aciertos > 0)
            .sort((a, b) => b.aciertos - a.aciertos)
            .slice(0, TOPE_COINCIDENCIAS)
            .map((x) => x.item);
        }
        parcial = true;
      }

      /* La lista se EMITE más abajo, después de resolver el producto en juego:
         su fila va siempre, aunque el mensaje de ahora no lo nombre. */
      const emitirListaPrecios = () => {
        if (!seleccion.length) return;
        const linea = (i) => {
          const precio =
            Number(i.precio) > 0 ? `$${Number(i.precio).toFixed(2)}` : 'consultar';
          const dur =
            String(i.tipo).toLowerCase() === 'servicio' && Number(i.duracion) > 0
              ? ` · ${i.duracion} min`
              : '';
          const que =
            String(i.tipo).toLowerCase() === 'servicio' ? 'servicio' : 'producto';

          const combos = combosDe(i.combos_producto);
          const packs = combos.length
            ? ` · combos: ${combos
                .map((c) => `${c.cantidad} x $${c.precio.toFixed(2)}`)
                .join(', ')}`
            : '';

          return `- ${i.nombre} — ${precio}${dur} (${que})${packs}`;
        };

        bloque +=
          (parcial
            ? `💲 Precios de los productos de esta conversación (tomados del catálogo):\n`
            : `💲 Precios vigentes (esto es lo ÚNICO que puedes cotizar):\n`) +
          seleccion.map(linea).join('\n') +
          `\n` +
          (parcial
            ? `Son el producto del que vienen hablando y lo que coincide con su ` +
              `mensaje; el resto del catálogo lo tienes disponible para consultar. `
            : ``) +
          /* Antes esto decía "se confirma en la valoración". El modelo tomaba esa
             palabra y la pegaba al único ítem del catálogo que se llama parecido
             —"Valoración facial"— así que a quien preguntaba por depilación de
             zona grande le ofrecía una valoración FACIAL. Se nombra el camino sin
             nombrar un servicio. */
          /* Los combos SÍ se ofrecen: son el precio por llevar más de uno y en
             dropshipping es de donde sale el margen. Antes esta misma frase los
             metía en la bolsa de "no cotices paquetes" y el bot terminaba
             vendiendo unidades sueltas. */
          /* Para qué sirve la lista y para qué NO. Sin decirlo, un cliente que
             contesta con un número hace que el modelo lo busque acá y cambie de
             producto: pasó con "solo la de $25", que encontró otro artículo de
             $25.00 exacto mientras el suyo costaba $24.99. La lista responde
             "cuánto vale ESTO", no "qué es lo que vale tanto". */
          `Esta lista sirve para decir cuánto cuesta algo que YA está ` +
          `identificado por su nombre. NUNCA para adivinar de qué producto habla ` +
          `alguien a partir de un número: si te dice "la de $25" y el producto ` +
          `del que venían hablando cuesta $24.99, está redondeando ESE — no es ` +
          `otro que cueste $25 exactos. Ante la duda, pregunta cuál antes de ` +
          `cotizar.\n` +
          `Los combos que ves ahí son precios reales por cantidad: ofrécelos ` +
          `cuando la persona quiera llevar más de uno, y respétalos tal cual.\n` +
          `Si te preguntan por algo que NO está en esta lista —otro producto, ` +
          `otra presentación, una cantidad sin combo cargado— NO inventes un ` +
          `precio ni lo estimes, y NO lo reemplaces por otro parecido del ` +
          `catálogo: dile con naturalidad que ese valor te lo confirma una ` +
          `compañera y pásalo a un asesor. Un precio inventado obliga al negocio ` +
          `a sostenerlo o a desdecirse.\n\n`;
        say(
          `✅ Precios inyectados (${seleccion.length}${parcial ? ` de ${items.length}, por coincidencia` : ''})`,
        );
      };

      /* ── De qué producto vienen hablando ─────────────────────
         La lista de precios completa viaja en cada mensaje, y eso tiene un
         efecto que no se ve venir: cuando el cliente contesta con un NÚMERO, el
         modelo lo busca en la lista en vez de mirar la conversación.

         Caso real (config 548): el cliente entró por un anuncio de la pistola
         rociadora de $24.99, el bot la cotizó bien, y cuando dijo "solo la de
         $25" —redondeando— encontró "Cooler para Laptop — $25.00", que calzaba
         exacto, y le cotizó el cooler. Venta perdida. En ese catálogo hay DIEZ
         productos a $24.99: sin saber de cuál venían hablando, un precio no
         alcanza para identificar nada.

         Se resuelve con el dato que sí tenemos: qué producto ya se nombró en
         esta conversación. Va SIEMPRE que se conozca, incluso cuando el mensaje
         de ahora parece nombrar otro: el selector de la ficha empareja por
         palabras sueltas, así que un "necesito soporte" hace saltar el "Cooler
         SOPORTE Laptop" sin que nadie haya cambiado de producto. Teniendo los
         dos datos y la regla, el modelo decide bien; con uno solo, adivina.

         Se declara fuera del bloque porque la lista de precios y la ficha (más
         abajo) lo necesitan: el producto en juego siempre lleva su fila y su
         ficha, aunque el mensaje de ahora no lo nombre. */
      let enJuego = null;
      if (opts?.id_cliente && items.length) {
        try {
          /* opts.historial existe por el simulador (simular_conversacion.js):
             sus turnos no se guardan en mensajes_clientes, así que sin esto el
             ancla no puede seguir la conversación simulada y la prueba deja de
             parecerse a producción. Mismo formato y mismo orden que la
             consulta: {rol_mensaje, texto_mensaje}, del más nuevo al más
             viejo. En producción no llega y se lee la BD. */
          const previos = Array.isArray(opts?.historial)
            ? opts.historial
            : await db.query(
            `SELECT rol_mensaje, texto_mensaje FROM mensajes_clientes
              WHERE id_configuracion = ? AND celular_recibe = ?
                AND texto_mensaje IS NOT NULL AND texto_mensaje <> ''
              /* Ventana amplia a propósito: el producto suele nombrarse en el
                 PRIMER mensaje —el del anuncio— y después la conversación se
                 llena de precios, ciudad y forma de pago. Con una ventana corta
                 ese primer mensaje se cae y solo quedan los del bot, que es
                 justo lo que no queremos usar como fuente. */
              ORDER BY id DESC
              LIMIT 40`,
            {
              replacements: [id_configuracion, String(opts.id_cliente)],
              type: db.QueryTypes.SELECT,
            },
          );

          /* Se busca por nombre completo contenido en el texto: es como lo
             escribe el bot al cotizar y como llega el anuncio en el mensaje de
             entrada. Se piden más de 8 caracteres para que un nombre corto y
             genérico no matchee media conversación. */
          const buscarEn = (mensajes) => {
            for (const m of mensajes) {
              const texto = normalizar(m.texto_mensaje);
              const candidatos = items.filter((i) => {
                const n = normalizar(i.nombre);
                return n.length > 8 && texto.includes(n);
              });
              if (candidatos.length) {
                /* El nombre MÁS LARGO gana: hay catálogos con "Corrector de
                   Postura" y "Corrector de Postura Pro" a la vez, y el anuncio
                   del Pro contiene los dos nombres. Quedarse con el primero
                   que aparezca ataba la versión equivocada. Mismo criterio que
                   elegirItemDelCatalogo en el agendamiento. */
                return candidatos.sort(
                  (a, b) =>
                    normalizar(b.nombre).length - normalizar(a.nombre).length,
                )[0];
              }
            }
            return null;
          };

          /* El anuncio se resuelve con el MISMO resolver que usa el webhook
             (mapa por source_id → texto). Antes acá se buscaba por contención
             del título, y los dos caminos podían no coincidir: el webhook le
             inyectaba un producto y este bloque anclaba otro. Una sola verdad. */
          let desdeAnuncio = null;
          try {
            const [ultimoAd] = await db.query(
              `SELECT headline, source_id FROM cliente_productos_ad
                WHERE id_cliente = ? ORDER BY id DESC LIMIT 1`,
              { replacements: [opts.id_cliente], type: db.QueryTypes.SELECT },
            );

            if (ultimoAd) {
              const {
                resolverProductoAnuncio,
              } = require('./webhook_whatsapp/buscar_producto_referral');
              const r = await resolverProductoAnuncio(
                id_configuracion,
                ultimoAd.headline,
                ultimoAd.source_id,
              );
              if (r?.producto?.id) {
                desdeAnuncio =
                  items.find((i) => Number(i.id) === Number(r.producto.id)) ||
                  null;
              }
            }

            /* Respaldo para clientes viejos sin fila en cliente_productos_ad:
               el título guardado en el propio cliente, por contención. */
            if (!desdeAnuncio) {
              const [cliRow] = await db.query(
                `SELECT ultimo_producto_ad FROM clientes_chat_center
                  WHERE id = ? LIMIT 1`,
                { replacements: [opts.id_cliente], type: db.QueryTypes.SELECT },
              );
              if (cliRow?.ultimo_producto_ad) {
                desdeAnuncio = buscarEn([
                  { texto_mensaje: cliRow.ultimo_producto_ad },
                ]);
              }
            }
          } catch (e) {
            say(`⚠️ resolviendo anuncio del cliente: ${e.message}`);
          }

          /* El producto en juego es la señal fuerte MÁS RECIENTE, no una
             jerarquía fija de fuentes. Con el anuncio ganando siempre, el
             ancla se quedaba vieja: el cliente preguntaba por la rodillera,
             el bot la cotizaba, y al turno siguiente el sistema volvía a
             servirle el producto del anuncio — arrastrando al modelo de
             vuelta a un producto que ya nadie quería.

             Recorriendo del mensaje más nuevo al más viejo:
             - Lo que el CLIENTE escribió con el nombre completo vale siempre.
             - Lo que nombró el BOT vale solo si el cliente se lo había pedido
               justo antes (alguna palabra de sus 2 mensajes anteriores calza
               con ese nombre). Sin esa validación, un error del bot se ancla
               solo: en la 285 el bot nombró el "Cabezal de ducha" por error y
               una fuente-bot libre lo habría clavado — reforzando el error
               que esto corrige. Y en el caso "Está bien" (el bot saltó al
               antironquidos sin que nadie lo pidiera), la validación falla,
               el ancla se queda con el anuncio y el sistema se corrige solo
               al turno siguiente.
             - Si la conversación no estableció nada, manda el anuncio por el
               que entró: la única señal que no depende de que alguien escriba
               el nombre bien. */
          let porConversacion = null;
          for (let k = 0; k < previos.length && !porConversacion; k++) {
            const m = previos[k];
            const item = buscarEn([m]);
            if (!item) continue;
            if (Number(m.rol_mensaje) === 0) {
              porConversacion = item;
            } else {
              const clientesAntes = previos
                .slice(k + 1)
                .filter((x) => Number(x.rol_mensaje) === 0)
                .slice(0, 2);
              const tokens = palabrasUtiles(item.nombre);
              const pedido = clientesAntes.some((x) =>
                palabrasUtiles(x.texto_mensaje).some((p) =>
                  tokens.some((t) => mismaPalabra(t, p)),
                ),
              );
              if (pedido) porConversacion = item;
            }
          }

          enJuego = porConversacion || desdeAnuncio;

          /* Si lo que se encontró en el historial es lo mismo que la persona
             acaba de nombrar, el bloque no aporta nada: la ficha ya lo dice. */
          const yaEsElDeAhora =
            enJuego &&
            nombrados.length === 1 &&
            normalizar(nombrados[0].nombre) === normalizar(enJuego.nombre);

          if (enJuego && !yaEsElDeAhora) {
            const precio =
              Number(enJuego.precio) > 0
                ? `$${Number(enJuego.precio).toFixed(2)}`
                : 'sin precio cargado';

            bloque +=
              `🎯 EL PRODUCTO DE ESTA CONVERSACIÓN: ${enJuego.nombre} (${precio}).\n` +
              `Es de lo que vienen hablando y sigue siéndolo mientras la persona ` +
              `no pida OTRO con sus palabras.\n` +
              `Un precio, una cantidad o un "sí, quiero" NO cambian de producto. ` +
              `Si dice "la de $25" y este cuesta $24.99, se refiere a ESTE ` +
              `redondeado — no busques en la lista cuál cuesta exactamente $25. ` +
              `Cambiar de producto porque un número calzó mejor es la forma más ` +
              `rápida de perder la venta.\n`;

            if (nombrados.length) {
              /* La ficha de abajo la eligió un emparejamiento por palabras, no
                 una decisión del cliente. Se lo decimos en vez de dejar que lo
                 resuelva por su cuenta. */
              bloque +=
                `OJO: abajo vas a ver la ficha de ` +
                `"${nombrados.map((n) => n.nombre).join('", "')}" porque alguna ` +
                `palabra de su mensaje coincidió con ese nombre. Eso NO es que lo ` +
                `haya pedido. Si de verdad quiere cambiar de producto lo va a ` +
                `decir claro ("mejor quiero el X"); si no, sigue con ` +
                `${enJuego.nombre} y usa esa ficha solo si te pregunta por ella.\n`;
            }

            bloque += `\n`;
            say(`✅ Producto de la conversación: ${enJuego.nombre}`);
          }
        } catch (err) {
          say(`⚠️ Error buscando el producto de la conversación: ${err.message}`);
        }
      }

      /* El producto en juego SIEMPRE lleva su fila en la lista, aunque el
         mensaje de ahora no lo nombre. En el incidente del "Está bien" (285)
         el producto equivocado llegó con precio, combos y ficha, y el correcto
         solo con la línea del 🎯: al modelo se le pedía decidir bien con el
         material desparejo. Los dos platos llegan servidos. */
      if (
        enJuego &&
        !seleccion.some((i) => normalizar(i.nombre) === normalizar(enJuego.nombre))
      ) {
        seleccion = [enJuego, ...seleccion];
      }
      emitirListaPrecios();

      /* Se registran como OFRECIDAS las medias del producto en juego y de lo
         nombrado en este mensaje: son las únicas urls de catálogo que el
         candado de dedupeMedia deja salir hacia el cliente. Cualquier otra
         —copiada de un fragmento de file_search, de la memoria del hilo o
         inventada— se bloquea en el envío. */
      if (opts?.id_cliente) {
        const ofrecidas = [];
        for (const p of [enJuego, ...nombrados].filter(Boolean)) {
          if (p.imagen_url) ofrecidas.push(normalizarUrlMedia(p.imagen_url));
          if (p.video_url) ofrecidas.push(normalizarUrlMedia(p.video_url));
        }
        if (ofrecidas.length) ofrecerMedia(opts.id_cliente, ofrecidas);
      }

      /* Ficha completa de lo que nombró. Va aparte de la lista de precios para
         que no se mezcle: la lista sirve para no inventar precios, esto sirve
         para vender. Se corta cada descripción porque alguna cuenta escribe
         media página y no vale la pena pagarla en cada mensaje. */
      const TOPE_DESC = 700;
      /* Entra el ítem que tenga ALGO que contar: descripción, ficha del nicho,
         ubicación o álbum. Antes se pedía descripción sí o sí, y un inmueble
         importado sin texto —o cargado a las apuradas con solo los datos duros—
         se quedaba sin bloque: el bot tenía su dirección y sus metros en la BD y
         respondía "déjame confirmarlo con un asesor". */
      /* El producto en juego encabeza la ficha aunque el mensaje de ahora no
         lo nombre: es el que se está vendiendo, y su material tiene que llegar
         tan servido como el de cualquier coincidencia de palabras. */
      const fuentesFicha = enJuego
        ? [
            enJuego,
            ...nombrados.filter(
              (i) => normalizar(i.nombre) !== normalizar(enJuego.nombre),
            ),
          ]
        : nombrados;
      const conFicha = fuentesFicha
        .filter((i) =>
          [
            String(i.descripcion || '').trim(),
            fichaDelItem(i.atributos_json),
            String(i.direccion || i.sector || i.ciudad || '').trim(),
            String(i.galeria_url || '').trim(),
          ].some(Boolean),
        )
        .slice(0, 3);

      if (conFicha.length) {
        /* La foto o el video vende más que cualquier párrafo, y ya estaban
           cargados en el catálogo: lo que faltaba era que el bot los tuviera a
           la vista. Se mandan con las etiquetas que el motor sabe extraer para
           convertirlas en archivos de WhatsApp de verdad; si van como texto
           suelto, al cliente le llega un link pelado.

           SOLO para lo nombrado EN ESTE mensaje. La ficha del producto en
           juego viaja todos los turnos, pero sus líneas de media no: la foto
           ya salió cuando se habló de él por primera vez (por el referral o al
           nombrarlo), y repetir "📷 imagen: <url>" en un turno sin contenido
           ("Está bien") hizo que el modelo respondiera "parece que has subido
           archivos" — leyó las urls como adjuntos del cliente. */
        const nombradoAhora = (i) =>
          nombrados.some((n) => normalizar(n.nombre) === normalizar(i.nombre));

        /* ¿La foto de este ítem ya salió hacia este chat? Se pregunta con EL
           MISMO criterio del filtro de envío (mediaYaEnviada, en dedupeMedia):
           tener dos criterios era el bug — el modelo anunciaba "aquí tienes la
           foto", el filtro la callaba por repetida, y al cliente le llegaba la
           promesa sin la foto. Sabiéndolo, el modelo no la anuncia. */
        const yaEnviada = new Map();
        if (opts?.id_cliente) {
          for (const i of conFicha) {
            const urlRef = i.imagen_url || i.video_url;
            if (!urlRef) continue;
            try {
              yaEnviada.set(
                normalizar(i.nombre),
                await mediaYaEnviada({
                  id_cliente: opts.id_cliente,
                  id_configuracion,
                  url: normalizarUrlMedia(urlRef),
                }),
              );
            } catch {
              /* sin el dato se comporta como siempre: propone la foto y el
                 filtro de envío decide */
            }
          }
        }
        const fotoYaSalio = (i) => yaEnviada.get(normalizar(i.nombre)) === true;

        const conMedia = conFicha.filter(
          (i) => (i.imagen_url || i.video_url) && nombradoAhora(i) && !fotoYaSalio(i),
        );

        bloque +=
          `📋 Ficha de los productos de esta conversación — úsala para responderle:\n\n` +
          conFicha
            .map((i) => {
              // Puede venir vacía: ahora entran ítems que solo tienen ficha o
              // ubicación. `String(null)` daría el texto "null" al modelo.
              const desc = String(i.descripcion || '')
                .trim()
                .slice(0, TOPE_DESC);
              /* Se normalizan antes de dárselas al modelo: él las copia tal
                 cual en la etiqueta, y si llevan espacios —las de Dropi los
                 traen— el extractor las corta en el primero y a Meta le llega
                 un link roto que nunca se entrega. */
              let media = '';
              if (fotoYaSalio(i) && (i.imagen_url || i.video_url)) {
                /* El dato que solo el sistema sabe: la foto ya está en el
                   chat. Sin esto el modelo la anunciaba y el filtro la
                   callaba — "aquí tienes la foto" sin foto. La instrucción es
                   NO hablar de la foto en absoluto: decir "está más arriba"
                   puede sonar cortante. */
                media =
                  `  📷 Su foto ya se le envió en esta conversación: NO la ` +
                  `menciones — no la anuncies, no digas que ya la mandaste y ` +
                  `no escribas la etiqueta de nuevo. Responde lo que te ` +
                  `pregunte con normalidad, sin hablar de la foto.`;
              } else if (nombradoAhora(i)) {
                media = [
                  i.imagen_url
                    ? `  📷 imagen: ${normalizarUrlMedia(i.imagen_url)}`
                    : null,
                  i.video_url
                    ? `  🎥 video: ${normalizarUrlMedia(i.video_url)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join('\n');
              }

              /* Dónde queda. Solo aparece en los ítems que tienen ubicación
                 propia —un inmueble, un local—, así que un catálogo de
                 dropshipping no ve ni una línea de esto.
                 El sector va siempre: es lo primero que preguntan y responderlo
                 con "consúltalo con el asesor" pierde la conversación. La
                 dirección exacta va aparte porque no se regala por WhatsApp: se
                 da cuando la visita ya está en pie. */
              const zona = [i.sector, i.ciudad].filter(Boolean).join(', ');
              const ubic = [
                zona ? `  📍 zona: ${zona}` : null,
                i.direccion ? `  🏠 dirección exacta: ${i.direccion}` : null,
                i.google_maps_url
                  ? `  🗺️ ubicación: ${i.google_maps_url}`
                  : null,
              ]
                .filter(Boolean)
                .join('\n');

              /* Ficha del nicho. Sale de los campos que la cuenta configuró en
                 su preset, así que un catálogo sin preset no ve ni una línea.
                 Es la diferencia entre responder "tiene 3 dormitorios y 2
                 baños" con el dato del catálogo y que el modelo lo deduzca de
                 la descripción —que es como terminó inventando metrajes. */
              const ficha = fichaDelItem(i.atributos_json);

              return (
                `▸ ${i.nombre}${desc ? `\n${desc}` : ''}` +
                `${ficha ? `\n  📐 ${ficha}` : ''}` +
                `${ubic ? `\n${ubic}` : ''}` +
                `${media ? `\n${media}` : ''}` +
                `${i.galeria_url ? `\n  🖼️ álbum con más fotos: ${i.galeria_url}` : ''}`
              );
            })
            .join('\n\n') +
          /* Esta ficha se inyecta en CADA mensaje mientras la persona siga
             hablando del mismo ítem. La instrucción decía "cuéntaselo tú, sin
             esperar a que lo pregunte" y el modelo la obedecía cada turno: le
             repetía la descripción entera tres y cuatro veces seguidas. Ahora
             se dice explícitamente que es material de consulta y que solo se
             presenta completo la primera vez. */
          `\n\nEsto es material de consulta, NO un texto para pegar. Preséntalo ` +
          `completo UNA sola vez, la primera vez que le hablas de ese ítem. ` +
          `Después responde solo lo que te pregunte, con el dato puntual: si ya ` +
          `le contaste qué incluye, no se lo vuelvas a contar. Repetir la misma ` +
          `descripción cada mensaje es lo que hace que la gente deje de leer.\n` +
          `Lo que no esté acá —garantías distintas, envíos especiales, ` +
          `descuentos— no te lo inventes.\n`;

        /* Reglas de la ubicación. Van solo si algún ítem nombrado la tiene
           cargada: en un catálogo sin ubicaciones esto sería ruido puro. */
        const conUbicacion = conFicha.filter(
          (i) => i.direccion || i.sector || i.ciudad,
        );

        if (conUbicacion.length) {
          bloque +=
            `\nSOBRE DÓNDE QUEDA. La zona la puedes decir siempre, apenas ` +
            `pregunten: es lo primero que quieren saber y responder "eso te lo ` +
            `confirma un asesor" pierde la conversación.\n` +
            `La dirección exacta y el enlace de ubicación NO. Esos se dan cuando ` +
            `la visita ya está acordada, o cuando la persona va en camino. ` +
            `Antes de eso, con la zona alcanza.\n` +
            `Y solo puedes usar las direcciones que ves acá arriba: si un ítem no ` +
            `tiene, dilo y ofrécete a confirmarlo — jamás la deduzcas de la zona ` +
            `ni la completes con lo que te parece.\n`;
        }

        /* El álbum. El sistema manda UNA foto por ítem —quince mensajes con
           imágenes es spam y WhatsApp no manda álbumes— así que "¿tienes más
           fotos?" se respondía con "te las envía un asesor", que en algo que se
           compra por los ojos es perder la conversación. */
        const conAlbum = conFicha.filter((i) => String(i.galeria_url || '').trim());

        if (conAlbum.length) {
          bloque +=
            `\nSI PIDEN MÁS FOTOS: manda el enlace del álbum que ves arriba, ` +
            `solo y en su propia línea, sin acortarlo ni cambiarlo. Ese enlace ` +
            `NO lleva las etiquetas de imagen: es un link para abrir, no un ` +
            `archivo para enviar.\n` +
            `Mándalo cuando lo pidan, no de entrada: primero la foto principal, ` +
            `que es la que engancha. Si un ítem no tiene álbum, no lo inventes ` +
            `ni mandes el de otro — dile que le pasas más material enseguida y ` +
            `pásalo a un asesor.\n`;
        }

        if (conMedia.length) {
          bloque +=
            `\nMÁNDALE LA FOTO. Cuando le hables de un producto que tenga ` +
            `imagen o video, agrégalo al final de tu mensaje en su propia ` +
            `línea, con este formato EXACTO:\n` +
            `[producto_imagen_url]: <la url de la imagen>\n` +
            `[producto_video_url]: <la url del video>\n` +
            `El sistema lo convierte en la foto o el video de verdad, así que ` +
            `no escribas la url dentro de una frase ni digas "aquí te dejo el ` +
            `enlace": el cliente ve el archivo, no el link. Manda la imagen la ` +
            `PRIMERA vez que le hablas de ese producto; no la repitas en cada ` +
            `mensaje. Si un producto no tiene, simplemente no pongas la línea.\n`;
        }

        bloque += `\n`;
        say(
          `✅ Ficha inyectada de ${conFicha.length} ítem(s) nombrados` +
            (conMedia.length ? ` · ${conMedia.length} con media` : ''),
        );
      }

      /* ── Plan de sesiones ────────────────────────────────────
         Un servicio de sesión única y un plan de 8 no se atienden igual, y hasta
         ahora nada los distinguía: el bot leía "entre 6 y 8 sesiones" de la
         descripción en prosa y adivinaba. Peor con los planes variables (borrado
         de tatuajes: puede terminar en 3 o en 8), donde insistir con un número
         fijo es quedar mal.

         Se le entrega el plan del catálogo Y cuántas sesiones lleva ESTA persona
         de verdad, contadas de la agenda. Con eso deja de suponer: sabe si
         empuja la siguiente, si pregunta o si ya terminó. */
      const conPlan = items.filter((i) => Number(i.sesiones_max) > 1);

      if (conPlan.length && opts?.id_cliente) {
        const asistidas = await db.query(
          `SELECT ap.title, COUNT(*) AS n
             FROM appointments ap
             JOIN calendars cal ON cal.id = ap.calendar_id
             JOIN appointment_invitees inv ON inv.appointment_id = ap.id
             JOIN clientes_chat_center cli
               ON cli.celular_last9 = RIGHT(REGEXP_REPLACE(inv.phone, '[^0-9]', ''), 9)
            WHERE cal.account_id = ? AND cli.id = ?
              AND ap.start_utc < UTC_TIMESTAMP()
              AND ap.status IN ('Agendado', 'Confirmado', 'Completado')
            GROUP BY ap.title`,
          {
            replacements: [id_configuracion, opts.id_cliente],
            type: db.QueryTypes.SELECT,
          },
        );

        const llevaDe = (nombre) => {
          const n = normalizar(nombre);
          return asistidas
            .filter((a) => normalizar(a.title).includes(n))
            .reduce((s, a) => s + Number(a.n), 0);
        };

        const lineas = conPlan.map((i) => {
          const min = Number(i.sesiones_min) || 1;
          const max = Number(i.sesiones_max);
          const lleva = llevaDe(i.nombre);
          const plan =
            min === max
              ? `plan de ${max} sesiones`
              : `plan de ${min} a ${max} sesiones (varía según el caso)`;

          let estado;
          if (lleva === 0) {
            estado = 'todavía no ha venido a ninguna';
          } else if (lleva < min) {
            estado = `lleva ${lleva}; aún le faltan para completar el plan`;
          } else if (lleva < max) {
            estado =
              `lleva ${lleva}: ya está en el tramo donde puede terminar o ` +
              `seguir. NO des por hecho que le faltan más — pregúntale cómo ve ` +
              `sus resultados y si quiere continuar`;
          } else {
            estado =
              `lleva ${lleva}, que es el máximo del plan. NO le ofrezcas más ` +
              `sesiones de esto: felicítala por terminar y, si quiere seguir, ` +
              `que lo defina una especialista`;
          }

          return `- ${i.nombre}: ${plan}. Esta persona ${estado}.`;
        });

        bloque +=
          `🔁 Planes de varias sesiones:\n` +
          lineas.join('\n') +
          `\n\nEse conteo sale de las citas a las que de verdad vino, no lo ` +
          `cambies ni lo estimes. Si un servicio no aparece acá, es de sesión ` +
          `única: no le hables de "próximas sesiones".\n\n`;
        say(`✅ Plan de sesiones inyectado (${lineas.length} servicio/s)`);
      }
    } catch (err) {
      say(`⚠️ Error lista de precios: ${err.message}`);
    }
  }

  /* ── Cierre con VARIOS productos ────────────────────────────
     Dropi acepta una orden con más de un producto (misma bodega), pero el
     motor solo puede leerla si cada producto va en SU PROPIA línea del
     resumen: el caso real de la 889 cerró con "Reloj SKMEI Multifuncion,
     1 x Reloj Steel Arabe" en una sola línea 📦 y la orden cayó a manual
     porque esa cadena no matchea ningún producto del catálogo.

     Va solo en columnas Dropi: en la vertical de servicios no existe este
     resumen y la instrucción sería ruido puro (regla del archivo: todo
     bloque se prueba en las dos verticales — este ni llega a la otra). El
     formato es EL MISMO que parsea parsearProductosResumen en
     kanban_ia.service: cambiar uno obliga a cambiar el otro.

     Cómo se decide "columna Dropi" — la misma cascada del gate del
     auto-orden (kanban_ia, paso 10):
      1. La columna tiene la acción crear/actualizar_orden_dropi ACTIVA
         (las acciones llegan ya filtradas por activo=1).
      2. Sin acción activa, el respaldo son los flags globales de la config
         (modelo viejo, hoy 8 configs siguen así). Este respaldo también
         cubre la columna con la acción APAGADA y el flag prendido: ahí el
         auto-orden no corre, pero un resumen bien formateado igual sirve
         para armar el pedido a mano en el panel — la instrucción no
         dispara nada por sí sola. */
  let esColumnaDropi =
    tiene('crear_orden_dropi') || tiene('actualizar_orden_dropi');
  if (!esColumnaDropi) {
    try {
      const [cfgDropi] = await db.query(
        `SELECT auto_crear_orden_dropi, auto_actualizar_orden_dropi
           FROM configuraciones WHERE id = ? LIMIT 1`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );
      esColumnaDropi =
        Number(cfgDropi?.auto_crear_orden_dropi) === 1 ||
        Number(cfgDropi?.auto_actualizar_orden_dropi) === 1;
    } catch (e) {
      say(`⚠️ flags dropi para cierre multi-producto: ${e.message}`);
    }
  }
  if (esColumnaDropi) {
    bloque +=
      `🧾 SI EL PEDIDO LLEVA MÁS DE UN PRODUCTO DISTINTO: en el resumen de ` +
      `cierre escribe UNA línea "📦 Producto:" POR CADA producto, con su ` +
      `cantidad y su variedad (si aplica) EN ESA MISMA línea, con este ` +
      `formato exacto:\n` +
      `📦 Producto: <nombre del producto> x<cantidad> (Variedad: <la elegida>)\n` +
      `📦 Producto: <otro producto> x<cantidad>\n` +
      `Nunca juntes dos productos en una sola línea 📦 ni los separes por ` +
      `comas: el sistema lee una línea por producto. La línea "💰 Precio ` +
      `total:" sigue siendo una sola, con la suma de todo el pedido. Con un ` +
      `solo producto, el resumen es el de siempre.\n\n`;
    say(`✅ Instrucción de cierre multi-producto inyectada`);

    /* ── Regla de agencias (retiro Servientrega) ──
       Los prompts ya traen el flujo completo (buscar por ciudad exacta,
       máx. 3 opciones, "por confirmar" si no hay) y el modelo igual recae:
       caso real 569 (2026-08-19, Manuel/Paltas) — mostró agencias de CUENCA
       como si fueran de Loja (las calles de Cuenca contienen "LOJA" y el
       retrieval trajo ese fragmento), nunca dijo la ciudad de cada agencia,
       y cuando el cliente respondió CINCO veces "en la Servientrega del
       cantón Paltas" siguió re-listando y re-preguntando "¿en cuál?" hasta
       que la venta se enfrió. La regla viaja acá, al inicio del input de
       cada turno, por el mismo motivo que la REGLA DE AVANCE: es donde el
       modelo sí la obedece. Mismo gate Dropi del bloque de arriba: en la
       vertical de servicios no existen agencias de courier. */
    bloque +=
      `🏦 SI EL CLIENTE RETIRA EN AGENCIA (Servientrega):\n` +
      `- Cada agencia que muestres va CON su ciudad, la que dice su propia ` +
      `línea del archivo. Solo puedes mostrar agencias cuya línea diga ` +
      `EXACTAMENTE la ciudad del cliente: que una calle se llame como otra ` +
      `provincia no la vuelve de ahí. Si el archivo no trae agencias de su ` +
      `ciudad o cantón, dilo con honestidad — JAMÁS presentes las de otra ` +
      `ciudad como si fueran de la suya.\n` +
      `- La lista se muestra UNA sola vez. Si el cliente responde sin elegir ` +
      `una puntual — repite su cantón/ciudad, dice "en la Servientrega de mi ` +
      `pueblo", "yo retiro en Servientrega", o pregunta otra cosa — ESO YA ES ` +
      `SU ELECCIÓN: el dato queda como "Agencia Servientrega por confirmar — ` +
      `<su ciudad o cantón>" y AVANZAS al siguiente dato o al cierre. ` +
      `Prohibido volver a mostrar la lista o repetir "¿en cuál agencia?": ` +
      `insistir es lo que hace que rechacen la venta. Un humano confirma la ` +
      `agencia exacta antes del envío.\n\n`;
    say(`✅ Regla de agencias inyectada`);
  }

  if (tiene('contexto_productos')) {
    try {
      const variables = await db.query(
        `SELECT pc.nombre,
                (SELECT CONCAT(MAX(pv.atributo), ': ',
                               GROUP_CONCAT(pv.valor ORDER BY pv.id SEPARATOR ', '))
                   FROM productos_variaciones pv
                  WHERE pv.id_producto = pc.id AND pv.activo = 1) AS opciones
           FROM productos_chat_center pc
          WHERE pc.id_configuracion = ? AND pc.eliminado = 0
            AND pc.es_variable = 1
          ORDER BY pc.nombre`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );

      const conOpciones = variables.filter((v) => v.opciones);
      if (conOpciones.length) {
        bloque +=
          `🎨 Productos que SÍ o SÍ necesitan variedad antes de cerrar:\n` +
          conOpciones.map((v) => `- ${v.nombre} → ${v.opciones}`).join('\n') +
          `\n` +
          `Si el pedido es de uno de estos, el cliente tiene que nombrar la ` +
          `variedad CON SUS PALABRAS antes del cierre, y va en la línea ` +
          `"🎨 Variedad:" del resumen. No la elijas tú ni la deduzcas. ` +
          `Si pide varias, escribe cuántas unidades de cada una ` +
          `("🎨 Variedad: Negro x2, Cafe x1") y que sumen la cantidad total del ` +
          `pedido. Cualquier otro producto es simple: no preguntes variedad ni ` +
          `pongas esa línea.\n` +
          `Y si el pedido lleva VARIOS productos distintos, la variedad de cada ` +
          `uno va en SU propia línea "📦 Producto:" del resumen — ` +
          `"📦 Producto: <nombre> x<cantidad> (Variedad: <la elegida>)" — no en ` +
          `una línea 🎨 aparte: ahí el sistema no sabría de cuál producto es.\n\n`;
        say(`✅ Contexto productos variables inyectado (${conOpciones.length})`);
      }
    } catch (err) {
      say(`⚠️ Error contexto productos variables: ${err.message}`);
    }
  }

  // ── Disponibilidad de la agenda ─────────────────────────────
  if (tiene('contexto_calendario')) {
    try {
      const {
        obtenerDatosCalendarioParaAssistant,
      } = require('./datosClienteAssistant');
      const datos = await obtenerDatosCalendarioParaAssistant(id_configuracion);
      if (datos?.bloque) {
        bloque += `📅 Información del calendario:\n${datos.bloque}\n\n`;
        say(`✅ Contexto calendario inyectado`);
      }
    } catch (err) {
      say(`⚠️ Error contexto_calendario: ${err.message}`);
    }
  }

  return bloque;
}

module.exports = { construirContextoColumna };
