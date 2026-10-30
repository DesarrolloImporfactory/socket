const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const releaseDirectory = path.resolve(
  process.env.MOBILE_ANDROID_RELEASE_DIR ||
    path.join(__dirname, '../uploads/mobile/android'),
);
const manifestPath = path.join(releaseDirectory, 'latest.json');
const versionNamePattern = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

function readLatest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new AppError('El manifiesto de la app móvil no es válido.', 500);
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

exports.latest = catchAsync(async (req, res) => {
  const manifest = readLatest();
  if (!manifest) {
    return res.status(404).json({
      status: 'fail',
      code: 'MOBILE_RELEASE_NOT_PUBLISHED',
      message: 'Todavía no se publicó una versión de Imporchat para Android.',
    });
  }

  res.set('Cache-Control', 'no-store, max-age=0');
  return res.json(manifest);
});

exports.download = catchAsync(async (req, res, next) => {
  const versionCode = Number(req.params.versionCode);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
    return next(new AppError('Código de versión inválido.', 400));
  }

  const filePath = path.join(releaseDirectory, `chatcenter-${versionCode}.apk`);
  if (!fs.existsSync(filePath)) {
    return next(new AppError('No se encontró el APK solicitado.', 404));
  }

  res.set({
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Type': 'application/vnd.android.package-archive',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.download(filePath, `chatcenter-${versionCode}.apk`);
});

exports.publish = catchAsync(async (req, res, next) => {
  const temporaryPath = req.file?.path;
  try {
    if (!req.file) return next(new AppError('Selecciona un archivo APK.', 400));

    const versionCode = Number(req.body.version_code);
    const versionName = String(req.body.version_name || '').trim();
    const releaseNotes = String(req.body.release_notes || '').trim().slice(0, 2000);
    if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
      return next(new AppError('El código de versión debe ser un entero positivo.', 400));
    }
    if (!versionNamePattern.test(versionName)) {
      return next(new AppError('Usa una versión con formato 0.1.2.', 400));
    }

    const latest = readLatest();
    if (latest && versionCode <= Number(latest.version_code)) {
      return next(
        new AppError(
          `La versión debe superar el código publicado ${latest.version_code}.`,
          409,
        ),
      );
    }

    const handle = await fs.promises.open(temporaryPath, 'r');
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    await handle.close();
    if (
      bytesRead < 4 ||
      header[0] !== 0x50 ||
      header[1] !== 0x4b ||
      header[2] !== 0x03 ||
      header[3] !== 0x04
    ) {
      return next(new AppError('El archivo seleccionado no parece un APK válido.', 400));
    }

    await fs.promises.mkdir(releaseDirectory, { recursive: true });
    const fileName = `chatcenter-${versionCode}.apk`;
    const finalApkPath = path.join(releaseDirectory, fileName);
    const sha256 = await sha256File(temporaryPath);
    const publicBase = String(
      process.env.MOBILE_ANDROID_PUBLIC_URL ||
        'https://chatapi.imporchat.com/api/v1/mobile/android',
    ).replace(/\/+$/, '');
    const manifest = {
      version_code: versionCode,
      version_name: versionName,
      apk_url: `${publicBase}/download/${versionCode}`,
      sha256,
      release_notes: releaseNotes,
    };

    await fs.promises.rename(temporaryPath, finalApkPath);
    const temporaryManifest = path.join(
      releaseDirectory,
      `.latest-${crypto.randomUUID()}.json`,
    );
    await fs.promises.writeFile(
      temporaryManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await fs.promises.rename(temporaryManifest, manifestPath);

    return res.status(201).json({
      status: 'success',
      message: `Imporchat ${versionName} quedó publicada.`,
      data: manifest,
    });
  } finally {
    if (temporaryPath) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
});
