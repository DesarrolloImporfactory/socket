const express = require('express');
const router = express.Router();
const { validarDisponibilidad } = require('../services/validacion.service');

// POST /api/v1/pedidos/validar_productos_guia
router.post('/validar_productos_guia', async (req, res) => {
  try {
    let { lista, id_plataforma } = req.body || {};
    // Si usas JWT/sesión, prioriza el valor del token:
    // id_plataforma = req.user?.id_plataforma ?? id_plataforma ?? req.headers['x-plataforma-id'];

    id_plataforma = Number(id_plataforma || 0);

    if (!Array.isArray(lista)) {
      return res.status(422).json({
        status: 422,
        message: 'Formato inválido: lista debe ser un arreglo.',
      });
    }
    if (!id_plataforma) {
      return res
        .status(422)
        .json({ status: 422, message: 'Falta id_plataforma.' });
    }

    const r = await validarDisponibilidad({ lista, id_plataforma });
    if (r.status !== 200) {
      // Mantén 400 para que el front muestre los motivos como en PHP
      return res.status(400).json(r);
    }
    return res.json({ status: 200 });
  } catch (err) {
    console.error('Error en validar_productos_guia:', err);
    return res
      .status(500)
      .json({ status: 500, message: 'Error de servidor en la validación' });
  }
});

module.exports = router;
