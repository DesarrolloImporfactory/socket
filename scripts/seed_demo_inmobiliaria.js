/**
 * Carga una cartera de inmuebles de demostración en una configuración, para
 * probar o mostrar el tablero de inmobiliaria sin depender de un cliente real.
 *
 * IMPORTANTE — los inmuebles van como tipo = 'servicio', no como 'producto'.
 * No es un error: procesarAgendarCita() se niega a crear la cita si lo que va
 * en "Servicio que desea" coincide con un ítem del catálogo cuyo tipo NO es
 * servicio (un guard para que el bot no agende recogidas de mercadería). Con
 * los inmuebles cargados como producto, ninguna visita se agenda y no se ve un
 * solo error. De paso, `duracion` pasa a ser la duración de la visita y el
 * sistema calcula solo la hora de fin.
 *
 * Uso:
 *   node scripts/seed_demo_inmobiliaria.js <id_configuracion>
 *   node scripts/seed_demo_inmobiliaria.js <id_configuracion> --archivar-otros
 *
 * --archivar-otros marca eliminado = 1 en lo que ya hubiera en el catálogo. Es
 * reversible (soft delete) y sirve cuando la cuenta viene de otro rubro: un
 * catálogo con servicios de estética confunde al asistente inmobiliario.
 */

require('dotenv').config();
const { db } = require('../src/database/config');

const ID_CONFIG = Number(process.argv[2]);
const ARCHIVAR = process.argv.includes('--archivar-otros');

if (!ID_CONFIG) {
  console.error(
    'Uso: node scripts/seed_demo_inmobiliaria.js <id_configuracion> [--archivar-otros]',
  );
  process.exit(1);
}

// Duración por defecto de una visita. Es lo que el sistema usa para la hora de fin.
const VISITA_MIN = 60;

const INMUEBLES = [
  {
    nombre: 'Departamento Cumbayá 3 dormitorios',
    precio: 185000,
    descripcion:
      'Departamento de 118 m² en Cumbayá, tercer piso con ascensor. 3 dormitorios ' +
      '(el máster con baño y vestidor), 2 baños y medio, sala-comedor con salida a ' +
      'una terraza de 12 m² con vista al valle. Cocina equipada con muebles altos y ' +
      'bajos. 2 parqueaderos cubiertos y bodega. Conjunto con guardianía 24h, área ' +
      'comunal y piscina. Alícuota $95. Listo para habitar, escrituras al día.',
  },
  {
    nombre: 'Casa en conjunto Tumbaco',
    precio: 245000,
    descripcion:
      'Casa de 210 m² de construcción en 240 m² de terreno, dentro de conjunto ' +
      'cerrado en Tumbaco. 4 dormitorios, 3 baños y medio, sala, comedor, cocina con ' +
      'desayunador y patio posterior con césped. Cuarto de servicio independiente. ' +
      'Garaje para 2 autos. Conjunto de 18 casas con guardianía, casa comunal y ' +
      'juegos infantiles. Alícuota $80. A 10 minutos de Scala Shopping.',
  },
  {
    nombre: 'Suite La Carolina',
    precio: 98000,
    descripcion:
      'Suite de 52 m² frente al parque La Carolina, piso 8 con vista despejada. ' +
      '1 dormitorio, 1 baño completo, cocina abierta y balcón. Edificio con ' +
      'ascensor, gimnasio y sala comunal. 1 parqueadero. Alícuota $60. Excelente ' +
      'opción de inversión: la zona tiene alta demanda de arriendo por oficinas y ' +
      'hospitales cercanos.',
  },
  {
    nombre: 'Departamento González Suárez vista al valle',
    precio: 320000,
    descripcion:
      'Departamento de 165 m² en la González Suárez, piso 11, con vista completa al ' +
      'valle de Cumbayá desde la sala y el dormitorio máster. 3 dormitorios, 3 baños ' +
      'y medio, sala con chimenea, comedor independiente, cocina equipada y cuarto ' +
      'de servicio con baño. 2 parqueaderos y bodega. Edificio de 14 pisos con ' +
      'guardianía 24h y ascensores nuevos. Alícuota $180.',
  },
  {
    nombre: 'Terreno Puembo 800 m²',
    precio: 140000,
    descripcion:
      'Terreno de 800 m² en Puembo, plano y con todos los servicios (agua, luz, ' +
      'alcantarillado). Frente de 20 metros a vía asfaltada. Uso de suelo ' +
      'residencial, permite hasta 3 pisos. Dentro de urbanización con vías internas ' +
      'y guardianía. Ideal para casa de campo o proyecto de vivienda.',
  },
  {
    nombre: 'Local comercial Av. Amazonas',
    precio: 175000,
    descripcion:
      'Local comercial de 90 m² en planta baja sobre la Av. Amazonas, con vitrina de ' +
      '8 metros a la calle. Baño, bodega interna y medio piso adicional de 25 m². ' +
      'Alto flujo peatonal, zona bancaria y de oficinas. Actualmente arrendado en ' +
      '$1.100 mensuales con contrato hasta fin de año.',
  },
  {
    nombre: 'Arriendo departamento amoblado La Floresta',
    precio: 650,
    descripcion:
      'Departamento amoblado de 78 m² en La Floresta, segundo piso. 2 dormitorios, ' +
      '2 baños, sala-comedor y cocina equipada con refrigeradora, cocina y ' +
      'lavadora. Incluye alícuota y agua. 1 parqueadero. Arriendo de $650 ' +
      'mensuales, se piden 2 meses de garantía. Disponible desde el primero del ' +
      'próximo mes. No se aceptan mascotas.',
  },
  {
    nombre: 'Arriendo casa Cumbayá',
    precio: 1200,
    descripcion:
      'Casa de 180 m² en Cumbayá dentro de conjunto cerrado, sin amoblar. ' +
      '3 dormitorios, 3 baños, sala, comedor, cocina y jardín propio de 60 m². ' +
      'Garaje para 2 autos. Arriendo de $1.200 mensuales más alícuota de $75. ' +
      'Se pide un mes de garantía y garante con rol de pagos. Se aceptan mascotas ' +
      'pequeñas. Disponible de inmediato.',
  },
];

async function main() {
  const [cfg] = await db.query(
    `SELECT id, nombre_configuracion FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );
  if (!cfg) throw new Error(`No existe la configuración ${ID_CONFIG}`);

  console.log(`Configuración ${ID_CONFIG} — ${cfg.nombre_configuracion}\n`);

  if (ARCHIVAR) {
    const nombres = INMUEBLES.map((i) => i.nombre);
    const ph = nombres.map(() => '?').join(',');
    const [n] = await db.query(
      `SELECT COUNT(*) c FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0 AND nombre NOT IN (${ph})`,
      { replacements: [ID_CONFIG, ...nombres], type: db.QueryTypes.SELECT },
    );
    await db.query(
      `UPDATE productos_chat_center SET eliminado = 1
        WHERE id_configuracion = ? AND eliminado = 0 AND nombre NOT IN (${ph})`,
      { replacements: [ID_CONFIG, ...nombres], type: db.QueryTypes.UPDATE },
    );
    console.log(`📦 ${n.c} ítem(s) del catálogo anterior archivados (eliminado = 1)\n`);
  }

  for (const inm of INMUEBLES) {
    const [ya] = await db.query(
      `SELECT id FROM productos_chat_center
        WHERE id_configuracion = ? AND nombre = ? LIMIT 1`,
      { replacements: [ID_CONFIG, inm.nombre], type: db.QueryTypes.SELECT },
    );

    if (ya) {
      await db.query(
        `UPDATE productos_chat_center
            SET tipo = 'servicio', precio = ?, duracion = ?, descripcion = ?,
                eliminado = 0
          WHERE id = ?`,
        {
          replacements: [inm.precio, VISITA_MIN, inm.descripcion, ya.id],
          type: db.QueryTypes.UPDATE,
        },
      );
      console.log(`  ♻️  ${inm.nombre} — $${inm.precio.toLocaleString('es')}`);
    } else {
      await db.query(
        `INSERT INTO productos_chat_center
           (id_configuracion, nombre, descripcion, tipo, precio, duracion, eliminado)
         VALUES (?, ?, ?, 'servicio', ?, ?, 0)`,
        {
          replacements: [
            ID_CONFIG,
            inm.nombre,
            inm.descripcion,
            inm.precio,
            VISITA_MIN,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
      console.log(`  ✅ ${inm.nombre} — $${inm.precio.toLocaleString('es')}`);
    }
  }

  console.log(
    `\n${INMUEBLES.length} inmuebles en la cartera.\n\n` +
      'Falta para que el bot los conozca bien:\n' +
      '  1. Sincronizar el catálogo de cada columna con IA:\n' +
      '     node scripts/sync_catalogo_columna.js <id_columna>\n' +
      '  2. Cargar foto y video de cada inmueble (imagen_url / video_url): es lo\n' +
      '     que más adelanta la conversación, un inmueble entra por los ojos.\n' +
      '  3. Revisar que las sedes sean las oficinas reales y que los corredores\n' +
      '     estén cargados en Profesionales, que es quien recibe cada visita.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
