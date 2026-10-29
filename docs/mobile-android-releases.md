# Publicación de ChatCenter Mobile para Android

## API pública

- `GET /api/v1/mobile/android/latest` devuelve el manifiesto JSON de la versión
  más reciente. No requiere sesión y no se cachea.
- `GET /api/v1/mobile/android/download/:versionCode` entrega el APK publicado
  con ese código de versión. Los archivos se conservan para que las descargas
  ya iniciadas sigan funcionando.
- `POST /api/v1/mobile/android/publish` recibe `multipart/form-data` con `apk`,
  `version_name`, `version_code` y `release_notes`. Requiere una sesión de
  `super_administrador`; rechaza códigos de versión repetidos o menores.

El backend calcula SHA-256 del archivo, publica el APK y actualiza
`latest.json`. La app Android solo descarga desde HTTPS, comprueba el hash y
abre el instalador del sistema.

## Archivos persistentes

Por defecto se guardan en `src/uploads/mobile/android`, carpeta excluida de la
sincronización de despliegue del servidor. Se puede cambiar con
`MOBILE_ANDROID_RELEASE_DIR`. La URL pública de descarga usa
`MOBILE_ANDROID_PUBLIC_URL`, cuyo valor por defecto es
`https://chatapi.imporchat.com/api/v1/mobile/android`.

## Entrega

Compilar con `D:\chatcenter-mobile\tool\release_android.ps1`, conservar el
mismo keystore y subir el APK desde el menú **Administración → App Android** del
front. No se debe cambiar el `applicationId` ni reemplazar el keystore después
de la primera instalación de producción.
