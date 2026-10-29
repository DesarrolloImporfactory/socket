/**
 * Proveedores de Yiwu para el bot de Expertos (265): «¿tienen proveedor de
 * mochilas?» → hasta 3 proveedores del Directorio con su tarjeta y la clase de
 * cómo escribirles.
 *
 * Antes el bot solo podía mandar el enlace del directorio («no recomendar a un
 * proveedor por su nombre»), y la mitad de esas preguntas terminaban en un
 * asesor que buscaba a mano lo mismo que está en la base.
 *
 * De dónde sale: `proveedores` de Imporsuit (solo lectura), las mismas filas
 * que muestra el Directorio de imporfactory.app: visibles (`ver = 1`), con el
 * enlace no caído, y además con tarjeta y algún contacto (`origen = 'tarjeta'`,
 * las que se cargaron del mercado de Yiwu). Las de `origen = 'importador'` no
 * traen contacto: no sirven para esto.
 *
 * Reglas:
 *   - Solo para alumnos con membresía activa (Daniel, 27-oct): el Directorio
 *     pide iniciar sesión en la plataforma, así que el bot no se los da a
 *     cualquiera que escriba. La membresía sale de membresiaImporsuit (1 año
 *     desde users.fecha_suscripcion, por la cola de 9 dígitos del WhatsApp de
 *     sus plataformas). Sin membresía activa o sin poder consultarla: «es
 *     parte de la membresía», sin nombrar a nadie.
 *   - Nunca se inventa un proveedor: si nada calza con el producto, el texto
 *     manda al directorio, a YiwuGo y a Alibaba, y no nombra a nadie.
 *   - El texto para el cliente se arma aquí con los datos de la fila, no lo
 *     redacta el modelo.
 *   - Las tarjetas se mandan como foto solo de los proveedores que salen en la
 *     respuesta final (si la guardia la cambió por «un asesor…», no sale
 *     ninguna tarjeta suelta).
 */

'use strict';

const { raices, casiIgual, sinTildes } = require('./texto');
const T = require('./textos');

const MAX_PROVEEDORES = 3;

/* Palabras de la pregunta que no dicen QUÉ producto busca. */
const GENERICAS = new Set(
  raices(
    'proveedor proveedores proveedora fabrica fabricante fabricantes yiwu china chino chinos ' +
      'mercado producto productos busco buscar necesito quiero importar importacion contacto contactos ' +
      'tienen tienes tarjeta tarjetas venden vende vendedor vendedores mayor mayorista mayoristas ' +
      'directorio lista empresa empresas tienda tiendas articulo articulos cosa cosas tipo tipos',
  ),
);

/* Palabras que solo afinan («ropa DE MUJER», «mochilas PARA NIÑOS»): solas no
   dicen el producto. «mujer» sola sacaba una fábrica de mochilas «de hombre y
   mujer» para quien pedía ropa. Cuentan como coincidencia débil. */
const MODIFICADORES = new Set(
  raices(
    'mujer mujeres hombre hombres dama damas caballero caballeros nino ninos nina ninas bebe bebes ' +
      'infantil infantiles adulto adultos unisex grande grandes pequeno pequenos mini color colores ' +
      'moda barato baratos economico calidad original nuevo nuevos',
  ),
);

const SQL_PROVEEDORES = `
  SELECT id_proveedor, nombre, producto, categoria, buscador, tarjeta,
         telefono, wechat_id, wechat, whatsapp, direccion
    FROM proveedores
   WHERE ver = 1
     AND origen = 'tarjeta'
     AND tarjeta IS NOT NULL AND tarjeta <> ''
     AND (enlace_estado IS NULL OR enlace_estado <> 'caido')
     AND ( (telefono IS NOT NULL AND telefono <> '')
        OR (wechat_id IS NOT NULL AND wechat_id <> '')
        OR (wechat IS NOT NULL AND wechat <> '')
        OR (whatsapp IS NOT NULL AND whatsapp <> '') )
   ORDER BY id_proveedor DESC
   LIMIT 500`;

const limpio = (s, max = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const tarjetaValida = (u) => /^https:\/\/\S+\.(jpe?g|png|webp)$/i.test(String(u || '').trim());

/** Raíces del producto que pidió, sin las palabras que no lo distinguen. */
function raicesProducto(producto) {
  return [...new Set(raices(producto))].filter((r) => r.length >= 3 && !GENERICAS.has(r));
}

const calza = (r, lista) => lista.some((x) => x === r || casiIgual(x, r) || (r.length >= 5 && x.startsWith(r)));

/**
 * Cómo calza una fila: 3 puntos por cada raíz que está en lo que vende, 1 si
 * solo está en el nombre, el buscador o la categoría (los nombres vienen en
 * inglés: «Rope & Belt» calzaba con «ropa»). Sin ninguna fuerte hacen falta
 * dos débiles: «cocina» sola calza con 23 proveedores de «Hogar, Cocina y
 * Decoración» y no dice cuál sirve. `cuantas` = raíces que calzaron; si
 * calzó la primera (la palabra principal: «BOTELLAS de agua») suma 2 al orden.
 */
function puntaje(fila, buscadas) {
  const fuerte = raices(fila.producto || '');
  const debil = raices(`${fila.nombre || ''} ${fila.buscador || ''} ${fila.categoria || ''}`);
  let fuertes = 0;
  let debiles = 0;
  let cabeza = false;
  buscadas.forEach((r, i) => {
    const enFuerte = calza(r, fuerte);
    if (enFuerte && !MODIFICADORES.has(r)) fuertes += 1;
    else if (enFuerte || calza(r, debil)) debiles += 1;
    else return;
    if (i === 0) cabeza = true;
  });
  if (!fuertes && debiles < 2) return { p: 0 };
  return { p: fuertes * 3 + debiles + (cabeza ? 2 : 0), cuantas: fuertes + debiles, cabeza };
}

/* De los que calzan, se quedan los mejores: si alguno calza con dos o más
   palabras de lo que pidió, fuera los que calzan con menos («accesorios para
   celular» no trae «accesorios eléctricos» si hay uno de celulares). Si nadie
   calza con todas, salen los parciales ordenados (la palabra principal suma):
   el texto dice qué vende cada uno y el cliente elige. Descartar al que no
   tenía la palabra principal dejaba «cajas de regalo» solo con «cajas
   fuertes» y sin el de «bolsas de regalo». */
function mejores(candidatos) {
  const tope = Math.max(...candidatos.map((x) => x.cuantas));
  return tope >= 2 ? candidatos.filter((x) => x.cuantas === tope) : candidatos;
}

/* ¿El número desde el que escribe tiene la membresía activa? Si no se pudo
   consultar, cuenta como que no: los contactos no salen a ciegas. */
async function membresiaActiva(telefono, resolver) {
  const cola = String(telefono ?? '').replace(/\D/g, '').slice(-9);
  if (cola.length < 9) return false;
  try {
    // eslint-disable-next-line global-require
    const r = resolver || require('../membresiaImporsuit').resolverMembresias;
    const m = (await r([String(telefono)])).get(cola);
    return Boolean(m && m.vencida === false);
  } catch {
    return false;
  }
}

/**
 * Busca proveedores para un producto. Devuelve:
 *   { estado: 'encontrado', producto, proveedores: [...] }  (1 a 3)
 *   { estado: 'sin_resultados', producto }
 *   { estado: 'sin_producto' }   no dijo qué producto
 *   { estado: 'sin_membresia' }  el número no tiene la membresía activa
 *   { estado: 'error', producto }
 */
async function buscarProveedores(producto, { consultar, telefono, membresias, limite = MAX_PROVEEDORES } = {}) {
  if (!(await membresiaActiva(telefono, membresias))) return { estado: 'sin_membresia' };
  const prod = limpio(producto, 80);
  const buscadas = raicesProducto(prod);
  if (!buscadas.length) return { estado: 'sin_producto' };
  let filas;
  try {
    // eslint-disable-next-line global-require
    const q = consultar || require('./cargaCliente').consultarImporsuit;
    filas = await q(SQL_PROVEEDORES);
  } catch {
    return { estado: 'error', producto: prod };
  }
  const candidatos = (Array.isArray(filas) ? filas : [])
    .filter((f) => tarjetaValida(f.tarjeta) && limpio(f.nombre))
    .map((f) => ({ f, ...puntaje(f, buscadas) }))
    .filter((x) => x.p > 0);
  const elegidos = (candidatos.length ? mejores(candidatos) : [])
    .sort((a, b) => b.p - a.p || Number(b.f.id_proveedor) - Number(a.f.id_proveedor))
    .slice(0, Math.max(1, Math.min(limite, MAX_PROVEEDORES)))
    .map(({ f }) => ({
      id: Number(f.id_proveedor),
      nombre: limpio(f.nombre, 60),
      vende: limpio(f.producto, 90),
      ubicacion: limpio(f.direccion, 70),
      contacto: contactoDe(f),
      tarjeta: String(f.tarjeta).trim(),
    }));
  if (!elegidos.length) return { estado: 'sin_resultados', producto: prod };
  return { estado: 'encontrado', producto: prod, proveedores: elegidos };
}

/* WeChat primero (es como responden en Yiwu); si no hay, el primer teléfono. */
function contactoDe(f) {
  const wechat = limpio(f.wechat_id || f.wechat, 40);
  if (wechat) return `WeChat: ${wechat}`;
  const wa = limpio(f.whatsapp, 30);
  if (wa) return `WhatsApp: ${wa}`;
  const tel = limpio(String(f.telefono || '').split('/')[0], 30);
  return tel ? `Teléfono: ${tel}` : '';
}

/** Texto exacto para el cliente, armado con las filas (no lo redacta el modelo). */
function textoProveedores(r) {
  if (r?.estado === 'encontrado') {
    const lineas = r.proveedores.map((p, i) => {
      const partes = [`${i + 1}. ${p.nombre}`, p.vende && `vende ${p.vende}`, p.ubicacion && `en el mercado: ${p.ubicacion}`, p.contacto];
      return partes.filter(Boolean).join(' · ');
    });
    return [
      T.PROVEEDORES_ENCONTRADOS(r.proveedores.length),
      ...lineas,
      T.PROVEEDORES_TARJETAS(r.proveedores.length),
      T.PROVEEDORES_PEDIR,
      T.PROVEEDORES_VIDEO,
    ].join('\n');
  }
  if (r?.estado === 'sin_producto') return null;
  if (r?.estado === 'sin_membresia') return T.PROVEEDORES_SIN_MEMBRESIA;
  return T.PROVEEDORES_SIN_RESULTADO;
}

/** Lo que recibe el modelo como resultado de la herramienta. */
function bloqueProveedores(r) {
  if (r?.estado === 'sin_producto')
    return 'No dijo qué producto busca. Pregúntale qué producto quiere importar (una sola pregunta) y vuelve a usar la herramienta con eso.';
  const texto = textoProveedores(r);
  return `Responde exactamente esto, sin agregar proveedores, enlaces ni datos que no estén aquí:\n${texto}`;
}

/**
 * Tarjetas a mandar como foto: solo las de los proveedores cuyo nombre quedó
 * en la respuesta final. Si la guardia la reemplazó por el texto seguro, no
 * sale ninguna.
 */
function tarjetasParaEnviar(respuesta, r) {
  if (r?.estado !== 'encontrado') return [];
  const plano = sinTildes(respuesta).replace(/\s+/g, ' ');
  return r.proveedores
    .filter((p) => plano.includes(sinTildes(p.nombre).replace(/\s+/g, ' ')))
    .map((p) => p.tarjeta);
}

module.exports = {
  buscarProveedores,
  textoProveedores,
  bloqueProveedores,
  tarjetasParaEnviar,
  raicesProducto,
  membresiaActiva,
  MAX_PROVEEDORES,
  SQL_PROVEEDORES,
};
