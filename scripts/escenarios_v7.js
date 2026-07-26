/* Escenarios para el flujo por pasos (v7):
   2=info+cantidad · 3=variedad (si aplica) · 4=envio · 5=datos · 6=cierre */
module.exports = ({ RE_TAG, RE_RESUMEN, tiene }) => [
  {
    nombre: 'variable_flujo_por_pasos',
    mensajes: [
      'quiero el cubre canas',
      'Quito',
      'quiero 2',
      'en negro',
      'a domicilio',
      'Michael Ordonez, 0991234567, calle Veintimilla y Alfredo Borja frente al Tuti',
    ],
    checks: (turnos) => {
      const e = [];
      const [t1, t2, t3, t4, t5, t6] = turnos;
      for (const [i, t] of turnos.slice(0, 5).entries())
        if (tiene(t, RE_TAG)) e.push(`cerró en el turno ${i + 1} antes de tiempo`);
      if (!/ciudad/i.test(t1)) e.push('turno1 no preguntó la ciudad');
      if (!/cu[aá]nt|unidad|combo/i.test(t2)) e.push('turno2 no preguntó la cantidad');
      if (/domicilio|agencia|nombre completo/i.test(t2))
        e.push('turno2 acumuló envío o datos (debía preguntar SOLO cantidad)');
      if (!/negro/i.test(t3) || !/caf/i.test(t3))
        e.push('turno3 no preguntó la variedad');
      if (!/domicilio/i.test(t4) || !/agencia|servientrega/i.test(t4))
        e.push('turno4 no preguntó el envío');
      if (!/nombre/i.test(t5)) e.push('turno5 no pidió los datos');
      if (!tiene(t6, RE_TAG)) e.push('turno final no cerró con el tag');
      if (!/🎨\s*Variedad:\s*Negro/i.test(t6)) e.push('resumen sin "Variedad: Negro"');
      if (!/🔢\s*Cantidad:\s*2/.test(t6)) e.push('resumen sin "Cantidad: 2"');
      if (!/🚚\s*Env[ií]o:\s*domicilio/i.test(t6)) e.push('resumen sin "Envio: domicilio"');
      return e;
    },
  },
  {
    nombre: 'cantidad_no_es_variedad',
    // Todo de golpe menos el color: debe preguntar SOLO la variedad y cerrar después.
    mensajes: [
      'quiero comprar el cubre canas',
      'Quito',
      'quiero 2 porfavor, a domicilio. Michael Ordonez, 0991234567, calle Cincuenta y Alfredo Borja frente al Tuti',
      'los dos en cafe',
    ],
    checks: (turnos) => {
      const e = [];
      const [, , t3, t4] = turnos;
      if (tiene(t3, RE_TAG)) e.push('cerró sin que el cliente nombrara variedad');
      if (/🎨\s*Variedad:/.test(t3)) e.push('inventó la línea Variedad sin elección');
      if (RE_RESUMEN.test(t3)) e.push('escribió resumen (a medias) en vez de solo preguntar');
      if (!/negro|caf/i.test(t3)) e.push('no preguntó la variedad');
      if (!tiene(t4, RE_TAG)) e.push('no cerró tras elegir café');
      if (!/🎨\s*Variedad:\s*Caf/i.test(t4)) e.push('resumen sin "Variedad: Café"');
      if (!/🔢\s*Cantidad:\s*2/.test(t4)) e.push('resumen sin "Cantidad: 2"');
      return e;
    },
  },
  {
    nombre: 'datos_incompletos_sin_resumen',
    // El caso real: nombre+dirección sin teléfono → nada de resumen "(pendiente)".
    mensajes: [
      'quiero el tv',
      'Quito',
      'uno solo',
      'a domicilio',
      'Michael Ordonez, Carcelen calle Cincuenta y Alfredo Borja frente al Tuti',
      '0991234567',
    ],
    checks: (turnos) => {
      const e = [];
      const [, , t3, t4, t5, t6] = turnos;
      if (!/domicilio/i.test(t3) || !/agencia|servientrega/i.test(t3))
        e.push('turno3 no preguntó el envío');
      if (!/nombre/i.test(t4)) e.push('turno4 no pidió los datos');
      if (RE_RESUMEN.test(t5) || tiene(t5, RE_TAG))
        e.push('con el teléfono faltante escribió resumen o cerró');
      if (!/tel[eé]fono|n[uú]mero/i.test(t5)) e.push('no pidió el teléfono faltante');
      if (!tiene(t6, RE_TAG)) e.push('no cerró tras recibir el teléfono');
      if (tiene(t6, RE_TAG) && !/📞\s*Tel[eé]fono:\s*0991234567/.test(t6))
        e.push('el resumen no usa el teléfono entregado');
      return e;
    },
  },
  {
    nombre: 'simple_flujo_por_pasos',
    mensajes: [
      'quiero el tv',
      'Guayaquil',
      'uno solo',
      'a domicilio',
      'Michael Ordonez, 0991234567, av Francisco de Orellana y Justino Cornejo',
    ],
    checks: (turnos) => {
      const e = [];
      const [, t2, t3, t4, t5] = turnos;
      if (!/cu[aá]nt|unidad|combo/i.test(t2)) e.push('turno2 no preguntó la cantidad');
      if (/negro|caf|variedad|color/i.test(t2 + t3))
        e.push('preguntó variedad en un producto simple');
      if (!/domicilio/i.test(t3) || !/agencia|servientrega/i.test(t3))
        e.push('turno3 no preguntó el envío');
      if (!tiene(t5, RE_TAG)) e.push('no cerró con datos completos');
      if (/🎨\s*Variedad:/.test(turnos.join('\n')))
        e.push('metió línea Variedad en producto simple');
      if (!/🔢\s*Cantidad:\s*1/.test(t5)) e.push('resumen sin "Cantidad: 1"');
      return e;
    },
  },
  {
    nombre: 'dos_variedades_mismo_pedido',
    mensajes: [
      'quiero el cubre canas',
      'Quito',
      'quiero 2',
      'uno negro y otro cafe',
      'a domicilio',
      'Michael Ordonez, 0991234567, calle Veintimilla y Alfredo Borja frente al Tuti',
    ],
    checks: (turnos) => {
      const e = [];
      const t6 = turnos[5];
      if (!tiene(t6, RE_TAG)) e.push('no cerró con datos completos');
      const productos = (t6.match(/📦\s*Producto:/g) || []).length;
      if (productos > 1) e.push('duplicó la línea 📦 Producto');
      if (!/🎨\s*Variedad:.*negro.*caf|🎨\s*Variedad:.*caf.*negro/i.test(t6))
        e.push('no registró ambas variedades en una sola línea');
      if (!/🔢\s*Cantidad:\s*2/.test(t6)) e.push('resumen sin "Cantidad: 2"');
      return e;
    },
  },
];
