/* Configuraciones de SOPORTE: conexiones con las que Imporsuit atiende a gente
   que ya es usuaria suya (no clientes finales de una tienda). Solo ahí tienen
   sentido las herramientas que cruzan contra la BD de Imporsuit: el panel de
   cuenta Imporchat en /chat y la membresía en las tarjetas del kanban.
   Agregar ids acá es lo único que hace falta para extenderlas a otra conexión. */
const CONFIGS_SOPORTE = [251, 265];

const esConfigSoporte = (id) => CONFIGS_SOPORTE.includes(Number(id));

module.exports = { CONFIGS_SOPORTE, esConfigSoporte };
