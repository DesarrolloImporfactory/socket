const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Envía código de recuperación de contraseña
 * @param {string} to       — correo destino
 * @param {string} codigo   — código de 6 dígitos
 * @param {string} nombre   — nombre del usuario
 */
const enviarCodigoRecuperacion = async (to, codigo, nombre = 'Usuario') => {
  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME || 'Imporfactory'}" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject: 'Código de recuperación de contraseña',
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0;">
        <div style="background: linear-gradient(135deg, #0B1426, #1e293b); padding: 32px 24px; text-align: center;">
          <h1 style="color: #ffffff; font-size: 20px; margin: 0; font-weight: 700;">Recuperar contraseña</h1>
          <p style="color: #94a3b8; font-size: 13px; margin: 8px 0 0;">Imporfactory</p>
        </div>
        <div style="padding: 32px 24px;">
          <p style="color: #334155; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
            Hola <strong>${nombre}</strong>, recibimos una solicitud para restablecer tu contraseña.
            Usa el siguiente código:
          </p>
          <div style="background: #f8fafc; border: 2px dashed #00BFFF; border-radius: 12px; padding: 20px; text-align: center; margin: 0 0 20px;">
            <span style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #0B1426;">${codigo}</span>
          </div>
          <p style="color: #64748b; font-size: 12px; line-height: 1.5; margin: 0 0 8px;">
            ⏱ Este código expira en <strong>15 minutos</strong>.
          </p>
          <p style="color: #64748b; font-size: 12px; line-height: 1.5; margin: 0;">
            Si no solicitaste este cambio, ignora este correo. Tu contraseña no será modificada.
          </p>
        </div>
        <div style="background: #f8fafc; padding: 16px 24px; text-align: center; border-top: 1px solid #e2e8f0;">
          <p style="color: #94a3b8; font-size: 10px; margin: 0;">
            © ${new Date().getFullYear()} Imporfactory · Este es un correo automático, no respondas.
          </p>
        </div>
      </div>
    `,
  };

  return transporter.sendMail(mailOptions);
};

module.exports = { transporter, enviarCodigoRecuperacion };
