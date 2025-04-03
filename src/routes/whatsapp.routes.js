// whatsapp.routes.js
const express = require("express");
const axios = require("axios");
const { db } = require("../database/config");

const router = express.Router();

/**
 * POST /api/whatsapp/obtener_numeros
 *  - Recibe: id_plataforma
 *  - Retorna: los phone_numbers desde la Cloud API (según la config en DB).
 */
router.post("/obtener_numeros", async (req, res) => {
  try {
    const { id_plataforma } = req.body;

    const wabaConfig = await getConfigFromDB(id_plataforma); 
    if (!wabaConfig) {
      return res
        .status(404)
        .json({ error: "No se encontraron registros para la plataforma dada." });
    }

    const { WABA_ID, ACCESS_TOKEN } = wabaConfig;

    // Llamada a la WhatsApp Cloud API
    const url = `https://graph.facebook.com/v22.0/${WABA_ID}/phone_numbers?access_token=${ACCESS_TOKEN}`;
    const response = await axios.get(url);

    return res.json({
      success: true,
      data: response.data?.data || [],
    });
  } catch (error) {
    console.error("Error al obtener phone_numbers:", error);
    return res.status(500).json({
      success: false,
      error: error?.response?.data || error.message,
    });
  }
});

/**
 * Obtiene la config de la tabla 'configuraciones' según el id_plataforma.
 * 
 * La tabla debe tener columnas: id_plataforma, id_whatsapp, token.
 * Devuelve un objeto { WABA_ID, ACCESS_TOKEN } si encuentra registro.
 */
async function getConfigFromDB(id_plataforma) {
  try {
    // Realiza la consulta a MySQL
    const [rows] = await db.query(
      `SELECT id_whatsapp AS WABA_ID, token AS ACCESS_TOKEN
       FROM configuraciones
       WHERE id_plataforma = ${id_plataforma}`
    );
    // Si la consulta encontró datos, retornamos la primera fila
    if (rows.length > 0) {
      return rows[0]; 
    }
    return null;
  } catch (error) {
    console.error("Error en getConfigFromDB:", error);
    throw error;
  }
}

module.exports = router;
