// utils/webhook_whatsapp/colchonMensajeIlegible.js
//
// Colchón para el primer mensaje que Meta entrega como `unsupported` ("Tipo de
// mensaje no reconocido"): sin texto y casi siempre sin el anuncio. Medido el
// 2026-10-13: 2.557 chats en 7 días (176 cuentas) y el 38% nunca volvió a
// escribir tras el "¿qué producto te interesa?" abierto.
//
// En vez de la pregunta abierta, se ofrecen como botones los productos que la
// cuenta tiene EN PAUTA (anuncios con clientes en las últimas 72 h) + "Otro
// producto". Nada se adivina: el cliente elige, y si no está, sigue la IA.

const { db } = require('../../database/config');
const { enviarOpcionesWhatsapp } = require('./enviarMensajes');

const RESPONSABLE_COLCHON = 'IA_colchon';
const VENTANA_PAUTA_HORAS = 72;
const MAX_PRODUCTOS = 9; // la lista admite 10 filas: 9 + "Otro producto"
const MIN_LEADS_TITULAR = 3;
const TITULAR_GENERICO = /^(anuncio|publicaci[oó]n|whatsapp|hola)\b/i;
const ID_PRODUCTO = 'colchon_prod_';
const ID_ANUNCIO = 'colchon_ad_';
const ID_OTRO = 'colchon_otro';

const normalizar = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/* Productos con anuncios vivos, de más a menos clientes. Un anuncio mapeado
   a un producto cuenta para ese producto; uno sin mapear se ofrece con su
   titular (el cliente vino por ese anuncio aunque nadie lo haya vinculado). */
async function opcionesEnPauta(id_configuracion) {
  let filas = await db.query(
    `SELECT a.headline, p.id AS id_producto, p.nombre,
            MAX(ap.id_producto) AS id_mapeado,
            COUNT(DISTINCT a.id_cliente) AS leads
       FROM cliente_productos_ad a
       LEFT JOIN anuncios_producto ap
              ON ap.id_configuracion = a.id_configuracion
             AND ap.source_id = a.source_id
       LEFT JOIN productos_chat_center p
              ON p.id = ap.id_producto AND p.eliminado = 0
             AND p.id_configuracion = a.id_configuracion
      WHERE a.id_configuracion = ?
        AND a.source_id IS NOT NULL
        AND a.headline IS NOT NULL AND a.headline <> ''
        AND a.created_at >= NOW() - INTERVAL ${VENTANA_PAUTA_HORAS} HOUR
      GROUP BY a.headline, p.id, p.nombre`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const porClave = new Map();
  /* Anuncio vinculado a un producto que ya se borró: el negocio dejó de
     venderlo, no se ofrece con su titular (cfg 476 ofrecía "Freidora con
     Canasta" días después de eliminarla). */
  filas = filas.filter((f) => f.id_producto || !f.id_mapeado);
  // Primero los mapeados: así un titular igual al nombre se suma al producto.
  const orden = [...filas].sort((x, y) => (y.id_producto ? 1 : 0) - (x.id_producto ? 1 : 0));
  for (const f of orden) {
    const nombre = String(f.nombre || f.headline).trim();
    let clave = f.id_producto ? `p${f.id_producto}` : `h${normalizar(nombre)}`;
    if (!f.id_producto) {
      const igual = [...porClave.values()].find(
        (o) => o.id_producto && normalizar(o.nombre) === normalizar(nombre),
      );
      if (igual) clave = `p${igual.id_producto}`;
    }
    const prev = porClave.get(clave);
    if (prev) prev.leads += Number(f.leads) || 0;
    else
      porClave.set(clave, {
        id_producto: f.id_producto || null,
        nombre,
        leads: Number(f.leads) || 0,
      });
  }
  /* Un titular sin producto vinculado entra solo si trae clientes de verdad
     y no es genérico ("Anuncio en estados"): con 1 lead suele ser una
     variante del mismo anuncio y ensucia los botones. Los productos
     vinculados entran siempre, aunque recién se estén probando. */
  return [...porClave.values()]
    .filter(
      (o) =>
        o.id_producto ||
        (o.leads >= MIN_LEADS_TITULAR && !TITULAR_GENERICO.test(o.nombre)),
    )
    .sort((a, b) => b.leads - a.leads)
    .slice(0, MAX_PRODUCTOS);
}

/* Solo para el PRIMER mensaje de la conversación: Meta también entrega como
   `unsupported` las ediciones de mensajes, y a mitad de chat no hay que
   preguntar por el producto. Tampoco si ya se sabe cuál es. Respeta el
   "Reiniciar conversación" del panel (reinicio_conversacion_at). */
async function puedeOfrecer({ id_configuracion, id_cliente, id_mensaje }) {
  const [previo] = await db.query(
    `SELECT id FROM mensajes_clientes
      WHERE id_configuracion = ? AND celular_recibe = ? AND id < ?
        AND rol_mensaje IN (0, 1)
        AND created_at >= (SELECT x.created_at FROM mensajes_clientes x WHERE x.id = ?) - INTERVAL 24 HOUR
        AND created_at >= COALESCE(
              (SELECT c.reinicio_conversacion_at FROM clientes_chat_center c WHERE c.id = ?),
              '1970-01-01')
      LIMIT 1`,
    {
      replacements: [id_configuracion, String(id_cliente), id_mensaje, id_mensaje, id_cliente],
      type: db.QueryTypes.SELECT,
    },
  );
  if (previo) return false;
  const [conocido] = await db.query(
    `SELECT id FROM cliente_productos_ad
      WHERE id_cliente = ? AND created_at >= NOW() - INTERVAL 7 DAY
        AND created_at >= COALESCE(
              (SELECT c.reinicio_conversacion_at FROM clientes_chat_center c WHERE c.id = ?),
              '1970-01-01')
      LIMIT 1`,
    { replacements: [id_cliente, id_cliente], type: db.QueryTypes.SELECT },
  );
  return !conocido;
}

/**
 * Ofrece los productos en pauta si aplica.
 * @returns {{ manejado: boolean }} manejado=true → la IA no corre este turno.
 */
async function intentarColchonMensajeIlegible({
  id_configuracion,
  id_cliente,
  id_mensaje,
  telefono,
  business_phone_id,
  accessToken,
  estado_contacto,
  log = async () => {},
}) {
  const nada = { manejado: false };
  try {
    const { botHabilitado } = require('../../services/producto_wizard_runtime.service');
    if (!(await botHabilitado(id_configuracion, estado_contacto))) return nada;
    if (!(await puedeOfrecer({ id_configuracion, id_cliente, id_mensaje }))) {
      return nada;
    }
    const productos = await opcionesEnPauta(id_configuracion);
    if (!productos.length) {
      await log(`🛟 colchón: mensaje ilegible pero la cuenta no tiene anuncios recientes; sigue la IA`);
      return nada;
    }

    const opciones = productos.map((p, i) => ({
      id: p.id_producto ? `${ID_PRODUCTO}${p.id_producto}` : `${ID_ANUNCIO}${i}`,
      titulo: p.nombre,
      descripcion: p.nombre.length > 24 ? p.nombre : undefined,
    }));
    opciones.push({ id: ID_OTRO, titulo: 'Otro producto' });

    const cuerpo =
      '¡Hola! 😊 No alcancé a leer tu mensaje. ¿Por cuál producto nos escribes?';
    const r = await enviarOpcionesWhatsapp({
      phone_whatsapp_to: telefono,
      business_phone_id,
      accessToken,
      id_configuracion,
      cuerpo,
      opciones,
      boton_lista: 'Ver productos',
      texto_registro: `${cuerpo}\n\n${opciones.map((o) => `• ${o.titulo}`).join('\n')}`,
      responsable: RESPONSABLE_COLCHON,
    });
    if (!r.ok) {
      await log(`⚠️ colchón: no salieron los botones (${JSON.stringify(r.error)}); sigue la IA`);
      return nada;
    }
    await log(
      `🛟 colchón: mensaje ilegible → ${r.formato} con ${productos.length} producto(s) en pauta: ${productos.map((p) => p.nombre).join(' | ')}`,
    );
    return { manejado: true };
  } catch (e) {
    await log(`⚠️ colchón: ${e.message}`);
    return nada;
  }
}

/* ¿Sigue valiendo el producto anclado al cliente (anuncio o elección)? No,
   si es anterior al "Reiniciar conversación" o al colchón: ahí empezó una
   conversación sin producto conocido. Sin esto, tras "Otro producto" el bot
   seguía vendiendo el anuncio de semanas atrás (cfg 610, 2026-10-13). */
async function anclaProductoVigente({ id_configuracion, id_cliente, fecha_ancla }) {
  if (!fecha_ancla) return true;
  try {
    const [r] = await db.query(
      `SELECT
         (SELECT reinicio_conversacion_at FROM clientes_chat_center WHERE id = ?) AS reinicio,
         (SELECT MAX(created_at) FROM mensajes_clientes
           WHERE id_configuracion = ? AND celular_recibe = ? AND responsable = ?) AS colchon`,
      {
        replacements: [id_cliente, id_configuracion, String(id_cliente), RESPONSABLE_COLCHON],
        type: db.QueryTypes.SELECT,
      },
    );
    const ancla = new Date(fecha_ancla).getTime();
    if (r?.reinicio && new Date(r.reinicio).getTime() > ancla) return false;
    if (r?.colchon && new Date(r.colchon).getTime() > ancla) return false;
    return true;
  } catch {
    return true;
  }
}

/* Lee la respuesta del cliente a los botones/lista del colchón. El texto
   completo viene en la descripción de la fila (el título va recortado). */
function interpretarRespuestaColchon(interactive) {
  const rep = interactive?.button_reply || interactive?.list_reply;
  const id = String(rep?.id || '');
  if (!id.startsWith('colchon_')) return null;
  const nombre = String(rep.description || rep.title || '').trim();
  if (id === ID_OTRO) return { otro: true, texto: 'Otro producto' };
  const idProducto = id.startsWith(ID_PRODUCTO)
    ? Number(id.slice(ID_PRODUCTO.length)) || null
    : null;
  return { otro: false, id_producto: idProducto, nombre, texto: `Me interesa: ${nombre}` };
}

/* Lo que recibe la IA tras la elección: el contexto de que el primer
   mensaje no se leyó y de qué tocó el cliente. */
function mensajeParaIaColchon(eleccion) {
  if (eleccion.otro) {
    return `[El primer mensaje del cliente no se pudo leer. Le ofrecimos los productos anunciados y eligió "Otro producto": pregúntale con amabilidad qué producto busca.]\nMensaje del cliente: Otro producto`;
  }
  return `[El primer mensaje del cliente no se pudo leer. Le ofrecimos los productos anunciados y eligió: "${eleccion.nombre}". Ese es el producto que le interesa; sigue tu guion con ese producto.]\nMensaje del cliente: Me interesa ${eleccion.nombre}`;
}

module.exports = {
  RESPONSABLE_COLCHON,
  opcionesEnPauta,
  puedeOfrecer,
  anclaProductoVigente,
  intentarColchonMensajeIlegible,
  interpretarRespuestaColchon,
  mensajeParaIaColchon,
};
