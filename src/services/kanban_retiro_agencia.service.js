// ════════════════════════════════════════════════════════════
// kanban_retiro_agencia.service.js
// Switch "el bot ofrece retiro en agencia Servientrega".
//
// Qué hace el toggle, por configuración:
//   ON  → 1. adjunta el archivo de agencias al vector store de documentos de
//            cada columna IA (kanban_archivos.service hace el trabajo: OpenAI
//            Files + BD + copia local). Si la cuenta ya tiene un archivo con
//            el nombre canónico (subió el suyo propio), se reutiliza ESE en
//            vez del default de la plataforma.
//         2. agrega el bloque de instrucciones al prompt de cada columna IA
//            (aplicarBloqueRetiroAgencia sobre kanban_columnas.instrucciones,
//            que es lo que lee la Responses API). Con marcas, idempotente.
//         3. guarda configuraciones.retiro_agencia_activo = 1.
//   OFF → quita el bloque del prompt, desvincula el archivo de las columnas
//         (queda en la biblioteca para re-encender sin resubir) y guarda 0.
//
// El compilador de personalización (promptCompiler) también conoce el flag:
// si el cliente personaliza o resincroniza su prompt con el switch encendido,
// el bloque se vuelve a inyectar en la compilación (perso.retiro_agencia), así
// que personalizar no lo pierde.
//
// PILOTO: solo las configuraciones de la lista pueden usar el switch. Para
// abrirlo a todos: vaciar la lista y dejar que gatee por plantilla.
// ════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { db } = require('../database/config');
const {
  aplicarBloqueRetiroAgencia,
  NOMBRE_ARCHIVO_AGENCIAS,
} = require('../utils/promptCompiler');
const kanbanArchivos = require('./kanban_archivos.service');

// Configuraciones habilitadas durante la fase de pruebas.
//   10  — WAPP IMPORTSUIT, cuenta de pruebas. Primera del piloto; toda la
//         batería de E2E del 2026-08-31 se corrió acá.
//   411 — CLICKYCOMPRA (2026-08-31). Cliente real con tablero personalizado:
//         su prompt trae un flujo de agencias propio (pedir nombre/referencia
//         sin verificar) que el bloque anula; el validador cubre lo demás.
//   610 — Global Outlet ec Pruebas (2026-08-31). Entra con el switch YA
//         ENCENDIDO: ofrece oficinas del directorio cuando el cliente pide
//         retiro en agencia.
// null = abierto para todas (el gate pasa a ser solo la plantilla E-commerce).
const PILOTO_CONFIGS = [10, 610, 411];

// Archivo default de la plataforma (viaja con el deploy — NO va en uploads/,
// que está excluido del rsync).
const RUTA_DEFAULT = path.join(
  __dirname,
  '..',
  'assets',
  'kanban_defaults',
  NOMBRE_ARCHIVO_AGENCIAS,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enPiloto(id_configuracion) {
  if (!Array.isArray(PILOTO_CONFIGS)) return true;
  return PILOTO_CONFIGS.includes(Number(id_configuracion));
}

// ─────────────────────────────────────────────────────────────
// Trabajos de toggle en segundo plano.
//
// Activar sube el archivo a OpenAI y lo indexa en el vector store de CADA
// columna IA (cada indexado se espera con polling): fácil 30-60 segundos. El
// axios del front corta antes (timeout) y el usuario ve "explotó" aunque por
// detrás terminó bien — y un doble clic lanzaba el trabajo dos veces. Por eso
// el toggle responde al instante, el trabajo corre acá con candado por
// configuración, y el front consulta `estado` hasta que termine (mismo
// espíritu que sincronizar catálogo con sync_status).
//
// El registro es en memoria: si el proceso se reinicia a mitad, el candado se
// pierde, pero activar/desactivar son idempotentes — repetir el toggle deja
// todo consistente.
// ─────────────────────────────────────────────────────────────
const trabajosToggle = new Map(); // id_configuracion -> {en_curso, activo_solicitado, error, inicio_at, fin_at}

function trabajoDe(id_configuracion) {
  return trabajosToggle.get(Number(id_configuracion)) || null;
}

function lanzarToggle(id_configuracion, activo, id_sub_usuario = null) {
  const key = Number(id_configuracion);
  const previo = trabajosToggle.get(key);
  if (previo?.en_curso) {
    throw new Error(
      'Ya hay una activación en curso para esta configuración. Espera a que termine.',
    );
  }

  trabajosToggle.set(key, {
    en_curso: true,
    activo_solicitado: activo,
    error: null,
    inicio_at: new Date().toISOString(),
    fin_at: null,
  });

  // El trabajo corre fuera del request. Los errores quedan en el registro
  // para que `estado` se los muestre al front — nunca revientan el proceso.
  (async () => {
    let error = null;
    try {
      if (activo) await activar(key, id_sub_usuario);
      else await desactivar(key);
    } catch (e) {
      error = e.message || 'Error desconocido';
      console.error(`[retiro_agencia] toggle cfg=${key} activo=${activo}:`, error);
    }
    trabajosToggle.set(key, {
      en_curso: false,
      activo_solicitado: activo,
      error,
      inicio_at: trabajosToggle.get(key)?.inicio_at || null,
      fin_at: new Date().toISOString(),
    });
  })();
}

async function estaActivo(id_configuracion) {
  const [row] = await db.query(
    `SELECT retiro_agencia_activo FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return Number(row?.retiro_agencia_activo) === 1;
}

async function columnasIA(id_configuracion) {
  return db.query(
    `SELECT id, nombre, estado_db, instrucciones, vector_store_docs_id
     FROM kanban_columnas
     WHERE id_configuracion = ? AND activo = 1 AND activa_ia = 1
     ORDER BY orden`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
}

// El archivo de agencias de ESTA cuenta en la biblioteca (subido por el
// cliente o adjuntado por la plataforma en un toggle anterior).
async function archivoAgenciasDeLaCuenta(id_configuracion) {
  const [row] = await db.query(
    `SELECT id, nombre_original, bytes, storage_path, status, openai_file_id
     FROM kanban_archivos
     WHERE id_configuracion = ? AND nombre_original = ? AND deleted_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    {
      replacements: [id_configuracion, NOMBRE_ARCHIVO_AGENCIAS],
      type: db.QueryTypes.SELECT,
    },
  );
  return row || null;
}

function existeDefault() {
  return fs.existsSync(RUTA_DEFAULT);
}

// ¿El file object sigue vivo en OpenAI? La fila de la BD puede apuntar a un
// archivo que alguien borró de OpenAI Files (caso real del piloto: el toggle
// re-activaba contra un file muerto y el attach devolvía 404 sin remedio).
async function archivoViveEnOpenAI(openai_file_id, apiKey) {
  try {
    await axios.get(`https://api.openai.com/v1/files/${openai_file_id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    });
    return true;
  } catch (e) {
    if (e?.response?.status === 404) return false;
    // Otro error (red, 5xx): no se puede afirmar que murió — se asume vivo y
    // que el attach (con su reintento) decida.
    return true;
  }
}

// El cliente puede usar SU PROPIO directorio: sube desde la UI un archivo con
// el nombre canónico a "Archivos de conocimiento" (eso lo deja en el vector
// store de documentos de su columna, sin pasar por la BD) y re-enciende el
// switch. Acá se detecta ese archivo en el store y se ADOPTA: se registra en
// la biblioteca y pasa a ser el directorio de la cuenta, por encima del
// default de la plataforma.
async function adoptarArchivoDelStore(id_configuracion, col, archivoActual, apiKey) {
  if (!col?.vector_store_docs_id || !apiKey) return null;
  try {
    const H = {
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Beta': 'assistants=v2',
    };
    const r = await axios.get(
      `https://api.openai.com/v1/vector_stores/${col.vector_store_docs_id}/files?limit=50`,
      { headers: H, timeout: 20000 },
    );
    for (const f of r.data?.data || []) {
      if (archivoActual?.openai_file_id === f.id) continue;
      let meta = null;
      try {
        meta = (
          await axios.get(`https://api.openai.com/v1/files/${f.id}`, {
            headers: H,
            timeout: 15000,
          })
        ).data;
      } catch (_) {
        continue;
      }
      if (meta?.filename !== NOMBRE_ARCHIVO_AGENCIAS) continue;

      if (archivoActual) {
        await db.query(
          `UPDATE kanban_archivos SET deleted_at = NOW() WHERE id = ?`,
          { replacements: [archivoActual.id], type: db.QueryTypes.UPDATE },
        );
      }
      const [id_archivo] = await db.query(
        `INSERT INTO kanban_archivos
           (id_configuracion, nombre_original, mime, bytes, openai_file_id,
            storage_path, status)
         VALUES (?, ?, 'text/plain', ?, ?, NULL, 'completed')`,
        {
          replacements: [
            id_configuracion,
            NOMBRE_ARCHIVO_AGENCIAS,
            meta?.bytes || 0,
            f.id,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
      return {
        id: id_archivo,
        nombre_original: NOMBRE_ARCHIVO_AGENCIAS,
        openai_file_id: f.id,
        storage_path: null,
      };
    }
  } catch (_) {
    /* listar el store falló: se sigue con el archivo registrado/default */
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// adoptarArchivoSubido
// Lo dispara el endpoint de "Subir archivo" de la UI (fire-and-forget) cuando
// el cliente sube un archivo con el nombre canónico del directorio. Si el
// switch está encendido, ESE archivo pasa a ser el directorio de la cuenta:
// el anterior se retira de la biblioteca y de todos los stores, el nuevo se
// registra con copia local (la vista previa muestra lo que el cliente subió)
// y se propaga a TODAS las columnas IA. El cliente no toca el switch: elimina
// el archivo viejo, sube el suyo, y listo.
// ─────────────────────────────────────────────────────────────
async function adoptarArchivoSubido({
  id_configuracion,
  openai_file_id,
  filename,
  buffer,
  bytes,
  id_sub_usuario = null,
}) {
  if (filename !== NOMBRE_ARCHIVO_AGENCIAS) return null;
  if (!(await estaActivo(id_configuracion))) return null;

  const cols = await columnasIA(id_configuracion);
  const [rowKey] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const apiKey = rowKey?.api_key_openai || null;

  // 1. Retirar el directorio anterior (biblioteca + stores). Sin esto el bot
  // vería DOS directorios a la vez y mezclaría oficinas de ambos.
  const previo = await archivoAgenciasDeLaCuenta(id_configuracion);
  if (previo && previo.openai_file_id !== openai_file_id) {
    for (const col of cols) {
      await kanbanArchivos
        .desvincularArchivo({ id_kanban_columna: col.id, id_archivo: previo.id })
        .catch(() => {});
      if (apiKey && previo.openai_file_id && col.vector_store_docs_id) {
        await kanbanArchivos
          .desadjuntarDeVectorStore(
            col.vector_store_docs_id,
            previo.openai_file_id,
            apiKey,
          )
          .catch(() => {});
      }
    }
    await db.query(
      `UPDATE kanban_archivos SET deleted_at = NOW() WHERE id = ?`,
      { replacements: [previo.id], type: db.QueryTypes.UPDATE },
    );
  }

  // 2. Registrar el nuevo en la biblioteca, con copia local para la vista previa
  let storage_path = null;
  if (buffer) {
    storage_path = await kanbanArchivos
      .guardarCopiaLocal(buffer, id_configuracion, NOMBRE_ARCHIVO_AGENCIAS)
      .catch(() => null);
  }
  const [id_archivo] = await db.query(
    `INSERT INTO kanban_archivos
       (id_configuracion, nombre_original, mime, bytes, openai_file_id,
        storage_path, status, id_sub_usuario)
     VALUES (?, ?, 'text/plain', ?, ?, ?, 'completed', ?)`,
    {
      replacements: [
        id_configuracion,
        NOMBRE_ARCHIVO_AGENCIAS,
        bytes || 0,
        openai_file_id,
        storage_path,
        id_sub_usuario,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  // 3. Propagarlo a TODAS las columnas IA (en la de la subida ya está
  // adjunto: vincular es idempotente y solo registra el vínculo)
  for (const col of cols) {
    await kanbanArchivos
      .vincularArchivo({ id_kanban_columna: col.id, id_archivo })
      .catch((e) =>
        console.error(
          `[retiro_agencia] adopción: no se pudo vincular a "${col.nombre}": ${e.message}`,
        ),
      );
  }

  console.log(
    `[retiro_agencia] cfg=${id_configuracion}: directorio propio adoptado (${openai_file_id})`,
  );
  return { id: id_archivo, openai_file_id };
}

// El contenido para (re)subir: la copia local del archivo de la cuenta si
// existe (respeta un archivo propio del cliente), si no el default del repo.
async function bufferParaSubir(archivo) {
  if (archivo?.storage_path) {
    const ruta = path.join(__dirname, '..', 'uploads', archivo.storage_path);
    try {
      return await fs.promises.readFile(ruta);
    } catch (_) {
      /* copia local perdida: cae al default */
    }
  }
  if (existeDefault()) return fs.promises.readFile(RUTA_DEFAULT);
  return null;
}

// ─────────────────────────────────────────────────────────────
// activar / desactivar
// ─────────────────────────────────────────────────────────────
async function activar(id_configuracion, id_sub_usuario = null) {
  const cols = await columnasIA(id_configuracion);
  if (!cols.length)
    throw new Error('Esta configuración no tiene columnas IA activas');

  // 1. Conseguir (o crear) el archivo de agencias en la biblioteca.
  // Prioridad: archivo propio subido por el cliente al store (se adopta) >
  // archivo registrado en la biblioteca > default de la plataforma.
  // AUTO-REPARACIÓN: si la fila registrada apunta a un file object que ya no
  // está en OpenAI (algo lo borró — caso real del piloto), la fila muerta se
  // marca eliminada y el archivo se resube desde su copia local (o el
  // default).
  let archivo = await archivoAgenciasDeLaCuenta(id_configuracion);

  const [rowKey] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const apiKey = rowKey?.api_key_openai || null;

  const adoptado = await adoptarArchivoDelStore(
    id_configuracion,
    cols[0],
    archivo,
    apiKey,
  );
  if (adoptado) archivo = adoptado;

  if (archivo && !adoptado) {
    if (
      apiKey &&
      archivo.openai_file_id &&
      !(await archivoViveEnOpenAI(archivo.openai_file_id, apiKey))
    ) {
      await db.query(
        `UPDATE kanban_archivos SET deleted_at = NOW() WHERE id = ?`,
        { replacements: [archivo.id], type: db.QueryTypes.UPDATE },
      );
      const buffer = await bufferParaSubir(archivo);
      archivo = null;
      if (buffer) {
        const subida = await kanbanArchivos.subirArchivo({
          id_kanban_columna: cols[0].id,
          archivo: {
            buffer,
            originalname: NOMBRE_ARCHIVO_AGENCIAS,
            mimetype: 'text/plain',
            size: buffer.length,
          },
          id_sub_usuario,
        });
        archivo = { id: subida.id, nombre_original: subida.nombre };
      }
    }
  }

  if (!archivo) {
    if (!existeDefault()) {
      throw new Error(
        `Falta el archivo default de la plataforma en ${RUTA_DEFAULT}. ` +
          `Súbelo al servidor o carga el archivo manualmente en la columna.`,
      );
    }
    const buffer = await fs.promises.readFile(RUTA_DEFAULT);
    const subida = await kanbanArchivos.subirArchivo({
      id_kanban_columna: cols[0].id,
      archivo: {
        buffer,
        originalname: NOMBRE_ARCHIVO_AGENCIAS,
        mimetype: 'text/plain',
        size: buffer.length,
      },
      id_sub_usuario,
    });
    archivo = { id: subida.id, nombre_original: subida.nombre };
  }

  // Pasos 2-4 con rollback: si cualquier cosa falla a la mitad, se revierte
  // TODO (desactivar quita bloques, desvincula el archivo y deja el flag en
  // 0) y el error sube al registro del trabajo. Regla simple para el usuario:
  // o queda todo encendido, o el switch queda apagado y limpio — nunca a
  // medias.
  try {
    // 2. Vincularlo a TODAS las columnas IA (vincular es idempotente: si el
    // archivo ya quedó adjunto en OpenAI por un intento anterior, OpenAI
    // responde "already" y sigue). Un fallo se reintenta UNA vez tras 3s —
    // caso real del piloto: un error transitorio de red durante el polling
    // dio por fallida una indexación que en OpenAI había terminado bien. Si
    // aún así una columna no indexa, se aborta: un bot con el bloque pero sin
    // poder buscar el archivo ofrecería agencias a ciegas.
    for (const col of cols) {
      try {
        await kanbanArchivos.vincularArchivo({
          id_kanban_columna: col.id,
          id_archivo: archivo.id,
        });
      } catch (e1) {
        await sleep(3000);
        try {
          await kanbanArchivos.vincularArchivo({
            id_kanban_columna: col.id,
            id_archivo: archivo.id,
          });
        } catch (e2) {
          throw new Error(
            `No se pudo indexar el archivo en la columna "${col.nombre}": ${e2.message} (primer intento: ${e1.message})`,
          );
        }
      }
    }

    // 3. Inyectar el bloque en el prompt de cada columna IA (lo que lee el bot)
    for (const col of cols) {
      const nuevo = aplicarBloqueRetiroAgencia(col.instrucciones, true);
      await db.query(
        `UPDATE kanban_columnas SET instrucciones = ? WHERE id = ?`,
        { replacements: [nuevo, col.id], type: db.QueryTypes.UPDATE },
      );
    }

    // 4. Guardar el flag
    await db.query(
      `UPDATE configuraciones SET retiro_agencia_activo = 1 WHERE id = ?`,
      { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
    );
  } catch (e) {
    await desactivar(id_configuracion).catch((e2) => {
      console.error(
        `[retiro_agencia] rollback de activar cfg=${id_configuracion} falló:`,
        e2.message,
      );
    });
    throw e;
  }

  return { activo: true, columnas: cols.length, errores: [] };
}

async function desactivar(id_configuracion) {
  const cols = await columnasIA(id_configuracion);

  // 1. Quitar el bloque de los prompts
  for (const col of cols) {
    const nuevo = aplicarBloqueRetiroAgencia(col.instrucciones, false);
    await db.query(`UPDATE kanban_columnas SET instrucciones = ? WHERE id = ?`, {
      replacements: [nuevo, col.id],
      type: db.QueryTypes.UPDATE,
    });
  }

  // 2. Desvincular el archivo de las columnas (queda en la biblioteca).
  // Además del desvincular por BD, se despega DIRECTO del vector store de
  // documentos de cada columna: cuando una activación falla a mitad de camino
  // el archivo puede quedar adjunto en OpenAI sin fila en BD (el vínculo se
  // registra recién después de indexar), y el desvincular por BD no lo vería.
  const archivo = await archivoAgenciasDeLaCuenta(id_configuracion);
  const errores = [];
  if (archivo) {
    let apiKey = null;
    try {
      const [row] = await db.query(
        `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );
      apiKey = row?.api_key_openai || null;
    } catch (_) {
      /* sin api key: el desvincular por BD hace lo que pueda */
    }

    for (const col of cols) {
      try {
        await kanbanArchivos.desvincularArchivo({
          id_kanban_columna: col.id,
          id_archivo: archivo.id,
        });
      } catch (e) {
        errores.push(`columna "${col.nombre}": ${e.message}`);
      }

      if (apiKey && archivo.openai_file_id) {
        const [colFull] = await db.query(
          `SELECT vector_store_docs_id FROM kanban_columnas WHERE id = ? LIMIT 1`,
          { replacements: [col.id], type: db.QueryTypes.SELECT },
        );
        if (colFull?.vector_store_docs_id) {
          await kanbanArchivos
            .desadjuntarDeVectorStore(
              colFull.vector_store_docs_id,
              archivo.openai_file_id,
              apiKey,
            )
            .catch(() => {});
        }
      }
    }
  }

  // 3. Guardar el flag
  await db.query(
    `UPDATE configuraciones SET retiro_agencia_activo = 0 WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  return { activo: false, columnas: cols.length, errores };
}

// ─────────────────────────────────────────────────────────────
// estado — para pintar el switch en el front
// ─────────────────────────────────────────────────────────────
async function estado(id_configuracion) {
  const activo = await estaActivo(id_configuracion);
  const archivo = await archivoAgenciasDeLaCuenta(id_configuracion);
  return {
    piloto: enPiloto(id_configuracion),
    activo,
    archivo: archivo
      ? {
          id: archivo.id,
          nombre: archivo.nombre_original,
          bytes: archivo.bytes,
          status: archivo.status,
        }
      : null,
    default_disponible: existeDefault(),
    nombre_canonico: NOMBRE_ARCHIVO_AGENCIAS,
    trabajo: trabajoDe(id_configuracion),
  };
}

// ─────────────────────────────────────────────────────────────
// contenidoArchivo — la vista previa
// Prioridad: la copia local del archivo de la cuenta (es EXACTAMENTE lo que
// está indexado en OpenAI) > el default del repo. Es la respuesta a "¿por qué
// mi bot no ofreció tal agencia?": si no está en este texto, no existe para
// el bot.
// ─────────────────────────────────────────────────────────────
async function contenidoArchivo(id_configuracion) {
  const archivo = await archivoAgenciasDeLaCuenta(id_configuracion);

  if (archivo?.storage_path) {
    const ruta = path.join(__dirname, '..', 'uploads', archivo.storage_path);
    try {
      const texto = await fs.promises.readFile(ruta, 'utf8');
      return { origen: 'cuenta', nombre: archivo.nombre_original, texto };
    } catch (_) {
      /* copia local perdida: se resuelve abajo */
    }
  }

  /* Copia local ausente pero el archivo registrado ES el default de la
     plataforma (mismos bytes): el contenido es idéntico al del repo, así que
     se sirve ese. Caso real: el toggle se activó desde una máquina (la copia
     quedó en SU src/uploads) y la vista previa se pide desde otra — uploads/
     no viaja en el deploy, pero assets/ sí. */
  if (archivo && existeDefault()) {
    try {
      const st = await fs.promises.stat(RUTA_DEFAULT);
      if (Number(archivo.bytes) === st.size) {
        const texto = await fs.promises.readFile(RUTA_DEFAULT, 'utf8');
        return { origen: 'cuenta', nombre: archivo.nombre_original, texto };
      }
    } catch (_) {
      /* sigue al caso sin copia */
    }
  }

  // Archivo propio del cliente sin copia local (adoptado del vector store, o
  // con bytes distintos al default): OpenAI no permite descargar files de
  // purpose assistants y mostrar el default acá sería MENTIR (el bot usa otro
  // contenido). Se devuelve sin texto y el front lo explica.
  if (archivo) {
    return { origen: 'cliente_sin_copia', nombre: archivo.nombre_original, texto: null };
  }

  if (existeDefault()) {
    const texto = await fs.promises.readFile(RUTA_DEFAULT, 'utf8');
    return { origen: 'default', nombre: NOMBRE_ARCHIVO_AGENCIAS, texto };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// corregirDireccionRetiro — RED DE SEGURIDAD DETERMINÍSTICA DEL CIERRE
//
// El modelo a veces encuentra la oficina correcta en la conversación y aun
// así la pierde al armar el resumen final (caso real cfg 10: confirmó
// "San Sebastian — AV NAPO S/N Y CALIXTO PINO" y cerró con "Agencia
// Servientrega San Sebastian — Latacunga", sin calles). El prompt solo no
// alcanza para "cero fallas": acá, en código, se valida la línea 🏡 de todo
// cierre con retiro contra el directorio real:
//   1. Si la línea ya contiene una dirección del directorio → se deja.
//   2. Si no, pero nombra un sector que identifica UNA oficina de esa
//      ciudad → se reescribe con sector + dirección reales.
//   3. Si no se puede verificar → se reescribe al "por confirmar con un
//      asesor (cliente sugirió: ...)" — honesto para el cliente y accionable
//      para el dueño.
// Lo llama kanban_ia.service ANTES de validar/mover el cierre, así lo
// corregido llega igual al cliente, a la columna y al auto-orden.
// ─────────────────────────────────────────────────────────────
function normTxt(s) {
  return String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function parseDirectorio(texto) {
  const oficinas = [];
  const lineas = String(texto || '').split('\n');
  let pendiente = null;
  for (const l of lineas) {
    const m = l.match(
      /Oficina Servientrega\s*—\s*Sector (.+?) · Ciudad: (.+?) · Provincia: (.+)/,
    );
    if (m) {
      pendiente = { sector: m[1].trim(), ciudad: m[2].trim() };
      continue;
    }
    const d = l.match(/Direcci[oó]n:\s*(.+)/);
    if (d && pendiente) {
      oficinas.push({ ...pendiente, direccion: d[1].trim() });
      pendiente = null;
    }
  }
  return oficinas;
}

async function corregirDireccionRetiro(texto, id_configuracion, id_cliente = null) {
  const t = String(texto || '');
  if (!/\[generar_guia\]:true/i.test(t)) return null;
  if (!/Envio:\s*agencia/i.test(t)) return null;
  if (!(await estaActivo(id_configuracion))) return null;

  const cont = await contenidoArchivo(id_configuracion);
  if (!cont?.texto) return null; // archivo propio sin copia local: no se puede validar
  const oficinas = parseDirectorio(cont.texto);
  if (!oficinas.length) return null;

  const mDir = t.match(/^([^\n]{0,6}?Direcci[oó]n[^:\n]{0,25}:\s*)(.+)$/m);
  if (!mDir) return null;
  const dirVal = mDir[2].replace(/[*_]/g, '').trim();
  const nd = normTxt(dirVal);
  if (!nd || /POR CONFIRMAR/.test(nd)) return null;

  /* 0. MEMORIA DE LA CONVERSACIÓN: si el bot ya confirmó "retiras en X —
     dirección", el cierre lleva ESA oficina — no otra real cualquiera.
     Caso cfg 10: confirmó "por confirmar", el cliente siguió, y el cierre
     salió con "Principal" (real, pero que nadie eligió). Se busca la última
     confirmación desde el reinicio y, si el cierre trae otra cosa, se
     reescribe a la confirmada. */
  if (id_cliente) {
    try {
      const [msgs] = await db.query(
        `SELECT m.texto_mensaje FROM mensajes_clientes m
          WHERE m.id_configuracion = ? AND m.celular_recibe = ? AND m.rol_mensaje = 1
            AND m.created_at >= COALESCE(
              (SELECT c.reinicio_conversacion_at FROM clientes_chat_center c WHERE c.id = ?),
              '1970-01-01')
          ORDER BY m.id DESC LIMIT 15`,
        { replacements: [id_configuracion, String(id_cliente), id_cliente] },
      );
      for (const m of msgs) {
        const mm = String(m.texto_mensaje || '').match(
          /(?:retiras en|retiramos ah[ií].*?oficina|tenemos la oficina)\s+([^\n]{6,160})/i,
        );
        if (!mm) continue;
        const nconf = normTxt(mm[1]);
        const confirmada = oficinas.find((o) => {
          const ndir = normTxt(o.direccion);
          return ndir.length >= 10 && nconf.includes(ndir);
        });
        if (confirmada) {
          const ndirConf = normTxt(confirmada.direccion);
          if (nd.includes(ndirConf)) return null; // el cierre ya trae la confirmada
          return {
            texto: t.replace(
              mDir[0],
              `${mDir[1]}${confirmada.sector} — ${confirmada.direccion}`,
            ),
            motivo: `el cierre traía otra oficina: se impone la confirmada en la conversación ("${confirmada.sector}")`,
          };
        }
        break; // la última confirmación no calzó con el directorio: sigue el flujo normal
      }
    } catch (_) {
      /* la memoria es un refuerzo: si falla, sigue la validación normal */
    }
  }

  // 1. ¿Contiene una dirección real del directorio? → válida, no tocar.
  const yaValida = oficinas.some((o) => {
    const ndir = normTxt(o.direccion);
    return ndir.length >= 10 && nd.includes(ndir);
  });
  if (yaValida) return null;

  const ciudadTxt = (
    t.match(/^[^\n]{0,6}?Ciudad\s*:\s*(.+)$/m)?.[1] || ''
  )
    .replace(/[*_]/g, '')
    .trim();
  const nCiudad = normTxt(ciudadTxt);

  // 2. ¿Nombra un sector que identifica UNA oficina de la ciudad?
  const enCiudad = nCiudad
    ? oficinas.filter((o) => normTxt(o.ciudad) === nCiudad)
    : [];
  const porSector = enCiudad.filter((o) => {
    const ns = normTxt(o.sector);
    return ns.length >= 4 && nd.includes(ns);
  });

  let nuevaLinea;
  let motivo;
  if (porSector.length === 1) {
    nuevaLinea = `${porSector[0].sector} — ${porSector[0].direccion}`;
    motivo = `sector "${porSector[0].sector}" resuelto contra el directorio`;
  } else {
    nuevaLinea = `Agencia Servientrega de ${ciudadTxt || 'la ciudad'} — por confirmar con un asesor (cliente sugirió: ${dirVal})`;
    motivo = 'oficina no verificable en el directorio → por confirmar';
  }

  return {
    texto: t.replace(mDir[0], `${mDir[1]}${nuevaLinea}`),
    motivo,
  };
}

// ─────────────────────────────────────────────────────────────
// guardiaOficinaRetiro — EL PASO DE OFRECER OFICINAS, EN CÓDIGO
//
// El guion base de la plantilla ("cuando ya respondió domicilio o agencia →
// dame tu nombre...") le gana al bloque, a la regla del input y a la ficha:
// gpt-5-mini pide el nombre apenas el cliente dice "agencia" y nunca ofrece
// una oficina (3 capas de prompt no lo corrigieron — caso cfg 10,
// 2026-08-31). Misma filosofía que el respondedor logístico: el paso que se
// puede derivar con datos no se le ruega al modelo, se hace en código.
//
// Si el modelo pide datos personales cuando el pedido es con retiro y aún no
// hay oficina elegida NI se ofreció una lista, su respuesta se REEMPLAZA:
//   - sin ciudad  → pregunta de ciudad (texto fijo).
//   - con ciudad  → la lista real de oficinas de esa ciudad, del directorio.
// Los textos son marcas fijas: el turno siguiente los reconoce (kanban_ia
// inyecta la nota "tu último mensaje no está en tu memoria") para que el
// modelo no se desoriente con la respuesta del cliente a un mensaje que él
// no escribió.
// ─────────────────────────────────────────────────────────────
const GUARDIA_MARCA_CIUDAD =
  '¿En qué ciudad te encuentras? 😊 Así te paso las oficinas Servientrega disponibles para retirar 📦';
const GUARDIA_MARCA_LISTA = 'tienes estas oficinas Servientrega para retirar:';
const GUARDIA_MARCA_OFERTA = 'Por ahí tenemos la oficina';

// Busca la oficina que el cliente describe por una referencia libre ("la de
// la general maldonado", "por el terminal"): tokens significativos del
// mensaje contra sector+dirección de las oficinas de SU ciudad. Devuelve la
// oficina solo si hay UN ganador claro — en empate no se adivina.
function oficinaPorReferencia(oficinasCiudad, mensajeCliente) {
  const stop = new Set([
    'AGENCIA', 'OFICINA', 'SERVIENTREGA', 'SERVI', 'RETIRO', 'RETIRAR',
    'CERCA', 'QUEDA', 'TENGO', 'TIENE', 'TIENES', 'ESTA', 'HAY', 'SOBRE',
    'CALLE', 'AVENIDA', 'SECTOR', 'CENTRO', 'COMERCIAL', 'FAVOR', 'MEJOR',
    'PREFIERO', 'QUIERO',
  ]);
  const tokens = normTxt(mensajeCliente)
    .split(' ')
    .filter((w) => w.length >= 5 && !stop.has(w));
  if (!tokens.length) return null;

  let mejor = null;
  let mejorScore = 0;
  let empate = false;
  for (const o of oficinasCiudad) {
    const texto = normTxt(`${o.sector} ${o.direccion}`);
    const score = tokens.reduce((n, w) => n + (texto.includes(w) ? 1 : 0), 0);
    if (score > mejorScore) {
      mejor = o;
      mejorScore = score;
      empate = false;
    } else if (score === mejorScore && score > 0) {
      empate = true;
    }
  }
  return mejorScore > 0 && !empate ? mejor : null;
}

async function guardiaOficinaRetiro({
  respuesta,
  ficha,
  id_configuracion,
  id_cliente,
  mensajeCliente = '',
}) {
  const t = String(respuesta || '');
  const { agenciaConcreta } = require('../utils/fichaPedido');
  if (!ficha || ficha.entrega !== 'agencia') return null;
  if (/\[(generar_guia|asesor|cancelados)\]:true/i.test(t)) return null;
  if (!(await estaActivo(id_configuracion))) return null;

  /* Caso 0 — ROMPE-BUCLE: el cliente AFIRMÓ una oferta de la guardia ("Sí
     por favor") y el modelo —que no tiene ese mensaje en su memoria, porque
     fue un reemplazo en código— vuelve a preguntar "¿cuál oficina
     prefieres?". Caso real cfg 10 (13:28-13:31): tres vueltas del mismo
     bucle. El código confirma la oficina de la última oferta y pide el
     siguiente dato. */
  const msgAfirma = /^(SI|SII+|SI POR FAVOR|SI PORFA\w*|SI CLARO|SI ESA( MISMO)?( ESTA BIEN)?|ESA( MISMO)?( ESTA BIEN)?|DALE|OK|OKAY|CLARO|DE UNA|LISTO|BUENO|PERFECTO)$/.test(
    normTxt(mensajeCliente),
  );
  const vuelveAPreguntarOficina =
    /cu[aá]l (?:de las|oficina|te queda|prefieres)|qu[eé] oficina|prefieres:/i.test(t);
  if (msgAfirma && vuelveAPreguntarOficina) {
    const [ultimos] = await db.query(
      `SELECT m.texto_mensaje FROM mensajes_clientes m
        WHERE m.id_configuracion = ? AND m.celular_recibe = ? AND m.rol_mensaje = 1
          AND m.created_at >= COALESCE(
            (SELECT c.reinicio_conversacion_at FROM clientes_chat_center c WHERE c.id = ?),
            '1970-01-01')
        ORDER BY m.id DESC LIMIT 3`,
      { replacements: [id_configuracion, String(id_cliente), id_cliente] },
    );
    for (const m of ultimos) {
      const mm = String(m.texto_mensaje || '').match(
        /(?:Por ahí tenemos la oficina|retiras en)\s+([^\n😊?¿]{6,160})/i,
      );
      if (!mm) continue;
      const oficinaTxt = mm[1].trim().replace(/[.\s]+$/, '');
      const pregunta = !ficha.nombre
        ? '¿Tu nombre completo?'
        : !ficha.telefono
          ? '¿Tu número de teléfono? 📞'
          : '¿Confirmamos el pedido?';
      return {
        texto: `Perfecto, retiras en ${oficinaTxt} 😊 ${pregunta}`,
        motivo: `rompe-bucle: el cliente afirmó la oferta y el modelo volvía a preguntar cuál oficina`,
      };
    }
  }

  /* Caso 1 — el modelo SE RINDE sin haber buscado bien la referencia que el
     cliente acaba de dar: "por confirmar", "por esa zona no tengo una
     oficina registrada", "no encontré/no hay oficina..." (incluso usando el
     texto de fallback del propio bloque). Caso real cfg 10: "me queda cerca
     una que está en la general maldonado" → el directorio tiene
     "AV. AMAZONAS 1766 Y GENERAL MALDONADO" y la búsqueda del modelo no la
     vio. El código busca la referencia contra las oficinas de su ciudad:
     con UN ganador claro, la respuesta se reemplaza por esa oferta. */
  const seRinde =
    /por confirmar|por esa zona no|no tengo (?:una |ninguna )?oficina|no (?:aparece|encuentro|encontr[eé]|hay) (?:una |ninguna )?(?:oficina|agencia)|no est[aá] (?:registrada|en (?:el|nuestro) directorio)/i.test(
      t,
    );
  if (seRinde && ficha.ciudad && mensajeCliente) {
    const cont = await contenidoArchivo(id_configuracion);
    if (cont?.texto) {
      const deCiudad = parseDirectorio(cont.texto).filter(
        (o) => normTxt(o.ciudad) === normTxt(ficha.ciudad),
      );
      const hallada = oficinaPorReferencia(deCiudad, mensajeCliente);
      if (hallada) {
        return {
          texto: `¡Sí! ${GUARDIA_MARCA_OFERTA} ${hallada.sector} — ${hallada.direccion} 😊 ¿Retiramos ahí?`,
          motivo: `referencia del cliente resuelta a "${hallada.sector}" (el modelo se rendía con por-confirmar)`,
        };
      }
    }
  }

  // De aquí en adelante solo aplica cuando NO hay oficina ni referencia
  // concreta en la ficha ("Servientrega" a secas no cuenta: es la modalidad).
  if (agenciaConcreta(ficha.agencia)) return null;

  // ¿La respuesta ya ofrece oficinas, confirma una, o pregunta la ciudad? OK.
  if (/cu[aá]l te queda mejor|\b1\)\s|retiras en|oficina|sector|qu[eé] ciudad/i.test(t))
    return null;
  // El error a corregir: pide datos personales sin haber resuelto la oficina.
  if (!/nombre completo|tu nombre|apellido|n[uú]mero de tel[eé]fono|tu tel[eé]fono|tel[eé]fono para/i.test(t))
    return null;

  // ¿Ya se ofreció una lista antes en ESTA conversación? Entonces el cliente
  // está eligiendo y pedir datos puede ser legítimo — no interceptar (el
  // candado del cierre protege el final). Con el MISMO corte del recap y la
  // ficha: lo anterior a "Reiniciar conversación" no cuenta — sin el corte,
  // las listas de una prueba vieja hacían que la guardia se abstuviera.
  const [prev] = await db.query(
    `SELECT m.texto_mensaje FROM mensajes_clientes m
      WHERE m.id_configuracion = ? AND m.celular_recibe = ? AND m.rol_mensaje = 1
        AND m.created_at >= COALESCE(
          (SELECT c.reinicio_conversacion_at FROM clientes_chat_center c WHERE c.id = ?),
          '1970-01-01')
      ORDER BY m.id DESC LIMIT 12`,
    { replacements: [id_configuracion, String(id_cliente), id_cliente] },
  );
  const yaOfrecio = prev.some((m) => {
    const x = String(m.texto_mensaje || '');
    return x.includes(GUARDIA_MARCA_LISTA) || /cu[aá]l te queda mejor/i.test(x);
  });
  if (yaOfrecio) return null;

  if (!ficha.ciudad) {
    return { texto: GUARDIA_MARCA_CIUDAD, motivo: 'faltaba la ciudad: se pregunta antes que el nombre' };
  }

  const cont = await contenidoArchivo(id_configuracion);
  if (!cont?.texto) return null;
  const deCiudad = parseDirectorio(cont.texto).filter(
    (o) => normTxt(o.ciudad) === normTxt(ficha.ciudad),
  );
  // Ciudad sin oficinas en el directorio: que el modelo maneje el "por
  // confirmar" (la guardia no puede mejorar eso).
  if (!deCiudad.length) return null;

  const top = deCiudad.slice(0, 5);
  const lista = top.map((o, i) => `${i + 1}) ${o.sector} — ${o.direccion}`).join('\n');
  return {
    texto: `Perfecto! En ${ficha.ciudad} ${GUARDIA_MARCA_LISTA}\n${lista}\n¿Cuál te queda mejor? 😊`,
    motivo: `lista de ${top.length} oficina(s) de ${ficha.ciudad} generada del directorio`,
  };
}

module.exports = {
  PILOTO_CONFIGS,
  enPiloto,
  estaActivo,
  activar,
  desactivar,
  lanzarToggle,
  trabajoDe,
  adoptarArchivoSubido,
  corregirDireccionRetiro,
  guardiaOficinaRetiro,
  GUARDIA_MARCA_CIUDAD,
  GUARDIA_MARCA_LISTA,
  GUARDIA_MARCA_OFERTA,
  estado,
  contenidoArchivo,
  RUTA_DEFAULT,
};
