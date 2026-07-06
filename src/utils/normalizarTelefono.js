const DEBUG_TEL = process.env.DEBUG_TELEFONO === '1';

function normalizarTelefono(raw) {
  const soloDigitos = String(raw ?? '').replace(/\D/g, '');
  const resultado = soloDigitos ? '+' + soloDigitos : '';

  if (DEBUG_TEL) {
    const stack = (new Error().stack || '').split('\n');
    const origen = (stack[2] || '').trim().replace(/^at\s+/, '');
    console.log(
      `[normalizarTelefono] "${raw}" -> "${resultado}" | desde: ${origen}`,
    );
  }

  return resultado;
}

module.exports = { normalizarTelefono };
