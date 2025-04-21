const { db } = require('../database/config');

class EtiquetaService {
    static async guardar(etiqueta) {
        const [result] = await db.query(
            `INSERT INTO etiquetas_chat_center (nombre_etiqueta, color_etiqueta, id_plataforma) VALUES (?, ?, ?)`,
            {
                replacements: [
                    etiqueta.nombre_etiqueta,
                    etiqueta.color_etiqueta,
                    etiqueta.id_plataforma,
                ],
                type: db.QueryTypes.INSERT,
            }
        );

        return result;
    }
}

module.exports = EtiquetaService;
