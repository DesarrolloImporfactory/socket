<?php
/* Corre Class/EstadoCargaCliente.php (el ORIGINAL de Imporsuit) sobre los casos
   de casos_estado_carga.entrada.js y escribe lo que devuelve. Con eso se
   comprueba que src/utils/soporteExpertos/estadoCarga.js da exactamente lo
   mismo que el portal «Mi puesto».

   Cuándo correrlo: cada vez que cambie EstadoCargaCliente.php en Imporsuit.

   Cómo (en una carpeta de trabajo, con PHP 8.1; sirve @php-wasm/cli por node):
     1. copiar aquí Class/EstadoCargaCliente.php del repo de Imporsuit;
     2. node -e "const {HOY,CASOS}=require('./casos_estado_carga.entrada.js');
          require('fs').writeFileSync('casos_entrada.json', JSON.stringify({hoy:HOY,
          casos:CASOS.map(c=>({nombre:c.nombre,cot:c.cot,abiertoDesde:c.abiertoDesde||{}}))}))"
     3. php comparar_con_php.php
     4. copiar casos_esperado.json sobre casos_estado_carga.esperado.json
     5. node scripts/probar_soporte_expertos.js  → dice en qué caso difiere.

   Última corrida: 2026-10-12, contra imporsuit-pro origin/main 9436219a,
   33 casos, 33 iguales. */
require __DIR__ . '/EstadoCargaCliente.php';
$in  = json_decode(file_get_contents(__DIR__ . '/casos_entrada.json'), true);
$hoy = new DateTimeImmutable($in['hoy'], new DateTimeZone('America/Guayaquil'));
$out = [];
foreach ($in['casos'] as $c) {
    $abierto = [];
    foreach (($c['abiertoDesde'] ?? []) as $k => $v) { $abierto[(int) $k] = $v; }
    $out[] = ['nombre' => $c['nombre'], 'esperado' => EstadoCargaCliente::de($c['cot'], $hoy, $abierto)];
}
file_put_contents(__DIR__ . '/casos_esperado.json', json_encode($out, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
echo count($out) . " casos\n";
