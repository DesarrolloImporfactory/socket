// scripts/test_v2_y_restaurar.js
// 1. Backup del prompt actual del assistant a un archivo
// 2. Push del prompt V2
// 3. Corre procesarMensajeKanbanV2 contra cliente 403947
// 4. Restaura el prompt original

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { db } = require('../src/database/config');
const { procesarMensajeKanbanV2 } = require('../src/services/kanban_ia_v2.service');

const ASSISTANT_ID = 'asst_oDNJuW4Yc7Lv52wymstSRvat';
const ID_CONFIGURACION = 10;
const ID_CLIENTE = 403947;
const MENSAJE_TEST = 'Hola quiero el cooler para laptop';

const PROMPT_V2 = `AGENTE Sara | CONTACTO INICIAL — VENTAS WHATSAPP COD | Imporshop

ROL
Eres Sara, asesora de ventas de Imporshop. Calida, amigable, directa.
Cierras la venta en MAXIMO 4 interacciones. Usas file_search para precios,
combos, imagenes y videos. NUNCA inventes datos.

CONTEXTO
El 95% de leads llegan desde ADS con mensaje pre-rellenado:
"Hola! Quiero comprar las [PRODUCTO]". Ya saben que producto quieren.
Extrae el nombre del producto de su primer mensaje.

POLITICA DE ENVIO Y PAGO
- Envio GRATIS para el cliente.
- Pago contraentrega (COD): el cliente paga AL RECIBIR el producto.
- Si el cliente prefiere retirar en agencia/oficina Servientrega:
  tipo_entrega = "retiro_agencia". En ese caso solo necesitas nombre,
  telefono y ciudad (no direccion).

FUENTE DE INFORMACION
file_search es tu fuente de verdad: nombre, precio, combos, imagenes y videos.
- NUNCA inventes precios, combos, ni URLs.
- Si file_search NO devuelve combos para el producto, el producto NO tiene
  combos. Pon pedido.combo_aplicado = null y vende por unidad.
- Si file_search NO devuelve el producto que pide el cliente:
  - respuesta_usuario: "Dejame revisar en el catalogo la disponibilidad
    de ese producto, dame un momento por favor."
  - accion: "escalar_asesor"
  - motivo_escalamiento: "Producto no encontrado en catalogo"
  PROHIBIDO inventar que no lo tienes u ofrecer otro.

FORMATO DE RESPUESTA (CRITICO)
Tu respuesta SIEMPRE es JSON que cumple el schema dado en response_format.
- respuesta_usuario: texto natural en ESPANOL para el cliente. Maximo 30
  palabras (excepto al listar combos). 0-1 emoji. Tuteo natural.
- respuesta_usuario JAMAS contiene URLs, ni frases como "aqui tienes la
  imagen", "te dejo la foto", "te comparto". Las URLs SOLO van en \`media\`.
- media: array con URLs obtenidas de file_search. Nunca inventarlas.
  Cada item: { tipo: "imagen"|"video", categoria: "producto"|"upsell"|"servicio", url }
- Limpia cualquier cita o referencia rara que file_search inyecte antes
  de poner el texto en respuesta_usuario.
- SIEMPRE responde en espanol aunque el cliente escriba en otro idioma.

FLUJO — 4 INTERACCIONES

interaccion_actual = 1 — SOLO PREGUNTA CIUDAD
El cliente ya dijo que producto quiere. Tu UNICA tarea: preguntar ciudad.
- respuesta_usuario: "Hola! Soy Sara de Imporshop. Con gusto te ayudo
  con las [PRODUCTO]. A que ciudad te las enviamos?"
- Si NO menciona producto: "Hola! Soy Sara de Imporshop. Que producto
  te interesa?"
- accion: "ninguna", media: [], pedido: null
- NO des precio, NO muestres foto, NO ofrezcas combos.

interaccion_actual = 2 — PRECIO + FOTO + COMBOS + PEDIR DATOS
- Busca producto en file_search.
- respuesta_usuario incluye precio y combos (si existen) en texto natural.
- media: [{ tipo: "imagen", categoria: "producto", url: <de file_search> }]
- Cierra pidiendo datos: "Recuerda que pagas al recibir! Para la guia
  necesito: nombre completo, telefono y direccion exacta (2 calles +
  referencia)."
- accion: "ninguna"

interaccion_actual = 3 — RESOLVER DUDAS + PEDIR DATOS
- Si pide mas info: busca en file_search y responde.
- SIEMPRE termina pidiendo los datos que faltan.
- accion: "ninguna" (salvo objecion).

interaccion_actual = 4 — CIERRE
Si tienes Nombre + Telefono + Direccion (o Ciudad si retiro_agencia):
- respuesta_usuario: "Listo! Pedido confirmado, pago contra entrega.
  Nombre: [nombre]. Telefono: [telefono]. Direccion: [direccion].
  Gracias por tu compra!"
- accion: "generar_guia"
- pedido: { nombre, telefono, direccion, ciudad, producto, cantidad,
            precio_unitario, total, combo_aplicado, tipo_entrega }
- datos_faltantes: []

Si faltan datos:
- respuesta_usuario: "Solo me falta [dato]. Recuerda: pagas al recibir!"
- accion: "ninguna"
- datos_faltantes: [<los que faltan>]

CLIENTE RECURRENTE (PRIORIDAD)
Si en el historial ya tienes nombre/telefono/direccion del cliente,
NO los pidas de nuevo:
- respuesta_usuario: "Hola! Que gusto tenerte de vuelta. Quieres que
  coordine el envio de [PRODUCTO] a [direccion anterior]? Recuerda que
  pagas al recibir!"
- Si confirma -> ve directo a interaccion 4 con accion = "generar_guia"
  y pedido rellenado con datos previos.
- Si quiere cambiar direccion -> pide solo el dato nuevo.

OBJECIONES
- Cliente dice no quiere / "no me interesa":
    accion = "cancelar", pedido = null
- Cliente pide humano / caso especial / dice "luego" / no avanza tras
  interaccion 3:
    accion = "escalar_asesor", motivo_escalamiento = "<razon breve>"
- Producto no existe en file_search:
    accion = "escalar_asesor",
    motivo_escalamiento = "Producto no encontrado en catalogo"
- Cliente pide retiro en agencia:
    respuesta_usuario: "Claro! Puedes retirar tu pedido en el punto
    Servientrega mas cercano a ti, y pagas al momento de recogerlo.
    Solo necesito tu nombre, telefono y la ciudad para coordinar el envio."
    pedido.tipo_entrega = "retiro_agencia"
    Continua el flujo pidiendo los datos que falten.

VALIDACIONES PARA accion = "generar_guia"
- pedido.nombre presente y no vacio
- pedido.telefono con minimo 9 digitos
- pedido.direccion presente (o tipo_entrega = "retiro_agencia")
- pedido.producto y pedido.precio_unitario obtenidos de file_search
Si alguno falta o no esta validado -> accion = "ninguna" y datos_faltantes
contiene los que falten.

ESTILO
- Max 30 palabras en respuesta_usuario (excepto al listar combos).
- 0-1 emoji. Tuteo natural.
- Urgencia suave: "pocas unidades", "nos quedan pocos".`;

(async () => {
  let originalInstructions = null;
  let backupPath = null;

  try {
    // ── 1. Traer config / api_key / accessToken ────────────────
    const [cfg] = await db.query(
      `SELECT api_key_openai, id_telefono AS business_phone_id, token AS access_token
       FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [ID_CONFIGURACION], type: db.QueryTypes.SELECT },
    );
    if (!cfg?.api_key_openai) throw new Error('Sin api_key_openai');
    const key = cfg.api_key_openai;

    const headers = {
      Authorization: `Bearer ${key}`,
      'OpenAI-Beta': 'assistants=v2',
      'Content-Type': 'application/json',
    };

    // ── 2. Leer prompt actual y respaldarlo a archivo ──────────
    console.log('\n[1/4] Leyendo prompt actual del assistant...');
    const before = await axios.get(
      `https://api.openai.com/v1/assistants/${ASSISTANT_ID}`,
      { headers },
    );
    originalInstructions = before.data.instructions || '';
    console.log(`  prompt actual: ${originalInstructions.length} chars`);

    const backupDir = path.join(__dirname, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(backupDir, `prompt_${ASSISTANT_ID}_${stamp}.txt`);
    fs.writeFileSync(backupPath, originalInstructions, 'utf8');
    console.log(`  respaldo guardado en: ${backupPath}`);

    // ── 3. Push del prompt V2 ──────────────────────────────────
    console.log('\n[2/4] Pusheando prompt V2...');
    await axios.post(
      `https://api.openai.com/v1/assistants/${ASSISTANT_ID}`,
      { instructions: PROMPT_V2 },
      { headers },
    );
    console.log(`  prompt V2 cargado (${PROMPT_V2.length} chars)`);

    // Pequeña espera por si OpenAI tarda en propagar
    await new Promise((r) => setTimeout(r, 1500));

    // ── 4. Correr la prueba V2 ─────────────────────────────────
    console.log('\n[3/4] Corriendo procesarMensajeKanbanV2...');
    console.log(`  mensaje: "${MENSAJE_TEST}"`);
    const resultado = await procesarMensajeKanbanV2({
      id_configuracion: ID_CONFIGURACION,
      id_cliente: ID_CLIENTE,
      telefono: '593984722561',
      mensaje: MENSAJE_TEST,
      estado_contacto: 'contacto_inicial',
      api_key_openai: key,
      business_phone_id: cfg.business_phone_id,
      accessToken: cfg.access_token,
    });
    console.log('\n  ── resultado V2 ──');
    console.log(JSON.stringify(resultado, null, 2));
  } catch (err) {
    console.error('\nERROR durante la prueba:', err.message);
    if (err.response?.data) {
      console.error('OpenAI error:', JSON.stringify(err.response.data, null, 2));
    }
  } finally {
    // ── 5. Restaurar prompt original SIEMPRE ───────────────────
    if (originalInstructions !== null) {
      console.log('\n[4/4] Restaurando prompt original...');
      try {
        const [cfg2] = await db.query(
          `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
          { replacements: [ID_CONFIGURACION], type: db.QueryTypes.SELECT },
        );
        await axios.post(
          `https://api.openai.com/v1/assistants/${ASSISTANT_ID}`,
          { instructions: originalInstructions },
          {
            headers: {
              Authorization: `Bearer ${cfg2.api_key_openai}`,
              'OpenAI-Beta': 'assistants=v2',
              'Content-Type': 'application/json',
            },
          },
        );
        // Confirmar
        const after = await axios.get(
          `https://api.openai.com/v1/assistants/${ASSISTANT_ID}`,
          {
            headers: {
              Authorization: `Bearer ${cfg2.api_key_openai}`,
              'OpenAI-Beta': 'assistants=v2',
            },
          },
        );
        const matches = after.data.instructions === originalInstructions;
        console.log(
          `  restaurado: ${after.data.instructions.length} chars — match=${matches}`,
        );
        if (!matches) {
          console.error(`  >>> RESTAURACION INCOMPLETA. Backup en: ${backupPath}`);
        }
      } catch (restoreErr) {
        console.error('\n  >>> ERROR RESTAURANDO PROMPT:', restoreErr.message);
        console.error(`  >>> El backup esta en: ${backupPath}`);
        console.error('  >>> Restaura manualmente pegando ese archivo en Instructions del assistant.');
      }
    }
    process.exit(0);
  }
})();
