const axios = require('axios');
const { db } = require('../database/config');
const {
  verificarCuentaInstagramDisponible,
  dejarSoloEstaPagina,
} = require('../utils/unified/conexionCanal');
const InstagramOAuthService = require('./instagram_oauth.service');
const AppError = require('../utils/appError');

const FB_VERSION = 'v23.0';

module.exports = {
  async connect({ oauth_session_id, id_configuracion, page_id }) {
    // 1-2) sesión + página concedida (directo por id: las de portafolio con
    // "solo las actuales" no salen en /me/accounts)
    const page = await InstagramOAuthService.getPageTokenFromSession(
      oauth_session_id,
      page_id,
    );
    const { session } = page;

    if (!page.has_ig) {
      throw new Error(
        `La Página "${page.page_name}" no tiene una cuenta de Instagram vinculada.

        1) Asegúrate que la cuenta IG es Profesional (Business/Creator).
        2) Vincúlala a esta Página en Instagram app o Business Suite.
        3) Repite el flujo.`
      );
    }

    const pageAccessToken = page.page_access_token;
    const pageName = page.page_name;
    const igId = page.ig_id;
    const igUser = page.ig_username;

    // 2.5) Ni la cuenta de IG ni su página pueden estar ya conectadas a otra
    // conexión activa: el webhook enruta por ig_id con LIMIT 1 y la segunda
    // tarjeta se quedaría muda. Se valida ANTES de suscribir en Meta.
    await verificarCuentaInstagramDisponible({
      page_id,
      ig_id: igId,
      id_configuracion,
    });

    // 3) Suscribir app a la Page con campos válidos para IG Messaging
    // Recomendado para IG: messages, messaging_postbacks, message_reactions, message_edit
    const subscribed_fields =
      'messages,messaging_postbacks,message_reactions,message_edits,message_deliveries,message_reads';

    try {
      await axios.post(
        `https://graph.facebook.com/${FB_VERSION}/${page_id}/subscribed_apps`,
        {}, // body vacío
        {
          params: {
            access_token: pageAccessToken,
            subscribed_fields,
          },
        }
      );
    } catch (err) {
      const g = err?.response?.data?.error;
      console.error('[IG subscribe error]', {
        status: err?.response?.status,
        code: g?.code,
        subcode: g?.error_subcode,
        type: g?.type,
        message: g?.message,
      });
      // 400 con motivo: como Error plano salía un 500 "Something went wrong"
      // y ni el cliente ni soporte sabían qué había fallado.
      const faltaPermiso =
        g?.code === 200 || g?.code === 10 || /permission/i.test(g?.message || '');
      throw new AppError(
        faltaPermiso
          ? 'Meta no dio permiso para recibir los mensajes de esta página. Vuelve a pulsar "Conectar Instagram" y acepta todos los permisos que pide Meta.'
          : `No se pudo suscribir la página en Meta. ${g?.message || ''}`.trim(),
        400,
      );
    }

    // 3.1) Verificar estado de suscripción (como en Messenger)
    const { data: status } = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/${page_id}/subscribed_apps`,
      { params: { access_token: pageAccessToken } }
    );

    // 4) Upsert en instagram_pages
    const upsertSQL = `
      INSERT INTO instagram_pages
        (id_configuracion, page_id, page_name, page_access_token, ig_id, ig_username, subscribed,
         connected_by_fb_user_id, connected_by_name, status, connected_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', NOW())
      ON DUPLICATE KEY UPDATE
        page_name = VALUES(page_name),
        page_access_token = VALUES(page_access_token),
        ig_id = VALUES(ig_id),
        ig_username = VALUES(ig_username),
        subscribed = 1,
        connected_by_fb_user_id = VALUES(connected_by_fb_user_id),
        connected_by_name = VALUES(connected_by_name),
        status = 'active',
        updated_at = NOW()
    `;
    await db.query(upsertSQL, {
      replacements: [
        id_configuracion,
        page_id,
        pageName,
        pageAccessToken,
        igId,
        igUser,
        session.fb_user_id || null,
        session.fb_user_name || null,
      ],
      type: db.QueryTypes.INSERT,
    });

    // Token nuevo: se borra el veredicto de salud del anterior para que el
    // aviso de "reconectar" de /conexiones desaparezca en el acto.
    await require('./messenger_pages_health.service').limpiarSaludTrasReconectar(
      { canal: 'ig', id_configuracion, page_id },
    );

    // Una cuenta de Instagram por conexión: la recién guardada reemplaza a
    // cualquier otra que tuviera (ver dejarSoloEstaPagina).
    await dejarSoloEstaPagina({ canal: 'ig', id_configuracion, page_id });

    // 5) Consumir sesión
    await db.query(
      'UPDATE instagram_oauth_sessions SET used = 1 WHERE id_oauth_session = ?',
      { replacements: [oauth_session_id], type: db.QueryTypes.UPDATE }
    );

    return {
      page_id,
      page_name: pageName,
      ig_id: igId,
      ig_username: igUser,
      connected: true,
      subscribed_apps: status?.data || [], //Verificamos si suscribimos a la page
    };
  },
};
