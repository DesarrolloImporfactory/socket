# TikTok Business API Integration

## Descripción

Esta implementación proporciona integración completa con TikTok Business API (Login Kit), permitiendo autenticación OAuth2, gestión de campañas publicitarias, y análisis de rendimiento.

## Características Principales

- ✅ OAuth2 con TikTok Business (Login Kit)
- ✅ Soporte para múltiples plataformas (Web, Desktop, Android, iOS)
- ✅ Gestión de tokens con renovación automática
- ✅ API completa para campañas, grupos de anuncios, y anuncios
- ✅ Reportes de rendimiento y métricas
- ✅ Gestión de audiencias personalizadas
- ✅ Middlewares de validación y logging
- ✅ Manejo de errores robusto

## Configuración Inicial

### 1. Variables de Entorno

Agregar al archivo `.env`:

```env
# TikTok Business API Configuration
TIKTOK_APP_ID=tu_app_id_aqui
TIKTOK_APP_SECRET=tu_app_secret_aqui
TIKTOK_REDIRECT_URI=https://tu-dominio.com/tiktok/callback
TIKTOK_REDIRECT_URI_DEV=http://localhost:3000/tiktok/callback
```

### 2. Configuración en TikTok Developer

1. Crear una aplicación en [TikTok for Developers](https://developers.tiktok.com/)
2. Configurar las URLs de redirección para cada plataforma:
   - **Web**: `https://tu-dominio.com/tiktok/callback`
   - **Desktop**: `http://localhost:PORT/tiktok/callback`
   - **Android**: `tu-app://tiktok/callback`
   - **iOS**: `tu-app://tiktok/callback`
3. Solicitar los permisos necesarios:
   - `business_basic`: Información básica del negocio
   - `business_user_info`: Información del usuario
   - `ads_read`: Lectura de campañas y anuncios
   - `ads_write`: Escritura de campañas y anuncios

### 3. Migración de Base de Datos

Ejecutar las migraciones para crear las tablas necesarias:

```sql
-- Tabla para sesiones OAuth
CREATE TABLE tiktok_oauth_sessions (
    id_oauth_session INT PRIMARY KEY AUTO_INCREMENT,
    id_configuracion INT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    platform ENUM('web', 'desktop', 'android', 'ios') DEFAULT 'web',
    redirect_uri VARCHAR(500) NOT NULL,
    advertiser_ids TEXT,
    expires_at DATETIME NOT NULL,
    state ENUM('active', 'expired', 'revoked') DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_id_configuracion (id_configuracion),
    INDEX idx_expires_at (expires_at),
    INDEX idx_state (state)
);

-- Tabla para conexiones activas
CREATE TABLE tiktok_connections (
    id_connection INT PRIMARY KEY AUTO_INCREMENT,
    id_configuracion INT NOT NULL UNIQUE,
    oauth_session_id INT NOT NULL,
    business_account_id VARCHAR(100) NOT NULL,
    business_account_name VARCHAR(255),
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    platform ENUM('web', 'desktop', 'android', 'ios') DEFAULT 'web',
    status ENUM('active', 'inactive', 'error') DEFAULT 'active',
    last_sync DATETIME,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_id_configuracion (id_configuracion),
    INDEX idx_oauth_session_id (oauth_session_id),
    INDEX idx_business_account_id (business_account_id),
    INDEX idx_status (status),
    INDEX idx_expires_at (expires_at)
);
```

## Uso de la API

### Flujo de Autenticación OAuth

#### 1. Obtener URL de Login

```javascript
// GET /api/v1/tiktok/login-url
const response = await fetch(
  '/api/v1/tiktok/login-url?' +
    new URLSearchParams({
      id_configuracion: '123',
      redirect_uri: 'https://tu-app.com/tiktok/callback',
      platform: 'web', // web, desktop, android, ios
    })
);

const { url } = await response.json();
// Redirigir al usuario a esta URL
window.location.href = url;
```

#### 2. Intercambiar Código por Token

```javascript
// POST /api/v1/tiktok/oauth/exchange
const response = await fetch('/api/v1/tiktok/oauth/exchange', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    code: 'codigo_de_autorizacion',
    id_configuracion: '123',
    redirect_uri: 'https://tu-app.com/tiktok/callback',
    platform: 'web',
  }),
});

const { oauth_session_id, expires_at } = await response.json();
```

#### 3. Obtener Cuentas de Negocio

```javascript
// GET /api/v1/tiktok/business-accounts
const response = await fetch(
  '/api/v1/tiktok/business-accounts?' +
    new URLSearchParams({
      oauth_session_id: 'session_id',
    })
);

const { accounts } = await response.json();
```

#### 4. Conectar Cuenta de Negocio

```javascript
// POST /api/v1/tiktok/connect
const response = await fetch('/api/v1/tiktok/connect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    oauth_session_id: 'session_id',
    id_configuracion: '123',
    business_account_id: 'account_id',
  }),
});
```

### Gestión de Campañas

#### Obtener Campañas

```javascript
// GET /api/v1/tiktok/campaigns
const response = await fetch(
  '/api/v1/tiktok/campaigns?' +
    new URLSearchParams({
      id_configuracion: '123',
      limit: '20',
      page: '1',
    })
);

const { campaigns, pagination } = await response.json();
```

#### Obtener Grupos de Anuncios

```javascript
// GET /api/v1/tiktok/ad-groups
const response = await fetch(
  '/api/v1/tiktok/ad-groups?' +
    new URLSearchParams({
      id_configuracion: '123',
      campaign_id: 'campaign_id',
      limit: '20',
      page: '1',
    })
);

const { ad_groups, pagination } = await response.json();
```

#### Obtener Anuncios

```javascript
// GET /api/v1/tiktok/ads
const response = await fetch(
  '/api/v1/tiktok/ads?' +
    new URLSearchParams({
      id_configuracion: '123',
      ad_group_id: 'adgroup_id',
      limit: '20',
      page: '1',
    })
);

const { ads, pagination } = await response.json();
```

### Reportes y Métricas

#### Obtener Reportes de Rendimiento

```javascript
// GET /api/v1/tiktok/reports
const response = await fetch(
  '/api/v1/tiktok/reports?' +
    new URLSearchParams({
      id_configuracion: '123',
      level: 'campaign', // campaign, adgroup, ad
      ids: 'campaign_id_1,campaign_id_2',
      start_date: '2023-01-01',
      end_date: '2023-12-31',
      metrics: 'impressions,clicks,conversions,cost,cpm,cpc,ctr',
    })
);

const { reports, summary } = await response.json();
```

### Audiencias Personalizadas

#### Listar Audiencias

```javascript
// GET /api/v1/tiktok/audiences
const response = await fetch(
  '/api/v1/tiktok/audiences?' +
    new URLSearchParams({
      id_configuracion: '123',
      limit: '10',
      page: '1',
    })
);

const { audiences } = await response.json();
```

#### Crear Audiencia

```javascript
// POST /api/v1/tiktok/audiences
const response = await fetch('/api/v1/tiktok/audiences', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id_configuracion: '123',
    audience_name: 'Mi Audiencia Personalizada',
    audience_type: 'CUSTOMER_FILE',
    file_paths: ['path/to/customer/file.csv'],
    retention_days: 180,
  }),
});
```

### Utilidades

#### Verificar Estado de Conexión

```javascript
// GET /api/v1/tiktok/connection-status
const response = await fetch(
  '/api/v1/tiktok/connection-status?' +
    new URLSearchParams({
      id_configuracion: '123',
    })
);

const { connected, status, message } = await response.json();
```

#### Sincronizar Datos

```javascript
// POST /api/v1/tiktok/sync-data
const response = await fetch('/api/v1/tiktok/sync-data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id_configuracion: '123',
    sync_type: 'all', // all, campaigns, ads, metrics
  }),
});

const { sync_result } = await response.json();
```

#### Desconectar Cuenta

```javascript
// DELETE /api/v1/tiktok/disconnect
const response = await fetch(
  '/api/v1/tiktok/disconnect?' +
    new URLSearchParams({
      id_configuracion: '123',
    }),
  {
    method: 'DELETE',
  }
);
```

## Manejo de Errores

La API maneja varios tipos de errores:

- **400 Bad Request**: Parámetros faltantes o inválidos
- **401 Unauthorized**: Token expirado o inválido
- **404 Not Found**: Conexión no encontrada
- **500 Internal Server Error**: Errores del servidor

Ejemplo de respuesta de error:

```json
{
  "ok": false,
  "status": "error",
  "message": "Token expirado. Necesita reautenticación.",
  "statusCode": 401
}
```

## Middlewares Incluidos

1. **validateTikTokConnection**: Valida y refresca tokens automáticamente
2. **validateTikTokIds**: Valida formato de IDs de TikTok
3. **validateDateRange**: Valida rangos de fechas para reportes
4. **validatePagination**: Valida parámetros de paginación
5. **logTikTokRequest**: Logging de peticiones para debugging

## Notas Importantes

1. Los tokens de TikTok tienen una duración limitada y se refrescan automáticamente
2. La API maneja múltiples plataformas (Web, Desktop, Android, iOS)
3. Se recomienda implementar rate limiting en producción
4. Los datos se sincronizan automáticamente pero también se puede hacer manualmente
5. Todas las conexiones se almacenan de forma segura en la base de datos

## Webhooks de TikTok Business

### Configuración de Webhooks

Los webhooks permiten recibir notificaciones en tiempo real sobre eventos que ocurren en las cuentas de TikTok conectadas.

#### Variables de Entorno Adicionales

```env
# TikTok Webhooks Configuration
TIKTOK_WEBHOOK_VERIFY_TOKEN=tu_token_de_verificacion_secreto
TIKTOK_WEBHOOK_SECRET=tu_secreto_para_validar_firmas
TIKTOK_WEBHOOK_URL=https://tu-dominio.com/api/v1/tiktok/webhook/receive
```

#### Migración de Base de Datos para Webhooks

```sql
-- Tabla para eventos de webhook
CREATE TABLE tiktok_webhook_events (
    id INT PRIMARY KEY AUTO_INCREMENT,
    event_id VARCHAR(100),
    event_type ENUM('CAMPAIGN_STATUS_CHANGE', 'AD_GROUP_STATUS_CHANGE', 'AD_STATUS_CHANGE', 'BUDGET_EXHAUSTED', 'BID_TOO_LOW', 'CREATIVE_REJECTED', 'CONVERSION_EVENT', 'TEST_EVENT', 'UNKNOWN') NOT NULL,
    advertiser_id VARCHAR(100),
    campaign_id VARCHAR(100),
    ad_group_id VARCHAR(100),
    ad_id VARCHAR(100),
    event_data TEXT NOT NULL,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed BOOLEAN DEFAULT FALSE,
    processed_at DATETIME,
    error_message TEXT
);

-- Tabla para suscripciones de webhook
CREATE TABLE tiktok_webhook_subscriptions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    id_configuracion INT NOT NULL,
    subscription_id VARCHAR(100) UNIQUE NOT NULL,
    event_types TEXT NOT NULL,
    callback_url VARCHAR(500) NOT NULL,
    status ENUM('active', 'inactive', 'cancelled', 'failed') DEFAULT 'active',
    last_event_received DATETIME,
    events_received_count INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Tabla para notificaciones
CREATE TABLE tiktok_notifications (
    id INT PRIMARY KEY AUTO_INCREMENT,
    type ENUM('campaign_paused', 'ad_rejected', 'budget_exhausted', 'bid_too_low', 'creative_rejected', 'conversion_event', 'general') NOT NULL,
    message TEXT NOT NULL,
    event_data TEXT,
    read BOOLEAN DEFAULT FALSE,
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Uso de Webhooks

#### 1. Configurar URL de Webhook en TikTok Business Manager

La URL que debes configurar en el panel de TikTok Business Manager es:

```
https://tu-dominio.com/api/v1/tiktok/webhook/receive
```

#### 2. Suscribirse a Eventos

```javascript
// POST /api/v1/tiktok/webhook/subscribe
const response = await fetch('/api/v1/tiktok/webhook/subscribe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id_configuracion: '123',
    event_types: [
      'CAMPAIGN_STATUS_CHANGE',
      'AD_STATUS_CHANGE',
      'BUDGET_EXHAUSTED',
      'CREATIVE_REJECTED',
    ],
    callback_url: 'https://tu-dominio.com/api/v1/tiktok/webhook/receive',
  }),
});
```

#### 3. Listar Suscripciones Activas

```javascript
// GET /api/v1/tiktok/webhook/subscriptions
const response = await fetch(
  '/api/v1/tiktok/webhook/subscriptions?id_configuracion=123'
);
const { subscriptions } = await response.json();
```

#### 4. Ver Historial de Eventos

```javascript
// GET /api/v1/tiktok/webhook/events
const response = await fetch(
  '/api/v1/tiktok/webhook/events?' +
    new URLSearchParams({
      id_configuracion: '123',
      event_type: 'CAMPAIGN_STATUS_CHANGE', // Opcional
      limit: '20',
      page: '1',
    })
);

const { events } = await response.json();
```

#### 5. Probar Webhook

```javascript
// POST /api/v1/tiktok/webhook/test
const response = await fetch('/api/v1/tiktok/webhook/test', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id_configuracion: '123',
    callback_url: 'https://tu-dominio.com/api/v1/tiktok/webhook/receive',
  }),
});
```

#### 6. Cancelar Suscripción

```javascript
// DELETE /api/v1/tiktok/webhook/unsubscribe
const response = await fetch('/api/v1/tiktok/webhook/unsubscribe', {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id_configuracion: '123',
    subscription_id: 'subscription_id_here',
  }),
});
```

### Tipos de Eventos de Webhook

- **CAMPAIGN_STATUS_CHANGE**: Cambios de estado en campañas (pausada, activada, etc.)
- **AD_GROUP_STATUS_CHANGE**: Cambios de estado en grupos de anuncios
- **AD_STATUS_CHANGE**: Cambios de estado en anuncios individuales
- **BUDGET_EXHAUSTED**: Presupuesto agotado en campaña o grupo de anuncios
- **BID_TOO_LOW**: Puja muy baja que puede afectar el rendimiento
- **CREATIVE_REJECTED**: Rechazo de creativos por políticas de TikTok
- **CONVERSION_EVENT**: Eventos de conversión en tiempo real

### Estructura de un Evento de Webhook

```json
{
  "event_id": "evt_123456789",
  "data": [
    {
      "event_type": "CAMPAIGN_STATUS_CHANGE",
      "advertiser_id": "1234567890",
      "campaign_id": "987654321",
      "campaign_name": "Mi Campaña",
      "old_status": "ACTIVE",
      "new_status": "PAUSED",
      "timestamp": "2023-12-07T10:30:00Z",
      "reason": "Budget exhausted"
    }
  ]
}
```

### Seguridad de Webhooks

1. **Validación de Firma**: Los webhooks pueden incluir una firma HMAC para verificar autenticidad
2. **Rate Limiting**: Se aplica automáticamente para prevenir abuso
3. **Validación de Origen**: Verificación del User-Agent de TikTok
4. **Token de Verificación**: Token secreto para verificar la configuración inicial

### Ejemplo de Gestión

Para una interfaz completa de gestión de webhooks, consulta el archivo:
`examples/tiktok_webhook_management.html`

Este ejemplo incluye:

- Configuración de URLs de webhook
- Gestión de suscripciones
- Visualización de eventos en tiempo real
- Pruebas de conectividad
- Historial de eventos

## Soporte

Para más información sobre la API de TikTok Business, consultar:

- [TikTok Business API Documentation](https://business-api.tiktok.com/portal/docs)
- [TikTok for Developers](https://developers.tiktok.com/)
- [TikTok Webhooks Guide](https://business-api.tiktok.com/portal/docs?id=1740593127619585)
