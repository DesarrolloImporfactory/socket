class EtiquetasChatCenter {
    constructor(nombre, color, id_configuracion){
        if (!nombre || !color || !id_configuracion){
            throw new Error('Datos incompletos al crear la etiqueta');
        }

        this.nombre_etiqueta = nombre;
        this.color_etiqueta = color;
        this.id_configuracion = id_configuracion;
    }
}

module.exports = EtiquetasChatCenter;