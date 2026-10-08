'use strict';

/**
 * dropi_novedades.service.js
 *
 * Registro de novedades Dropi y su historial (tablas dropi_novedades y
 * dropi_novedades_historial, ver dropi_novedades_migration.sql).
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────
 * Dropi solo dice "esta orden está en NOVEDAD". No deja consultar cuántas
 * veces se volvió a ofrecer un pedido, quién lo solventó ni cómo terminó. Sin
 * eso no se puede decidir qué novedad puede resolver la IA y cuál tiene que
 * ver un asesor: la regla más importante es justamente la reincidencia (ya se
 * ofreció y volvió a caer en novedad → la gestiona una persona).
 *
 * ── Ciclo de una novedad ───────────────────────────────────────────────────
 *   pendiente ──(se envía solución)──▶ solventada ──(la orden sale de
 *   novedad)──▶ en_ruta ──(entregada / devolución / cancelada)──▶ cerrada
 *
 * Si estando en_ruta la orden vuelve a NOVEDAD, esa fila se cierra con
 * resultado "nueva_novedad" y se abre otra con numero + 1 marcada
 * requiere_asesor.
 *
 * ── Tolerante a que las tablas no existan ──────────────────────────────────
 * La migración se aplica a mano. Todas las funciones son best-effort: si la
 * tabla no existe (o falla la BD) devuelven el valor por defecto y NO rompen
 * el webhook, el cron ni el endpoint que las llamó.
 */

const { db } = require('../database/config');

const FINALES = new Set(['entregada', 'devolucion', 'cancelada', 'indemnizada']);
const EN_RUTA = new Set(['en_transito', 'en_reparto', 'retiro_agencia']);
// Tras una solución, la orden puede seguir llegando en NOVEDAD un rato (cron,
// webhooks atrasados). Solo se cuenta como novedad nueva pasado este margen.
const HORAS_MARGEN_SOLVENTADA = 12;

let tablasFaltanHasta = 0;

const esTablaFaltante = (e) =>
  (e?.original?.code || e?.parent?.code || e?.code) === 'ER_NO_SUCH_TABLE';

async function seguro(etiqueta, fn, porDefecto) {
  if (tablasFaltanHasta > Date.now()) return porDefecto;
  try {
    return await fn();
  } catch (e) {
    if (esTablaFaltante(e)) {
      // No insistir en cada webhook: se reintenta en 5 minutos.
      tablasFaltanHasta = Date.now() + 5 * 60 * 1000;
      console.warn(
        '[dropi-novedades] faltan las tablas (aplicar dropi_novedades_migration.sql); no se registra',
      );
    } else {
      console.error(`[dropi-novedades] ${etiqueta}:`, e?.message || e);
    }
    return porDefecto;
  }
}

const recortar = (v, n) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, n) : null;
};

const ordinal = (n) => `${n}ª`;

async function agregarEvento({
  id_novedad,
  id_configuracion,
  dropi_order_id,
  evento,
  origen = 'sistema',
  usuario = null,
  descripcion = null,
  detalle = null,
}) {
  await db.query(
    `INSERT INTO dropi_novedades_historial
       (id_novedad, id_configuracion, dropi_order_id, evento, origen,
        id_sub_usuario, nombre_usuario, descripcion, detalle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        id_novedad,
        id_configuracion,
        dropi_order_id,
        evento,
        origen,
        usuario?.id_sub_usuario || null,
        recortar(usuario?.nombre_encargado || usuario?.usuario, 150),
        recortar(descripcion, 500),
        detalle ? JSON.stringify(detalle) : null,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
}

/* Abre la novedad número `numero` de la orden. INSERT IGNORE: el webhook y el
   cron pueden ver la misma orden a la vez y la clave única evita duplicarla. */
async function abrirNovedad({ id_configuracion, orden, numero }) {
  const reincide = numero > 1;
  const motivo = reincide
    ? `Reincidencia: es la ${ordinal(numero)} novedad del pedido (ya se volvió a ofrecer ${numero - 1} ${numero - 1 === 1 ? 'vez' : 'veces'})`
    : null;

  const [, afectadas] = await db.query(
    `INSERT IGNORE INTO dropi_novedades
       (id_configuracion, dropi_order_id, numero, shipping_guide,
        transportadora, novedad, estado, requiere_asesor, motivo_asesor)
     VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)`,
    {
      replacements: [
        id_configuracion,
        orden.id,
        numero,
        recortar(orden.guia, 100),
        recortar(orden.transportadora, 100),
        recortar(orden.novedad, 500),
        reincide ? 1 : 0,
        motivo,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
  if (!afectadas) return null; // otro proceso la abrió primero

  const [fila] = await db.query(
    `SELECT * FROM dropi_novedades
      WHERE id_configuracion = ? AND dropi_order_id = ? AND numero = ? LIMIT 1`,
    {
      replacements: [id_configuracion, orden.id, numero],
      type: db.QueryTypes.SELECT,
    },
  );
  if (!fila) return null;

  await agregarEvento({
    id_novedad: fila.id,
    id_configuracion,
    dropi_order_id: orden.id,
    evento: reincide ? 'reincidencia' : 'detectada',
    descripcion: reincide
      ? `${motivo}. Novedad: ${orden.novedad || 'sin detalle'}`
      : `Novedad detectada: ${orden.novedad || 'sin detalle'}`,
    detalle: { status: orden.status, transportadora: orden.transportadora },
  });
  return fila;
}

async function cerrarNovedad({ fila, resultado, descripcion }) {
  await db.query(
    `UPDATE dropi_novedades
        SET estado = 'cerrada', resultado = ?, cerrada_at = NOW()
      WHERE id = ? AND estado <> 'cerrada'`,
    { replacements: [resultado, fila.id], type: db.QueryTypes.UPDATE },
  );
  await agregarEvento({
    id_novedad: fila.id,
    id_configuracion: fila.id_configuracion,
    dropi_order_id: fila.dropi_order_id,
    evento: 'cerrada',
    descripcion,
    detalle: { resultado },
  });
}

/**
 * Actualiza el registro con el estado más reciente de un lote de órdenes.
 * Lo llaman el webhook y el cron (vía upsertOrders) y el listado en vivo.
 *
 * ordenes: [{ id, status, clasificado, guia, transportadora, novedad,
 *             solucionadaPorUsuario }]
 *   - clasificado: resultado de classifyDropiStatus(status)
 *   - solucionadaPorUsuario: issue_solved_by_parent_order de Dropi (true /
 *     false / undefined si el origen no lo trae)
 */
async function registrarDesdeOrdenes({ id_configuracion, ordenes }) {
  const cfg = Number(id_configuracion);
  const lote = (ordenes || []).filter((o) => o && o.id && o.clasificado);
  if (!cfg || !lote.length) return;

  await seguro(
    'registrarDesdeOrdenes',
    async () => {
      const ids = lote.map((o) => o.id);
      const filas = await db.query(
        `SELECT * FROM dropi_novedades
          WHERE id_configuracion = ? AND dropi_order_id IN (?)
          ORDER BY numero ASC`,
        { replacements: [cfg, ids], type: db.QueryTypes.SELECT },
      );

      // Por orden: la fila abierta (si hay) y el número más alto usado.
      const abierta = new Map();
      const maxNumero = new Map();
      for (const f of filas) {
        const k = String(f.dropi_order_id);
        maxNumero.set(k, Math.max(maxNumero.get(k) || 0, f.numero));
        if (f.estado !== 'cerrada') abierta.set(k, f);
      }

      for (const o of lote) {
        const k = String(o.id);
        const fila = abierta.get(k) || null;
        const siguiente = (maxNumero.get(k) || 0) + 1;

        if (o.clasificado === 'novedad') {
          if (!fila) {
            await abrirNovedad({ id_configuracion: cfg, orden: o, numero: siguiente });
            continue;
          }

          if (fila.estado === 'pendiente') {
            // Misma novedad: solo se completan datos que antes no venían.
            const novedad = recortar(o.novedad, 500);
            if (novedad && novedad !== fila.novedad) {
              await db.query(
                `UPDATE dropi_novedades
                    SET novedad = ?,
                        shipping_guide = COALESCE(?, shipping_guide),
                        transportadora = COALESCE(?, transportadora)
                  WHERE id = ?`,
                {
                  replacements: [
                    novedad,
                    recortar(o.guia, 100),
                    recortar(o.transportadora, 100),
                    fila.id,
                  ],
                  type: db.QueryTypes.UPDATE,
                },
              );
            }
            continue;
          }

          // Ya se le había enviado solución. ¿Volvió a caer en novedad?
          let reincide = fila.estado === 'en_ruta';
          if (fila.estado === 'solventada') {
            const horas =
              (Date.now() - new Date(fila.solventada_at || fila.updated_at).getTime()) /
              3600000;
            // Solo si Dropi dice explícitamente que está sin gestionar y ya
            // pasó el margen: antes de eso es la misma novedad aún en proceso.
            reincide =
              o.solucionadaPorUsuario === false && horas >= HORAS_MARGEN_SOLVENTADA;
          }
          if (reincide) {
            await cerrarNovedad({
              fila,
              resultado: 'nueva_novedad',
              descripcion:
                'La solución no fue efectiva: el pedido volvió a caer en novedad',
            });
            await abrirNovedad({ id_configuracion: cfg, orden: o, numero: siguiente });
          }
          continue;
        }

        if (!fila) continue;

        if (FINALES.has(o.clasificado)) {
          await cerrarNovedad({
            fila,
            resultado: o.clasificado,
            descripcion: `El pedido terminó en: ${o.status || o.clasificado}`,
          });
          continue;
        }

        if (EN_RUTA.has(o.clasificado) && fila.estado !== 'en_ruta') {
          const externa = fila.estado === 'pendiente';
          await db.query(
            `UPDATE dropi_novedades
                SET estado = 'en_ruta',
                    tipo_solucion = COALESCE(tipo_solucion, 'externa'),
                    solventada_por = COALESCE(solventada_por, 'dropi'),
                    solventada_at = COALESCE(solventada_at, NOW())
              WHERE id = ?`,
            { replacements: [fila.id], type: db.QueryTypes.UPDATE },
          );
          await agregarEvento({
            id_novedad: fila.id,
            id_configuracion: cfg,
            dropi_order_id: o.id,
            evento: externa ? 'solventada_externa' : 'en_ruta',
            origen: externa ? 'dropi' : 'sistema',
            descripcion: externa
              ? `Salió de novedad sin pasar por ChatCenter (se gestionó en Dropi o la transportadora reintentó). Estado: ${o.status}`
              : `La transportadora volvió a ofrecer el pedido. Estado: ${o.status}`,
            detalle: { status: o.status },
          });
        }
      }
    },
    undefined,
  );
}

/**
 * Deja constancia de una solución enviada a Dropi desde ChatCenter.
 * accion: 'solucionar' | 'devolver'. Si la orden no tenía fila abierta (la
 * novedad es anterior al registro) se abre en el momento.
 */
async function registrarSolucion({
  id_configuracion,
  order_id,
  accion,
  tipo_solucion,
  solucion,
  origen = 'asesor',
  usuario = null,
  payload = null,
  datosOrden = null,
}) {
  const cfg = Number(id_configuracion);
  await seguro(
    'registrarSolucion',
    async () => {
      let [fila] = await db.query(
        `SELECT * FROM dropi_novedades
          WHERE id_configuracion = ? AND dropi_order_id = ? AND estado <> 'cerrada'
          ORDER BY numero DESC LIMIT 1`,
        { replacements: [cfg, order_id], type: db.QueryTypes.SELECT },
      );
      if (!fila) {
        const [m] = await db.query(
          `SELECT COALESCE(MAX(numero), 0) AS n FROM dropi_novedades
            WHERE id_configuracion = ? AND dropi_order_id = ?`,
          { replacements: [cfg, order_id], type: db.QueryTypes.SELECT },
        );
        fila = await abrirNovedad({
          id_configuracion: cfg,
          orden: { id: order_id, status: 'NOVEDAD', ...(datosOrden || {}) },
          numero: Number(m?.n || 0) + 1,
        });
        if (!fila) return;
      }

      const devolucion = accion === 'devolver';
      const tipo = devolucion ? 'devolucion' : tipo_solucion || 'volver_a_ofrecer';
      await db.query(
        `UPDATE dropi_novedades
            SET estado = 'solventada', tipo_solucion = ?, solucion = ?,
                solventada_por = ?, id_sub_usuario = ?, solventada_at = NOW()
          WHERE id = ?`,
        {
          replacements: [
            tipo,
            recortar(solucion, 500),
            origen === 'ia' ? 'ia' : 'asesor',
            usuario?.id_sub_usuario || null,
            fila.id,
          ],
          type: db.QueryTypes.UPDATE,
        },
      );
      await agregarEvento({
        id_novedad: fila.id,
        id_configuracion: cfg,
        dropi_order_id: order_id,
        evento: devolucion ? 'devolucion' : 'solventada',
        origen,
        usuario,
        descripcion: devolucion
          ? 'Se pidió la devolución al remitente'
          : `${tipo === 'ajustar_recaudo' ? 'Ajustar recaudo' : 'Volver a ofrecer'}: ${solucion || ''}`,
        detalle: payload,
      });
    },
    undefined,
  );
}

/** Evento suelto sobre la novedad abierta de la orden (sugerencia de IA,
 *  error de Dropi…). opciones.requiereAsesor marca la novedad para asesor. */
async function registrarEvento({
  id_configuracion,
  order_id,
  evento,
  origen = 'sistema',
  usuario = null,
  descripcion = null,
  detalle = null,
  requiereAsesor = null,
}) {
  const cfg = Number(id_configuracion);
  await seguro(
    'registrarEvento',
    async () => {
      const [fila] = await db.query(
        `SELECT id FROM dropi_novedades
          WHERE id_configuracion = ? AND dropi_order_id = ?
          ORDER BY numero DESC LIMIT 1`,
        { replacements: [cfg, order_id], type: db.QueryTypes.SELECT },
      );
      if (!fila) return;
      if (requiereAsesor) {
        await db.query(
          `UPDATE dropi_novedades
              SET requiere_asesor = 1, motivo_asesor = COALESCE(motivo_asesor, ?)
            WHERE id = ?`,
          {
            replacements: [recortar(requiereAsesor, 255), fila.id],
            type: db.QueryTypes.UPDATE,
          },
        );
      }
      await agregarEvento({
        id_novedad: fila.id,
        id_configuracion: cfg,
        dropi_order_id: order_id,
        evento,
        origen,
        usuario,
        descripcion,
        detalle,
      });
    },
    undefined,
  );
}

/**
 * Dropi es la fuente de verdad de cuántas novedades tuvo la orden
 * (history_new_orders del detalle). Si dice que hubo más de las que tenemos
 * registradas —novedades anteriores a este registro— se marca la reincidencia.
 */
async function sincronizarConGestionesDropi({
  id_configuracion,
  order_id,
  totalNovedades,
  ofrecidas,
}) {
  const cfg = Number(id_configuracion);
  if (!(totalNovedades > 1)) return;
  await seguro(
    'sincronizarConGestionesDropi',
    async () => {
      const [fila] = await db.query(
        `SELECT id, requiere_asesor FROM dropi_novedades
          WHERE id_configuracion = ? AND dropi_order_id = ? AND estado <> 'cerrada'
          ORDER BY numero DESC LIMIT 1`,
        { replacements: [cfg, order_id], type: db.QueryTypes.SELECT },
      );
      if (!fila || fila.requiere_asesor) return;
      const motivo = `Reincidencia según Dropi: ${totalNovedades} novedades en este pedido (${ofrecidas} con solución enviada)`;
      await db.query(
        `UPDATE dropi_novedades SET requiere_asesor = 1, motivo_asesor = ? WHERE id = ?`,
        { replacements: [motivo, fila.id], type: db.QueryTypes.UPDATE },
      );
      await agregarEvento({
        id_novedad: fila.id,
        id_configuracion: cfg,
        dropi_order_id: order_id,
        evento: 'reincidencia',
        origen: 'dropi',
        descripcion: motivo,
        detalle: { totalNovedades, ofrecidas },
      });
    },
    undefined,
  );
}

/** Resumen por orden para pintar el listado: Map(order_id → resumen). */
async function resumenPorOrdenes(id_configuracion, orderIds) {
  const ids = (orderIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  return seguro(
    'resumenPorOrdenes',
    async () => {
      const filas = await db.query(
        `SELECT dropi_order_id,
                MAX(numero) AS numero,
                SUM(tipo_solucion IN ('volver_a_ofrecer','ajustar_recaudo','externa')) AS veces_ofrecida,
                MAX(CASE WHEN estado <> 'cerrada' THEN requiere_asesor ELSE 0 END) AS requiere_asesor,
                SUBSTRING_INDEX(GROUP_CONCAT(
                  CASE WHEN estado <> 'cerrada' THEN motivo_asesor END
                  ORDER BY numero DESC SEPARATOR '||'), '||', 1) AS motivo_asesor,
                SUBSTRING_INDEX(GROUP_CONCAT(estado ORDER BY numero DESC), ',', 1) AS estado
           FROM dropi_novedades
          WHERE id_configuracion = ? AND dropi_order_id IN (?)
          GROUP BY dropi_order_id`,
        {
          replacements: [Number(id_configuracion), ids],
          type: db.QueryTypes.SELECT,
        },
      );
      return new Map(
        filas.map((f) => [
          String(f.dropi_order_id),
          {
            numero: Number(f.numero) || 1,
            veces_ofrecida: Number(f.veces_ofrecida) || 0,
            requiere_asesor: Number(f.requiere_asesor) === 1,
            motivo_asesor: f.motivo_asesor || null,
            estado: f.estado || null,
          },
        ]),
      );
    },
    new Map(),
  );
}

/** Todo lo registrado de una orden: sus novedades y la bitácora de eventos. */
async function historialDeOrden(id_configuracion, order_id) {
  return seguro(
    'historialDeOrden',
    async () => {
      const cfg = Number(id_configuracion);
      const novedades = await db.query(
        `SELECT id, numero, novedad, estado, resultado, requiere_asesor,
                motivo_asesor, tipo_solucion, solucion, solventada_por,
                detectada_at, solventada_at, cerrada_at
           FROM dropi_novedades
          WHERE id_configuracion = ? AND dropi_order_id = ?
          ORDER BY numero ASC`,
        { replacements: [cfg, order_id], type: db.QueryTypes.SELECT },
      );
      const eventos = await db.query(
        `SELECT id, id_novedad, evento, origen, nombre_usuario, descripcion,
                created_at
           FROM dropi_novedades_historial
          WHERE id_configuracion = ? AND dropi_order_id = ?
          ORDER BY created_at ASC, id ASC`,
        { replacements: [cfg, order_id], type: db.QueryTypes.SELECT },
      );
      return {
        novedades,
        eventos,
        veces_ofrecida: novedades.filter((n) =>
          ['volver_a_ofrecer', 'ajustar_recaudo', 'externa'].includes(n.tipo_solucion),
        ).length,
      };
    },
    { novedades: [], eventos: [], veces_ofrecida: 0 },
  );
}

/** Registro paginado (pestaña Historial) + contadores para medir resultados. */
async function listarRegistro({ id_configuracion, estado, page = 1, pageSize = 20 }) {
  const vacio = { rows: [], total: 0, resumen: null, disponible: false };
  return seguro(
    'listarRegistro',
    async () => {
      const cfg = Number(id_configuracion);
      const where = ['id_configuracion = :cfg'];
      const rep = { cfg, limit: pageSize, offset: (page - 1) * pageSize };
      if (estado === 'requiere_asesor') {
        where.push("requiere_asesor = 1 AND estado IN ('pendiente','solventada')");
      } else if (['pendiente', 'solventada', 'en_ruta', 'cerrada'].includes(estado)) {
        where.push('estado = :estado');
        rep.estado = estado;
      }
      const filtro = where.join(' AND ');

      const rows = await db.query(
        `SELECT id, dropi_order_id, numero, shipping_guide, transportadora,
                novedad, estado, resultado, requiere_asesor, motivo_asesor,
                tipo_solucion, solucion, solventada_por, detectada_at,
                solventada_at, cerrada_at
           FROM dropi_novedades
          WHERE ${filtro}
          ORDER BY COALESCE(solventada_at, detectada_at) DESC, id DESC
          LIMIT :limit OFFSET :offset`,
        { replacements: rep, type: db.QueryTypes.SELECT },
      );
      const [{ total }] = await db.query(
        `SELECT COUNT(*) AS total FROM dropi_novedades WHERE ${filtro}`,
        { replacements: rep, type: db.QueryTypes.SELECT },
      );
      const [resumen] = await db.query(
        `SELECT COUNT(*) AS total,
                SUM(estado = 'pendiente') AS pendientes,
                SUM(estado IN ('solventada','en_ruta')) AS en_proceso,
                SUM(requiere_asesor = 1 AND estado IN ('pendiente','solventada')) AS requieren_asesor,
                SUM(numero > 1) AS reincidencias,
                SUM(estado = 'cerrada' AND resultado = 'entregada') AS entregadas,
                SUM(estado = 'cerrada' AND resultado = 'devolucion') AS devueltas,
                SUM(estado = 'cerrada' AND resultado = 'nueva_novedad') AS sin_efecto
           FROM dropi_novedades
          WHERE id_configuracion = :cfg
            AND detectada_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
        { replacements: { cfg }, type: db.QueryTypes.SELECT },
      );
      return {
        rows,
        total: Number(total) || 0,
        resumen: Object.fromEntries(
          Object.entries(resumen || {}).map(([k, v]) => [k, Number(v) || 0]),
        ),
        disponible: true,
      };
    },
    vacio,
  );
}

module.exports = {
  registrarDesdeOrdenes,
  registrarSolucion,
  registrarEvento,
  sincronizarConGestionesDropi,
  resumenPorOrdenes,
  historialDeOrden,
  listarRegistro,
};
