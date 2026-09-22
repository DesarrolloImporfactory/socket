/**
 * Prueba manual del cron que devuelve a «En espera» los chats sin respuesta
 * (services/liberar_sin_respuesta.service.js).
 *
 * OJO: el .env local apunta a la base de PRODUCCIÓN. Por eso:
 *   - por defecto SIMULA: muestra qué liberaría y no escribe nada;
 *   - con --aplicar libera de verdad, pero se niega a hacerlo sobre las
 *     configuraciones reales del cron (hoy la 242). Para probar escribiendo,
 *     usar una configuración de prueba propia.
 *
 * Uso:
 *   node scripts/probarLiberarSinRespuesta.js
 *       → simula la 242 con la regla real (3 h hábiles, desde la activación)
 *
 *   node scripts/probarLiberarSinRespuesta.js --desde "2026-09-15 00:00:00"
 *       → simula la 242 como si se hubiera activado el 15-sep
 *
 *   node scripts/probarLiberarSinRespuesta.js --config 1234 --minutos 2 \
 *        --todo-el-dia --desde "2026-09-22 10:00:00" --aplicar
 *       → prueba real en la configuración 1234: vence a los 2 minutos,
 *         a cualquier hora, y libera de verdad
 *
 *   node scripts/probarLiberarSinRespuesta.js --chat 310191 --minutos 2 \
 *        --todo-el-dia --desde "2026-09-22 10:00:00" --aplicar
 *       → prueba real sobre UN chat propio de la 242 (el tuyo)
 *
 * Opciones:
 *   --chat <id>       solo ese chat; con esto sí se permite --aplicar en la 242
 *   --config <id>     configuración a revisar (por defecto, las del cron)
 *   --minutos <n>     límite en minutos en vez de las 3 horas
 *   --desde "<fecha>" fecha de activación, hora Ecuador (YYYY-MM-DD HH:mm:ss)
 *   --todo-el-dia     cuenta las 24 h y los 7 días (para probar fuera de horario)
 *   --ahora "<fecha>" hace la cuenta como si fuera esa hora (Ecuador); sirve
 *                     para ver la regla real de 3 h sin esperar. Solo con
 *                     simulación: con --aplicar se usa siempre la hora real.
 *   --aplicar         libera de verdad (no permitido en las configs del cron)
 */
require('dotenv').config();
const svc = require('../src/services/liberar_sin_respuesta.service');

const args = process.argv.slice(2);
const opcion = (nombre) => {
  const i = args.indexOf(nombre);
  return i >= 0 ? args[i + 1] : undefined;
};
const bandera = (nombre) => args.includes(nombre);

(async () => {
  const cfg = { ...svc.CONFIG };

  if (opcion('--config')) cfg.configuraciones = [Number(opcion('--config'))];
  if (opcion('--chat')) cfg.soloChat = Number(opcion('--chat'));
  if (opcion('--minutos')) cfg.horasLimite = Number(opcion('--minutos')) / 60;
  if (opcion('--desde')) cfg.activoDesde = opcion('--desde');
  if (bandera('--todo-el-dia')) {
    cfg.horaInicio = 0;
    cfg.horaFin = 24;
    cfg.diasHabiles = [0, 1, 2, 3, 4, 5, 6];
  }

  const aplicar = bandera('--aplicar');
  const reales = svc.CONFIG.configuraciones;
  if (
    aplicar &&
    !cfg.soloChat &&
    cfg.configuraciones.some((id) => reales.includes(id))
  ) {
    console.error(
      `✋ --aplicar no se permite sobre toda la ${reales.join(', ')}: son chats ` +
        'reales de producción. Usa --chat <id> con un chat tuyo, o --config ' +
        'con una configuración de prueba.',
    );
    process.exit(1);
  }

  console.log(
    `${aplicar ? '⚠️  APLICANDO' : '🔎 SIMULANDO'} | config ${cfg.configuraciones.join(', ')}` +
      (cfg.soloChat ? ` | solo chat ${cfg.soloChat}` : '') +
      ` | límite ${Math.round(cfg.horasLimite * 60)} min` +
      ` | ventana ${cfg.horaInicio}:00-${cfg.horaFin}:00 días ${cfg.diasHabiles.join(',')}` +
      ` | desde ${cfg.activoDesde}`,
  );

  // --ahora solo adelanta el reloj de la simulación. Aplicar con una hora
  // inventada liberaría chats que en la realidad todavía no vencieron.
  const ahoraSimulada = opcion('--ahora');
  if (ahoraSimulada && aplicar) {
    console.error('✋ --ahora es solo para simular; quítalo para usar --aplicar.');
    process.exit(1);
  }
  const ahoraMs = ahoraSimulada ? svc.parseFechaBD(ahoraSimulada) : Date.now();
  if (ahoraSimulada) console.log(`🕒 Reloj simulado: ${ahoraSimulada}`);

  const { candidatos, aLiberar, liberados } = await svc.ejecutarPasada({
    dryRun: !aplicar,
    cfg,
    ahoraMs,
  });

  console.log(`\n${candidatos} chat(s) asignados con el cliente esperando.`);
  console.log(`${aLiberar.length} ya pasaron el límite:`);
  for (const c of aLiberar) {
    const f = (v) =>
      v
        ? new Date(svc.parseFechaBD(v)).toLocaleString('es-EC', {
            timeZone: 'America/Guayaquil',
          })
        : '-';
    console.log(
      `  chat ${c.id} | dueño ${c.id_encargado} | espera desde ${f(c.inicio_espera)}` +
        ` | asignado ${f(c.asignado_at)} | ${Math.round(c.minutos_habiles)} min`,
    );
  }
  if (aplicar) {
    console.log(`\n✅ Liberados: ${liberados.length} (${liberados.map((c) => c.id).join(', ') || 'ninguno'})`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
