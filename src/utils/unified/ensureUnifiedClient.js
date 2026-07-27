const ClientesChatCenter = require('../../models/clientes_chat_center.model');
const {
  crearClienteConRoundRobinUnDepto,
} = require('../webhook_whatsapp/round_robin');
const {
  rellenarEmailClienteSiVacio,
} = require('../../services/imporsuitEmailSync.service');
const { buscarContactoWa, esErrorDuplicado } = require('./dedupeContacto');

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

  // 1) Buscar por la identidad del canal.
  //    WA: por los últimos 9 dígitos (celular_last9 + idx_ccc_cfg_last9). Antes
  //    era igualdad exacta del texto y el mismo número guardado en otro formato
  //    (0969…, 593969…, +593969…) no se encontraba → se creaba otro contacto.
  //    MS/IG: por identidad Meta, igual que siempre.
  const buscar = async () => {
    if (source === 'wa') {
      const id = await buscarContactoWa({ id_configuracion, telefono: phone });
      return id ? await ClientesChatCenter.findByPk(id) : null;
    }
    return ClientesChatCenter.findOne({
      where: {
        id_configuracion,
        source,
        page_id: String(page_id || ''),
        external_id: String(external_id || ''),
      },
    });
  };

  let cliente = await buscar();

  // 2) Crear si no existe (RR)
  if (!cliente) {
    try {
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
    } catch (err) {
      // Perdimos la carrera: otro webhook del MISMO contacto insertó primero y
      // el índice único de identidad nos rechazó. No es un fallo — se relee y
      // se sigue con el contacto que ganó. Esto es lo que evita que un texto y
      // el referral del anuncio CTWA, llegando con 2 segundos de diferencia,
      // terminen creando dos chats para la misma persona.
      if (!esErrorDuplicado(err)) throw err;
      cliente = await buscar();
      if (!cliente) throw err; // colisión que no sabemos explicar → que se vea
      console.log(
        `[ensureUnifiedClient] carrera resuelta (${source}) cfg=${id_configuracion} → contacto ${cliente.id}`,
      );
    }

    // Hook "al crear cliente": si es WA y se acaba de crear, intenta rellenar
    // email_cliente desde imporsuit (match por whatsapp de plataforma). No bloquea
    // ni rompe el flujo si falla.
    if (cliente?.id && source === 'wa' && phone) {
      await rellenarEmailClienteSiVacio({ id: cliente.id, celular: phone });
    }
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
