'use strict';

/* Horario de atención de una sede.

   Antes era texto libre y el bot tenía que interpretarlo: "Lunes a viernes
   09:00-19:00 · Sábados 09:00-14:00" y aun así ofrecía domingo, o proponía las
   18:00 de un sábado que cierra a las 14:00. Interpretar el horario del negocio
   no puede depender del modelo.

   Ahora se guarda estructurado y el texto pasa a ser un resumen generado, para
   que todo lo que ya lo leía (la ficha de la sede, el listado, los avisos) siga
   funcionando sin cambios.

   Forma del JSON:
     { abierto_24h: false,
       dias: { "1": [{ desde: "09:00", hasta: "19:00" }], ... } }
   La clave del día es la del getDay() de JS: 0 domingo … 6 sábado. Un día sin
   franjas —o ausente— está cerrado. */

const DIAS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

const aMinutos = (hhmm) => {
  const m = String(hhmm || '').match(RE_HORA);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/* Deja el horario en su forma canónica y descarta lo que no se entienda: una
   franja rota guardada tal cual volvería a dejar al bot adivinando. */
function normalizarHorario(entrada) {
  if (!entrada) return null;

  let obj = entrada;
  if (typeof entrada === 'string') {
    try {
      obj = JSON.parse(entrada);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  if (obj.abierto_24h) return { abierto_24h: true, dias: {} };

  const dias = {};
  for (let d = 0; d <= 6; d += 1) {
    const franjas = Array.isArray(obj?.dias?.[d])
      ? obj.dias[d]
      : Array.isArray(obj?.dias?.[String(d)])
        ? obj.dias[String(d)]
        : [];

    const limpias = franjas
      .map((f) => ({
        desde: String(f?.desde || '').trim(),
        hasta: String(f?.hasta || '').trim(),
      }))
      .filter((f) => {
        const a = aMinutos(f.desde);
        const b = aMinutos(f.hasta);
        return a !== null && b !== null && b > a;
      })
      .sort((a, b) => aMinutos(a.desde) - aMinutos(b.desde));

    if (limpias.length) dias[d] = limpias;
  }

  if (!Object.keys(dias).length) return null;
  return { abierto_24h: false, dias };
}

/* Resumen legible, agrupando días seguidos con el mismo horario: siete líneas
   iguales no las lee nadie, y es el texto que ve el cliente final. */
function resumenHorario(horario) {
  const h = normalizarHorario(horario);
  if (!h) return null;
  if (h.abierto_24h) return 'Abierto 24 horas, todos los días';

  const clave = (d) =>
    (h.dias[d] || []).map((f) => `${f.desde}-${f.hasta}`).join(' y ');

  // Se empieza en lunes: "lunes a viernes" se lee mejor que "domingo, lunes…"
  const orden = [1, 2, 3, 4, 5, 6, 0];
  const grupos = [];

  for (const d of orden) {
    const k = clave(d);
    if (!k) continue;
    const ultimo = grupos[grupos.length - 1];
    const consecutivo =
      ultimo && orden.indexOf(d) === orden.indexOf(ultimo.fin) + 1;
    if (ultimo && ultimo.horas === k && consecutivo) {
      ultimo.fin = d;
    } else {
      grupos.push({ ini: d, fin: d, horas: k });
    }
  }

  if (!grupos.length) return null;

  return grupos
    .map((g) => {
      const dias =
        g.ini === g.fin
          ? DIAS[g.ini][0].toUpperCase() + DIAS[g.ini].slice(1)
          : `${DIAS[g.ini][0].toUpperCase() + DIAS[g.ini].slice(1)} a ${DIAS[g.fin]}`;
      return `${dias} ${g.horas}`;
    })
    .join(' · ');
}

/* Días en los que la sede abre. null = no se sabe (sin horario cargado), que no
   es lo mismo que "cerrado siempre": sin dato no se bloquea nada. */
function diasAbiertos(horario) {
  const h = normalizarHorario(horario);
  if (!h) return null;
  if (h.abierto_24h) return new Set([0, 1, 2, 3, 4, 5, 6]);
  return new Set(Object.keys(h.dias).map(Number));
}

/* Franjas de un día concreto, para poder decirle a la persona hasta qué hora
   atienden ESE día en vez de repetirle el horario entero. */
function franjasDelDia(horario, dia) {
  const h = normalizarHorario(horario);
  if (!h) return null;
  if (h.abierto_24h) return [{ desde: '00:00', hasta: '23:59' }];
  return h.dias[dia] || [];
}

function estaAbierto(horario, dia, hhmm) {
  const franjas = franjasDelDia(horario, dia);
  if (!franjas) return null; // sin horario cargado no se afirma nada
  const min = aMinutos(hhmm);
  if (min === null) return false;
  return franjas.some(
    (f) => min >= aMinutos(f.desde) && min < aMinutos(f.hasta),
  );
}

/* Lectura del texto libre viejo, para las sedes que todavía no migraron. Es
   conservadora a propósito: si no se entiende, devuelve null y nadie bloquea
   un día por una mala interpretación. */
function diasAbiertosDesdeTexto(texto) {
  const t = String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (!t.trim()) return null;
  if (/todos los dias|24\s*horas|24\s*\/?\s*7/.test(t)) {
    return new Set([0, 1, 2, 3, 4, 5, 6]);
  }

  const NOMBRES = [
    ['domingo', 0],
    ['lunes', 1],
    ['martes', 2],
    ['miercoles', 3],
    ['jueves', 4],
    ['viernes', 5],
    ['sabado', 6],
  ];

  const abiertos = new Set();

  for (const [n1, i1] of NOMBRES) {
    for (const [n2, i2] of NOMBRES) {
      if (new RegExp(`${n1}s?\\s*(?:a|-|hasta)\\s*${n2}s?`).test(t)) {
        let i = i1;
        for (let n = 0; n < 7; n += 1) {
          abiertos.add(i);
          if (i === i2) break;
          i = (i + 1) % 7;
        }
      }
    }
  }
  for (const [n, i] of NOMBRES) {
    if (new RegExp(`${n}s?\\b`).test(t)) abiertos.add(i);
  }

  return abiertos.size ? abiertos : null;
}

module.exports = {
  DIAS,
  normalizarHorario,
  resumenHorario,
  diasAbiertos,
  diasAbiertosDesdeTexto,
  franjasDelDia,
  estaAbierto,
};
