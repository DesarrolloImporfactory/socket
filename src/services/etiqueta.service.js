const { db } = require('../database/config');
const EtiquetasChatCenter = require('../models/etiquetas_chat_center.model');

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

    static async eliminar(id_etiqueta){        
        const etiqueta = await EtiquetasChatCenter.findByPk(id_etiqueta);

        if (!etiqueta) {
            throw new Error('Etiqueta no encontrada');
        }
        
        await etiqueta.destroy();
        return true;
    }
}

module.exports = EtiquetaService;
