/**
 * Reconciliación de la telefonía por saldo contra Zadarma.
 *
 * El cierre de una llamada depende de avisos (webhooks) que Zadarma manda
 * una sola vez. Si el servidor está reiniciando justo en ese momento (un
 * deploy, por ejemplo), el aviso se pierde y la llamada queda abierta: sin
 * estado, SIN COBRAR a la conexión (Zadarma sí le cobró a Imporfactory),
 * sin grabación y sin análisis. Este proceso lo repara cada 10 minutos
 * (cron/telefoniaReconciliar.js) leyendo la verdad en Zadarma:
 *
 *   1. Llamadas abiertas (o con cierre provisional) → se buscan en las
 *      estadísticas de la central por extensión + destino + hora y se cierran
 *      con zadarma.cerrarLlamada (mismo camino que el webhook: cobra, avisa
 *      en el chat). Sin rastro en Zadarma: a los 20 min se cierran como
 *      "no_marco" (nunca salió) y a las 2 h como "sin_cierre"; ambos son
 *      provisionales y se corrigen si luego aparece el dato real.
 *   2. Grabaciones que no se descargaron → zadarma.traerGrabacion.
 *   3. Análisis de IA a medias → telefonia_ia.analizarRezagadas.
 *
 * Es idempotente: correrlo dos veces no cobra dos veces (el UPDATE de
 * cierre es atómico) y puede convivir con el webhook y con otro servidor
 * apuntando a la misma base.
 */
const { Op } = require('sequelize');
const { db } = require('../database/config');
const TelefoniaLlamadas = require('../models/telefonia_llamadas.model');
const zadarma = require('./zadarma.service');
const telefoniaIA = require('./telefonia_ia.service');

const MIN = 60_000;
const ESPERA_MIN = 3; // no tocar llamadas más nuevas: el webhook aún puede llegar
const SIN_RASTRO_NO_MARCO_MIN = 20;
const SIN_RASTRO_SIN_CIERRE_MIN = 120;
const VENTANA_HORAS = 48;

/** "YYYY-MM-DD HH:MM:SS" (hora de Ecuador, como la guarda la base y como la
 *  entrega Zadarma) → milisegundos comparables entre sí. */
const aMs = (v) => {
  if (!v) return NaN;
  if (v instanceof Date) return v.getTime() - 5 * 3600_000; // Date real → reloj de Ecuador
  return new Date(`${String(v).slice(0, 19).replace(' ', 'T')}Z`).getTime();
};
const aTexto = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** Ahora mismo en reloj de Ecuador, en la misma escala que aMs(). */
const ahoraEc = () => Date.now() - 5 * 3600_000;
const digitos = (t) => String(t || '').replace(/\D/g, '');

/**
 * Empareja cada llamada nuestra con su registro en /v1/statistics/pbx/.
 * Misma extensión, mismo destino, y la central la vio empezar entre 15 s
 * antes y 3 min después de que el asesor pulsó llamar (el navegador tarda
 * en marcar). Cada registro de Zadarma se usa una sola vez; gana el más
 * cercano en el tiempo. Devuelve Map(id_llamada → registro).
 */
function emparejar(llamadas, stats) {
  /* Emparejamiento GLOBAL por cercanía: se arman todos los pares posibles
     (llamada, registro) y se asignan del más cercano al más lejano. Hay que
     pasarle TODAS las llamadas del período, también las ya cerradas: así
     cada llamada real reclama su propio registro (1-3 s de diferencia) y un
     intento que nunca se marcó, hecho un minuto antes al mismo número, no
     se lo roba. Sin esto el cron habría cobrado dos veces la misma llamada
     (lo detectó el modo prueba el 2026-10-05: 29 intentos huérfanos
     emparejaban con llamadas ya cobradas). */
  const regs = (stats || []).map((s, i) => ({ s, i, ms: aMs(s.callstart) }));
  const candidatos = [];
  for (const l of llamadas) {
    const t = aMs(l.inicio_at);
    for (const r of regs) {
      if (String(r.s.sip) !== String(l.extension)) continue;
      if (digitos(r.s.destination) !== digitos(l.telefono_cliente)) continue;
      const d = r.ms - t;
      if (d < -15_000 || d > 3 * MIN) continue;
      candidatos.push({ id: l.id, i: r.i, dist: Math.abs(d) });
    }
  }
  candidatos.sort((a, b) => a.dist - b.dist);
  const pares = new Map();
  const usados = new Set();
  for (const c of candidatos) {
    if (pares.has(c.id) || usados.has(c.i)) continue;
    pares.set(c.id, regs[c.i].s);
    usados.add(c.i);
  }
  return pares;
}

/**
 * @param {object} o
 * @param {boolean} o.dryRun      no escribe nada; devuelve lo que haría
 * @param {Array}   o.statsPbx    estadísticas inyectadas (pruebas); si no, se piden a Zadarma
 * @param {number}  o.soloConfig  limita a una conexión (pruebas)
 * @param {boolean} o.conGrabaciones / o.conAnalisis  pasos 2 y 3
 */
async function reconciliar({ dryRun = false, statsPbx = null, soloConfig = null, conGrabaciones = true, conAnalisis = true } = {}) {
  const out = { abiertas: 0, cerradas: 0, cobrado_centavos: 0, no_marco: 0, sin_cierre: 0, en_espera: 0, grabaciones: 0, analisis: 0, detalle: [] };
  const ahora = ahoraEc();
  const filtroCfg = soloConfig ? { id_configuracion: soloConfig } : {};

  /* ── 1. Llamadas sin cierre real ── */
  const candidatas = await TelefoniaLlamadas.findAll({
    where: {
      ...filtroCfg,
      inicio_at: { [Op.gt]: db.literal(`DATE_SUB(NOW(), INTERVAL ${VENTANA_HORAS} HOUR)`) },
      [Op.or]: [{ fin_at: null }, { disposition: { [Op.in]: zadarma.CIERRES_PROVISIONALES } }],
    },
    order: [['id', 'ASC']],
  });
  // Las muy recientes se dejan: el webhook normal todavía puede llegar.
  // Los cierres provisionales solo se revisan 6 h: después de eso Zadarma ya
  // no va a traer nada nuevo y no vale gastar una consulta cada 10 min.
  const maduras = candidatas.filter((l) => {
    const edad = ahora - aMs(l.inicio_at);
    return edad >= ESPERA_MIN * MIN && (!l.fin_at || edad <= 6 * 60 * MIN);
  });
  out.abiertas = maduras.filter((l) => !l.fin_at).length;

  let stats = statsPbx;
  if (maduras.length && !stats) {
    try {
      const desde = Math.min(...maduras.map((l) => aMs(l.inicio_at))) - 2 * MIN;
      const d = await zadarma.api('/v1/statistics/pbx/', { start: aTexto(desde), end: aTexto(ahora + MIN) });
      stats = Array.isArray(d.stats) ? d.stats : [];
    } catch (e) {
      // Zadarma limita las consultas: sin estadísticas no se cierra nada a
      // ciegas; se intenta en la siguiente corrida. Lo demás sigue.
      out.error_estadisticas = e.message;
      stats = null;
    }
  }
  if (maduras.length && stats) {
    /* Se empareja contra TODAS las llamadas del período (también las ya
       cerradas en firme), para que cada registro de Zadarma lo reclame su
       llamada real y no un intento huérfano al mismo número. */
    const desdePeriodo = aTexto(Math.min(...maduras.map((l) => aMs(l.inicio_at))) - 5 * MIN);
    const delPeriodo = await TelefoniaLlamadas.findAll({
      where: { ...filtroCfg, inicio_at: { [Op.gte]: db.literal(db.escape(desdePeriodo)) } },
      attributes: ['id', 'extension', 'telefono_cliente', 'inicio_at'],
    });
    const pares = emparejar(delPeriodo, stats);
    for (const l of maduras) {
      const s = pares.get(l.id);
      const edadMin = (ahora - aMs(l.inicio_at)) / MIN;
      if (s) {
        const datos = {
          duracion: Number(s.seconds) || 0,
          disposition: s.disposition || null,
          grabada: String(s.is_recorded) === 'true',
          call_id_with_rec: String(s.is_recorded) === 'true' ? s.call_id || null : null,
          pbx_call_id: s.pbx_call_id || null,
        };
        if (dryRun) {
          out.detalle.push({ id: l.id, accion: 'cerrar', ...datos, antes: l.disposition || l.estado });
          out.cerradas += 1;
          continue;
        }
        const r = await zadarma.cerrarLlamada(l, datos);
        if (r) {
          out.cerradas += 1;
          out.cobrado_centavos += r.costo_centavos;
          out.detalle.push({ id: l.id, accion: 'cerrada', estado: r.estado, costo_centavos: r.costo_centavos });
        }
        continue;
      }
      if (l.fin_at) continue; // cierre provisional sin dato nuevo: se queda igual
      // Sin rastro en Zadarma.
      const provisional =
        !l.pbx_call_id && edadMin >= SIN_RASTRO_NO_MARCO_MIN
          ? 'no_marco'
          : edadMin >= SIN_RASTRO_SIN_CIERRE_MIN
            ? 'sin_cierre'
            : null;
      if (!provisional) {
        out.en_espera += 1;
        continue;
      }
      out[provisional] += 1;
      out.detalle.push({ id: l.id, accion: provisional });
      if (dryRun) continue;
      await TelefoniaLlamadas.update(
        { estado: 'failed', disposition: provisional, fin_at: new Date(), duracion_seg: 0, costo_centavos: 0 },
        { where: { id: l.id, fin_at: null } },
      );
    }
  }

  /* ── 2. Grabaciones que no llegaron a nuestro almacenamiento ── */
  if (conGrabaciones) {
    const sinGrabacion = await TelefoniaLlamadas.findAll({
      where: {
        ...filtroCfg,
        estado: 'answered',
        duracion_seg: { [Op.gt]: 0 },
        grabada: 1,
        fin_at: { [Op.and]: [{ [Op.gt]: db.literal(`DATE_SUB(NOW(), INTERVAL ${VENTANA_HORAS} HOUR)`) }, { [Op.lt]: db.literal('DATE_SUB(NOW(), INTERVAL 3 MINUTE)') }] },
        [Op.and]: [
          { [Op.or]: [{ grabacion_url: null }, { grabacion_url: { [Op.like]: '%api.zadarma.com%' } }] },
          { [Op.or]: [{ call_id_with_rec: { [Op.ne]: null } }, { pbx_call_id: { [Op.ne]: null } }] },
        ],
      },
      order: [['id', 'DESC']],
      limit: 10,
    });
    for (const l of sinGrabacion) {
      if (dryRun) {
        out.detalle.push({ id: l.id, accion: 'traer_grabacion' });
        out.grabaciones += 1;
        continue;
      }
      const url = await zadarma.traerGrabacion(l).catch(() => null);
      if (url && !/api\.zadarma\.com/.test(url)) out.grabaciones += 1;
    }
  }

  /* ── 3. Análisis de IA a medias ── */
  if (conAnalisis && !dryRun && !soloConfig) {
    const r = await telefoniaIA.analizarRezagadas(10).catch((e) => {
      console.error('[telefonia-reconciliar] análisis:', e.message);
      return { listas: 0 };
    });
    out.analisis = r.listas;
  }
  return out;
}

module.exports = { reconciliar, emparejar, aMs };
