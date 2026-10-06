/* ═══════════════════════════════════════════════════════════
   Ajustes del bot a nivel de cuenta (configuraciones.ia_ajustes, JSON)

   Perillas que antes eran una sola para todas las cuentas y que una cuenta de
   SOPORTE necesita distintas a una tienda (caso cfg 261, manual de Evelyn del
   2026-10-05):

   - espera_rafaga_seg   segundos que el bot espera al cliente antes de
                         contestar (fijo, reemplaza la ventana adaptativa de
                         utils/agruparRafaga). Un dropshipper escribe "buen día"
                         / "una consulta" / foto / "el ID es…" y el bot le
                         contestaba cada pedazo.
   - mensaje_fallback    texto que SÍ se le manda al cliente cuando el bot no
                         pudo responder (OpenAI sin saldo o caído). Sin esto el
                         cliente no recibe nada y el equipo solo ve el cartel.
   - numeros_excluidos   teléfonos del propio equipo (bodega, asesores) a los
                         que el bot nunca les contesta.
   - pausa_humano        { minutos, estados }: en esas columnas el bot calla si
                         una persona del equipo escribió hace menos de N
                         minutos — el chat lo está atendiendo alguien.

   Va en un JSON y no en cuatro columnas porque son ajustes de pocas cuentas y
   van a aparecer más. Si la columna todavía no existe (falta aplicar
   ia_ajustes_migration.sql) se responde "sin ajustes": el bot queda
   exactamente como estaba.
   ═══════════════════════════════════════════════════════════ */
const { db } = require('../database/config');

const TTL_MS = 60 * 1000;
const ESPERA_MIN_SEG = 2;
const ESPERA_MAX_SEG = 45; // más que eso ya es un bot que no contesta

const SIN_AJUSTES = Object.freeze({
  espera_rafaga_ms: null,
  mensaje_fallback: null,
  numeros_excluidos: [],
  pausa_humano: null,
});

// id_configuracion → { ts, valor }
const cache = new Map();
let avisoSinMigrar = false;

const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');

function normalizar(raw) {
  let c = raw;
  try {
    while (typeof c === 'string') c = JSON.parse(c);
  } catch {
    return SIN_AJUSTES;
  }
  if (!c || typeof c !== 'object') return SIN_AJUSTES;

  const espera = Number(c.espera_rafaga_seg);
  const fallback = String(c.mensaje_fallback || '').trim();
  const minutos = Number(c.pausa_humano?.minutos);
  const estados = Array.isArray(c.pausa_humano?.estados)
    ? c.pausa_humano.estados.map((e) => String(e).toLowerCase().trim()).filter(Boolean)
    : [];

  return {
    espera_rafaga_ms:
      Number.isFinite(espera) && espera > 0
        ? Math.min(Math.max(espera, ESPERA_MIN_SEG), ESPERA_MAX_SEG) * 1000
        : null,
    mensaje_fallback: fallback || null,
    numeros_excluidos: (Array.isArray(c.numeros_excluidos) ? c.numeros_excluidos : [])
      .map(soloDigitos)
      .filter((n) => n.length >= 7),
    pausa_humano:
      Number.isFinite(minutos) && minutos > 0 && estados.length
        ? { minutos: Math.min(minutos, 24 * 60), estados }
        : null,
  };
}

async function getAjustesIA(id_configuracion) {
  const id = Number(id_configuracion);
  if (!id) return SIN_AJUSTES;

  const enCache = cache.get(id);
  if (enCache && Date.now() - enCache.ts < TTL_MS) return enCache.valor;

  let valor = SIN_AJUSTES;
  try {
    const [row] = await db.query(
      `SELECT ia_ajustes FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id], type: db.QueryTypes.SELECT },
    );
    valor = normalizar(row?.ia_ajustes);
  } catch (err) {
    if (!avisoSinMigrar) {
      avisoSinMigrar = true;
      console.warn(
        '[ajustesIA] No se pudo leer ia_ajustes (¿falta la migración?):',
        err.message,
      );
    }
  }
  cache.set(id, { ts: Date.now(), valor });
  return valor;
}

function invalidarAjustesIA(id_configuracion) {
  cache.delete(Number(id_configuracion));
}

/* El mismo número llega con y sin código de país según el canal ("0991234567",
   "593991234567"): se compara por los últimos 9 dígitos. */
function esNumeroExcluido(ajustes, telefono) {
  const tel = soloDigitos(telefono);
  if (tel.length < 7 || !ajustes?.numeros_excluidos?.length) return false;
  const cola = (n) => n.slice(-9);
  return ajustes.numeros_excluidos.some((n) => cola(n) === cola(tel));
}

/* `responsable` trae el nombre de quien escribió. Lo que empieza con IA_, cron_
   o es un emisor del sistema (encuesta, notifier, respondedor) no es una
   persona. "Whatsapp Business" sí: es el eco de la app de coexistencia, o sea
   alguien del equipo escribiendo desde el teléfono. */
function esResponsableHumano(responsable) {
  const resp = String(responsable || '').trim();
  return Boolean(
    resp &&
      !/^(IA_|IA$|cron_|dropi|aliclik|sistema|instagram|messenger|respondedor|encuesta|bot\b)/i.test(
        resp,
      ),
  );
}

module.exports = {
  getAjustesIA,
  invalidarAjustesIA,
  esNumeroExcluido,
  esResponsableHumano,
  normalizar,
};
