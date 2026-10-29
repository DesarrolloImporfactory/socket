/**
 * «¿Hasta cuándo tengo acceso?» / «no puedo entrar a la plataforma»
 * (auditoría 265 del 27-oct, grupo c: acceso y membresía).
 *
 * Lee la membresía de Imporsuit del WhatsApp que escribe con el mismo módulo
 * que la cabecera de /chat y el candado de proveedores (membresiaImporsuit:
 * plataformas.whatsapp → users; vale 1 año desde users.fecha_suscripcion; si
 * el número cuelga de varios usuarios, gana la suscripción más reciente).
 * Si el número no está ahí (el 27-oct: 57 de 60 alumnos de la 265), se
 * identifica al dueño igual que revisar_mi_imporchat (quienEs: su WhatsApp en
 * IMPORCHAT) y se lee la membresía por el correo de esa cuenta.
 * Solo del número que escribe: no se busca por un dato escrito, así nadie
 * consulta la membresía de otro. Si el número está en dos cuentas, no se dice
 * nada (pasa a una persona).
 *
 * No dice por qué no puede entrar: eso lo explica la ficha de acceso. Solo da
 * el dato que hace falta para saber si es la membresía (activa o vencida y
 * desde cuándo).
 */
const T = require('./textos');

const LIMITE_MS = 5000;

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** '2027-03-12' → '12-mar-2027'. */
function fecha(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])}-${MESES[Number(m[2]) - 1]}-${m[1]}` : '';
}

const conLimite = (promesa, ms) =>
  Promise.race([
    promesa,
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error(`membresiaAlumno: más de ${ms} ms`)), ms);
      if (t.unref) t.unref();
    }),
  ]);

const NOMBRE_PAQUETE = {
  importacion: 'importación',
  ecommerce: 'ecommerce',
  membresia_ecommerce: 'membresía ecommerce',
  productos: 'productos',
};

const llenar = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => (v[k] === undefined || v[k] === null ? '' : String(v[k])));

/* El correo de la cuenta IMPORCHAT del dueño de este WhatsApp, con la misma
   identificación que revisar_mi_imporchat. null = no tiene cuenta; 'ambiguo'
   = el número está en más de una. */
async function correoPorImporchat(telefono, o) {
  // eslint-disable-next-line global-require
  const { quienEs, consultarImporchat } = require('./diagnosticoCuenta');
  // Sin inyectar nada, quienEs usa sus consultas de siempre (con el cruce de Imporsuit).
  const r = await quienEs(telefono, { propia: o.propia, consultar: o.consultarImporchat, consultarImporsuit: o.consultarImporsuit });
  const consultar = o.consultarImporchat || consultarImporchat;
  if (r.fijo) return r.fijo.estado === 'ambiguo' ? 'ambiguo' : null;
  if (!r.quien?.idUsuario) return null;
  const [u] = await consultar('SELECT email_propietario AS email FROM usuarios_chat_center WHERE id_usuario = :id LIMIT 1', {
    id: r.quien.idUsuario,
  });
  return u?.email ? String(u.email) : null;
}

/**
 * @param {string} telefono
 * @param {object} [o] { resolver: (celulares[], {lanzar}) → Map(cola → membresía),
 *                       porCorreo: (correo, {lanzar}) → membresía|null,
 *                       correoDelDueno: (telefono) → correo|null|'ambiguo',
 *                       propia, consultarImporchat, consultarImporsuit, limite_ms }
 * @returns {Promise<object>} estado: activa | vencida | sin_fecha | sin_membresia | ambiguo | error
 */
async function membresiaDelAlumno(telefono, o = {}) {
  try {
    // eslint-disable-next-line global-require
    const mi = () => require('../membresiaImporsuit');
    const resolver = o.resolver || mi().resolverMembresias;
    const ms = o.limite_ms || LIMITE_MS;
    const mapa = await conLimite(resolver([telefono], { lanzar: true }), ms);
    const cola = String(telefono || '').replace(/\D/g, '').slice(-9);
    let m = mapa?.get?.(cola) || null;
    let por = m ? 'numero' : null;
    if (!m) {
      const correoDelDueno = o.correoDelDueno || ((t) => correoPorImporchat(t, o));
      const correo = await conLimite(correoDelDueno(telefono), ms);
      if (correo === 'ambiguo') return { estado: 'ambiguo', texto: T.MEMBRESIA.error };
      if (correo) {
        const porCorreo = o.porCorreo || mi().resolverMembresiaPorCorreo;
        m = await conLimite(porCorreo(correo, { lanzar: true }), ms);
        por = m ? 'imporchat' : null;
      }
    }
    if (!m) return { estado: 'sin_membresia', texto: T.MEMBRESIA.sin_membresia };
    const paquetes = Object.entries(m.paquetes || {})
      .filter(([, v]) => v)
      .map(([k]) => NOMBRE_PAQUETE[k] || k);
    const vars = {
      plan: m.plan_actual ? ` (plan ${String(m.plan_actual).trim()})` : '',
      desde: fecha(m.fecha_suscripcion),
      vence: fecha(m.vence_el),
      dias: m.dias_restantes,
      paquetes: paquetes.length ? ` Incluye: ${paquetes.join(', ')}.` : '',
    };
    if (!m.vence_el) return { estado: 'sin_fecha', texto: llenar(T.MEMBRESIA.sin_fecha, vars), membresia: m, por };
    if (m.vencida) return { estado: 'vencida', texto: llenar(T.MEMBRESIA.vencida, vars), membresia: m, por };
    return { estado: 'activa', texto: llenar(T.MEMBRESIA.activa, vars), membresia: m, por };
  } catch (err) {
    return { estado: 'error', texto: T.MEMBRESIA.error, motivo: String(err?.message || err) };
  }
}

function bloqueMembresia(r) {
  if (!r) return T.MEMBRESIA.error;
  return ['activa', 'vencida', 'sin_fecha'].includes(r.estado) ? `${r.texto}\n${T.MEMBRESIA.instruccion}` : r.texto;
}

module.exports = { membresiaDelAlumno, bloqueMembresia, fecha };
