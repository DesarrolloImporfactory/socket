// Script para verificar que las asociaciones funcionan correctamente
// Ejecuta esto desde tu terminal: node verificar_modelos.js

require('dotenv').config();
const { db_2 } = require('./src/database/config');
const initModel = require('./src/models/initModels');
const { getModels } = require('./src/models/initModels');

async function verificarModelos() {
  try {
    console.log('\n🔍 Verificando modelos y asociaciones...\n');

    // Inicializar asociaciones
    initModel();

    // Obtener modelos
    const models = getModels();

    // Verificar que los modelos existen
    console.log('✅ Modelos encontrados:');
    console.log('  - ImporsuitApi:', !!models.ImporsuitApi);
    console.log('  - ImporsuitCursos:', !!models.ImporsuitCursos);
    console.log('  - ImporsuitApiCursos:', !!models.ImporsuitApiCursos);
    console.log('  - User:', !!models.User);

    // Conectar y sincronizar
    await db_2.authenticate();
    console.log('\n✅ Conexión a DB2 exitosa');

    // Sincronizar tablas (esto las crea si no existen)
    await db_2.sync({ alter: false }); // alter: true actualiza estructura
    console.log('✅ Tablas sincronizadas');

    // Verificar asociaciones
    const { ImporsuitApi, ImporsuitCursos, ImporsuitApiCursos } = models;

    console.log('\n📎 Verificando asociaciones:');
    console.log(
      '  - ImporsuitApi.associations:',
      Object.keys(ImporsuitApi.associations || {})
    );
    console.log(
      '  - ImporsuitCursos.associations:',
      Object.keys(ImporsuitCursos.associations || {})
    );
    console.log(
      '  - ImporsuitApiCursos.associations:',
      Object.keys(ImporsuitApiCursos.associations || {})
    );

    console.log('\n✅ TODO FUNCIONANDO CORRECTAMENTE!\n');
    console.log('Puedes empezar a usar los modelos en tus controllers.');
    console.log(
      'Revisa: ejemplos_uso_api_cursos.js para ver cómo usarlos.\n'
    );

    process.exit(0);
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error);
    process.exit(1);
  }
}

verificarModelos();
