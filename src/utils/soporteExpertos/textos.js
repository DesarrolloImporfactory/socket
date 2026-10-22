/* Textos FIJOS que el bot de soporte de Expertos le manda al cliente. Viven en
   un solo lugar porque los usan el prompt, la guardia de respuestas (son el
   reemplazo cuando el modelo se sale de la regla) y las pruebas.

   Los aprueba Daniel antes de abrir el bot a clientes reales. Ninguno promete
   una hora ni un día: solo «apenas abramos». Tuteo ecuatoriano, sin voseo. */

'use strict';

const LINKS = {
  plataforma: 'https://imporfactory.app',
  // Enlace fijo de la clase en vivo: abre la sala solo cuando el calendario de
  // la plataforma dice que hay clase (imporsuit-pro, docs/enlace_clase.md).
  clase: 'https://new.imporsuitpro.com/clase',
  // Las 6 herramientas de «Importaciones» en la plataforma nueva (imporfactory.app,
  // rutas sacadas de su código el 18-oct-2026). El bot manda al cliente a la
  // herramienta exacta en vez de pasarlo a un asesor.
  importaciones: 'https://imporfactory.app/importaciones',
  ideasProductos: 'https://imporfactory.app/ideas-productos',
  proveedores: 'https://imporfactory.app/proveedores',
  calculadora: 'https://imporfactory.app/calculadora',
  seguimientoCarga: 'https://imporfactory.app/seguimiento-carga',
  infoaduana: 'https://imporfactory.app/infoaduana',
  imporia: 'https://imporfactory.app/imporia',
  checklist: 'https://imporfactory.app/checklist',
  cursoMetodoYuan: 'https://imporfactory.app/cursos/30',
};

/* ── Los de la versión 1 (sin cambios) ── */
// La segunda mitad del paso a asesor. La guardia la agrega cuando el modelo
// contestó con una ficha que pasa a una persona y se olvidó de decirlo.
const CIERRE_ASESOR = 'Un asesor lo revisa y te escribe apenas abramos.';
const MENSAJE_ASESOR = `Recibí tu mensaje. ${CIERRE_ASESOR}`;
const MENSAJE_SALUDO =
  'Hola. Cuéntame qué necesitas. Si hace falta un asesor, lo dejo anotado para que te escriba apenas abramos.';
const MENSAJE_RECIBIDO = 'Recibido. Lo sumo a tu caso para el asesor.';
const MENSAJE_ARCHIVO = 'Recibí lo que enviaste. Un asesor lo revisa y te escribe apenas abramos.';
const MENSAJE_CLASE = `El enlace para entrar a la clase en vivo es siempre el mismo: ${LINKS.clase}
Se abre 30 minutos antes de cada clase. Fuera de ese rato te muestra cuándo es la próxima, con la hora de Ecuador y la de México. Las clases anteriores quedan grabadas en la plataforma.`;
const MENSAJE_ROBOT = 'Soy el asistente automático de IMPORFACTORY. Un asesor te escribe apenas abramos.';
// Lo que recibe el cliente si OpenAI falla (ia_ajustes → mensaje_fallback).
const MENSAJE_FALLBACK = 'Recibimos tu mensaje. Un asesor te escribe apenas abramos.';

/* ── Nuevos de la versión 2 (pendientes de aprobación) ── */
// Preguntó por su carga y con su número no hay ninguna en curso.
const MENSAJE_SIN_CARGA =
  'Con el número desde el que me escribes no encuentro una carga en curso; puede estar registrada con otro teléfono. Envíame tu marca de envío o tu número de cotización y lo dejo anotado para el área de logística. Un asesor te escribe apenas abramos.';
// Hay carga, pero el dato del sistema no se puede informar sin que lo vea una persona.
const MENSAJE_CARGA_A_LOGISTICA =
  'Recibí tu mensaje. El área de logística revisa tu carga y un asesor te escribe apenas abramos.';
// Pide la carga de otra persona, de otro número o con un código que no es suyo.
const MENSAJE_SOLO_TU_NUMERO =
  'Por seguridad, por este chat solo puedo informar la carga registrada con el número desde el que escribes. Un asesor revisa tu consulta y te escribe apenas abramos.';
// Mandó un archivo, un video o un audio que no se pudo leer y no dijo para qué.
const MENSAJE_ADJUNTO_SIN_TEXTO =
  'Recibí lo que enviaste, pero no lo puedo abrir. Cuéntame en un mensaje qué necesitas con eso y lo dejo anotado para el asesor.';

/* ── Tras la prueba en papel de la versión 2 (pendientes de aprobación) ──
   No traen palabras nuevas: son «Entiendo tu preocupación.» (que el prompt ya
   mandaba ante un reclamo) más un texto fijo. Están aquí porque ahora también
   los pone el CÓDIGO cuando el modelo manda un reclamo a cobranza o le repite
   el estado de la carga a quien reclama por la demora. */
const FRASE_RECLAMO = 'Entiendo tu preocupación.';
const MENSAJE_RECLAMO = `${FRASE_RECLAMO} ${MENSAJE_ASESOR}`;
const MENSAJE_RECLAMO_CARGA = `${FRASE_RECLAMO} ${MENSAJE_CARGA_A_LOGISTICA}`;

/* La ficha `cotizar-datos` ya no pide la cantidad (para no pedirla dos veces):
   la pide el prompt junto con el paso a asesor. Si el modelo manda la ficha
   sola y la guardia le completa el paso, también completa este pedido, salvo
   que el cliente ya haya dicho cuántas unidades quiere (senales.dioCantidad).
   Es la misma frase que trae la ficha `cotizar-producto-del-catalogo`. */
const PREGUNTA_CANTIDAD = 'Dime cuántas unidades piensas comprar.';

const TODOS = {
  MENSAJE_ASESOR,
  MENSAJE_SALUDO,
  MENSAJE_RECIBIDO,
  MENSAJE_ARCHIVO,
  MENSAJE_CLASE,
  MENSAJE_ROBOT,
  MENSAJE_FALLBACK,
  MENSAJE_SIN_CARGA,
  MENSAJE_CARGA_A_LOGISTICA,
  MENSAJE_SOLO_TU_NUMERO,
  MENSAJE_ADJUNTO_SIN_TEXTO,
  MENSAJE_RECLAMO,
  MENSAJE_RECLAMO_CARGA,
};

module.exports = { LINKS, ...TODOS, CIERRE_ASESOR, FRASE_RECLAMO, PREGUNTA_CANTIDAD, TEXTOS_FIJOS: Object.freeze(TODOS) };
