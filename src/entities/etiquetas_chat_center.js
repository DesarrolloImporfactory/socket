class EtiquetasChatCenter {
    constructor(nombre, color, plataformaId){
        if (!nombre || !color || !plataformaId){
            throw new Error('Datos incompletos al crear la etiqueta');
        }

        this.nombre_etiqueta = nombre;
        this.color_etiqueta = color;
        this.id_plataforma = plataformaId;
    }
}

module.exports = EtiquetasChatCenter;