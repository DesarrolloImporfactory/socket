const ClientesChatCenter = require('../../models/clientes_chat_center.model');
const {
  crearClienteConRoundRobinUnDepto,
} = require('../webhook_whatsapp/round_robin');

async function ensureUnifiedClient({
  id_configuracion,
  id_usuario_dueno,
  source = 'wa', // 'wa' | 'ms' | 'ig'
  business_phone_id = null, // wa: phone_number_id, ms/ig: page_id
  phone = null, // wa peer phone (string)
  page_id = null, // ms/ig page id
  external_id = null, // ms/ig sender id
  nombre_cliente = '',
  apellido_cliente = '',
  motivo = 'auto_round_robin',
  metaClienteTimestamps = {},
  permiso_round_robin,
}) {
  // 1) WHERE por canal
  let where = null;

  if (source === 'wa') {
    where = { id_configuracion, celular_cliente: String(phone || '') };
  } else {
    // ✅ MS/IG por identidad Meta
    where = {
      id_configuracion,
      source,
      page_id: String(page_id || ''),
      external_id: String(external_id || ''),
    };
  }

  // 2) Buscar
  let cliente = await ClientesChatCenter.findOne({ where });

  // 3) Crear si no existe (RR)
  if (!cliente) {
    const rr = await crearClienteConRoundRobinUnDepto({
      id_configuracion,
      business_phone_id,
      nombre_cliente,
      apellido_cliente,
      phone_whatsapp_from: source === 'wa' ? String(phone || '') : null,
      id_usuario_dueno,
      motivo,
      metaClienteTimestamps,

      // 👇 para MS/IG
      source,
      page_id: source === 'wa' ? null : page_id,
      external_id: source === 'wa' ? null : external_id,
      permiso_round_robin,
    });

    cliente = rr?.cliente || null;
  } else {
    // 4) Completar nombre si vino vacío
    const n = (nombre_cliente || '').trim();
    if (
      n &&
      (!cliente.nombre_cliente || cliente.nombre_cliente.trim() === '')
    ) {
      await ClientesChatCenter.update(
        {
          nombre_cliente: n,
          apellido_cliente: (apellido_cliente || '').trim(),
        },
        { where: { id: cliente.id } },
      );
      cliente.nombre_cliente = n;
      cliente.apellido_cliente = (apellido_cliente || '').trim();
    }
  }

  return cliente;
}

module.exports = { ensureUnifiedClient };
