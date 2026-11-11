/**
 * admin_asistente.controller.js — /api/v1/admin_asistente (solo super admin)
 *
 * Configura con qué llave responde el asistente flotante cuando paga la
 * plataforma: llave de OpenAI y/o de Claude, cuál va primero, el modelo de
 * Claude y el tope diario por usuario. Las llaves se guardan cifradas y al
 * navegador solo llegan enmascaradas. Ver services/asistente_plataforma.service.
 */
'use strict';

const axios = require('axios');
const plataforma = require('../services/asistente_plataforma.service');
const { hoyEcuador } = require('../services/asistente_cuenta.service');
const { obtenerCuentaOpenAI } = require('../utils/openia/cuentaOpenAI');
const { obtenerCuentaClaude } = require('../utils/claude/cuentaClaude');
const {
  esSinSaldoOpenAI,
  esApiKeyInvalida,
  mensajeErrorOpenAI,
} = require('../utils/openia/sinSaldo');
const {
  MODELOS_CLAUDE,
  IDS_CLAUDE,
  cliente: clienteClaude,
  opcionesPorModelo,
  PISO_MAX_TOKENS,
  validarApiKeyClaude,
  esSinSaldoClaude,
  esApiKeyClaudeInvalida,
  mensajeErrorClaude,
} = require('../utils/claude/claude');


const actorDe = (req) =>
  req.sessionUser?.email || req.sessionUser?.usuario || `sub:${req.sessionUser?.id_sub_usuario}`;

const hayRespaldoEnv = () => Boolean(String(process.env.OPENAI_API_KEY_SOPORTE || '').trim());

function vistaProveedor(cfg, p) {
  return {
    llave: cfg.enmascaradas[p],
    cuenta: cfg.cuentas[p],
    error: cfg.errores[p],
  };
}

async function armarVista() {
  const cfg = await plataforma.leerConfig({ fresco: true });
  let uso = [];
  try {
    uso = await plataforma.resumenUso(7);
  } catch (err) {
    console.warn('[AdminAsistente] uso:', err.message);
  }
  return {
    proveedor: cfg.proveedor,
    modelo_claude: cfg.modelo_claude,
    modelo_openai: cfg.modelo_openai,
    modelos_openai: plataforma.MODELOS_OPENAI,
    modelos_claude: MODELOS_CLAUDE,
    tope_diario: cfg.tope_diario,
    tope_diario_max: plataforma.TOPE_DIARIO_MAX,
    openai: vistaProveedor(cfg, 'openai'),
    claude: vistaProveedor(cfg, 'claude'),
    respaldo_env: hayRespaldoEnv(),
    hoy: hoyEcuador(),
    uso,
    updated_at: cfg.updated_at,
    updated_by: cfg.updated_by,
  };
}

exports.config = async (req, res) => {
  try {
    return res.json({ success: true, data: await armarVista() });
  } catch (err) {
    console.error('[AdminAsistente] config:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* Para el aviso del menú: ¿la llave que debería estar respondiendo falla? */
exports.estado = async (req, res) => {
  try {
    const cfg = await plataforma.leerConfig();
    const principal = cfg.proveedor;
    const sinLlaves = !cfg.llaves.openai && !cfg.llaves.claude && !hayRespaldoEnv();
    const errorPrincipal = cfg.llaves[principal] ? cfg.errores[principal] : null;
    const grave =
      errorPrincipal && ['SIN_SALDO', 'KEY_INVALIDA'].includes(errorPrincipal.codigo);
    return res.json({
      success: true,
      alerta: Boolean(sinLlaves || grave),
      motivo: sinLlaves ? 'SIN_LLAVES' : grave ? errorPrincipal.codigo : null,
    });
  } catch (err) {
    return res.json({ success: true, alerta: false, motivo: null });
  }
};

exports.guardar = async (req, res) => {
  try {
    const cfg = await plataforma.leerConfig({ fresco: true });
    const proveedor = String(req.body?.proveedor || cfg.proveedor).toLowerCase();
    if (!plataforma.PROVEEDORES.includes(proveedor)) {
      return res.status(400).json({ success: false, message: 'Proveedor inválido.' });
    }
    const tieneLlave =
      Boolean(cfg.llaves[proveedor]) || (proveedor === 'openai' && hayRespaldoEnv());
    if (!tieneLlave) {
      return res.status(400).json({
        success: false,
        message: `Primero guarda una API key de ${proveedor === 'claude' ? 'Claude' : 'OpenAI'}.`,
      });
    }
    const modelo = String(req.body?.modelo_claude || cfg.modelo_claude);
    if (!IDS_CLAUDE.includes(modelo)) {
      return res.status(400).json({ success: false, message: 'Modelo de Claude inválido.' });
    }
    const modeloOpenAI = String(req.body?.modelo_openai || cfg.modelo_openai);
    if (!plataforma.IDS_OPENAI.includes(modeloOpenAI)) {
      return res.status(400).json({ success: false, message: 'Modelo de OpenAI inválido.' });
    }
    const tope = Math.round(Number(req.body?.tope_diario ?? cfg.tope_diario));
    if (!(tope >= 1 && tope <= plataforma.TOPE_DIARIO_MAX)) {
      return res.status(400).json({
        success: false,
        message: `El tope diario va de 1 a ${plataforma.TOPE_DIARIO_MAX} preguntas.`,
      });
    }
    await plataforma.guardarAjustes({
      proveedor,
      modelo_claude: modelo,
      modelo_openai: modeloOpenAI,
      tope_diario: tope,
      actor: actorDe(req),
    });
    return res.json({ success: true, data: await armarVista() });
  } catch (err) {
    console.error('[AdminAsistente] guardar:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* Lanza si OpenAI rechaza la llave. Listar modelos no gasta tokens. */
async function validarApiKeyOpenAI(apiKey) {
  await axios.get('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 10000,
  });
}

exports.guardarLlave = async (req, res) => {
  try {
    const proveedor = String(req.body?.proveedor || '').toLowerCase();
    const apiKey = String(req.body?.api_key || '').trim();
    if (!plataforma.PROVEEDORES.includes(proveedor)) {
      return res.status(400).json({ success: false, message: 'Proveedor inválido.' });
    }
    const esClaude = proveedor === 'claude';
    const formatoOk = esClaude
      ? apiKey.startsWith('sk-ant-')
      : apiKey.startsWith('sk-') && !apiKey.startsWith('sk-ant-');
    if (!formatoOk || apiKey.length < 20) {
      return res.status(400).json({
        success: false,
        message: esClaude
          ? 'La API key de Claude empieza con «sk-ant-».'
          : 'La API key de OpenAI empieza con «sk-».',
      });
    }

    try {
      if (esClaude) await validarApiKeyClaude(apiKey);
      else await validarApiKeyOpenAI(apiKey);
    } catch (err) {
      const invalida = esClaude ? esApiKeyClaudeInvalida(err) : esApiKeyInvalida(err);
      if (invalida) {
        return res.status(400).json({
          success: false,
          message: `${esClaude ? 'Anthropic' : 'OpenAI'} rechazó la llave: revisa que esté completa y activa.`,
        });
      }
      // Sin red o proveedor caído: no se puede confirmar, no se guarda a ciegas.
      return res.status(502).json({
        success: false,
        message: `No se pudo verificar la llave con ${esClaude ? 'Anthropic' : 'OpenAI'} en este momento. Intenta de nuevo.`,
      });
    }

    const cuenta = esClaude
      ? await obtenerCuentaClaude(apiKey)
      : await obtenerCuentaOpenAI(apiKey);
    const antes = await plataforma.leerConfig({ fresco: true });
    await plataforma.guardarLlave(proveedor, apiKey, cuenta, actorDe(req));

    // Primera llave que se carga: pasa a ser la que responde.
    const otro = esClaude ? 'openai' : 'claude';
    if (antes.proveedor !== proveedor && !antes.llaves[otro]) {
      await plataforma.guardarAjustes({
        proveedor,
        modelo_claude: antes.modelo_claude,
        modelo_openai: antes.modelo_openai,
        tope_diario: antes.tope_diario,
        actor: actorDe(req),
      });
    }
    return res.json({ success: true, data: await armarVista() });
  } catch (err) {
    console.error('[AdminAsistente] guardarLlave:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.eliminarLlave = async (req, res) => {
  try {
    const proveedor = String(req.body?.proveedor || '').toLowerCase();
    if (!plataforma.PROVEEDORES.includes(proveedor)) {
      return res.status(400).json({ success: false, message: 'Proveedor inválido.' });
    }
    const antes = await plataforma.leerConfig({ fresco: true });
    await plataforma.eliminarLlave(proveedor, actorDe(req));

    // Si era la principal y la otra tiene llave, la otra toma su lugar.
    const otro = proveedor === 'claude' ? 'openai' : 'claude';
    if (antes.proveedor === proveedor && antes.llaves[otro]) {
      await plataforma.guardarAjustes({
        proveedor: otro,
        modelo_claude: antes.modelo_claude,
        modelo_openai: antes.modelo_openai,
        tope_diario: antes.tope_diario,
        actor: actorDe(req),
      });
    }
    return res.json({ success: true, data: await armarVista() });
  } catch (err) {
    console.error('[AdminAsistente] eliminarLlave:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* Una pregunta mínima de verdad: listar modelos responde 200 aunque la cuenta
   esté en cero, así que el saldo solo se comprueba generando. Cuesta unos
   pocos tokens. */
exports.probar = async (req, res) => {
  const proveedor = String(req.body?.proveedor || '').toLowerCase();
  if (!plataforma.PROVEEDORES.includes(proveedor)) {
    return res.status(400).json({ success: false, message: 'Proveedor inválido.' });
  }
  try {
    const cfg = await plataforma.leerConfig({ fresco: true });
    const apiKey = cfg.llaves[proveedor];
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        message: 'No hay una llave guardada para ese proveedor.',
      });
    }

    const t0 = Date.now();
    let modelo;
    try {
      if (proveedor === 'claude') {
        modelo = cfg.modelo_claude;
        const r = await clienteClaude(apiKey).beta.messages.create({
          model: modelo,
          max_tokens: PISO_MAX_TOKENS,
          output_config: { effort: 'low' },
          ...opcionesPorModelo(modelo),
          messages: [{ role: 'user', content: 'Responde solo: ok' }],
        });
        modelo = r.model || modelo;
      } else {
        modelo = cfg.modelo_openai;
        await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: modelo,
            messages: [{ role: 'user', content: 'Responde solo: ok' }],
            max_tokens: 5,
          },
          { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 20000 },
        );
      }
    } catch (err) {
      const esClaude = proveedor === 'claude';
      const mensaje = esClaude ? mensajeErrorClaude(err) : mensajeErrorOpenAI(err);
      const codigo = (esClaude ? esApiKeyClaudeInvalida(err) : esApiKeyInvalida(err))
        ? 'KEY_INVALIDA'
        : (esClaude ? esSinSaldoClaude(err) : esSinSaldoOpenAI(err))
          ? 'SIN_SALDO'
          : 'ERROR';
      await plataforma.marcarError(proveedor, codigo, mensaje);
      return res.json({
        success: true,
        ok: false,
        codigo,
        mensaje,
        data: await armarVista(),
      });
    }

    await plataforma.limpiarError(proveedor);
    return res.json({
      success: true,
      ok: true,
      modelo,
      ms: Date.now() - t0,
      data: await armarVista(),
    });
  } catch (err) {
    console.error('[AdminAsistente] probar:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};
