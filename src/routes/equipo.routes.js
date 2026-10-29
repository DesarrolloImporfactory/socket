const express = require('express');
const router = express.Router();

const { teamToken } = require('../middlewares/teamToken.middleware');
const { protect } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/equipo.controller');
const multer = require('multer');

// Nota de voz de Team: en memoria (se convierte y se sube al almacén), una
// sola y de hasta 8 MB (5 minutos de webm/mp4 pesan bastante menos).
const MAX_AUDIO = 8 * 1024 * 1024;
const notaDeVoz = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO, files: 1 } }).single('audio');
const recibirAudio = (req, res, next) =>
  notaDeVoz(req, res, (err) => {
    if (!err) return next();
    const grande = err.code === 'LIMIT_FILE_SIZE';
    res.status(grande ? 413 : 400).json({
      status: 'fail',
      message: grande ? 'La nota de voz es muy larga (máximo 5 minutos).' : 'No se pudo recibir la nota de voz.',
    });
  });

// Foto de Team: Team ya la achica a JPG; el tope es el de WhatsApp (5 MB).
const MAX_IMAGEN = 5 * 1024 * 1024;
const foto = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGEN, files: 1 } }).single('imagen');
const recibirImagen = (req, res, next) =>
  foto(req, res, (err) => {
    if (!err) return next();
    const grande = err.code === 'LIMIT_FILE_SIZE';
    res.status(grande ? 413 : 400).json({
      status: 'fail',
      message: grande ? 'La foto pesa más de 5 MB. Elige una más liviana.' : 'No se pudo recibir la foto.',
    });
  });

/* Rutas de Team para el rol «equipo» (utils/rolEquipo.js). Un usuario «equipo»
   solo puede llamar rutas de aquí: protect le niega el resto. */

// Servidor de Team → sesión de un usuario «equipo».
router.post('/sesion', teamToken, ctrl.sesion);

// Desde aquí, solo con la sesión de Team (protect ya la validó, la limitó a
// estas rutas y tapa los teléfonos). Con un token de login, ni el rol
// «equipo» ni nadie: los demás tienen sus pantallas de siempre.
router.use(protect, (req, res, next) =>
  req.sesionTeam === true
    ? next()
    : res.status(403).json({ status: 'fail', code: 'SOLO_EQUIPO', message: 'Esta sección es solo para el equipo de Team' }),
);
router.get('/yo', ctrl.yo);
router.get('/conexiones', ctrl.conexiones);
router.get('/chats', ctrl.chats);
router.get('/bandeja', ctrl.bandeja);
router.post('/chats/:id_cliente/bot', ctrl.cambiarBot);
router.get('/asesores', ctrl.asesores);
router.post('/chats/:id_cliente/transferir', ctrl.transferir);
router.post('/chats/:id_cliente/cerrar', ctrl.cerrar);
router.get('/chats/:id_cliente/mensajes', ctrl.mensajes);
router.post('/chats/:id_cliente/mensajes', ctrl.enviarMensaje);
router.post('/chats/:id_cliente/audio', recibirAudio, ctrl.enviarAudio);
router.post('/chats/:id_cliente/imagen', recibirImagen, ctrl.enviarImagen);
router.get('/chats/:id_cliente/carga', ctrl.carga);
router.get('/chats/:id_cliente/historial-cargas', ctrl.historialCargas);
router.post('/chats/:id_cliente/enviar-informacion', ctrl.enviarInformacion);
router.get('/agenda', ctrl.agenda);

module.exports = router;
