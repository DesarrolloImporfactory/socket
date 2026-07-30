'use strict';

/**
 * Pone el texto del catálogo en las plantillas de RETIRO EN AGENCIA que ya
 * existen aprobadas en la WABA de una configuración.
 *
 *   node scripts/editar_templates_retiro_agencia.js 10             (simula)
 *   node scripts/editar_templates_retiro_agencia.js 10 --aplicar
 *
 * Por qué EDITAR y no crear: Meta no deja crear dos plantillas con el mismo
 * nombre, y estas tres ya existen aprobadas con el texto sobrio original. Para
 * que salga la versión amable ("por favor" + emoji) la única vía es editarlas.
 *
 * ⚠️ Editar una plantilla APROBADA la manda de vuelta a revisión de Meta: queda
 * en PENDING un rato y, si la rechazaran, hay que volver a editarla (nunca
 * borrarla: Meta bloquea el nombre de una plantilla eliminada). Mientras esté en
 * revisión, el motor de remarketing puede quedarse sin plantilla que enviar.
 * Meta además limita las ediciones (del orden de 1 por día y 10 al mes por
 * plantilla), así que esto no es para correrlo en bucle.
 *
 * Solo toca las 3 plantillas del seguimiento de agencia y solo si el texto
 * difiere del catálogo.
 */

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');
const { KANBAN_TEMPLATES_META } = require('../src/utils/kanban_catalogo.data');
const { getConfigFromDB } = require('../src/utils/whatsappTemplate.helpers');

const OK = '✅';
const NO = '❌';
const WARN = '⚠️ ';
const SIN_CAMBIO = '·';

const NOMBRES = [
  'retiro_agencia_disponible_k1',
  'retiro_agencia_recordatorio_k2',
  'retiro_agencia_recordatorio_k3',
];

function bodyDe(components) {
  return (components || []).find((c) => String(c.type).toUpperCase() === 'BODY');
}

(async () => {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const id_configuracion = args.map(Number).filter(Boolean)[0];

  if (!id_configuracion) {
    console.log(
      'Uso: node scripts/editar_templates_retiro_agencia.js <id_configuracion> [--aplicar]',
    );
    process.exit(1);
  }

  const waba = await getConfigFromDB(id_configuracion);
  if (!waba?.WABA_ID || !waba?.ACCESS_TOKEN) {
    console.log(`${NO} la configuración ${id_configuracion} no tiene WABA/token`);
    process.exit(1);
  }

  const { data } = await axios.get(
    `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${waba.WABA_ID}/message_templates`,
    {
      params: {
        access_token: waba.ACCESS_TOKEN,
        limit: 200,
        fields: 'id,name,status,language,category,components',
      },
    },
  );
  const enMeta = new Map((data.data || []).map((t) => [t.name, t]));

  console.log(`\n${'═'.repeat(66)}`);
  console.log(`CONFIG ${id_configuracion} — WABA ${waba.WABA_ID}`);
  console.log('═'.repeat(66));

  let editadas = 0;

  for (const nombre of NOMBRES) {
    const cat = KANBAN_TEMPLATES_META.find((t) => t.name === nombre);
    if (!cat) {
      console.log(`${NO} ${nombre}: no está en el catálogo`);
      continue;
    }
    const remoto = enMeta.get(nombre);
    if (!remoto) {
      console.log(
        `${WARN}${nombre}: no existe en la WABA → la crea "Actualizar tablero", no este script`,
      );
      continue;
    }

    const textoCat = bodyDe(cat.components)?.text || '';
    const textoRemoto = bodyDe(remoto.components)?.text || '';

    if (textoCat === textoRemoto) {
      console.log(`${SIN_CAMBIO} ${nombre} [${remoto.status}]: ya tiene el texto del catálogo`);
      continue;
    }

    console.log(`\n${nombre} [${remoto.status}] (id ${remoto.id})`);
    console.log(`   ── EN META ──\n   ${textoRemoto.replace(/\n/g, '\n   ')}`);
    console.log(`   ── CATÁLOGO ──\n   ${textoCat.replace(/\n/g, '\n   ')}`);

    if (!aplicar) continue;

    try {
      // Se manda solo el BODY con su example: es lo único que cambia. El
      // nombre y el idioma no se pueden editar, y la categoría se deja como
      // está para no reabrir la discusión que ya hizo rechazar una versión.
      await axios.post(
        `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${remoto.id}`,
        { components: cat.components },
        {
          headers: {
            Authorization: `Bearer ${waba.ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
      console.log(`   ${OK} enviada a revisión de Meta`);
      editadas++;
    } catch (e) {
      console.log(
        `   ${NO} error: ${e.response?.data?.error?.error_user_msg || e.response?.data?.error?.message || e.message}`,
      );
    }
  }

  console.log(`\n${'─'.repeat(66)}`);
  if (!aplicar) {
    console.log(
      `${WARN}SIMULACIÓN — nada se envió a Meta. Con --aplicar se editan y quedan en revisión.`,
    );
  } else {
    console.log(`${editadas} plantilla(s) enviada(s) a revisión.`);
    console.log(
      'Revisa el estado con: node scripts/verificar_seguimiento_agencia.js ' +
        id_configuracion,
    );
  }
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.response?.data?.error?.message || e.message);
  process.exit(1);
});
