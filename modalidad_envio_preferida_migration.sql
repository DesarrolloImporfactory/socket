-- Modalidad de entrega que el bot SUGIERE PRIMERO cuando el cliente aún no
-- eligió cómo recibir (solo aplica con el switch de retiro en agencia
-- Servientrega encendido). NULL = pregunta neutra "¿domicilio o agencia?".
-- Caso que lo motiva (2026-09-29): NOVASHOP EC (711) despacha casi todo por
-- oficina Servientrega y el bot insistía con la dirección de la casa.
ALTER TABLE configuraciones
  ADD COLUMN modalidad_envio_preferida ENUM('domicilio','agencia') NULL DEFAULT NULL
  AFTER retiro_agencia_activo;

UPDATE configuraciones SET modalidad_envio_preferida = 'agencia' WHERE id = 711;
