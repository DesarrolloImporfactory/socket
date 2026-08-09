const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const ctrl = require('../controllers/encuestas_publico.controller');

/**
 * El link público (sin ?cid=) crea contactos en clientes_chat_center a partir
 * de un teléfono que teclea cualquiera. El limiter global de /api/v1 es de
 * 100.000/h, así que no protege nada.
 *
 * OJO con la llave: no se puede limitar por IP. La app no tiene
 * `app.set('trust proxy')`, así que detrás del proxy TODOS los clientes
 * comparten la misma `req.ip` y un límite por IP dejaría fuera a los que
 * responden legítimamente. Se limita por encuesta+teléfono, que es justo lo
 * que hay que proteger: que un mismo número no reviente la tabla a envíos.
 * Los envíos con `cid` (link personal desde el chat o una plantilla) se saltan
 * el limiter porque ya vienen identificados.
 */
const responderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => Boolean(req.body?.cid),
  keyGenerator: (req) => {
    const tel = String(req.body?.telefono || '').replace(/\D/g, '');
    const cc = String(req.body?.codigo_pais || '').replace(/\D/g, '');
    const encuesta = req.params.idEncuesta || '0';
    return tel ? `enc:${encuesta}:${cc}${tel}` : `enc:${encuesta}:ip:${req.ip}`;
  },
  message: {
    ok: false,
    error: 'Ya registramos varias respuestas con este número, intenta más tarde',
  },
});

// SIN protect — son endpoints públicos para el cliente final
router.get('/publica/:idEncuesta', ctrl.obtenerEncuestaPublica);
router.post(
  '/publica/:idEncuesta/responder',
  responderLimiter,
  ctrl.responderEncuestaPublica,
);

module.exports = router;
