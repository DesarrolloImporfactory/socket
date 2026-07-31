const moment = require('moment-timezone');
const { enlaceUbicacionSede } = require('./ubicacionSede');

/* Qué datos puede poner el cliente en cada variable de su plantilla de
   recordatorio.

   La lista es corta a propósito: solo lo que de verdad tenemos a la mano cuando
   sale el aviso. Ofrecer "precio" o "abono" cuando la cita no los guarda
   terminaría mandándole al cliente final un mensaje con un hueco, que es peor
   que no mandar nada.

   Mismo contrato que las plantillas de seguimiento de Dropi: se guarda la clave
   pelada ("nombre"), no "{{nombre}}", y el mapeo es POSICIONAL —
   body[0] → {{1}}, body[1] → {{2}}, …— para que la plantilla pueda tener las
   variables que quiera, en el orden que quiera, o ninguna. */
const VARIABLES_RECORDATORIO = [
  { key: 'nombre', label: 'Nombre del cliente', ejemplo: 'María Pérez' },
  {
    key: 'servicio',
    label: 'Servicio de la cita',
    ejemplo: 'Limpieza facial profunda',
  },
  { key: 'hora', label: 'Hora de la cita', ejemplo: '15:30' },
  { key: 'fecha', label: 'Fecha de la cita', ejemplo: 'lunes 4 de agosto' },
  {
    key: 'fecha_hora',
    label: 'Fecha y hora juntas',
    ejemplo: 'lunes 4 de agosto a las 15:30',
  },
  {
    key: 'ubicacion',
    label: 'Enlace de cómo llegar (Maps)',
    ejemplo: 'https://maps.app.goo.gl/ejemplo',
  },
  { key: 'sede', label: 'Nombre de la sede', ejemplo: 'Sede Norte' },
  {
    key: 'direccion',
    label: 'Dirección de la sede',
    ejemplo: 'Av. Amazonas N34-120 y Atahualpa',
  },
  { key: 'ciudad', label: 'Ciudad de la sede', ejemplo: 'Quito' },
  {
    key: 'telefono_sede',
    label: 'Teléfono de la sede',
    ejemplo: '02 245 6789',
  },
  { key: 'negocio', label: 'Nombre del negocio', ejemplo: 'Centro de Belleza' },
  {
    key: 'detalle',
    label: 'Detalle de la cita',
    ejemplo: 'Valoración previa incluida',
  },
];

const CLAVES_VALIDAS = new Set(VARIABLES_RECORDATORIO.map((v) => v.key));

/* Mapeo por defecto cuando el cliente elige una plantilla y todavía no ajustó
   nada. Es el orden en que casi siempre están escritas: "Hola NOMBRE, te
   recordamos tu SERVICIO a las HORA en UBICACIÓN". */
const MAPEO_SUGERIDO = ['nombre', 'servicio', 'hora', 'ubicacion'];

const mapeoPorDefecto = (cuantas) =>
  Array.from(
    { length: Math.max(0, Number(cuantas) || 0) },
    (_, i) => MAPEO_SUGERIDO[i] || 'nombre',
  );

/* Meta tumba la plantilla entera (error 132000) si un parámetro va vacío o trae
   saltos de línea, así que nunca sale un valor en blanco: si el dato falta se
   manda un guion y el mensaje llega igual. */
const limpiarParametro = (valor) =>
  String(valor ?? '')
    .replace(/[\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 1024);

/* ctx trae lo que el cron ya tiene en la mano por cada cita:
   nombre, title, description, start_utc, time_zone, meeting_url,
   sede_nombre, sede_direccion, sede_ciudad, sede_provincia, sede_maps,
   sede_telefono, negocio. */
function resolverVariableRecordatorio(clave, ctx = {}) {
  const zona = ctx.time_zone || 'America/Guayaquil';
  const cuando = ctx.start_utc ? moment.utc(ctx.start_utc).tz(zona) : null;

  switch (clave) {
    case 'nombre':
      return ctx.nombre || 'Hola';
    case 'servicio':
      return ctx.title || 'tu cita';
    case 'hora':
      return cuando ? cuando.format('HH:mm') : '';
    case 'fecha':
      return cuando ? cuando.locale('es').format('dddd D [de] MMMM') : '';
    case 'fecha_hora':
      return cuando
        ? cuando.locale('es').format('dddd D [de] MMMM [a las] HH:mm')
        : '';
    case 'ubicacion':
      /* En una cita presencial meeting_url va en NULL. El enlace de Maps de la
         sede ocupa ese lugar: es el dato que el cliente necesita justo antes de
         salir. Si no hay ninguno, al menos la dirección escrita. */
      return (
        ctx.meeting_url ||
        enlaceUbicacionSede({
          google_maps_url: ctx.sede_maps,
          direccion: ctx.sede_direccion,
          ciudad: ctx.sede_ciudad,
          provincia: ctx.sede_provincia,
        }) ||
        ctx.sede_nombre ||
        'Te esperamos en el local'
      );
    case 'sede':
      return ctx.sede_nombre || ctx.negocio || '';
    case 'direccion':
      return ctx.sede_direccion || '';
    case 'ciudad':
      return ctx.sede_ciudad || '';
    case 'telefono_sede':
      return ctx.sede_telefono || '';
    case 'negocio':
      return ctx.negocio || '';
    case 'detalle':
      return ctx.description || '';
    default:
      return '';
  }
}

/* Convierte el mapeo guardado en el array posicional que espera el envío.
   Una plantilla sin variables devuelve [] y se manda tal cual. */
function construirParametrosRecordatorio(mapeo, ctx) {
  if (!Array.isArray(mapeo) || !mapeo.length) return [];
  return mapeo.map(
    (clave) => limpiarParametro(resolverVariableRecordatorio(clave, ctx)) || '-',
  );
}

/* Normaliza lo que llega del front. Una clave inventada se cae a "nombre" en
   vez de mandar un parámetro vacío que tumbaría el envío. */
const normalizarMapeo = (lista) =>
  (Array.isArray(lista) ? lista : [])
    .map((k) => String(k || '').trim())
    .map((k) => (CLAVES_VALIDAS.has(k) ? k : 'nombre'));

module.exports = {
  VARIABLES_RECORDATORIO,
  CLAVES_VALIDAS,
  MAPEO_SUGERIDO,
  mapeoPorDefecto,
  normalizarMapeo,
  limpiarParametro,
  resolverVariableRecordatorio,
  construirParametrosRecordatorio,
};
