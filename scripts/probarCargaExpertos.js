/**
 * Muestra qué leería el bot de soporte de Expertos sobre la carga de un número
 * de WhatsApp. SOLO LECTURA: consulta la base de Imporsuit con SELECT y no
 * escribe nada, no llama a OpenAI y no manda ningún mensaje.
 *
 * Sirve para comprobar, antes de encender el bot, que el buscador encuentra a
 * un cliente conocido y que el texto es el mismo que da «Buscar carga» en el
 * portal «Mi puesto».
 *
 *   node scripts/probarCargaExpertos.js --telefono=5939XXXXXXXX
 *   node scripts/probarCargaExpertos.js --telefono=5939XXXXXXXX --mensaje="ya llegó mi carga EC-2609112?"
 *
 * Lo que imprime son datos de un cliente: no pegarlo en canales abiertos.
 */
require('dotenv').config();
const { db_2 } = require('../src/database/config');
const { cargasDelTelefono, bloqueCarga, codigosEnMensaje } = require('../src/utils/soporteExpertos/cargaCliente');
const { MENSAJE_ASESOR } = require('../src/utils/soporteExpertos/textos');

const arg = (k) =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');

(async () => {
  const telefono = arg('telefono').replace(/\D/g, '');
  if (!telefono) throw new Error('Falta --telefono=<número con código de país, como llega por WhatsApp>');
  const mensaje = arg('mensaje') || 'dónde está mi carga';

  const t0 = Date.now();
  const r = await cargasDelTelefono(telefono);
  console.log(`Resultado: ${r.estado} — ${r.motivo} (${Date.now() - t0} ms)`);
  console.log(`Cotizaciones de este número: ${r.propias.cotizaciones.length} · marcas: ${r.propias.marcas.length}`);
  console.log('\n──── Bloque que recibiría el modelo ────');
  console.log(bloqueCarga(r, { codigos: codigosEnMensaje(mensaje), mensajeAsesor: MENSAJE_ASESOR }));
})()
  .then(() => db_2.close())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
