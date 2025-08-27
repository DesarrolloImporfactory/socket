const { cancelRemarketing, cancelRemarketingByThread } = require('../services/remarketing.service');

exports.cancel = async (req, res) => {
  try {
    const { telefono, id_configuracion } = req.body;
    if (!telefono || !id_configuracion) {
      return res.status(400).json({ status: 400, error: 'telefono e id_configuracion son requeridos' });
    }

    await cancelRemarketing({ telefono, id_configuracion });
    return res.status(200).json({ status: 200, message: 'Remarketing cancelado' });
  } catch (e) {
    console.error('❌ cancel remarketing error:', e);
    return res.status(500).json({ status: 500, error: 'Error interno' });
  }
};

exports.cancelByThread = async (req, res) => {
  try {
    const { id_thread } = req.body;
    if (!id_thread) {
      return res.status(400).json({ status: 400, error: 'id_thread es requerido' });
    }

    await cancelRemarketingByThread({ id_thread });
    return res.status(200).json({ status: 200, message: 'Remarketing cancelado por thread' });
  } catch (e) {
    console.error('❌ cancel by thread error:', e);
    return res.status(500).json({ status: 500, error: 'Error interno' });
  }
};
