/**
 * Revisa la salud de las conexiones de páginas de Facebook y la imprime.
 *
 * Uso:
 *   node scripts/verificarPaginasMessenger.js              → solo mira, no toca nada
 *   node scripts/verificarPaginasMessenger.js --guardar    → guarda el diagnóstico
 *   node scripts/verificarPaginasMessenger.js --cfg=285    → solo una configuración
 *
 * Por defecto NO escribe en la base: sirve para diagnosticar sin efectos.
 *
 * ⚠️ --marcar (poner status='revoked') existe pero NO debe usarse salvo que
 * sepas exactamente lo que hace. `status` está sobrecargado: `getConfigIdByPageId`
 * lo usa para enrutar mensajes ENTRANTES, así que 'revoked' hace que los
 * mensajes que escriben los clientes se descarten. Un token muerto solo rompe
 * el envío; no hay motivo para romper también la recepción.
 * La señal de "hay que reconectar" es `token_valido = 0`, que --guardar ya deja.
 */

require('dotenv').config();
const { db } = require('../src/database/config');
const { revisarPaginas } = require('../src/services/messenger_pages_health.service');

const args = process.argv.slice(2);
const tiene = (f) => args.includes(f);
const valor = (p) => {
  const a = args.find((x) => x.startsWith(p));
  return a ? a.split('=')[1] : null;
};

const marcar = tiene('--marcar');
const guardar = marcar || tiene('--guardar');
const cfg = valor('--cfg=');

(async () => {
  console.log('Revisando conexiones de páginas de Facebook...');
  console.log(
    `Modo: ${marcar ? 'GUARDA y MARCA revoked' : guardar ? 'GUARDA diagnóstico' : 'solo lectura (no escribe nada)'}`,
  );

  if (marcar) {
    console.log('');
    console.log('⚠️  ADVERTENCIA: --marcar pone status=\'revoked\'.');
    console.log(
      "   `getConfigIdByPageId` filtra por status='active' para enrutar mensajes",
    );
    console.log(
      '   ENTRANTES: las páginas marcadas dejarán de recibir lo que les escriban.',
    );
    console.log(
      '   Para señalar "hay que reconectar" alcanza con --guardar (token_valido=0).',
    );
    console.log('');
  }
  if (cfg) console.log(`Filtrado a id_configuracion=${cfg}`);
  console.log('');

  const { resumen, resultados } = await revisarPaginas({
    id_configuracion: cfg ? Number(cfg) : null,
    persistir: guardar,
    marcarRevoked: marcar,
  });

  const corto = (s, n) => String(s ?? '').slice(0, n);

  console.table(
    resultados.map((r) => ({
      cfg: r.id_configuracion,
      pagina: corto(r.page_name, 22),
      estado_bd: r.status,
      token:
        r.token_valido === true
          ? 'vivo'
          : r.token_valido === false
            ? 'MUERTO'
            : '¿? (no concluyente)',
      lee_feed:
        r.puede_leer_feed === true
          ? 'si'
          : r.puede_leer_feed === false
            ? 'NO'
            : '-',
      manage_eng: (r.scopes || []).includes('pages_manage_engagement')
        ? 'si'
        : 'no',
      detalle: corto(r.token_error || r.feed_error || '', 46),
    })),
  );

  console.log('\n───────────── RESUMEN ─────────────');
  console.log(`Páginas revisadas          : ${resumen.total}`);
  console.log(`Token vivo                 : ${resumen.sanas}`);
  console.log(`Token muerto (reconectar)  : ${resumen.muertas}`);
  console.log(`No concluyente (reintentar): ${resumen.indeterminadas}`);
  console.log(`Pueden leer el feed        : ${resumen.pueden_leer_feed}`);
  console.log(`Con pages_manage_engagement: ${resumen.con_manage_engagement}`);

  const aReconectar = resultados.filter((r) => r.token_valido === false);
  if (aReconectar.length) {
    console.log('\n⚠️  CLIENTES QUE DEBEN RECONECTAR SU PÁGINA:');
    for (const r of aReconectar) {
      console.log(
        `   cfg=${r.id_configuracion}  ${r.page_name || '(sin nombre)'}  →  ${r.token_error}`,
      );
    }
  }

  if (!guardar) {
    console.log(
      '\n(No se escribió nada. Usá --guardar para persistir el diagnóstico, --marcar para además poner status=revoked.)',
    );
  }

  await db.close();
  process.exit(0);
})().catch(async (e) => {
  console.error('Error:', e.message);
  try {
    await db.close();
  } catch {}
  process.exit(1);
});
