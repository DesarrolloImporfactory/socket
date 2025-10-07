const TikTokOAuthService = require('../services/tiktok_oauth.service');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

/**
 * Middleware para validar y refrescar automáticamente tokens de TikTok
 */
exports.validateTikTokConnection = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.query || req.body;

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  try {
    // Obtener la conexión
    const connection = await TikTokOAuthService.getConnectionByConfigId(
      id_configuracion
    );

    if (!connection) {
      return next(
        new AppError(
          'No se encontró una conexión de TikTok para esta configuración. Por favor, conecte su cuenta primero.',
          404
        )
      );
    }

    // Verificar si el token ha expirado
    const now = new Date();
    const expiryDate = new Date(connection.expires_at);

    // Si el token expira en menos de 1 hora, intentar refrescarlo
    const oneHourBeforeExpiry = new Date(expiryDate.getTime() - 60 * 60 * 1000);

    if (now > oneHourBeforeExpiry) {
      try {
        console.log(
          `[TIKTOK_MIDDLEWARE] Token expira pronto para configuración ${id_configuracion}, refrescando...`
        );
        await TikTokOAuthService.refreshAccessToken(
          connection.oauth_session_id
        );
        console.log(
          `[TIKTOK_MIDDLEWARE] Token refrescado exitosamente para configuración ${id_configuracion}`
        );
      } catch (refreshError) {
        console.error(
          `[TIKTOK_MIDDLEWARE] Error al refrescar token para configuración ${id_configuracion}:`,
          refreshError
        );
        return next(
          new AppError(
            'Token de TikTok expirado y no se pudo refrescar. Por favor, reconecte su cuenta.',
            401
          )
        );
      }
    }

    // Agregar información de la conexión al request para uso posterior
    req.tiktokConnection = connection;

    next();
  } catch (error) {
    console.error(
      '[TIKTOK_MIDDLEWARE] Error en validateTikTokConnection:',
      error
    );
    return next(new AppError('Error al validar conexión de TikTok', 500));
  }
});

/**
 * Middleware para validar que los IDs de TikTok sean válidos
 */
exports.validateTikTokIds = (requiredFields = []) => {
  return (req, res, next) => {
    const data = { ...req.query, ...req.body };

    for (const field of requiredFields) {
      const value = data[field];

      if (!value) {
        return next(new AppError(`${field} es requerido`, 400));
      }

      // Validar formato de IDs de TikTok (generalmente son números largos o strings alfanuméricos)
      if (field.includes('id') && field !== 'id_configuracion') {
        if (typeof value === 'string' && value.includes(',')) {
          // Validar lista de IDs separados por coma
          const ids = value.split(',').map((id) => id.trim());
          for (const id of ids) {
            if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
              return next(
                new AppError(`${field} contiene un ID inválido: ${id}`, 400)
              );
            }
          }
        } else {
          // Validar ID único
          if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
            return next(
              new AppError(`${field} tiene un formato inválido`, 400)
            );
          }
        }
      }
    }

    next();
  };
};

/**
 * Middleware para validar fechas en reportes
 */
exports.validateDateRange = catchAsync(async (req, res, next) => {
  const { start_date, end_date } = req.query;

  if (start_date && end_date) {
    const startDate = new Date(start_date);
    const endDate = new Date(end_date);
    const now = new Date();

    // Validar formato de fecha
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return next(
        new AppError('Formato de fecha inválido. Use YYYY-MM-DD', 400)
      );
    }

    // Validar que start_date sea anterior a end_date
    if (startDate >= endDate) {
      return next(new AppError('start_date debe ser anterior a end_date', 400));
    }

    // Validar que las fechas no sean futuras
    if (startDate > now || endDate > now) {
      return next(new AppError('Las fechas no pueden ser futuras', 400));
    }

    // Validar rango máximo (ej. 365 días)
    const maxDays = 365;
    const diffTime = Math.abs(endDate - startDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays > maxDays) {
      return next(
        new AppError(
          `El rango de fechas no puede ser mayor a ${maxDays} días`,
          400
        )
      );
    }
  }

  next();
});

/**
 * Middleware para validar parámetros de paginación
 */
exports.validatePagination = (req, res, next) => {
  let { limit, page } = req.query;

  // Convertir a números y establecer valores por defecto
  limit = parseInt(limit) || 10;
  page = parseInt(page) || 1;

  // Validar límites
  if (limit < 1 || limit > 1000) {
    return next(new AppError('limit debe estar entre 1 y 1000', 400));
  }

  if (page < 1) {
    return next(new AppError('page debe ser mayor a 0', 400));
  }

  // Actualizar los valores en req.query para uso posterior
  req.query.limit = limit;
  req.query.page = page;

  next();
};

/**
 * Middleware para logging de peticiones a TikTok API
 */
exports.logTikTokRequest = (req, res, next) => {
  const { id_configuracion } = req.query || req.body;
  const endpoint = req.originalUrl;
  const method = req.method;
  const timestamp = new Date().toISOString();

  console.log(
    `[TIKTOK_API_LOG] ${timestamp} - ${method} ${endpoint} - Config: ${id_configuracion}`
  );

  // Log del body para requests POST/PUT/PATCH (sin información sensible)
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const bodyLog = { ...req.body };
    // Remover información sensible si existe
    delete bodyLog.access_token;
    delete bodyLog.refresh_token;
    console.log(`[TIKTOK_API_LOG] Body:`, JSON.stringify(bodyLog));
  }

  next();
};
