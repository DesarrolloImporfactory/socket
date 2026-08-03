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

/* Palabras que no distinguen un producto de otro. Sin esto, "quiero información
   del tratamiento facial" traería cualquier cosa que diga "facial". */
const VACIAS = new Set([
  'de','del','la','el','los','las','un','una','unos','unas','y','o','para','por',
  'con','sin','en','al','que','qué','me','mi','tu','su','es','son','the','info',
  'informacion','información','precio','precios','cuanto','cuánto','cuesta',
  'vale','quiero','necesito','busco','hola','buenas','tienen','tienes','hay',
  'sobre','favor','porfa','gracias','sesion','sesión','servicio','producto',
]);

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
           número" y hay que saber cuál es. */
        bloque +=
          `\n\n[DATOS TÉCNICOS DEL CONTACTO — solo de respaldo]\n` +
          `Número desde el que escribe: ${cli.celular_cliente}\n` +
          (nombre ? `Nombre de su perfil de WhatsApp: ${nombre}\n` : '') +
          `PREGÚNTALE SIEMPRE su nombre y su teléfono antes de agendar. No los ` +
          `des por sabidos: el nombre del perfil puede ser un apodo y el número ` +
          `puede no ser donde quiere que la contacten.\n` +
          `Estos datos son SOLO para cuando ella misma te diga "a este mismo ` +
          `número", "desde donde te escribo" o "el mismo de acá": ahí ya no ` +
          `vuelves a preguntar, usas el de arriba y sigues.\n\n`;
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
          `🏢 Sedes donde atendemos (ÚNICAS ciudades con cobertura):\n${lineas.join('\n')}\n\n` +
          `Si la persona escribe desde una ciudad que NO está en esta lista, está fuera de cobertura.\n` +
          `Al agendar, usa el nombre EXACTO de la sede tal como aparece aquí.\n` +
          `Cuando pregunten cómo llegar, o al confirmar una cita, pega el enlace de ` +
          `Google Maps de esa sede tal cual, en su propia línea y sin acortarlo ni ` +
          `cambiarlo. Si una sede no tiene enlace, da la dirección y la referencia.\n` +
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
        `SELECT nombre, tipo, precio, duracion, descripcion,
                imagen_url, video_url, sesiones_min, sesiones_max,
                combos_producto
           FROM productos_chat_center
          WHERE id_configuracion = ? AND eliminado = 0
          ORDER BY tipo DESC, nombre`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );

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
      const casanPalabras = (a, b) =>
        a === b ||
        (a.length >= 5 &&
          b.length >= 5 &&
          (a.startsWith(b) || b.startsWith(a)));

      const nombrados = palabrasMsg.length
        ? items.filter((i) => {
            const tokens = palabrasUtiles(i.nombre);
            return palabrasMsg.some((p) => tokens.some((t) => casanPalabras(t, p)));
          })
        : [];

      if (items.length > TOPE_LISTA_INLINE) {
        const palabras = palabrasUtiles(mensajeCliente);
        if (!palabras.length) {
          seleccion = [];
        } else {
          /* Se comparan PALABRAS COMPLETAS, no subcadenas: buscar "set" dentro
             del nombre hacía coincidir "camiSETa" y "corSET", y el bot recibía
             precios de ropa cuando le preguntaban por un juego de cuchillos.
             Se acepta prefijo solo en palabras largas, para que "libro" y
             "libros" sigan siendo lo mismo. */
          const casan = (a, b) =>
            a === b ||
            (a.length >= 5 && b.length >= 5 &&
              (a.startsWith(b) || b.startsWith(a)));

          seleccion = items
            .map((i) => {
              const tokens = palabrasUtiles(i.nombre);
              const aciertos = palabras.filter((p) =>
                tokens.some((t) => casan(t, p)),
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

      if (seleccion.length) {
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
            ? `💲 Precios de lo que mencionó la persona (tomados del catálogo):\n`
            : `💲 Precios vigentes (esto es lo ÚNICO que puedes cotizar):\n`) +
          seleccion.map(linea).join('\n') +
          `\n` +
          (parcial
            ? `Estos son los que coinciden con su mensaje; el resto del catálogo ` +
              `lo tienes disponible para consultar. `
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
      }

      /* Ficha completa de lo que nombró. Va aparte de la lista de precios para
         que no se mezcle: la lista sirve para no inventar precios, esto sirve
         para vender. Se corta cada descripción porque alguna cuenta escribe
         media página y no vale la pena pagarla en cada mensaje. */
      const TOPE_DESC = 700;
      const conFicha = nombrados
        .filter((i) => String(i.descripcion || '').trim())
        .slice(0, 3);

      if (conFicha.length) {
        /* La foto o el video vende más que cualquier párrafo, y ya estaban
           cargados en el catálogo: lo que faltaba era que el bot los tuviera a
           la vista. Se mandan con las etiquetas que el motor sabe extraer para
           convertirlas en archivos de WhatsApp de verdad; si van como texto
           suelto, al cliente le llega un link pelado. */
        const conMedia = conFicha.filter((i) => i.imagen_url || i.video_url);

        bloque +=
          `📋 Ficha de lo que la persona nombró — úsala para responderle:\n\n` +
          conFicha
            .map((i) => {
              const desc = String(i.descripcion).trim().slice(0, TOPE_DESC);
              /* Se normalizan antes de dárselas al modelo: él las copia tal
                 cual en la etiqueta, y si llevan espacios —las de Dropi los
                 traen— el extractor las corta en el primero y a Meta le llega
                 un link roto que nunca se entrega. */
              const media = [
                i.imagen_url
                  ? `  📷 imagen: ${normalizarUrlMedia(i.imagen_url)}`
                  : null,
                i.video_url
                  ? `  🎥 video: ${normalizarUrlMedia(i.video_url)}`
                  : null,
              ]
                .filter(Boolean)
                .join('\n');
              return `▸ ${i.nombre}\n${desc}${media ? `\n${media}` : ''}`;
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
          `pongas esa línea.\n\n`;
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
