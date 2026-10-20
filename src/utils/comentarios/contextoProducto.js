// ════════════════════════════════════════════════════════════════════════
// contextoProducto.js
// De qué producto habla una publicación, y cómo contárselo al asistente de
// comentarios.
//
// POR QUÉ NO SE INYECTA EL CATÁLOGO
//
// El bot de kanban le pasa al modelo el catálogo entero (kanban_columnas.
// catalogo_inline). Para una conversación de venta tiene sentido: el cliente
// puede preguntar por cualquier cosa. Para un comentario no: ese bloque llega a
// ~64.000 caracteres y acá se contesta con dos frases. Sale caro y responde
// peor, porque cuanta más paja tiene delante, más se despista el modelo.
//
// Así que la publicación se vincula a UN producto (facebook_posts.id_producto,
// a mano desde la bandeja) y solo ese entra al prompt.
//
// LO QUE SE REUTILIZA
//
// Las "respuestas rápidas" que el negocio ya llenó en el wizard de producto
// (productos_wizard.respuestas_rapidas_json). No son un invento de esta
// función: 992 productos en 228 cuentas ya las tienen cargadas, y el matcher
// determinista de utils/wizardProducto/respuestasRapidas.js sabe elegirlas sin
// gastar un token. Acá se usan para las dos cosas:
//   - como respuesta directa, cuando el matcher acierta;
//   - como contexto del modelo, cuando no acierta pero igual sirven de fuente.
// ════════════════════════════════════════════════════════════════════════

const { db } = require('../../database/config');
const {
  leerJson,
  fmtPrecio,
} = require('../wizardProducto/componerMensajeInicial');

/** Tope de caracteres de la descripción que entra al prompt. */
const TOPE_DESCRIPCION = 700;

/** Tope de respuestas rápidas que se le muestran al modelo como referencia. */
const TOPE_FAQS_CONTEXTO = 12;

/* Las columnas que necesita el asistente, iguales se llegue por la publicación
   o por el id del producto. */
const CAMPOS = `p.id, p.nombre, p.descripcion, p.material, p.precio, p.stock,
       p.es_variable, p.combos_producto, p.landing_url,
       w.descripcion_ia, w.bullets_json, w.linea_envio,
       w.respuestas_rapidas_json, w.usar_respuestas_rapidas`;

function mapear(fila) {
  if (!fila) return null;

  // Las desactivadas no se miran nunca: el negocio las apagó por algo.
  const faqs = leerJson(fila.respuestas_rapidas_json, []).filter(
    (f) => f && f.activa !== 0 && f.activa !== false && String(f.respuesta || '').trim(),
  );

  return {
    id: fila.id,
    nombre: fila.nombre,
    descripcion: fila.descripcion_ia || fila.descripcion || '',
    material: fila.material || '',
    precio: fila.precio,
    stock: fila.stock,
    es_variable: Number(fila.es_variable) === 1,
    combos: leerJson(fila.combos_producto, []),
    bullets: leerJson(fila.bullets_json, []),
    linea_envio: fila.linea_envio || '',
    landing_url: fila.landing_url || '',
    // El interruptor del wizard manda también acá: si el negocio apagó las
    // quemadas para el chat, no tiene sentido que salgan en los comentarios.
    usar_respuestas_rapidas: Number(fila.usar_respuestas_rapidas ?? 1) === 1,
    faqs,
  };
}

/**
 * Producto vinculado a la publicación, con su wizard si lo tiene.
 *
 * Devuelve null cuando la publicación no tiene producto, o cuando lo tenía y el
 * negocio lo borró: quedarse sin contexto es un caso normal, no un error, y el
 * asistente sabe trabajar así (reconoce el comentario y manda al privado).
 */
async function cargarProductoDelPost({ id_configuracion, id_facebook_post }) {
  const [fila] = await db.query(
    `SELECT ${CAMPOS}
       FROM facebook_posts fp
       JOIN productos_chat_center p
         ON p.id = fp.id_producto AND p.id_configuracion = fp.id_configuracion
       LEFT JOIN productos_wizard w
         ON w.id_producto = p.id
      WHERE fp.id_facebook_post = ? AND fp.id_configuracion = ?
      LIMIT 1`,
    {
      replacements: [id_facebook_post, id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );
  return mapear(fila);
}

/**
 * El mismo producto, pero pedido por su id.
 *
 * Existe para poder probar el asistente sin una publicación de por medio
 * (scripts/probarSugerenciaComentarios.js): así se afinan las respuestas
 * rápidas y el prompt sin publicar nada en Facebook.
 */
async function cargarProductoPorId({ id_configuracion, id_producto }) {
  const [fila] = await db.query(
    `SELECT ${CAMPOS}
       FROM productos_chat_center p
       LEFT JOIN productos_wizard w ON w.id_producto = p.id
      WHERE p.id = ? AND p.id_configuracion = ?
      LIMIT 1`,
    {
      replacements: [id_producto, id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );
  return mapear(fila);
}

/** Variaciones activas, para poder contestar "¿hay en azul?" de verdad. */
async function cargarVariaciones(id_producto) {
  try {
    return await db.query(
      `SELECT atributo, valor, stock FROM productos_variaciones
        WHERE id_producto = ? AND activo = 1
        ORDER BY atributo, valor LIMIT 25`,
      { replacements: [id_producto], type: db.QueryTypes.SELECT },
    );
  } catch (err) {
    // Sin variaciones el asistente igual responde; sin sugerencia, no. Que un
    // fallo acá no tumbe todo el borrador.
    console.warn('[FB_COMENT] variaciones no disponibles:', err?.message);
    return [];
  }
}

/**
 * El bloque de texto que ve el modelo.
 *
 * Va con la misma regla que el PUENTE_INLINE del kanban: lo que no está acá no
 * existe. Es lo único que impide que invente un color, un plazo o un descuento
 * que nadie ofreció.
 */
function bloqueProducto(prod, variaciones = []) {
  if (!prod) return null;

  const l = [];
  l.push('PRODUCTO DE ESTA PUBLICACIÓN');
  l.push(`Nombre: ${prod.nombre}`);
  if (prod.precio != null) l.push(`Precio: ${fmtPrecio(prod.precio)}`);
  if (prod.material) l.push(`Material: ${prod.material}`);

  const bullets = (prod.bullets || []).filter(Boolean).slice(0, 8);
  if (bullets.length) l.push(`Características: ${bullets.join(' · ')}`);

  const combos = (prod.combos || [])
    .map((c) => {
      const cant = c?.cantidad ?? c?.unidades;
      const precio = c?.precio ?? c?.valor;
      return cant && precio ? `${cant} x ${fmtPrecio(precio)}` : null;
    })
    .filter(Boolean);
  if (combos.length) l.push(`Ofertas por cantidad: ${combos.join(' · ')}`);

  if (prod.linea_envio) l.push(`Envío: ${prod.linea_envio}`);

  const vars = (variaciones || [])
    .map((v) => {
      const etiqueta = [v.atributo, v.valor].filter(Boolean).join(': ');
      if (!etiqueta) return null;
      return `- ${etiqueta}${Number(v.stock) > 0 ? '' : ' — AGOTADO'}`;
    })
    .filter(Boolean);

  /* El silencio se lee como un "no".
     Medido con el M27 (es_variable = 0, cero filas en productos_variaciones):
     ante "¿viene en color rojo?" el modelo contestó "No tenemos el M27 en
     color rojo, solo en el acabado estándar". Una negación rotunda sobre algo
     de lo que no tenía UN dato, y la peor de las dos: el cliente se va
     convencido de que no existe.
     No alcanza con callar el hueco ni con la regla de no inventar — el modelo
     no considera que negar sea inventar. Hay que nombrarlo. */
  if (vars.length) {
    /* Una lista contada, y no "Variaciones: A · B · C" en una línea.
       Medido con el Parlante G200 (Negro y Rojo, los dos agotados) y la
       pregunta "¿qué colores tienen?": en una línea el modelo contestaba
       "solo tenemos el G200 en color rojo" 2 de cada 5 veces —se comía un
       color Y añadía un "solo" que no era verdad—. Con la lista, el número
       delante y la prohibición explícita del "solo": 6 de 6 correctas. */
    l.push(`VARIANTES DE ESTE PRODUCTO: son ${vars.length} en total.`);
    l.push(...vars);
    l.push(
      'Si te preguntan por las variantes, nómbralas TODAS, agotadas incluidas.',
    );
    l.push(
      'No digas "solo", "únicamente" ni "el único" si en la lista hay más de una.',
    );
    l.push(
      'No existe ninguna otra: si preguntan por una que no esté ahí, no la hay.',
    );
  } else {
    /* Prohibir "el modelo estándar" es tan necesario como prohibir la
       negación. Sin esa línea el modelo rellenaba el hueco por el otro lado:
       "solo tenemos el modelo estándar M27" cierra la puerta igual que un "no
       hay en rojo", y suena más creíble porque no niega nada de frente. */
    l.push(
      'Variantes: NO tienes información de colores, tallas ni modelos de este ' +
        'producto. Si preguntan por uno concreto, no digas que no existe ni ' +
        'que sí lo tienes, y NO lo llames "el modelo estándar", "el único ' +
        'modelo" ni nada que insinúe que viene en una sola versión. Di que lo ' +
        'confirmas por el privado.',
    );
  }

  const faqs = (prod.faqs || []).slice(0, TOPE_FAQS_CONTEXTO);
  if (faqs.length) {
    l.push('');
    l.push('RESPUESTAS QUE EL NEGOCIO YA ESCRIBIÓ (son la verdad oficial):');
    for (const f of faqs) {
      l.push(`- ${String(f.pregunta || '').trim()} → ${String(f.respuesta).trim()}`);
    }
  }

  /* La descripción va al FINAL, y es el motivo de la mitad del arreglo.
     La que escribe el wizard trae sus propios encabezados en mayúsculas
     ("DESCRIPCIÓN:", "BENEFICIOS:", "MATERIAL:", "USO PRINCIPAL:") repartidos
     en quince líneas. Puesta arriba, todo lo que viniera después —las
     variantes, sobre todo— se leía como un apartado más de ese bloque y
     perdía peso. Abajo, los datos cortos y exactos quedan solos. */
  if (prod.descripcion) {
    l.push('');
    l.push(
      `Descripción del producto: ${String(prod.descripcion).slice(0, TOPE_DESCRIPCION)}`,
    );
  }

  l.push('');
  l.push(
    'Esto es TODO lo que sabes del producto. Lo que no esté aquí arriba no lo ' +
      'sabes: no lo inventes, no lo deduzcas y no lo supongas. Si te preguntan ' +
      'algo que no está, dices que le escribes al privado con el detalle.',
  );

  return l.join('\n');
}

module.exports = {
  cargarProductoDelPost,
  cargarProductoPorId,
  cargarVariaciones,
  bloqueProducto,
};
