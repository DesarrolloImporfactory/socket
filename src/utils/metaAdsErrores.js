// Traduce los errores que Meta devuelve al crear una campaña a algo que el
// dueño de la cuenta pueda entender y, sobre todo, ARREGLAR.
//
// Por qué existe este archivo: el lanzador reenviaba al front el
// `error_user_msg` de Meta tal cual. Eso significa inglés (Meta responde en el
// idioma del usuario que conectó) y jerga de la API: "Param
// promoted_object[page_id] must be a valid page ID". El cliente leía eso, no
// entendía nada y escribía a soporte.
//
// De 87 lanzamientos fallidos en producción, ~49 eran requisitos de la cuenta
// del propio cliente que él puede resolver solo en dos minutos si alguien le
// dice dónde. Este catálogo es ese "alguien".
//
// Se indexa por `code`/`error_subcode`, NUNCA por el texto: el mismo subcode
// llega en inglés o en español según el idioma del usuario (el 2446886 aparece
// de las dos formas en la tabla de lanzamientos). Solo se cae al texto cuando
// Meta no manda subcode.
//
// `culpa` dice de quién es el problema, y el front lo usa para el tono:
//   'cuenta'     → falta un requisito en la cuenta/portafolio del cliente.
//   'plantilla'  → eligió algo que Meta no acepta; se corrige editándola.
//   'nuestro'    → bug de ChatCenter. No se le pide al cliente que lo arregle.
//   'reintentar' → no se sabe si llegó a crearse; que revise antes de repetir.
//   'desconocido'→ no está en el catálogo; se muestra lo que dijo Meta.

// Rutas de Configuración del negocio. El camino escrito en `pasos` es lo que
// de verdad guía; el enlace solo ahorra clics.
const AJUSTES = 'https://business.facebook.com/settings';
const FACTURACION = 'https://business.facebook.com/billing_hub/payment_settings';

const CATALOGO = [
  {
    subcode: 2446886,
    culpa: 'cuenta',
    titulo: 'Tu página de Facebook no está conectada a WhatsApp',
    porque:
      'Este anuncio manda a la gente a WhatsApp, y Meta no deja publicarlo si la página no tiene una cuenta de WhatsApp Business vinculada.',
    pasos: [
      'Entra a Configuración del negocio → Cuentas → Cuentas de WhatsApp.',
      'Vincula tu número de WhatsApp Business con la página del anuncio.',
      'Vuelve aquí y lanza otra vez.',
    ],
    enlace: { texto: 'Abrir Configuración del negocio', url: AJUSTES },
  },
  {
    subcode: 1487246,
    culpa: 'cuenta',
    titulo: 'El WhatsApp de esta cuenta no es el que tiene la página',
    porque: (ctx) =>
      `El número que usa ChatCenter${
        ctx.numero ? ` (${ctx.numero})` : ''
      } no es el que está vinculado a la página${
        ctx.pagina ? ` "${ctx.pagina}"` : ''
      } en Meta, así que el anuncio no sabría a qué bandeja mandar los mensajes.`,
    pasos: [
      'Abre la configuración de la página en Facebook, sección WhatsApp.',
      'Vincula ahí el mismo número que tienes conectado en ChatCenter, o cambia el número en ChatCenter por el que ya está vinculado.',
      'Vuelve a lanzar.',
    ],
    enlace: { texto: 'Abrir Configuración del negocio', url: AJUSTES },
  },
  {
    subcode: 1359188,
    culpa: 'cuenta',
    titulo: 'Tu cuenta publicitaria no tiene medio de pago',
    porque:
      'Meta no crea campañas en una cuenta sin tarjeta o medio de pago válido, aunque la campaña salga en pausa.',
    pasos: [
      'Entra al centro de facturación de tu cuenta publicitaria.',
      'Agrega una tarjeta o medio de pago y guárdalo.',
      'Vuelve a lanzar.',
    ],
    enlace: { texto: 'Abrir el centro de facturación', url: FACTURACION },
  },
  {
    subcode: 2859024,
    culpa: 'cuenta',
    titulo: 'Falta aceptar la política de no discriminación de Meta',
    porque:
      'Meta obliga a que un administrador del portafolio acepte esa política una sola vez antes de que la cuenta pueda publicar cualquier anuncio. Es papeleo pendiente, no una sanción: se firma una vez y vale para siempre.',
    pasos: [
      'Entra a Configuración del negocio con un usuario ADMINISTRADOR del portafolio (no basta con ser empleado).',
      'Ve a Información del negocio y busca "Política de no discriminación".',
      'Acéptala y vuelve a lanzar.',
    ],
    // Este enlace lo da Meta en el propio error, no es inventado.
    enlace: {
      texto: 'Guía de Meta sobre esta política',
      url: 'https://www.facebook.com/business/help/338925176776440',
    },
  },
  {
    subcode: 1487202,
    culpa: 'cuenta',
    titulo: 'No tienes permiso para crear anuncios de esa página',
    porque:
      'Meta te deja usar la cuenta publicitaria, pero no publicar en nombre de esa página. Pasa cuando la página es de otra persona o solo te dieron un acceso parcial.',
    pasos: [
      'Pide a quien tenga control total de la página que te dé acceso para crear anuncios.',
      'O elige otra página en la plantilla, si tienes más de una conectada.',
    ],
    enlace: { texto: 'Ver tus páginas y permisos', url: `${AJUSTES}/pages` },
  },
  {
    subcode: 1487194,
    culpa: 'cuenta',
    titulo: 'Meta no te deja usar esta cuenta publicitaria o esta página',
    porque:
      'El acceso existe en ChatCenter, pero Meta responde que el usuario que conectó ya no ve ese activo, o que la acción está restringida para ese tipo de cuenta.',
    pasos: [
      'Comprueba que sigues siendo administrador de la cuenta publicitaria y de la página en Configuración del negocio.',
      'Si cambiaste de rol o de portafolio, vuelve a conectar Facebook desde Conexiones.',
    ],
    enlace: { texto: 'Abrir Configuración del negocio', url: AJUSTES },
  },
  {
    code: 200,
    culpa: 'cuenta',
    titulo: 'Meta rechazó el permiso sobre la cuenta o la página',
    porque:
      'Meta devolvió un error de permisos sin más detalle. Casi siempre es que el usuario que conectó Facebook perdió el acceso a la cuenta publicitaria o a la página.',
    pasos: [
      'Entra a Conexiones y vuelve a conectar Facebook con el usuario que sí es administrador.',
      'Si acabas de cambiar de portafolio, reconecta también la cuenta publicitaria.',
    ],
    enlace: { texto: 'Abrir Configuración del negocio', url: AJUSTES },
  },
  {
    subcode: 33,
    culpa: 'cuenta',
    titulo: 'La cuenta publicitaria ya no está disponible',
    porque:
      'Meta dice que esa cuenta publicitaria no existe o no se puede ver con el acceso actual. Suele pasar si la cerraron, la movieron a otro portafolio o te quitaron el acceso.',
    pasos: [
      'Revisa la cuenta en Configuración del negocio → Cuentas publicitarias.',
      'Si cambió de dueño o de portafolio, vuelve a conectarla desde Conexiones.',
    ],
    enlace: {
      texto: 'Ver tus cuentas publicitarias',
      url: `${AJUSTES}/ad-accounts`,
    },
  },
  {
    subcode: 1487756,
    culpa: 'plantilla',
    titulo: 'Hay ubicaciones que se solapan',
    porque:
      'Elegiste dos lugares donde uno está dentro del otro (por ejemplo un país y una de sus ciudades). Meta no acepta ese cruce.',
    pasos: [
      'Edita la plantilla y quita una de las dos ubicaciones.',
      'Deja solo el nivel que quieras segmentar: el país, o las ciudades.',
    ],
  },
  {
    patron: /global id .* is not allowed for this call/i,
    culpa: 'plantilla',
    titulo: 'Una de las ubicaciones no sirve para anuncios',
    porque:
      'Meta no acepta ese lugar para segmentar anuncios, aunque aparezca en el buscador.',
    pasos: [
      'Edita la plantilla, borra esa ubicación y vuelve a buscarla.',
      'Elige una ciudad o región más grande de las que ofrece el buscador.',
    ],
  },
  {
    patron: /promoted_object\[page_id\]/i,
    culpa: 'plantilla',
    titulo: 'La página de la plantilla no es válida',
    porque:
      'La plantilla apunta a una página que Meta ya no reconoce con este acceso: la desconectaron, la borraron o te quitaron el permiso.',
    pasos: [
      'Edita la plantilla y vuelve a elegir la página.',
      'Si no aparece ninguna, reconecta Facebook desde Conexiones.',
    ],
  },
  {
    subcode: 4834011,
    culpa: 'nuestro',
    titulo: 'Fallo de ChatCenter al armar el presupuesto',
    porque:
      'Meta empezó a pedir un campo nuevo al crear el conjunto de anuncios (is_adset_budget_sharing_enabled) que nuestro lanzador todavía no envía.',
    pasos: [
      'Avísanos con la fecha y el nombre de la plantilla y lo corregimos de nuestro lado.',
    ],
  },
  {
    patron: /timeout of \d+ms exceeded|ETIMEDOUT|ECONNABORTED/i,
    culpa: 'reintentar',
    titulo: 'Meta tardó demasiado en responder',
    porque:
      'Se agotó el tiempo de espera. La campaña PUEDE haberse creado igual, así que volver a lanzar la duplicaría.',
    pasos: [
      'Espera un minuto y abre el centro de campañas.',
      'Si la campaña aparece ahí, ya está creada y no hace falta lanzar otra vez.',
      'Si no aparece, vuelve a lanzar.',
    ],
  },
];

// Normaliza lo que Meta mandó: a veces es {error:{...}}, a veces el error
// plano, y en los fallos de red es solo un string con el mensaje de axios.
const normalizar = (crudo) => {
  if (!crudo) return {};
  if (typeof crudo === 'string') return { message: crudo };
  if (crudo.error && typeof crudo.error === 'object') return crudo.error;
  return crudo;
};

const resolver = (valor, ctx) =>
  typeof valor === 'function' ? valor(ctx) : valor;

/**
 * Explica en español por qué Meta rechazó un lanzamiento.
 * @param {object|string} crudo err.meta_error, o el mensaje suelto.
 * @param {object} ctx { paso, numero, pagina } para los textos con datos.
 * @returns {{titulo:string,porque:string,pasos:string[],enlace:object|null,
 *            culpa:string,codigo:string|null,crudo:string}}
 */
const explicarError = (crudo, ctx = {}) => {
  const e = normalizar(crudo);
  const subcode = Number(e.error_subcode) || null;
  const code = Number(e.code) || null;
  const texto = String(e.error_user_msg || e.message || '');

  const ficha =
    CATALOGO.find((c) => c.subcode && c.subcode === subcode) ||
    CATALOGO.find((c) => c.patron && c.patron.test(texto)) ||
    CATALOGO.find((c) => c.code && c.code === code && !c.subcode);

  const codigo = [code, subcode].filter(Boolean).join('/') || null;

  // Meta a veces mete su propio artículo de ayuda dentro del mensaje. Ese
  // enlace es mejor que cualquiera que pongamos nosotros, así que se extrae y
  // se usa cuando la ficha no trae uno propio.
  const ayuda = texto.match(
    /https:\/\/(?:www\.|developers\.)?facebook\.com\/[^\s)"']+/i,
  );

  // Desconocido: no se inventa una explicación. Se muestra lo que dijo Meta y
  // se pide la captura, que es lo único útil para añadirlo al catálogo.
  if (!ficha) {
    return {
      titulo: 'Meta rechazó el lanzamiento',
      porque:
        (ctx.paso ? `Falló en el paso "${ctx.paso}". ` : '') +
        (texto || 'Meta no dio un motivo legible.'),
      pasos: [
        'Mándanos una captura de este mensaje con la fecha y el nombre de la plantilla.',
      ],
      enlace: ayuda ? { texto: 'Lo que dice Meta', url: ayuda[0] } : null,
      culpa: 'desconocido',
      codigo,
      crudo: texto,
    };
  }

  return {
    titulo: resolver(ficha.titulo, ctx),
    porque: resolver(ficha.porque, ctx),
    pasos: resolver(ficha.pasos, ctx) || [],
    enlace:
      ficha.enlace ||
      (ayuda ? { texto: 'Lo que dice Meta', url: ayuda[0] } : null),
    culpa: ficha.culpa,
    codigo,
    crudo: texto,
  };
};

// Una sola línea, para donde no cabe la ficha entera: la tabla de la bitácora
// y el campo `message` que ya leían los avisos antiguos del front.
const resumirError = (crudo, ctx = {}) => {
  const m = explicarError(crudo, ctx);
  return `${m.titulo}. ${m.porque}`;
};

module.exports = { explicarError, resumirError };
