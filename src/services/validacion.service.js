// services/validacion.service.js
const { db_2 } = require('../database/config'); // Sequelize instance

async function obtenerProductosPrivadosIds(id_plataforma) {
  const rows = await db_2.query(
    'SELECT id_producto FROM producto_privado WHERE id_plataforma = ?',
    { replacements: [id_plataforma], type: db_2.QueryTypes.SELECT }
  );
  return rows.map((r) => Number(r.id_producto));
}

async function validarDisponibilidad({ lista, id_plataforma }) {
  // lista: [{id_inventario, cantidad}, ...]
  if (!Array.isArray(lista) || lista.length === 0) {
    return { status: 200, invalidos: [] };
  }

  // Mapa id_inventario -> cantidad (última ocurrencia)
  const cantidadesPorInv = {};
  const idsInventario = [];
  for (const it of lista) {
    const idInv = Number(it?.id_inventario || 0);
    if (idInv > 0) {
      idsInventario.push(idInv);
      const c = Number(it?.cantidad ?? 1);
      cantidadesPorInv[idInv] = Number.isFinite(c) && c > 0 ? c : 1;
    }
  }
  if (idsInventario.length === 0) return { status: 200, invalidos: [] };

  const idsPrivados = await obtenerProductosPrivadosIds(id_plataforma);
  const privadosMap = Object.create(null);
  for (const pid of idsPrivados) privadosMap[pid] = true;

  const filas = await db_2.query(
    `
    SELECT
      ib.id_inventario,
      ib.saldo_stock,
      p.nombre_producto,
      p.drogshipin,
      p.eliminado,
      p.id_plataforma,
      p.id_producto
    FROM inventario_bodegas ib
    JOIN productos p ON p.id_producto = ib.id_producto
    WHERE ib.id_inventario IN (:ids)
    `,
    { replacements: { ids: idsInventario }, type: db_2.QueryTypes.SELECT }
  );

  // Detectar ids_inventario inexistentes (no devueltos por la consulta)
  const encontrados = new Set(filas.map((f) => Number(f.id_inventario)));
  const invalidos = [];
  for (const idInv of idsInventario) {
    if (!encontrados.has(idInv)) {
      invalidos.push({
        id_inventario: idInv,
        nombre: `(ID ${idInv})`,
        saldo_stock: 0,
        drogshipin: 0,
        eliminado: 0,
        motivos: ['Inventario inexistente o no disponible.'],
        codes: ['INVENTARIO_NO_ENCONTRADO'],
      });
    }
  }

  // Reglas de disponibilidad (idénticas a tu PHP)
  for (const f of filas) {
    const idInv = Number(f.id_inventario);
    const stock = Number(f.saldo_stock || 0);
    const nombre = String(f.nombre_producto || '');
    const drop = Number(f.drogshipin || 0);
    const eliminado = Number(f.eliminado || 0);
    const idProd = Number(f.id_producto);
    const idPlatProd = Number(f.id_plataforma);
    const cantSolic = cantidadesPorInv[idInv] ?? null;

    const esPropio = idPlatProd === Number(id_plataforma);
    const esPrivado = !!privadosMap[idProd];
    const esPropioOPrivado = esPropio || esPrivado;

    const motivos = [];
    const codes = [];

    if (eliminado === 1) {
      motivos.push('El producto fue eliminado del catálogo.');
      codes.push('ELIMINADO');

      invalidos.push({
        id_inventario: idInv,
        nombre,
        saldo_stock: stock,
        drogshipin: drop,
        eliminado,
        motivos,
        codes,
      });
      continue; // ⛔ no agregamos más motivos
    }

    // 🟡 STOCK: evita duplicidad
    if (stock <= 0) {
      motivos.push('Sin stock disponible.');
      codes.push('SIN_STOCK');
    } else if (cantSolic !== null && cantSolic > stock) {
      // solo mostramos “cantidad supera stock” cuando SÍ hay stock (>0)
      motivos.push(
        `Stock insuficiente para la cantidad solicitada (solicitado ${cantSolic} / disponible ${stock}).`
      );
      codes.push('CANTIDAD_SUPERA_STOCK');
    }

    // 🔵 Marketplace apagado (solo aplica a usuarios no propios/privados)
    if (!esPropioOPrivado && drop !== 1) {
      motivos.push('No disponible en marketplace.');
      codes.push('DROPSHIPPING_OFF');
    }

    // Criterio de invalidez (igual que antes)
    const fallaPropioPrivado =
      stock <= 0 || (cantSolic !== null && cantSolic > stock);
    const fallaNormal = fallaPropioPrivado || drop !== 1;
    const invalido = esPropioOPrivado ? fallaPropioPrivado : fallaNormal;

    if (invalido) {
      if (!motivos.length) {
        motivos.push(
          'El producto no cumple las condiciones de disponibilidad.'
        );
        codes.push('REGLA_GENERAL');
      }
      invalidos.push({
        id_inventario: idInv,
        nombre,
        saldo_stock: stock,
        drogshipin: drop,
        eliminado,
        motivos,
        codes,
      });
    }
  }

  if (invalidos.length) {
    const detalle = invalidos.map(
      (p) => `${p.nombre}— ${p.motivos.join(' + ')}`
    );
    return {
      status: 400,
      title:
        invalidos.length > 1
          ? 'Hay productos con problemas'
          : 'Producto con problemas',
      message:
        'Revise los siguientes ítems. Puede ajustar cantidades, quitar productos o reemplazarlos.',
      detalle,
      invalidos,
    };
  }
  return { status: 200, invalidos: [] };
}

module.exports = { validarDisponibilidad };
