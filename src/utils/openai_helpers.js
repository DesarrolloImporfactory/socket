const obtenerTrackingGuia = (transportadora, numeroGuia) => {
  let urlTracking = 'No tiene tracking';

  switch (transportadora.toUpperCase()) {
    case 'LAAR':
      urlTracking = `https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=${numeroGuia}`;
      break;
    case 'SERVIENTREGA':
      urlTracking = `https://www.servientrega.com.ec/Tracking/?guia=${numeroGuia}&tipo=GUIA`;
      break;
    case 'GINTRACOM':
      urlTracking = `https://ec.gintracom.site/web/site/tracking?guia=${numeroGuia}`;
      break;
  }

  return urlTracking;
};

const obtenerUrlDescargaGuia = (transportadora, numeroGuia) => {
  let urlDescarga = 'No tiene link de descarga';

  switch (transportadora.toUpperCase()) {
    case 'LAAR':
      urlDescarga = `https://api.laarcourier.com:9727/guias/pdfs/DescargarV2?guia=${numeroGuia}`;
      break;
    case 'SERVIENTREGA':
      urlDescarga = `https://guias.imporsuitpro.com/Servientrega/guia/${numeroGuia}`;
      break;
    case 'GINTRACOM':
      urlDescarga = `https://guias.imporsuitpro.com/Gintracom/label/${numeroGuia}`;
      break;
    case 'SPEED':
      urlDescarga = `https://guias.imporsuitpro.com/Speed/descargar/${numeroGuia}`;
      break;
  }

  return urlDescarga;
};

const obtenerEstadoGuia = (transportadora, estado) => {
  let estadoAsignado = 'Estado sin asignar';

  switch (transportadora.toUpperCase()) {
    case 'LAAR':
      if (estado === 1) estadoAsignado = 'Generado';
      else if (estado === 2) estadoAsignado = 'Recolectado';
      else if (estado === 4) estadoAsignado = 'En bodega';
      else if ([5, 11, 12].includes(estado)) estadoAsignado = 'En tránsito';
      else if (estado === 6) estadoAsignado = 'Zona entrega';
      else if (estado === 7) estadoAsignado = 'Entregado';
      else if (estado === 8) estadoAsignado = 'Anulado';
      else if (estado === 9) estadoAsignado = 'Devuelto';
      else if (estado === 14) estadoAsignado = 'Novedad';
      break;

    case 'SERVIENTREGA':
      if (estado === 101) estadoAsignado = 'Anulado';
      else if ([100, 102, 103].includes(estado)) estadoAsignado = 'Generado';
      else if ([200, 201, 202].includes(estado)) estadoAsignado = 'Recolectado';
      else if (estado >= 300 && estado <= 317 && estado !== 307) estadoAsignado = 'En tránsito';
      else if (estado === 307) estadoAsignado = 'Zona entrega';
      else if (estado >= 400 && estado <= 403) estadoAsignado = 'Entregado';
      else if (estado >= 318 && estado <= 351) estadoAsignado = 'Novedad';
      else if (estado >= 500 && estado <= 502) estadoAsignado = 'Devuelto';
      break;

    case 'GINTRACOM':
      if (estado === 1) estadoAsignado = 'Generado';
      else if ([2, 3].includes(estado)) estadoAsignado = 'Recolectado';
      else if (estado === 4) estadoAsignado = 'En tránsito';
      else if (estado === 5) estadoAsignado = 'Zona entrega';
      else if (estado === 6) estadoAsignado = 'Novedad';
      else if (estado === 7) estadoAsignado = 'Entregado';
      else if ([8, 9, 13].includes(estado)) estadoAsignado = 'Devolución';
      else if (estado === 10) estadoAsignado = 'Cancelada';
      else if (estado === 12) estadoAsignado = 'Anulada';
      break;

    case 'SPEED':
      if (estado === 2) estadoAsignado = 'Generado';
      else if (estado === 3) estadoAsignado = 'En tránsito';
      else if (estado === 7) estadoAsignado = 'Entregado';
      else if (estado === 9) estadoAsignado = 'Devuelto';
      else if (estado === 14) estadoAsignado = 'Novedad';
      break;
  }

  return estadoAsignado;
};


module.exports = {
  obtenerTrackingGuia,
  obtenerUrlDescargaGuia,
  obtenerEstadoGuia,
};

