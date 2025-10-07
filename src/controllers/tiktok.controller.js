const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const TikTokService = require('../services/tiktok.service');

/**
 * GET /api/v1/tiktok/campaigns?id_configuracion=123
 * Obtiene las campañas de TikTok Ads para una cuenta conectada
 */
exports.getCampaigns = catchAsync(async (req, res, next) => {
  const { id_configuracion, limit = 10, page = 1 } = req.query;

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  const campaigns = await TikTokService.getCampaigns({
    id_configuracion,
    limit: parseInt(limit),
    page: parseInt(page),
  });

  res.json({
    ok: true,
    campaigns: campaigns.data,
    pagination: campaigns.pagination,
  });
});

/**
 * GET /api/v1/tiktok/ad-groups?id_configuracion=123&campaign_id=456
 * Obtiene los grupos de anuncios para una campaña específica
 */
exports.getAdGroups = catchAsync(async (req, res, next) => {
  const { id_configuracion, campaign_id, limit = 10, page = 1 } = req.query;

  if (!id_configuracion || !campaign_id) {
    return next(
      new AppError('id_configuracion y campaign_id son requeridos', 400)
    );
  }

  const adGroups = await TikTokService.getAdGroups({
    id_configuracion,
    campaign_id,
    limit: parseInt(limit),
    page: parseInt(page),
  });

  res.json({
    ok: true,
    ad_groups: adGroups.data,
    pagination: adGroups.pagination,
  });
});

/**
 * GET /api/v1/tiktok/ads?id_configuracion=123&ad_group_id=456
 * Obtiene los anuncios para un grupo de anuncios específico
 */
exports.getAds = catchAsync(async (req, res, next) => {
  const { id_configuracion, ad_group_id, limit = 10, page = 1 } = req.query;

  if (!id_configuracion || !ad_group_id) {
    return next(
      new AppError('id_configuracion y ad_group_id son requeridos', 400)
    );
  }

  const ads = await TikTokService.getAds({
    id_configuracion,
    ad_group_id,
    limit: parseInt(limit),
    page: parseInt(page),
  });

  res.json({
    ok: true,
    ads: ads.data,
    pagination: ads.pagination,
  });
});

/**
 * GET /api/v1/tiktok/reports?id_configuracion=123&level=campaign&ids=123,456
 * Obtiene reportes de rendimiento para campañas, grupos de anuncios o anuncios
 */
exports.getReports = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    level,
    ids,
    start_date,
    end_date,
    metrics = 'impressions,clicks,conversions,cost,cpm,cpc,ctr,conversion_rate',
  } = req.query;

  if (!id_configuracion || !level || !ids) {
    return next(
      new AppError('id_configuracion, level e ids son requeridos', 400)
    );
  }

  const validLevels = ['campaign', 'adgroup', 'ad'];
  if (!validLevels.includes(level)) {
    return next(
      new AppError(`level debe ser uno de: ${validLevels.join(', ')}`, 400)
    );
  }

  const reports = await TikTokService.getReports({
    id_configuracion,
    level,
    ids: ids.split(','),
    start_date,
    end_date,
    metrics: metrics.split(','),
  });

  res.json({
    ok: true,
    reports: reports.data,
    summary: reports.summary,
  });
});

/**
 * GET /api/v1/tiktok/audiences?id_configuracion=123
 * Obtiene las audiencias personalizadas de TikTok
 */
exports.getAudiences = catchAsync(async (req, res, next) => {
  const { id_configuracion, limit = 10, page = 1 } = req.query;

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  const audiences = await TikTokService.getAudiences({
    id_configuracion,
    limit: parseInt(limit),
    page: parseInt(page),
  });

  res.json({
    ok: true,
    audiences: audiences.data,
    pagination: audiences.pagination,
  });
});

/**
 * POST /api/v1/tiktok/audiences
 * Crea una nueva audiencia personalizada
 */
exports.createAudience = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    audience_name,
    audience_type,
    file_paths,
    retention_days = 180,
  } = req.body;

  if (!id_configuracion || !audience_name || !audience_type) {
    return next(
      new AppError(
        'id_configuracion, audience_name y audience_type son requeridos',
        400
      )
    );
  }

  const audience = await TikTokService.createAudience({
    id_configuracion,
    audience_name,
    audience_type,
    file_paths,
    retention_days,
  });

  res.json({
    ok: true,
    audience,
    message: 'Audiencia creada exitosamente',
  });
});

/**
 * GET /api/v1/tiktok/connection-status?id_configuracion=123
 * Verifica el estado de la conexión de TikTok para una configuración
 */
exports.getConnectionStatus = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.query;

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  const status = await TikTokService.getConnectionStatus(id_configuracion);

  res.json({
    ok: true,
    status,
  });
});

/**
 * POST /api/v1/tiktok/sync-data
 * Sincroniza datos de TikTok (campañas, anuncios, métricas) para una configuración
 */
exports.syncData = catchAsync(async (req, res, next) => {
  const { id_configuracion, sync_type = 'all' } = req.body;

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  const validSyncTypes = ['all', 'campaigns', 'ads', 'metrics'];
  if (!validSyncTypes.includes(sync_type)) {
    return next(
      new AppError(
        `sync_type debe ser uno de: ${validSyncTypes.join(', ')}`,
        400
      )
    );
  }

  const syncResult = await TikTokService.syncData({
    id_configuracion,
    sync_type,
  });

  res.json({
    ok: true,
    sync_result: syncResult,
    message: 'Sincronización iniciada exitosamente',
  });
});
