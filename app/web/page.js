/* ---------- Categorías de gasto ---------- */
/* Los nombres de las categorías son los de la base de datos y no se renombran. Lo único fijo es qué cuenta como "gasto operativo":
   Nómina, Renta, Servicios, Insumos y Mercancía, sin importar mayúsculas, acentos ni espacios (NÓMINA, nomina, Mercancia…).
   Todo lo demás es "gasto de expansión". */
const norm = (t) => String(t === null || t === undefined ? '' : t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const RE_OPER = /^(nomina|renta|servicios?|insumos?|mercancias?)$/;
const esOper = (cat) => RE_OPER.test(norm(cat));
const ORDEN_OPER = ['nomina', 'renta', 'insumo', 'servicio', 'mercancia'];
const ordenOper = (cat) => ORDEN_OPER.indexOf(norm(cat).replace(/s$/, ''));
const porNombre = (a, b) => String(a.categoria).localeCompare(String(b.categoria), 'es');
/* El check "Incluir gastos de expansión" (solo gráfica, resultado y semáforo) vive en los parámetros: solo '0' lo desactiva. */
const conExpansion = () => dash.params().expansion !== '0';

/* ---------- Cálculos (cada uno se lee solo, sin ayudas externas) ---------- */

dash.calc('meses_disponibles', {
  title: 'Meses con datos',
  description: 'Meses que tienen ingresos registrados, en orden. Alimentan los selectores de año y mes.',
  inputs: ['ingresos_diarios'],
  fn: (diarios) => [...new Set(diarios.map((r) => String(r.fecha).slice(0, 7)))].sort()
    .map((mes) => ({ mes, anio: +mes.slice(0, 4), numero: +mes.slice(5, 7) })),
});

dash.calc('mes_activo', {
  title: 'Mes que se está viendo',
  description: 'El mes elegido en los selectores; si no hay elección válida, el mes en curso o el último con datos.',
  inputs: ['meses_disponibles'],
  fn: (meses) => {
    const lista = meses.map((r) => r.mes);
    const hoy = new Date();
    const hoyYm = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0');
    const pedido = dash.params().mes;
    const mes = lista.includes(pedido) ? pedido : lista.includes(hoyYm) ? hoyYm : lista[lista.length - 1];
    return mes ? [{ mes }] : [];
  },
});

dash.calc('kpi_mes', {
  title: 'Avance del mes contra la meta prorrateada',
  description: 'Meta del mes ÷ días del mes × días transcurridos, comparada con los ingresos registrados.',
  inputs: ['ingresos_diarios', 'metas', 'mes_activo'],
  fn: (diarios, metas, activo) => {
    if (!activo.length) return [];
    const mes = activo[0].mes;
    const hoy = new Date();
    const hoyYm = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0');
    const [y, m] = mes.split('-').map(Number);
    const dias = new Date(y, m, 0).getDate();
    const transcurridos = mes === hoyYm ? hoy.getDate() : dias;
    const filas = diarios.filter((r) => String(r.fecha).slice(0, 7) === mes);
    const ingresos = d3.sum(filas, (r) => +r.total);
    const ultimo = d3.max(filas, (r) => +String(r.fecha).slice(8, 10)) || 0;
    const pos = (v) => (v !== null && v !== undefined && v !== '' && +v > 0 ? +v : null);
    const delMes = metas.find((r) => r.id === mes);
    const std = metas.find((r) => r.id === 'estandar');
    const metaMes = pos(delMes && delMes.ingresos);
    const meta = metaMes || pos(std && std.ingresos) || 30000;
    const metaSocios = pos(delMes && delMes.socios) || pos(std && std.socios);
    const esperado = (meta / dias) * transcurridos;
    const pct = ingresos / esperado;
    return [{
      mes, dias, transcurridos, ultimo_cierre: ultimo, ingresos, meta,
      origen_meta: metaMes ? 'meta del mes' : 'meta estándar',
      meta_socios: metaSocios, esperado, pct,
      pct_meta: ingresos / meta,
      proyeccion: (ingresos / transcurridos) * dias,
      estado: pct >= 1 ? 'verde' : pct >= 0.85 ? 'amarillo' : 'rojo',
    }];
  },
});

dash.calc('estado_mes', {
  title: 'Estado financiero del mes',
  description: 'Ingresos por categoría menos gastos (egresos) por categoría del mes elegido. El resultado es provisional si el mes sigue en curso, los gastos están incompletos (falta Nómina o Renta) o algún cierre de caja del mes sigue sin revisar.',
  inputs: ['ingresos_diarios', 'egresos_mensual', 'mes_activo'],
  fn: (diarios, egresos, activo) => {
    if (!activo.length) return [];
    const mes = activo[0].mes;
    const hoy = new Date();
    const enCurso = mes === hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0');
    const filas = diarios.filter((r) => String(r.fecha).slice(0, 7) === mes);
    const suma = (k) => d3.sum(filas, (r) => +r[k]);
    const eg = egresos.filter((r) => r.mes === mes);
    const estado = eg.length ? eg[0].estado : 'sin captura';
    const sinRevisar = eg.length ? +eg[0].cierres_sin_revisar || 0 : 0;   // cierres de caja del mes aún sin revisar
    const ing = [
      ['Venta de membresías', suma('membresias')],
      ['Venta de mercancías', suma('mercancias')],
      ['Otros ingresos', suma('excedente')],
    ];
    const conMonto = eg.filter((r) => +r.monto !== 0);
    const oper = conMonto.filter((r) => esOper(r.categoria)).sort((x, y) => ordenOper(x.categoria) - ordenOper(y.categoria));
    const expa = conMonto.filter((r) => !esOper(r.categoria)).sort(porNombre);
    const totI = d3.sum(ing, (d) => d[1]);
    const totO = d3.sum(oper, (r) => +r.monto);
    const totE = d3.sum(expa, (r) => +r.monto);
    const fila = (lado, concepto, monto) => ({ lado, concepto, monto, estado_egresos: estado, cierres_sin_revisar: sinRevisar });
    const out = ing.map((d) => fila('Ingresos', d[0], d[1]));
    out.push(fila('Ingresos', 'Total de ingresos', totI));
    if (estado !== 'sin captura') {
      oper.forEach((r) => out.push(fila('Gastos operativos', r.categoria, +r.monto)));
      out.push(fila('Gastos operativos', 'Subtotal', totO));
      expa.forEach((r) => out.push(fila('Gastos de expansión', r.categoria, +r.monto)));
      out.push(fila('Gastos de expansión', 'Subtotal', totE));
      out.push(fila('Gastos', 'Total de gastos', totO + totE));
      const prov = !(estado === 'completo' && sinRevisar === 0 && !enCurso);   // completo = Nómina y Renta + todos los cierres revisados
      out.push(Object.assign(fila('Resultado', 'Con todos los gastos', totI - totO - totE), { clave: 'todos', prov }));
      out.push(Object.assign(fila('Resultado', 'Solo con gastos operativos', totI - totO), { clave: 'oper', prov }));
    }
    return out;
  },
});

dash.calc('resultado_mes', {
  title: 'Resultado del mes',
  description: 'Ingresos menos gastos. Con "Incluir gastos de expansión" activo se restan todos los gastos; sin él, solo los gastos operativos (Nómina, Renta, Servicios, Insumos y Mercancía). Es provisional mientras el mes sigue en curso o los gastos están incompletos.',
  inputs: ['estado_mes', 'kpi_mes'],
  fn: (estado, kpi) => {
    const k = kpi[0];
    if (!k || !estado.length) return [];
    const tot = (lado, concepto) => estado.find((r) => r.lado === lado && r.concepto === (concepto || 'Total de ingresos'));
    const res = (clave) => estado.find((r) => r.lado === 'Resultado' && r.clave === clave);
    const exp = conExpansion();
    const gT = tot('Gastos', 'Total de gastos');
    const gB = tot('Gastos operativos', 'Subtotal');
    const rT = res('todos');
    const rB = res('oper');
    const hoy = new Date();
    return [{
      mes: k.mes,
      ingresos: +tot('Ingresos').monto,
      gastos: gT ? +(exp ? gT : gB).monto : null,
      resultado: rT ? +(exp ? rT : rB).monto : null,
      resultado_todos: rT ? +rT.monto : null,
      resultado_oper: rB ? +rB.monto : null,
      expansion: exp,
      excluidos: estado.filter((r) => r.lado === 'Gastos de expansión' && r.concepto !== 'Subtotal').map((r) => r.concepto),
      en_curso: k.mes === hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0'),
      provisional: !!rT && rT.prov,
      estado_egresos: estado[0].estado_egresos,
      cierres_sin_revisar: estado[0].cierres_sin_revisar,
    }];
  },
});

dash.calc('acumulado_mes', {
  title: 'Ingresos acumulados por día',
  description: 'Ingresos acumulados del mes junto al ritmo de la meta (meta ÷ días del mes × día).',
  inputs: ['ingresos_diarios', 'kpi_mes'],
  fn: (diarios, kpi) => {
    const k = kpi && kpi[0];
    if (!k) return [];
    const porDia = new Map(diarios
      .filter((r) => String(r.fecha).slice(0, 7) === k.mes)
      .map((r) => [+String(r.fecha).slice(8, 10), +r.total]));
    let acum = 0;
    const out = [];
    for (let d = 1; d <= k.dias; d++) {
      acum += porDia.get(d) || 0;
      out.push({ dia: d, acumulado: d <= k.ultimo_cierre ? acum : null, ritmo: (k.meta / k.dias) * d });
    }
    return out;
  },
});

/* ---------- Ayudas de la página ---------- */

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const pct1 = d3.format('.1%');
const ymHoy = () => { const h = new Date(); return h.getFullYear() + '-' + String(h.getMonth() + 1).padStart(2, '0'); };
const mesActivo = () => {
  const g = dash.data('mes_activo');
  return g.status === 'ok' && g.data[0] ? g.data[0].mes : null;
};
const mesesDisp = () => {
  const g = dash.data('meses_disponibles');
  return g.status === 'ok' ? g.data : [];
};
const nombreMes = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return MESES[m - 1][0].toUpperCase() + MESES[m - 1].slice(1) + ' ' + y;
};
const $ = (id) => document.getElementById(id);
const kpiRow = () => {
  const g = dash.data('kpi_mes');
  return g.status === 'ok' && g.data && g.data[0] ? g.data[0] : null;
};
const note = (t) => { const p = document.createElement('p'); p.className = 'fg-empty'; p.textContent = t; return p; };

const bind = (name, f) => dash.draw(name, (el) => {
  const k = kpiRow();
  const v = k ? f(k) : null;
  el.textContent = v === null || v === undefined ? '—' : v;
});
bind('s_pct', (k) => pct1(k.pct));
bind('u_dia', (k) => (k.ultimo_cierre ? k.ultimo_cierre : null));

const resRow = () => {
  const g = dash.data('resultado_mes');
  return g.status === 'ok' && g.data && g.data[0] ? g.data[0] : null;
};
const bindRes = (name, f) => dash.draw(name, (el) => {
  const r = resRow();
  const v = r ? f(r, el) : null;
  el.textContent = v === null || v === undefined ? '—' : v;
});
bindRes('res_prov', (r) => (r.provisional ? 'provisional' : 'del mes'));
bindRes('res_momento', (r) => (r.en_curso ? 'al momento' : 'del mes'));
bindRes('res_ing', (r) => mxn.format(r.ingresos));
bindRes('res_gas', (r) => (r.gastos === null ? 'Sin captura' : mxn.format(r.gastos)));
bindRes('res_monto', (r, el) => {
  el.className = 'fg-resnum' + (r.resultado === null ? '' : r.resultado >= 0 ? ' is-ok' : ' is-bad');
  return r.resultado === null ? null : mxn.format(r.resultado);
});
dash.draw('res_pill', (el) => {
  const r = resRow();
  const sin = !r || r.resultado === null;
  const estado = sin ? null : r.resultado >= 0 ? 'verde' : 'rojo';
  el.className = 'fg-pill' + (estado ? ' fg-pill--' + estado : '');
  const [icon, label] = sin ? ['–', r ? 'Sin gastos capturados' : 'Cargando'] : r.resultado >= 0 ? ['✓', 'Ganancia'] : ['✕', 'Pérdida'];
  const ic = document.createElement('span');
  ic.className = 'ic';
  ic.setAttribute('aria-hidden', 'true');
  ic.textContent = icon;
  const tx = document.createElement('span');
  tx.textContent = label;
  el.replaceChildren(ic, tx);
});

dash.draw('pill', (el) => {
  const k = kpiRow();
  const sinDatos = dash.data('kpi_mes').status === 'ok' && !k;
  const map = {
    verde: ['✓', 'En meta'],
    amarillo: ['!', 'Cerca de la meta'],
    rojo: ['✕', 'Debajo de la meta'],
  };
  el.className = 'fg-pill' + (k ? ' fg-pill--' + k.estado : '');
  const [icon, label] = k ? map[k.estado] : ['–', sinDatos ? 'Sin datos' : 'Cargando'];
  const ic = document.createElement('span');
  ic.className = 'ic';
  ic.setAttribute('aria-hidden', 'true');
  ic.textContent = icon;
  const tx = document.createElement('span');
  tx.textContent = label;
  el.replaceChildren(ic, tx);
});

/* Selector de periodo: meses con datos; en el resumen anual, años con datos (el más reciente primero). */
const vistaActual = () => dash.params().vista || 'resumen-ejecutivo';
dash.draw('lblPeriodo', (el) => { el.textContent = vistaActual() === 'resumen-anual' ? 'Año' : 'Periodo'; });
dash.draw('selPeriodo', (sel) => {
  const ds = mesesDisp().slice().reverse();
  const act = mesActivo();
  if (vistaActual() === 'resumen-anual') {
    const anios = [...new Set(ds.map((d) => d.anio))];
    sel.replaceChildren(...anios.map((a) => new Option(String(a), String(a))));
    sel.value = act ? act.slice(0, 4) : '';
    sel.disabled = !anios.length;
    sel.onchange = () => {
      const delAnio = ds.filter((d) => String(d.anio) === sel.value);
      const igual = act ? delAnio.find((d) => d.mes.slice(5) === act.slice(5)) : null;
      const elegido = igual || delAnio[0];
      if (elegido) dash.setParams({ mes: elegido.mes });
    };
    return;
  }
  sel.replaceChildren(...ds.map((d) => new Option(MESES[d.numero - 1][0].toUpperCase() + MESES[d.numero - 1].slice(1) + ' ' + d.anio, d.mes)));
  sel.value = act || '';
  sel.disabled = !ds.length;
  sel.onchange = () => dash.setParams({ mes: sel.value });
});

/* ---------- Avisos y estados vacíos ---------- */

dash.onData(() => {
  const vista = dash.params().vista || 'resumen-ejecutivo';
  document.querySelectorAll('.fg-view').forEach((s) => { s.classList.toggle('is-off', s.id !== 'vista-' + vista); });
  if ($('selVista').value !== vista) $('selVista').value = vista;
  const r = resRow();
  const estadoEg = r ? r.estado_egresos : null;
  document.querySelectorAll('.js-aviso-parcial').forEach((e) => { e.hidden = estadoEg !== 'parcial'; });
  document.querySelectorAll('.js-aviso-sin').forEach((e) => { e.hidden = estadoEg !== 'sin captura'; });
  document.querySelectorAll('.js-aviso-cierres').forEach((e) => { e.hidden = !(r && estadoEg !== 'sin captura' && r.cierres_sin_revisar > 0); });
  $('res-cap-prov').hidden = !(r && r.resultado !== null && r.provisional);
  $('res-cap-final').hidden = !(r && r.resultado !== null && !r.provisional);
  $('res-cap-sin').hidden = !(r && r.resultado === null);
  const m = dash.data('metas');
  $('metas-vacio').hidden = !(m.status === 'ok' && !m.data.some((r) => r.id !== 'estandar' && (r.ingresos !== null || r.socios !== null)));
});

/* ---------- Gráficas ---------- */

const COLOR_IDX = { 'Venta de membresías': 0, 'Venta de mercancías': 1, 'Otros ingresos': 2 };
const COLOR_OPER = [3, 4, 5, 6, 7]; // Nómina, Renta, Insumos, Servicios, Mercancía: un tono fijo cada uno
/* Colores estables por categoría de gasto: los gastos operativos tienen su tono; las de expansión (las demás categorías (las que trae el Excel,
   sean cuales sean) van en una rampa de grises por orden alfabético, así no cambian al cambiar de mes. */
const mapaColores = () => {
  const m = new Map();
  Object.entries(COLOR_IDX).forEach(([c, i]) => m.set(c, dash.colors[i % dash.colors.length]));
  const g = dash.data('egresos_mensual');
  const cats = g.status === 'ok' ? [...new Set(g.data.map((r) => r.categoria))] : [];
  cats.filter(esOper).forEach((c) => m.set(c, dash.colors[COLOR_OPER[ordenOper(c)] % dash.colors.length]));
  const otros = cats.filter((c) => !esOper(c)).sort((a, b) => String(a).localeCompare(String(b), 'es'));
  otros.forEach((c, i) => m.set(c, d3.hsl(0, 0, otros.length === 1 ? 0.55 : 0.36 + (0.34 * i) / (otros.length - 1)).formatHex()));
  return m;
};
let _colores = null;
const colorDe = (c) => (_colores && _colores.get(c)) || '#8c8c8c';
const eje = (v) => '$' + d3.format('~s')(v);
const svgEl = (parent, name, attrs) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs || {}).forEach(([a, v]) => e.setAttribute(a, v));
  parent.appendChild(e);
  return e;
};
const makeTip = (wrap) => {
  const tip = document.createElement('div');
  tip.className = 'fg-tip';
  tip.hidden = true;
  wrap.appendChild(tip);
  return {
    show(ev, lines) {
      tip.replaceChildren(...lines.map((t, i) => {
        const d = document.createElement('div');
        d.textContent = t;
        if (i === 0) d.className = 'fg-tip-h';
        return d;
      }));
      tip.hidden = false;
      const r = wrap.getBoundingClientRect();
      let x = ev.clientX - r.left + 12;
      let y = ev.clientY - r.top + 12;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      if (x + w > r.width) x = Math.max(0, ev.clientX - r.left - w - 12);
      if (y + h > r.height) y = Math.max(0, r.height - h);
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    },
    hide() { tip.hidden = true; },
  };
};
const legendItem = (parent, swatch, text) => {
  const s = document.createElement('span');
  s.appendChild(swatch);
  s.appendChild(document.createTextNode(text));
  parent.appendChild(s);
};

dash.draw('chartEstado', (el) => {
  const g = dash.data('estado_mes');
  el.classList.toggle('dash-skeleton', g.status === 'loading');
  if (g.status === 'loading') return;
  el.replaceChildren();
  if (g.status === 'error') { el.appendChild(note('No se pudo cargar el estado financiero.')); return; }
  if (g.status !== 'ok') return;
  const rows = g.data;
  if (!rows.length) { el.appendChild(note('Este mes no tiene ingresos registrados.')); return; }
  _colores = mapaColores();
  const exp = conExpansion();
  const tot = (lado, concepto) => rows.find((r) => r.lado === lado && r.concepto === (concepto || 'Total de ingresos'));
  const res = rows.find((r) => r.lado === 'Resultado' && r.clave === (exp ? 'todos' : 'oper'));
  const bars = [{ lado: 'Ingresos', total: +tot('Ingresos').monto, segs: rows.filter((r) => r.lado === 'Ingresos' && r.concepto !== 'Total de ingresos') }];
  if (tot('Gastos', 'Total de gastos')) {
    const segsO = rows.filter((r) => r.lado === 'Gastos operativos' && r.concepto !== 'Subtotal');
    bars.push({ lado: 'Gastos operativos', lineas: ['Gastos', 'operativos'], total: d3.sum(segsO, (r) => +r.monto), segs: segsO });
    const segsE = rows.filter((r) => r.lado === 'Gastos de expansión' && r.concepto !== 'Subtotal');
    if (exp) bars.push({ lado: 'Gastos de expansión', lineas: ['Gastos de', 'expansión'], total: d3.sum(segsE, (r) => +r.monto), segs: segsE });
  }
  if (res) bars.push({ lado: 'Resultado', total: +res.monto, res: true, prov: !!res.prov });

  const W = Math.max(280, el.clientWidth);
  const M = { l: 92, r: 90, t: 6, b: 28 };
  const bh = 30, gap = 18;
  const H = M.t + bars.length * (bh + gap) - gap + M.b;
  const x = d3.scaleLinear()
    .domain([Math.min(0, ...bars.map((b) => b.total)), Math.max(1, ...bars.map((b) => b.total))])
    .range([M.l, W - M.r]);

  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  el.appendChild(wrap);
  const svg = svgEl(wrap, 'svg', { viewBox: `0 0 ${W} ${H}`, class: 'fg-svg', role: 'img' });
  svg.setAttribute('aria-label', 'Estado financiero: ' + bars.map((b) => b.lado + (b.prov ? ' provisional ' : ' ') + mxn.format(b.total)).join(', '));
  const axisG = svgEl(svg, 'g', { transform: `translate(0,${H - M.b})` });
  d3.select(axisG).call(d3.axisBottom(x).ticks(W < 480 ? 3 : 5).tickFormat(eje).tickSize(-(H - M.b - M.t) - 0));
  svgEl(svg, 'line', { x1: x(0), x2: x(0), y1: M.t, y2: H - M.b, stroke: 'var(--cds-chart-axis)' });
  const tip = makeTip(wrap);

  bars.forEach((b, i) => {
    const y = M.t + i * (bh + gap);
    if (b.lineas) {
      b.lineas.forEach((ln, k) => {
        const t2 = svgEl(svg, 'text', { x: M.l - 10, y: y + bh / 2 + (k ? 9 : -9), 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'lbl' });
        t2.textContent = ln;
      });
    } else {
      const t = svgEl(svg, 'text', { x: M.l - 10, y: y + bh / 2, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'lbl' });
      t.textContent = b.lado;
    }
    if (b.res) {
      const x0 = x(Math.min(0, b.total)), x1 = x(Math.max(0, b.total));
      const col = b.total >= 0 ? 'var(--color-ok)' : 'var(--color-bad)';
      const r = svgEl(svg, 'rect', {
        x: x0, y, width: Math.max(2, x1 - x0), height: bh, rx: 3, fill: col,
        'fill-opacity': b.prov ? 0.35 : 1, stroke: col, 'stroke-width': b.prov ? 1.5 : 0, 'stroke-dasharray': b.prov ? '5 3' : 'none',
      });
      const lines = [b.prov ? 'Resultado provisional' : 'Resultado', mxn.format(b.total)];
      r.addEventListener('pointermove', (ev) => tip.show(ev, lines));
      r.addEventListener('pointerleave', () => tip.hide());
    } else {
      let acc = 0;
      b.segs.filter((s) => +s.monto > 0).forEach((s) => {
        const a = x(acc), z = x(acc + +s.monto);
        const r = svgEl(svg, 'rect', { x: a + 1, y, width: Math.max(2, z - a - 2), height: bh, rx: 3, style: 'fill:' + colorDe(s.concepto) });
        const lines = [s.concepto, mxn.format(+s.monto)];
        r.addEventListener('pointermove', (ev) => tip.show(ev, lines));
        r.addEventListener('pointerleave', () => tip.hide());
        acc += +s.monto;
      });
    }
    const vx = x(Math.max(0, b.total)) + 8;
    const v = svgEl(svg, 'text', { x: vx, y: y + bh / 2 - (b.prov ? 6 : 0), 'dominant-baseline': 'central', class: 'val' });
    v.textContent = mxn.format(b.total);
    if (b.prov) {
      const s = svgEl(svg, 'text', { x: vx, y: y + bh / 2 + 9, 'dominant-baseline': 'central', class: 'sub' });
      s.textContent = 'provisional';
    }
  });

  const lg = document.createElement('div');
  lg.className = 'fg-legend';
  const usados = [...new Set(bars.flatMap((b) => (b.segs || []).filter((s) => +s.monto > 0).map((s) => s.concepto)))];
  usados.forEach((c) => {
    const sw = document.createElement('i');
    sw.className = 'fg-sw';
    sw.style.background = colorDe(c);
    legendItem(lg, sw, c);
  });
  wrap.appendChild(lg);
});

dash.draw('chartAcum', (el) => {
  const g = dash.data('acumulado_mes');
  el.classList.toggle('dash-skeleton', g.status === 'loading');
  if (g.status === 'loading') return;
  el.replaceChildren();
  if (g.status === 'error') { el.appendChild(note('No se pudo cargar la gráfica de ingresos acumulados.')); return; }
  if (g.status !== 'ok') return;
  const rows = g.data;
  if (!rows.length) { el.appendChild(note('No hay ingresos registrados para mostrar.')); return; }
  const real = rows.filter((r) => r.acumulado !== null && r.acumulado !== undefined).map((r) => ({ dia: +r.dia, v: +r.acumulado }));
  const ritmo = rows.map((r) => ({ dia: +r.dia, v: +r.ritmo }));
  const dias = rows.length;

  const W = Math.max(280, el.clientWidth);
  const H = W < 480 ? 210 : 250;
  const M = { l: 48, r: 14, t: 22, b: 28 };
  const ymax = Math.max(d3.max(ritmo, (d) => d.v), d3.max(real, (d) => d.v) || 0) * 1.1;
  const x = d3.scaleLinear().domain([1, Math.max(2, dias)]).range([M.l, W - M.r]);
  const y = d3.scaleLinear().domain([0, ymax]).nice().range([H - M.b, M.t]);

  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  el.appendChild(wrap);
  const svg = svgEl(wrap, 'svg', { viewBox: `0 0 ${W} ${H}`, class: 'fg-svg', role: 'img' });
  const ult = real[real.length - 1];
  svg.setAttribute('aria-label', 'Ingresos acumulados del mes' + (ult ? ': ' + mxn.format(ult.v) + ' al día ' + ult.dia : '') + ', contra el ritmo de la meta, que llega a ' + mxn.format(ritmo[ritmo.length - 1].v) + ' al día ' + dias);

  const gy = svgEl(svg, 'g', { transform: `translate(${M.l},0)` });
  d3.select(gy).call(d3.axisLeft(y).ticks(5).tickFormat(eje).tickSize(-(W - M.l - M.r)));
  const paso = W < 480 ? 10 : 5;
  const gx = svgEl(svg, 'g', { transform: `translate(0,${H - M.b})` });
  d3.select(gx).call(d3.axisBottom(x).tickValues(d3.range(1, dias + 1).filter((d) => d === 1 || d % paso === 0)).tickFormat(d3.format('d')).tickSize(4));
  svgEl(svg, 'line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, stroke: 'var(--cds-chart-axis)' });

  const line = d3.line().x((d) => x(d.dia)).y((d) => y(d.v));
  svgEl(svg, 'path', { d: line(ritmo), fill: 'none', stroke: 'var(--color-fg-muted)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' });
  const metaFin = ritmo[ritmo.length - 1];
  const tm = svgEl(svg, 'text', { x: W - M.r, y: y(metaFin.v) - 8, 'text-anchor': 'end', class: 'sub halo' });
  tm.textContent = 'Meta ' + mxn.format(metaFin.v);
  if (real.length) {
    svgEl(svg, 'path', { d: line(real), fill: 'none', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', style: 'stroke:' + dash.colors[0] });
    svgEl(svg, 'circle', { cx: x(ult.dia), cy: y(ult.v), r: 4.5, 'stroke-width': 2, style: 'fill:' + dash.colors[0] + ';stroke:var(--color-panel)' });
    const anchorEnd = x(ult.dia) > W * 0.6;
    const tv = svgEl(svg, 'text', { x: x(ult.dia) + (anchorEnd ? -8 : 8), y: y(ult.v) - 10, 'text-anchor': anchorEnd ? 'end' : 'start', class: 'val halo' });
    tv.textContent = mxn.format(ult.v);
  }

  const cross = svgEl(svg, 'line', { y1: M.t, y2: H - M.b, stroke: 'var(--cds-chart-axis)', visibility: 'hidden' });
  const dot = svgEl(svg, 'circle', { r: 4, visibility: 'hidden', 'stroke-width': 2, style: 'fill:' + dash.colors[0] + ';stroke:var(--color-panel)' });
  const tip = makeTip(wrap);
  const hit = svgEl(svg, 'rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: 'transparent' });
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const d = Math.max(1, Math.min(dias, Math.round(x.invert(px))));
    const rr = rows[d - 1];
    cross.setAttribute('x1', x(d)); cross.setAttribute('x2', x(d)); cross.setAttribute('visibility', 'visible');
    const tieneReal = rr.acumulado !== null && rr.acumulado !== undefined;
    if (tieneReal) { dot.setAttribute('cx', x(d)); dot.setAttribute('cy', y(+rr.acumulado)); dot.setAttribute('visibility', 'visible'); }
    else dot.setAttribute('visibility', 'hidden');
    tip.show(ev, [
      'Día ' + d,
      'Acumulado: ' + (tieneReal ? mxn.format(+rr.acumulado) : 'sin cierre todavía'),
      'Ritmo de la meta: ' + mxn.format(+rr.ritmo),
    ]);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hide(); });

  const lg = document.createElement('div');
  lg.className = 'fg-legend';
  const s1 = document.createElement('i');
  s1.className = 'fg-swline';
  s1.style.borderTopColor = dash.colors[0];
  legendItem(lg, s1, 'Ingresos acumulados');
  const s2 = document.createElement('i');
  s2.className = 'fg-swline fg-swline--dash';
  s2.style.borderTopColor = 'var(--color-fg-muted)';
  legendItem(lg, s2, 'Ritmo de la meta');
  wrap.appendChild(lg);
});

/* ---------- Tablas ---------- */

dash.draw('tbodyEstado', (tb) => {
  const g = dash.data('estado_mes');
  tb.replaceChildren();
  if (g.status !== 'ok') return;
  /* Cada grupo lleva su título (Ingresos, Gastos operativos, Gastos de expansión, Resultado); aquí siempre se ven todos los gastos. */
  const GRUPOS = ['Ingresos', 'Gastos operativos', 'Gastos de expansión', 'Resultado'];
  let previo = null;
  g.data.forEach((r) => {
    if (GRUPOS.includes(r.lado) && r.lado !== previo) {
      const th = document.createElement('tr');
      th.className = 'is-grupo';
      th.dataset.key = 'grupo,' + encodeURIComponent(r.lado);
      const c = document.createElement('th');
      c.colSpan = 2;
      c.scope = 'colgroup';
      c.textContent = r.lado;
      th.appendChild(c);
      tb.appendChild(th);
    }
    previo = r.lado;
    const tr = document.createElement('tr');
    tr.dataset.key = encodeURIComponent(r.lado) + ',' + encodeURIComponent(r.concepto);
    if (r.concepto === 'Total de ingresos' || r.concepto === 'Subtotal' || r.concepto === 'Total de gastos' || r.lado === 'Resultado') tr.className = 'is-total';
    if (r.concepto === 'Total de gastos' || r.concepto === 'Total de ingresos') tr.className += ' is-total-grupo';
    [r.concepto + (r.lado === 'Resultado' && r.prov ? ' (provisional)' : ''), mxn.format(+r.monto)].forEach((t, i) => {
      const td = document.createElement('td');
      if (i === 1) td.className = 'num';
      td.textContent = t;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
});

dash.draw('tbodyMetas', (tb) => {
  const g = dash.data('metas');
  tb.replaceChildren();
  if (g.status !== 'ok') return;
  const rows = g.data.filter((r) => r.id !== 'estandar' && (r.ingresos !== null || r.socios !== null)).sort((a, b) => (a.id < b.id ? 1 : -1));
  const val = (v, f) => (v === null || v === undefined || v === '' ? '—' : f(+v));
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.dataset.key = encodeURIComponent(r.id);
    [nombreMes(r.id), val(r.ingresos, (v) => mxn.format(v)), val(r.socios, (v) => String(v))].forEach((t, i) => {
      const td = document.createElement('td');
      if (i > 0) td.className = 'num';
      td.textContent = t;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
});

const metaStd = () => {
  const g = dash.data('metas');
  return g.status === 'ok' ? g.data.find((r) => r.id === 'estandar') || null : null;
};
dash.draw('std_ing', (el) => {
  const std = metaStd();
  el.textContent = mxn.format(std && +std.ingresos > 0 ? +std.ingresos : 30000);
});
dash.draw('std_soc', (el) => {
  const std = metaStd();
  el.textContent = std && std.socios !== null && std.socios !== undefined ? String(std.socios) : 'Sin meta';
});

/* ---------- Check "Incluir gastos de expansión" ---------- */
/* Está en el resumen ejecutivo y en el resumen anual; los dos comparten el mismo parámetro. Activo (por omisión) = se restan todos los
   gastos; apagado = solo los gastos operativos (Nómina, Renta, Servicios, Insumos, Mercancía). Afecta el resultado, la gráfica y el semáforo. */
document.querySelectorAll('.js-expansion').forEach((c) => {
  c.addEventListener('change', () => dash.setParams({ expansion: c.checked ? null : '0' }));
});
dash.onData(() => { document.querySelectorAll('.js-expansion').forEach((c) => { c.checked = conExpansion(); }); });
const textoExpansion = (exp, excluidos, ambito) => {
  if (!excluidos.length) return 'Este ' + ambito + ' no tiene gastos de expansión, así que el resultado es el mismo con o sin el check.';
  return exp
    ? 'Se restan todos los gastos, incluidos los de expansión: ' + excluidos.join(', ') + '.'
    : 'No se restan estos gastos: ' + excluidos.join(', ') + '. Solo cuentan los gastos operativos: Nómina, Renta, Servicios, Insumos y Mercancía.';
};
dash.draw('exp_nota_mes', (el) => {
  const r = resRow();
  el.textContent = r && r.resultado !== null ? textoExpansion(r.expansion, r.excluidos, 'mes') : '—';
});
dash.draw('exp_nota_anio', (el) => {
  const r = anRow();
  el.textContent = r && r.resultado !== null ? textoExpansion(r.expansion, r.excluidos, 'año') : '—';
});

/* ---------- Selector de gráfico ---------- */
/* Para sumar un gráfico: una <option> en #selVista, y una sección .fg-view con id "vista-<valor>" en el HTML. Cada sección trae dentro todo lo suyo: semáforo, gráfica, detalle y su "Cómo se calculan las cifras". */
$('selVista').addEventListener('change', () => dash.setParams({ vista: $('selVista').value }));

/* ---------- Pestañas ---------- */

const TABS = ['resumen', 'metas', 'revision', 'usuarios'];
const SOLO_ADMIN = ['revision', 'usuarios'];
let perfil = null;
const permitida = (n) => !SOLO_ADMIN.includes(n) || perfil === 'admin';

const mostrarTab = (nombre) => {
  if (!permitida(nombre)) nombre = 'resumen';
  TABS.forEach((n) => {
    $('tab-' + n).classList.toggle('is-off', n !== nombre);
    $('btn-' + n).classList.toggle('is-on', n === nombre);
    $('btn-' + n).setAttribute('aria-selected', n === nombre ? 'true' : 'false');
  });
  if (window.Admin && (nombre === 'revision' || nombre === 'usuarios' || nombre === 'metas')) window.Admin.activar(nombre);
};
TABS.forEach((n) => {
  $('btn-' + n).addEventListener('click', () => {
    if (window.Admin && !window.Admin.puedeSalir()) return;
    mostrarTab(n); dash.setLink(n);
  });
});
const tabInicial = () => { const h = location.hash.replace('#', ''); return TABS.includes(h) && permitida(h) ? h : 'resumen'; };
mostrarTab(tabInicial());


/* ---------- Resumen anual ---------- */

dash.calc('resultados_anio', {
  title: 'Resultado de cada mes del año',
  description: 'Ingresos menos gastos de cada mes con datos del año elegido. Es el mismo resultado del resumen ejecutivo, y también depende del check de gastos de expansión.',
  inputs: ['ingresos_diarios', 'egresos_mensual', 'mes_activo'],
  fn: (diarios, egresos, activo) => {
    if (!activo.length) return [];
    const anio = activo[0].mes.slice(0, 4);
    const hoy = new Date();
    const hoyYm = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0');
    const meses = [...new Set(diarios.map((r) => String(r.fecha).slice(0, 7)).filter((m) => m.slice(0, 4) === anio))].sort();
    return meses.map((mes) => {
      const ingresos = d3.sum(diarios.filter((r) => String(r.fecha).slice(0, 7) === mes), (r) => +r.total);
      const eg = egresos.filter((r) => r.mes === mes);
      const estado = eg.length ? eg[0].estado : 'sin captura';
      const sinRevisar = eg.length ? +eg[0].cierres_sin_revisar || 0 : 0;
      const sinCaptura = estado === 'sin captura';
      const gTodos = sinCaptura ? null : d3.sum(eg, (r) => +r.monto);
      const gOper = sinCaptura ? null : d3.sum(eg.filter((r) => esOper(r.categoria)), (r) => +r.monto);
      const gExp = sinCaptura ? null : d3.sum(eg.filter((r) => !esOper(r.categoria)), (r) => +r.monto);
      const gastos = conExpansion() ? gTodos : gOper;
      return {
        anio: +anio, mes, numero: +mes.slice(5, 7), ingresos, gastos,
        gastos_oper: gOper, gastos_exp: gExp,
        excluidos: eg.filter((r) => !esOper(r.categoria) && +r.monto !== 0).map((r) => r.categoria),
        resultado: gastos === null ? null : ingresos - gastos,
        provisional: estado !== 'completo' || sinRevisar > 0 || mes === hoyYm,
        estado_egresos: estado,
        cierres_sin_revisar: sinRevisar,
      };
    });
  },
});

dash.calc('resultado_anio', {
  title: 'Resultado del año',
  description: 'Suma de los resultados mensuales del año. Es provisional hasta que los 12 meses tengan resultado completo.',
  inputs: ['resultados_anio'],
  fn: (meses) => {
    if (!meses.length) return [];
    const con = meses.filter((m) => m.resultado !== null);
    return [{
      anio: meses[0].anio,
      resultado: con.length ? d3.sum(con, (m) => m.resultado) : null,
      ingresos: con.length ? d3.sum(con, (m) => m.ingresos) : null,
      gastos: con.length ? d3.sum(con, (m) => m.gastos) : null,
      gastos_oper: con.length ? d3.sum(con, (m) => m.gastos_oper) : null,
      gastos_exp: con.length ? d3.sum(con, (m) => m.gastos_exp) : null,
      expansion: conExpansion(),
      excluidos: [...new Set(meses.flatMap((m) => m.excluidos))].sort((a, b) => a.localeCompare(b, 'es')),
      meses_suman: con.length,
      meses_sin_gastos: meses.length - con.length,
      provisional: !(con.length === 12 && con.every((m) => !m.provisional)),
    }];
  },
});

const anRow = () => {
  const g = dash.data('resultado_anio');
  return g.status === 'ok' && g.data && g.data[0] ? g.data[0] : null;
};
const bindAn = (name, f) => dash.draw(name, (el) => {
  const r = anRow();
  const v = r ? f(r, el) : null;
  el.textContent = v === null || v === undefined ? '—' : v;
});
bindAn('an_titulo', (r) => (r.provisional ? 'provisional del año' : 'del año'));
bindAn('an_anio', (r) => r.anio);
bindAn('an_suman', (r) => r.meses_suman);
bindAn('an_sin', (r) => r.meses_sin_gastos);
bindAn('an_t_ing', (r) => (r.ingresos === null ? null : mxn.format(r.ingresos)));
bindAn('an_t_oper', (r) => (r.gastos_oper === null ? null : mxn.format(r.gastos_oper)));
bindAn('an_t_exp', (r) => (r.gastos_exp === null ? null : mxn.format(r.gastos_exp)));
bindAn('an_t_res', (r) => (r.resultado === null ? null : mxn.format(r.resultado)));
bindAn('an_monto', (r, el) => {
  el.className = 'fg-resnum' + (r.resultado === null ? '' : r.resultado >= 0 ? ' is-ok' : ' is-bad');
  return r.resultado === null ? null : mxn.format(r.resultado);
});
dash.draw('an_pill', (el) => {
  const r = anRow();
  const sin = !r || r.resultado === null;
  el.className = 'fg-pill' + (sin ? '' : r.resultado >= 0 ? ' fg-pill--verde' : ' fg-pill--rojo');
  const [icon, label] = sin ? ['–', r ? 'Sin gastos capturados' : 'Cargando'] : r.resultado >= 0 ? ['✓', 'Ganancia'] : ['✕', 'Pérdida'];
  const ic = document.createElement('span');
  ic.className = 'ic';
  ic.setAttribute('aria-hidden', 'true');
  ic.textContent = icon;
  const tx = document.createElement('span');
  tx.textContent = label;
  el.replaceChildren(ic, tx);
});

dash.onData(() => {
  const r = anRow();
  $('an-cap-prov').hidden = !(r && r.resultado !== null && r.provisional);
  $('an-cap-final').hidden = !(r && r.resultado !== null && !r.provisional);
  $('an-cap-sin').hidden = !(r && r.resultado === null);
});

dash.draw('tbodyAnual', (tb) => {
  const g = dash.data('resultados_anio');
  tb.replaceChildren();
  if (g.status !== 'ok') return;
  g.data.forEach((r) => {
    const tr = document.createElement('tr');
    tr.dataset.key = encodeURIComponent(r.mes);
    tr.className = r.provisional ? 'is-prov' : 'is-def';
    const mes = (r.provisional ? '◔ ' : '✓ ') + MESES[r.numero - 1][0].toUpperCase() + MESES[r.numero - 1].slice(1, 3);
    const celdas = [
      [mes, 'mes'],
      [mxn.format(+r.ingresos), 'num'],
      [r.gastos_oper === null ? 'Sin captura' : mxn.format(+r.gastos_oper), 'num'],
      [r.gastos_exp === null ? '—' : mxn.format(+r.gastos_exp), 'num'],
      [r.resultado === null ? '—' : mxn.format(+r.resultado), 'num'],
    ];
    celdas.forEach(([t, cls]) => {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = t;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
});

const signoK = (v) => (v < 0 ? '−$' : '$') + d3.format('.2~s')(Math.abs(v));
const ejeSigno = (v) => (v < 0 ? '−$' : '$') + d3.format('~s')(Math.abs(v));

dash.draw('chartAnual', (el) => {
  const g = dash.data('resultados_anio');
  el.classList.toggle('dash-skeleton', g.status === 'loading');
  if (g.status === 'loading') return;
  el.replaceChildren();
  if (g.status === 'error') { el.appendChild(note('No se pudo cargar el resultado por mes.')); return; }
  if (g.status !== 'ok') return;
  const rows = g.data;
  if (!rows.length) { el.appendChild(note('No hay meses con datos para mostrar.')); return; }

  const W = Math.max(280, el.clientWidth);
  const H = W < 480 ? 230 : 260;
  const M = { l: 54, r: 12, t: 20, b: 30 };
  const vals = rows.map((r) => r.resultado).filter((v) => v !== null && v !== undefined).map(Number);
  const y = d3.scaleLinear().domain([Math.min(0, ...vals), Math.max(0, ...vals, 1)]).nice().range([H - M.b, M.t]);
  const x = d3.scaleBand().domain(rows.map((r) => r.mes)).range([M.l, W - M.r]).padding(0.3);

  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  el.appendChild(wrap);
  const svg = svgEl(wrap, 'svg', { viewBox: `0 0 ${W} ${H}`, class: 'fg-svg', role: 'img' });
  svg.setAttribute('aria-label', 'Resultado por mes de ' + rows[0].anio + (conExpansion() ? '' : ', sin gastos de expansión') + ': ' + rows.map((r) => MESES[r.numero - 1] + ' ' + (r.resultado === null ? 'sin gastos capturados' : mxn.format(+r.resultado) + (r.provisional ? ' provisional' : ''))).join(', '));
  const gy = svgEl(svg, 'g', { transform: `translate(${M.l},0)` });
  d3.select(gy).call(d3.axisLeft(y).ticks(5).tickFormat(ejeSigno).tickSize(-(W - M.l - M.r)));
  svgEl(svg, 'line', { x1: M.l, x2: W - M.r, y1: y(0), y2: y(0), stroke: 'var(--cds-chart-axis)' });
  const tip = makeTip(wrap);

  rows.forEach((r) => {
    const bx = x(r.mes), bw = x.bandwidth();
    const lab = svgEl(svg, 'text', { x: bx + bw / 2, y: H - M.b + 18, 'text-anchor': 'middle', class: 'sub' });
    lab.textContent = MESES[r.numero - 1].slice(0, 3);
    const lines = [MESES[r.numero - 1][0].toUpperCase() + MESES[r.numero - 1].slice(1) + ' ' + r.anio,
      'Ingresos: ' + mxn.format(+r.ingresos),
      'Gastos operativos: ' + (r.gastos_oper === null ? 'sin captura' : mxn.format(+r.gastos_oper)),
      'Gastos de expansión: ' + (r.gastos_exp === null ? 'sin captura' : mxn.format(+r.gastos_exp)),
      'Resultado' + (r.provisional ? ' provisional' : '') + ': ' + (r.resultado === null ? 'no se calcula' : mxn.format(+r.resultado))];
    if (r.resultado === null) {
      svgEl(svg, 'line', { x1: bx, x2: bx + bw, y1: y(0), y2: y(0), stroke: 'var(--color-fg-muted)', 'stroke-width': 3, 'stroke-linecap': 'round' });
      const t = svgEl(svg, 'text', { x: bx + bw / 2, y: y(0) - 8, 'text-anchor': 'middle', class: 'sub halo' });
      t.textContent = 's/g';
    } else {
      const v = +r.resultado;
      const col = v >= 0 ? 'var(--color-ok)' : 'var(--color-bad)';
      svgEl(svg, 'rect', {
        x: bx, y: Math.min(y(v), y(0)), width: bw, height: Math.max(2, Math.abs(y(v) - y(0))), rx: 3, fill: col,
        'fill-opacity': r.provisional ? 0.35 : 1, stroke: col, 'stroke-width': r.provisional ? 1.5 : 0, 'stroke-dasharray': r.provisional ? '5 3' : 'none',
      });
      const t = svgEl(svg, 'text', { x: bx + bw / 2, y: v >= 0 ? y(v) - 6 : y(v) + 14, 'text-anchor': 'middle', class: 'val halo' });
      t.textContent = signoK(v);
    }
    const hit = svgEl(svg, 'rect', { x: bx - 2, y: M.t, width: bw + 4, height: H - M.t - M.b, fill: 'transparent' });
    hit.addEventListener('pointermove', (ev) => tip.show(ev, lines));
    hit.addEventListener('pointerleave', () => tip.hide());
  });

  const lg = document.createElement('div');
  lg.className = 'fg-legend';
  const sw = (css) => { const s = document.createElement('i'); s.className = 'fg-sw' + (css ? ' ' + css : ''); return s; };
  const ok = sw(); ok.style.background = 'var(--color-ok)'; legendItem(lg, ok, 'Ganancia');
  const bad = sw(); bad.style.background = 'var(--color-bad)'; legendItem(lg, bad, 'Pérdida');
  legendItem(lg, sw('fg-sw--prov'), 'Provisional');
  const sg = document.createElement('span');
  sg.textContent = 's/g: sin gastos capturados';
  lg.appendChild(sg);
  wrap.appendChild(lg);
});


/* ---------- Detalle de ventas: se segrega por tipo de pago o por turno ---------- */

const PAGO_CONCEPTOS = [['membresias', 'Membresías'], ['mercancias', 'Mercancías'], ['otros', 'Otros']];

/* Cada forma de segregar define sus grupos (en el orden en que se dibujan). 'idx' decide la textura y el tono del anillo:
   0 liso, 1 rayas, 2 rayas cruzadas. Para sumar una nueva característica (sucursal, vendedor…) basta con un renglón aquí
   y los datos con esa columna. */
const VENTAS_GRUPOS = {
  pago: [
    { k: 'efectivo', n: 'Pagos en efectivo', corto: 'efectivo', aria: 'en efectivo', idx: 0 },
    { k: 'electronico', n: 'Pagos electrónicos', corto: 'electrónico', aria: 'en medios electrónicos', idx: 1 },
  ],
  turno: [
    { k: 'M', n: 'Turno matutino', corto: 'matutino', aria: 'en el turno matutino', idx: 0 },
    { k: 'V', n: 'Turno vespertino', corto: 'vespertino', aria: 'en el turno vespertino', idx: 1 },
  ],
};
const segregaActual = () => (dash.params().segrega === 'turno' ? 'turno' : 'pago');
const codigoTurno = (r) => String(r.turno === null || r.turno === undefined ? '' : r.turno).trim().toUpperCase() || 'SIN';
const esTurnoBase = (r) => codigoTurno(r) === 'M' || codigoTurno(r) === 'V';
const sumaFilas = (filas, f) => d3.sum(filas, (r) => f(r) || 0);

dash.calc('ventas_detalle', {
  title: 'Ventas del mes por grupo y tipo de ingreso',
  description: 'Membresías, mercancías y otros ingresos del mes elegido, repartidos en los grupos de la característica elegida en "Segregar por": efectivo y electrónico (tarjeta o transferencia), o turno matutino, vespertino y, si el mes los trae, otros turnos (cierres especiales). Con su porcentaje sobre el total del mes.',
  inputs: ['ventas_mes', 'mes_activo'],
  fn: (ventas, activo) => {
    if (!activo.length) return [];
    const mes = activo[0].mes;
    const filas = ventas.filter((r) => String(r.mes) === mes);
    const dim = segregaActual();
    const importe = (r) => (+r.efectivo || 0) + (+r.electronico || 0);
    const grupos = [];
    if (dim === 'pago') {
      VENTAS_GRUPOS.pago.forEach((g) => grupos.push(Object.assign({}, g, { filas, valor: (r) => +r[g.k] || 0 })));
    } else {
      VENTAS_GRUPOS.turno.forEach((g) => grupos.push(Object.assign({}, g, { filas: filas.filter((r) => codigoTurno(r) === g.k), valor: importe })));
      const otras = filas.filter((r) => !esTurnoBase(r));
      if (otras.length) {
        const codigos = Array.from(new Set(otras.map(codigoTurno))).sort().map((c) => (c === 'SIN' ? 'sin turno' : c));
        grupos.push({ k: 'otros', n: 'Otros turnos (' + codigos.join(', ') + ')', corto: 'otros turnos', aria: 'en otros turnos', idx: 2, filas: otras, valor: importe });
      }
    }
    const out = [];
    grupos.forEach((g) => PAGO_CONCEPTOS.forEach(([ck, cn]) => {
      out.push({ dim, clave: g.k, grupo: g.n, corto: g.corto, aria: g.aria, idx: g.idx, concepto: cn, monto: sumaFilas(g.filas.filter((r) => r.concepto === ck), g.valor) });
    }));
    const total = d3.sum(out, (r) => r.monto);
    return out.map((r) => Object.assign(r, { pct: total > 0 ? r.monto / total : null }));
  },
});

dash.calc('ventas_resumen', {
  title: 'Total del mes por grupo',
  description: 'Total de ingresos del mes y cuánto aportó cada grupo de la característica elegida (los dos primeros se muestran en las tarjetas: electrónico y efectivo, o matutino y vespertino; los otros turnos, si existen, van en una línea aparte), con su porcentaje. El total es la suma de los grupos; si el total trae más que el efectivo y el electrónico, la diferencia se avisa como "sin desglosar".',
  inputs: ['ventas_detalle', 'ventas_mes', 'mes_activo'],
  fn: (det, ventas, activo) => {
    if (!activo.length) return [];
    const mes = activo[0].mes;
    const dim = det.length ? det[0].dim : segregaActual();
    const total = d3.sum(det, (r) => r.monto);
    const grupo = (k) => d3.sum(det.filter((r) => r.clave === k), (r) => r.monto);
    const pct = (v) => (total > 0 ? v / total : null);
    const kA = dim === 'pago' ? 'electronico' : 'M';
    const kB = dim === 'pago' ? 'efectivo' : 'V';
    const otros = det.find((r) => r.clave === 'otros');
    const mOtros = otros ? grupo('otros') : 0;
    const registrado = d3.sum(ventas.filter((r) => String(r.mes) === mes), (r) => +r.total || 0);
    return [{
      mes, dim, total,
      a_monto: grupo(kA), a_pct: pct(grupo(kA)),
      b_monto: grupo(kB), b_pct: pct(grupo(kB)),
      tiene_otros: !!otros,
      otros_monto: mOtros, otros_pct: pct(mOtros),
      otros_texto: otros ? otros.grupo + ': ' + mxn.format(mOtros) + (total > 0 ? ' · ' + d3.format('.1%')(mOtros / total) + ' del total' : '') : null,
      sin_desglosar: Math.max(0, Math.round((registrado - total) * 100) / 100),
    }];
  },
});

const pagosRes = () => {
  const g = dash.data('ventas_resumen');
  return g.status === 'ok' && g.data && g.data[0] ? g.data[0] : null;
};
const bindPv = (name, f) => dash.draw(name, (el) => {
  const r = pagosRes();
  const v = r ? f(r) : null;
  el.textContent = v === null || v === undefined ? '—' : v;
});
const pctPago = (v) => (v === null || v === undefined ? null : d3.format('.1%')(v));
bindPv('pv_total', (r) => mxn.format(r.total));
bindPv('pv_a_monto', (r) => mxn.format(r.a_monto));
bindPv('pv_a_pct', (r) => pctPago(r.a_pct));
bindPv('pv_b_monto', (r) => mxn.format(r.b_monto));
bindPv('pv_b_pct', (r) => pctPago(r.b_pct));
bindPv('pv_otros', (r) => r.otros_texto);
bindPv('pv_sin', (r) => mxn.format(r.sin_desglosar));
dash.onData(() => {
  const r = pagosRes();
  const dim = segregaActual();
  document.querySelectorAll('.js-aviso-desglose').forEach((e) => { e.hidden = !(r && r.sin_desglosar > 0.5); });
  document.querySelectorAll('.js-seg-pago').forEach((e) => { e.hidden = dim !== 'pago'; });
  document.querySelectorAll('.js-seg-turno').forEach((e) => { e.hidden = dim !== 'turno'; });
  $('pv-otros').hidden = !(dim === 'turno' && r && r.tiene_otros);
  if ($('selSegrega').value !== dim) $('selSegrega').value = dim;
});
$('selSegrega').addEventListener('change', () => dash.setParams({ segrega: $('selSegrega').value === 'turno' ? 'turno' : null }));

/* Un tono por concepto (como en el resto del tablero). El segundo grupo lleva rayas y el tercero rayas cruzadas, así no dependen solo del color. */
const colorPago = (concepto) => dash.colors[Math.max(0, PAGO_CONCEPTOS.findIndex((c) => c[1] === concepto))];
const ANILLO_VENTAS = ['var(--color-fg)', 'var(--color-fg-muted)', 'color-mix(in srgb, var(--color-fg-muted) 45%, var(--color-panel))'];
const gruposDe = (rows) => {
  const vistos = [];
  rows.forEach((r) => { if (!vistos.some((g) => g.clave === r.clave)) vistos.push({ clave: r.clave, nombre: r.grupo, idx: r.idx }); });
  return vistos;
};

dash.draw('chartPagos', (el) => {
  const g = dash.data('ventas_detalle');
  el.classList.toggle('dash-skeleton', g.status === 'loading');
  if (g.status === 'loading') return;
  el.replaceChildren();
  if (g.status === 'error') { el.appendChild(note('No se pudo cargar el detalle de ventas.')); return; }
  if (g.status !== 'ok') return;
  const rows = g.data;
  const total = d3.sum(rows, (r) => r.monto);
  if (!rows.length || total <= 0) { el.appendChild(note('Este mes no tiene ingresos registrados.')); return; }
  const porTurno = rows[0].dim === 'turno';

  const S = Math.max(240, Math.min(320, el.clientWidth));
  const R = S / 2 - 16;
  const wrap = document.createElement('div');
  wrap.className = 'fg-pie';
  el.appendChild(wrap);
  const box = document.createElement('div');
  box.style.position = 'relative';
  box.style.width = S + 'px';
  box.style.maxWidth = '100%';
  wrap.appendChild(box);

  const svg = svgEl(box, 'svg', { viewBox: `0 0 ${S} ${S}`, class: 'fg-svg', role: 'img' });
  svg.setAttribute('aria-label', (porTurno ? 'Ventas del mes por turno: ' : 'Ingresos del mes por forma de pago: ') + rows.map((r) => r.concepto + ' ' + r.aria + ' ' + pctPago(r.pct)).join(', '));
  const defs = svgEl(svg, 'defs', {});
  [['pv-rayas', 45], ['pv-rayas2', -45]].forEach(([id, giro]) => {
    const pat = svgEl(defs, 'pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(' + giro + ')' });
    svgEl(pat, 'rect', { width: 2.5, height: 6, fill: 'var(--color-panel)', 'fill-opacity': 0.6 });
  });
  const gg = svgEl(svg, 'g', { transform: `translate(${S / 2},${S / 2})` });
  const tip = makeTip(box);

  const arcos = d3.pie().sort(null).value((r) => r.monto)(rows);
  const arco = d3.arc().innerRadius(0).outerRadius(R);
  arcos.forEach((a) => {
    if (a.data.monto <= 0) return;
    const col = colorPago(a.data.concepto);
    const lines = [a.data.concepto + ' · ' + a.data.corto, mxn.format(a.data.monto), pctPago(a.data.pct) + ' del total'];
    const capas = [svgEl(gg, 'path', { d: arco(a), 'stroke-width': 2, style: 'fill:' + col + ';stroke:var(--color-panel)' })];
    if (a.data.idx > 0) capas.push(svgEl(gg, 'path', { d: arco(a), fill: a.data.idx === 1 ? 'url(#pv-rayas)' : 'url(#pv-rayas2)', stroke: 'none' }));
    capas.forEach((p) => {
      p.addEventListener('pointermove', (ev) => tip.show(ev, lines));
      p.addEventListener('pointerleave', () => tip.hide());
    });
    if (a.endAngle - a.startAngle > 0.4) {
      const [cx, cy] = d3.arc().innerRadius(R * 0.62).outerRadius(R * 0.62).centroid(a);
      const t = svgEl(gg, 'text', { x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'val halo', 'pointer-events': 'none' });
      t.textContent = pctPago(a.data.pct);
    }
  });
  const grupos = gruposDe(rows);
  /* Anillo exterior: marca qué rebanadas son de cada grupo (van seguidas). */
  grupos.forEach((gr) => {
    const del = arcos.filter((a) => a.data.clave === gr.clave && a.data.monto > 0);
    if (!del.length) return;
    const ring = d3.arc().innerRadius(R + 4).outerRadius(R + 9)({ startAngle: d3.min(del, (a) => a.startAngle), endAngle: d3.max(del, (a) => a.endAngle) });
    svgEl(gg, 'path', { d: ring, style: 'fill:' + ANILLO_VENTAS[gr.idx] });
  });

  /* Leyenda agrupada: cada grupo con su total y porcentaje. */
  const lg = document.createElement('div');
  lg.className = 'fg-pielg';
  grupos.forEach((gr) => {
    const filasG = rows.filter((r) => r.clave === gr.clave);
    const sub = d3.sum(filasG, (r) => r.monto);
    const col = document.createElement('div');
    const h = document.createElement('p');
    h.className = 'fg-pielg-h';
    const anillo = document.createElement('i');
    anillo.className = 'fg-pielg-anillo';
    anillo.style.background = ANILLO_VENTAS[gr.idx];
    h.appendChild(anillo);
    h.appendChild(document.createTextNode(gr.nombre + ' · ' + pctPago(sub / total) + ' · ' + mxn.format(sub)));
    col.appendChild(h);
    filasG.forEach((r) => {
      const fila = document.createElement('div');
      fila.className = 'fg-pielg-fila';
      const sw = document.createElement('i');
      sw.className = 'fg-sw' + (gr.idx === 1 ? ' fg-sw--rayas' : gr.idx === 2 ? ' fg-sw--rayas2' : '');
      sw.style.setProperty('--c', colorPago(r.concepto));
      const n = document.createElement('span');
      n.textContent = r.concepto;
      const v = document.createElement('span');
      v.className = 'fg-pielg-v';
      v.textContent = mxn.format(r.monto) + ' · ' + pctPago(r.pct);
      fila.append(sw, n, v);
      col.appendChild(fila);
    });
    lg.appendChild(col);
  });
  wrap.appendChild(lg);
});

dash.draw('tbodyPagos', (tb) => {
  const g = dash.data('ventas_detalle');
  tb.replaceChildren();
  if (g.status !== 'ok') return;
  const res = pagosRes();
  if (!res) return;
  const fila = (cls, key, celdas) => {
    const tr = document.createElement('tr');
    tr.className = cls;
    tr.dataset.key = key;
    celdas.forEach((t, i) => {
      const td = document.createElement('td');
      if (i > 0) td.className = 'num';
      td.textContent = t;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  };
  gruposDe(g.data).forEach((gr) => {
    const th = document.createElement('tr');
    th.className = 'is-grupo';
    th.dataset.key = 'grupo,' + gr.clave;
    const c = document.createElement('th');
    c.colSpan = 3;
    c.scope = 'colgroup';
    c.textContent = gr.nombre;
    th.appendChild(c);
    tb.appendChild(th);
    const filasG = g.data.filter((r) => r.clave === gr.clave);
    filasG.forEach((r) => fila('', gr.clave + ',' + r.concepto, [r.concepto, mxn.format(r.monto), pctPago(r.pct) || '—']));
    const sub = d3.sum(filasG, (r) => r.monto);
    fila('is-total', gr.clave + ',subtotal', ['Subtotal', mxn.format(sub), res.total > 0 ? pctPago(sub / res.total) : '—']);
  });
  fila('is-total is-total-grupo', 'total', ['Total de ingresos', mxn.format(res.total), res.total > 0 ? '100.0%' : '—']);
});

/* ---------- Detalle de gastos: operativos contra expansión ---------- */

const GASTO_GRUPOS = [['operativos', 'Gastos operativos'], ['expansion', 'Gastos de expansión']];

dash.calc('gastos_mes', {
  title: 'Gastos del mes por categoría',
  description: 'Cada categoría de gasto del mes elegido, con el nombre con que se registró, separada en gastos operativos (Nómina, Renta, Servicios, Insumos, Mercancía) y gastos de expansión (todo lo demás), con su porcentaje sobre el total de gastos del mes.',
  inputs: ['egresos_mensual', 'mes_activo'],
  fn: (egresos, activo) => {
    if (!activo.length) return [];
    const eg = egresos.filter((r) => r.mes === activo[0].mes && +r.monto !== 0);
    if (eg.length && eg[0].estado === 'sin captura') return [];
    const oper = eg.filter((r) => esOper(r.categoria)).sort((a, b) => ordenOper(a.categoria) - ordenOper(b.categoria));
    const expa = eg.filter((r) => !esOper(r.categoria)).sort(porNombre);
    const total = d3.sum(eg, (r) => +r.monto);
    const fila = (clave, nombre) => (r) => ({ grupo: nombre, clave, concepto: r.categoria, monto: +r.monto, pct: total !== 0 ? +r.monto / total : null });
    return [...oper.map(fila('operativos', 'Gastos operativos')), ...expa.map(fila('expansion', 'Gastos de expansión'))];
  },
});

dash.calc('gastos_resumen', {
  title: 'Total de gastos del mes: operativos y de expansión',
  description: 'Total de gastos del mes y cuánto fue gasto operativo y cuánto de expansión, con su porcentaje. "sin captura" si el mes no tiene gastos registrados.',
  inputs: ['gastos_mes', 'egresos_mensual', 'mes_activo'],
  fn: (gastos, egresos, activo) => {
    if (!activo.length) return [];
    const mes = activo[0].mes;
    const eg = egresos.filter((r) => r.mes === mes);
    const estado = eg.length ? eg[0].estado : 'sin captura';
    const grupo = (k) => d3.sum(gastos.filter((r) => r.clave === k), (r) => r.monto);
    const oper = grupo('operativos');
    const expa = grupo('expansion');
    const total = oper + expa;
    return [{
      mes, estado, total, operativos: oper, expansion: expa,
      pct_operativos: total !== 0 ? oper / total : null,
      pct_expansion: total !== 0 ? expa / total : null,
    }];
  },
});

const gastosRes = () => {
  const g = dash.data('gastos_resumen');
  return g.status === 'ok' && g.data && g.data[0] ? g.data[0] : null;
};
const bindGv = (name, f) => dash.draw(name, (el) => {
  const r = gastosRes();
  const v = r && r.estado !== 'sin captura' ? f(r) : null;
  el.textContent = v === null || v === undefined ? '—' : v;
});
bindGv('gv_total', (r) => mxn.format(r.total));
bindGv('gv_oper_monto', (r) => mxn.format(r.operativos));
bindGv('gv_oper_pct', (r) => pctPago(r.pct_operativos));
bindGv('gv_exp_monto', (r) => mxn.format(r.expansion));
bindGv('gv_exp_pct', (r) => pctPago(r.pct_expansion));

dash.draw('chartGastos', (el) => {
  const g = dash.data('gastos_mes');
  el.classList.toggle('dash-skeleton', g.status === 'loading');
  if (g.status === 'loading') return;
  el.replaceChildren();
  if (g.status === 'error') { el.appendChild(note('No se pudo cargar el detalle de gastos.')); return; }
  if (g.status !== 'ok') return;
  const rows = g.data;
  const total = d3.sum(rows, (r) => r.monto);
  if (!rows.length || total <= 0) { el.appendChild(note('Este mes no tiene gastos capturados.')); return; }
  _colores = mapaColores();

  const S = Math.max(240, Math.min(320, el.clientWidth));
  const R = S / 2 - 16;
  const wrap = document.createElement('div');
  wrap.className = 'fg-pie';
  el.appendChild(wrap);
  const box = document.createElement('div');
  box.style.position = 'relative';
  box.style.width = S + 'px';
  box.style.maxWidth = '100%';
  wrap.appendChild(box);

  const svg = svgEl(box, 'svg', { viewBox: `0 0 ${S} ${S}`, class: 'fg-svg', role: 'img' });
  svg.setAttribute('aria-label', 'Gastos del mes por categoría: ' + rows.map((r) => r.concepto + ' (' + (r.clave === 'operativos' ? 'operativo' : 'expansión') + ') ' + pctPago(r.pct)).join(', '));
  const defs = svgEl(svg, 'defs', {});
  const pat = svgEl(defs, 'pattern', { id: 'gv-rayas', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  svgEl(pat, 'rect', { width: 2.5, height: 6, fill: 'var(--color-panel)', 'fill-opacity': 0.6 });
  const gg = svgEl(svg, 'g', { transform: `translate(${S / 2},${S / 2})` });
  const tip = makeTip(box);

  const arcos = d3.pie().sort(null).value((r) => Math.max(0, r.monto))(rows);
  const arco = d3.arc().innerRadius(0).outerRadius(R);
  arcos.forEach((a) => {
    if (a.data.monto <= 0) return;
    const lines = [a.data.concepto, a.data.grupo, mxn.format(a.data.monto), pctPago(a.data.pct) + ' del total'];
    const capas = [svgEl(gg, 'path', { d: arco(a), 'stroke-width': 2, style: 'fill:' + colorDe(a.data.concepto) + ';stroke:var(--color-panel)' })];
    if (a.data.clave === 'expansion') capas.push(svgEl(gg, 'path', { d: arco(a), fill: 'url(#gv-rayas)', stroke: 'none' }));
    capas.forEach((p) => {
      p.addEventListener('pointermove', (ev) => tip.show(ev, lines));
      p.addEventListener('pointerleave', () => tip.hide());
    });
    if (a.endAngle - a.startAngle > 0.4) {
      const [cx, cy] = d3.arc().innerRadius(R * 0.62).outerRadius(R * 0.62).centroid(a);
      const t = svgEl(gg, 'text', { x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'val halo', 'pointer-events': 'none' });
      t.textContent = pctPago(a.data.pct);
    }
  });
  /* Anillo exterior: agrupa las rebanadas operativas y las de expansión (van seguidas). */
  GASTO_GRUPOS.forEach(([gk], i) => {
    const del = arcos.filter((a) => a.data.clave === gk && a.data.monto > 0);
    if (!del.length) return;
    const ring = d3.arc().innerRadius(R + 4).outerRadius(R + 9)({ startAngle: d3.min(del, (a) => a.startAngle), endAngle: d3.max(del, (a) => a.endAngle) });
    svgEl(gg, 'path', { d: ring, style: 'fill:' + (i === 0 ? 'var(--color-fg)' : 'var(--color-fg-muted)') });
  });

  const lg = document.createElement('div');
  lg.className = 'fg-pielg';
  GASTO_GRUPOS.forEach(([gk, gn], i) => {
    const filasG = rows.filter((r) => r.clave === gk);
    const sub = d3.sum(filasG, (r) => r.monto);
    const col = document.createElement('div');
    const h = document.createElement('p');
    h.className = 'fg-pielg-h';
    const anillo = document.createElement('i');
    anillo.className = 'fg-pielg-anillo';
    anillo.style.background = i === 0 ? 'var(--color-fg)' : 'var(--color-fg-muted)';
    h.appendChild(anillo);
    h.appendChild(document.createTextNode(gn + ' · ' + pctPago(sub / total) + ' · ' + mxn.format(sub)));
    col.appendChild(h);
    if (!filasG.length) {
      const vacio = document.createElement('div');
      vacio.className = 'fg-pielg-fila';
      vacio.textContent = 'Sin gastos este mes';
      col.appendChild(vacio);
    }
    filasG.forEach((r) => {
      const fila = document.createElement('div');
      fila.className = 'fg-pielg-fila';
      const sw = document.createElement('i');
      sw.className = 'fg-sw' + (gk === 'expansion' ? ' fg-sw--rayas' : '');
      sw.style.setProperty('--c', colorDe(r.concepto));
      const n = document.createElement('span');
      n.textContent = r.concepto;
      const v = document.createElement('span');
      v.className = 'fg-pielg-v';
      v.textContent = mxn.format(r.monto) + ' · ' + pctPago(r.pct);
      fila.append(sw, n, v);
      col.appendChild(fila);
    });
    lg.appendChild(col);
  });
  wrap.appendChild(lg);
});

dash.draw('tbodyGastos', (tb) => {
  const g = dash.data('gastos_mes');
  tb.replaceChildren();
  if (g.status !== 'ok') return;
  const res = gastosRes();
  if (!res || res.estado === 'sin captura') return;
  const fila = (cls, key, celdas) => {
    const tr = document.createElement('tr');
    tr.className = cls;
    tr.dataset.key = key;
    celdas.forEach((t, i) => {
      const td = document.createElement('td');
      if (i > 0) td.className = 'num';
      td.textContent = t;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  };
  GASTO_GRUPOS.forEach(([gk, gn]) => {
    const th = document.createElement('tr');
    th.className = 'is-grupo';
    th.dataset.key = 'grupo,' + gk;
    const c = document.createElement('th');
    c.colSpan = 3;
    c.scope = 'colgroup';
    c.textContent = gn;
    th.appendChild(c);
    tb.appendChild(th);
    const filasG = g.data.filter((r) => r.clave === gk);
    if (!filasG.length) fila('', gk + ',vacio', ['Sin gastos este mes', mxn.format(0), '—']);
    filasG.forEach((r) => fila('', gk + ',' + encodeURIComponent(r.concepto), [r.concepto, mxn.format(r.monto), pctPago(r.pct) || '—']));
    fila('is-total', gk + ',subtotal', ['Subtotal', mxn.format(gk === 'operativos' ? res.operativos : res.expansion), pctPago(gk === 'operativos' ? res.pct_operativos : res.pct_expansion) || '—']);
  });
  fila('is-total is-total-grupo', 'total', ['Total de gastos', mxn.format(res.total), res.total !== 0 ? '100.0%' : '—']);
});

/* ---------- Acceso ---------- */
/* El servidor comprueba usuario y contraseña contra la tabla usuarios (la contraseña se compara por su SHA-256)
   y solo entrega datos a quien tiene sesión. Aquí solo se muestra el formulario o el tablero. */

let sesion = null;

const mensajeLogin = (cual) => { ['bad', 'espera', 'err'].forEach((n) => { $('msg-login-' + n).hidden = n !== cual; }); };

dash.draw('lblUsuario', (el) => { el.textContent = sesion || '—'; });

const entrar = (nombre, perfilUsuario) => {
  sesion = nombre;
  perfil = perfilUsuario || 'user';
  SOLO_ADMIN.forEach((n) => { $('btn-' + n).hidden = perfil !== 'admin'; });
  $('metas-ayuda-admin').hidden = perfil !== 'admin';
  $('metas-ayuda-user').hidden = perfil === 'admin';
  $('metas-editor').hidden = perfil !== 'admin';
  if (window.Admin) window.Admin.iniciar(perfil, nombre);
  mostrarTab(tabInicial());
  mensajeLogin(null);
  $('login').hidden = true;
  $('app').hidden = false;
  dash.redraw();
  dash.iniciar();
};

const mostrarLogin = () => {
  sesion = null;
  perfil = null;
  if (window.Admin) window.Admin.detener();
  dash.detener();
  $('l-pass').value = '';
  $('app').hidden = true;
  $('login').hidden = false;
  $('l-user').focus();
};

$('formLogin').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('btnLogin').disabled = true;
  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ usuario: $('l-user').value.trim(), clave: $('l-pass').value }),
    });
    $('l-pass').value = '';
    if (resp.ok) { const c = await resp.json(); $('l-user').value = ''; entrar(c.usuario, c.perfil); }
    else mensajeLogin(resp.status === 401 ? 'bad' : resp.status === 429 ? 'espera' : 'err');
  } catch (e) {
    mensajeLogin('err');
  } finally {
    $('btnLogin').disabled = false;
  }
});

$('btnSalir').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* sin red */ }
  mostrarLogin();
});

window.addEventListener('dash:sesion-vencida', mostrarLogin);

/* Al abrir la página: ¿ya hay una sesión válida? */
fetch('/api/sesion', { credentials: 'same-origin', cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((c) => { if (c && c.usuario) entrar(c.usuario, c.perfil); else $('l-user').focus(); })
  .catch(() => {});
