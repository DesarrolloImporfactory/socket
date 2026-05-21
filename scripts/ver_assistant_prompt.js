require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const { db } = require('../src/database/config');
(async () => {
  const aid = process.argv[2];
  const idCfg = Number(process.argv[3] || 10);
  const [row] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [idCfg], type: db.QueryTypes.SELECT },
  );
  const key = row.api_key_openai;
  const res = await axios.get(`https://api.openai.com/v1/assistants/${aid}`, {
    headers: { Authorization: `Bearer ${key}`, 'OpenAI-Beta': 'assistants=v2' },
  });
  const ins = res.data.instructions || '';
  console.log('name:', res.data.name);
  console.log('model:', res.data.model);
  console.log('tools:', res.data.tools.map((t) => t.type).join(','));
  console.log('instructions length:', ins.length);
  console.log('created_at_epoch:', res.data.created_at);
  console.log('\n══ MENCIONES DE TAGS V1 EN EL PROMPT ══');
  const checks = [
    '[generar_guia]:true',
    '[cancelados]:true',
    '[asesor]:true',
    '[producto_imagen_url]',
    '[producto_video_url]',
    'accion:',
    'respuesta_usuario',
    'media',
    'json_schema',
  ];
  checks.forEach((c) => {
    const n = (ins.match(new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
    console.log(`  "${c}" → ${n} apariciones`);
  });
  console.log('\n══ PRIMEROS 600 CHARS ══');
  console.log(ins.slice(0, 600));
  console.log('\n══ ULTIMOS 600 CHARS ══');
  console.log(ins.slice(-600));
  process.exit(0);
})();
