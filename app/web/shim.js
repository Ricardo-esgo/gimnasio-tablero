/* Motor mínimo de datos del tablero.
   Ofrece la misma interfaz que usa page.js (dash.calc, dash.draw, dash.onData, dash.data, dash.params…),
   pero los datos vienen del servidor, que lee el Excel en cada petición.
   - Cada vez que cambia un filtro, una pestaña o la ventana se vuelve a pedir el Excel.
   - Además se consulta cada INTERVALO_MS por si el archivo cambió mientras la página estaba abierta. */
(function () {
  'use strict';
  const INTERVALO_MS = 15000;
  const FUENTES = ['ingresos_diarios', 'egresos_mensual', 'ventas_mes', 'metas'];

  const calcs = {};
  const dibujos = {};
  const alDatos = [];
  const montados = new WeakMap();
  let fuentes = {};
  let estado = 'loading'; // loading | ok | error | auth
  let mensaje = '';
  let params = {};
  let memo = new Map();
  let ultimaHuella = '';
  let enVuelo = false;
  let otraVez = false;
  let leidoEn = null;
  let advertencia = null;

  const paleta = {
    claro: ['#257de0', '#f47230', '#00b894', '#f2a600', '#ee7fac', '#008a17', '#6a4ce2', '#ec4647'],
    oscuro: ['#338ced', '#e76624', '#00a888', '#d28e05', '#e24d8b', '#0aac23', '#9887ef', '#eb6263'],
  };
  const oscuro = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  function resolver(id) {
    if (memo.has(id)) return memo.get(id);
    let r;
    if (FUENTES.includes(id)) {
      r = estado === 'ok' || (estado === 'error' && fuentes[id])
        ? { status: 'ok', data: fuentes[id] || [] }
        : { status: estado === 'error' ? 'error' : 'loading', data: [], message: mensaje };
    } else if (calcs[id]) {
      const ins = calcs[id].inputs.map(resolver);
      const falla = ins.find((x) => x.status !== 'ok');
      if (falla) r = { status: falla.status, data: null, message: falla.message };
      else {
        try { r = { status: 'ok', data: calcs[id].fn(...ins.map((x) => x.data)) }; }
        catch (e) { console.error('Cálculo', id, e); r = { status: 'error', data: null, message: String(e && e.message || e) }; }
      }
    } else {
      r = { status: 'missing', data: [], message: 'No existe ' + id };
    }
    memo.set(id, r);
    return r;
  }

  function dibujar(nombre) {
    const d = dibujos[nombre];
    if (!d) return;
    document.querySelectorAll('[data-draw="' + nombre + '"]').forEach((el) => {
      if (el.closest('[hidden]')) return; // lo oculto no se dibuja hasta que se muestre
      try {
        if (typeof d === 'function') d(el);
        else {
          if (!montados.has(el)) montados.set(el, d.mount ? d.mount(el) : undefined);
          if (d.update) d.update(el, montados.get(el));
        }
      } catch (e) { console.error('Dibujo', nombre, e); }
    });
  }
  const dibujarTodo = () => Object.keys(dibujos).forEach(dibujar);

  function emitir() {
    memo = new Map();
    alDatos.forEach((f) => { try { f(); } catch (e) { console.error('onData', e); } });
    dibujarTodo();
  }

  async function cargar() {
    if (enVuelo) { otraVez = true; return; }
    enVuelo = true;
    try {
      const resp = await fetch('/api/datos', { cache: 'no-store', credentials: 'same-origin' });
      if (resp.status === 401) {
        estado = 'auth';
        window.dispatchEvent(new CustomEvent('dash:sesion-vencida'));
        return;
      }
      const cuerpo = await resp.json();
      if (!resp.ok) throw new Error(cuerpo.error || 'No se pudieron leer los datos.');
      const huella = JSON.stringify([cuerpo.ingresos_diarios, cuerpo.egresos_mensual, cuerpo.ventas_mes, cuerpo.metas, cuerpo.advertencia]);
      leidoEn = cuerpo.leido_en;
      const cambio = huella !== ultimaHuella || estado !== 'ok';
      ultimaHuella = huella;
      fuentes = { ingresos_diarios: cuerpo.ingresos_diarios, egresos_mensual: cuerpo.egresos_mensual, ventas_mes: cuerpo.ventas_mes, metas: cuerpo.metas };
      advertencia = cuerpo.advertencia || null;
      estado = 'ok';
      mensaje = '';
      if (cambio) emitir();
      window.dispatchEvent(new CustomEvent('dash:leido', { detail: { leidoEn, advertencia, cambio } }));
    } catch (e) {
      mensaje = String(e && e.message || e);
      if (!fuentes.ingresos_diarios) estado = 'error';
      emitir();
      window.dispatchEvent(new CustomEvent('dash:leido', { detail: { error: mensaje } }));
    } finally {
      enVuelo = false;
      if (otraVez) { otraVez = false; cargar(); }
    }
  }

  window.dash = {
    calc(id, def) { calcs[id] = { inputs: def.inputs || [], fn: def.fn }; },
    draw(nombre, def) {
      if (def === undefined) { dibujar(nombre); return; }
      dibujos[nombre] = def;
    },
    onData(fn) { alDatos.push(fn); try { fn(); } catch (e) { console.error('onData', e); } },
    data(id) { return resolver(id); },
    params() { return Object.assign({}, params); },
    setParams(obj) {
      Object.keys(obj).forEach((k) => { if (obj[k] === null || obj[k] === undefined) delete params[k]; else params[k] = obj[k]; });
      emitir(); // se dibuja al instante con lo que ya se tiene…
      cargar(); // …y se vuelve a leer el Excel para confirmar que sigue igual
    },
    resetParams() { params = {}; emitir(); cargar(); },
    setLink(nombre) { try { history.replaceState(null, '', '#' + nombre); } catch (e) { /* sin historial */ } cargar(); },
    refresh() { return cargar(); },
    redraw: dibujarTodo,
    get colors() { return oscuro() ? paleta.oscuro : paleta.claro; },
    get leidoEn() { return leidoEn; },
    get advertencia() { return advertencia; },
    get estado() { return estado; },
    iniciar() { cargar(); },
    detener() { estado = 'auth'; fuentes = {}; ultimaHuella = ''; memo = new Map(); },
  };

  let t = null;
  const volver = () => { clearTimeout(t); t = setTimeout(dibujarTodo, 150); };
  window.addEventListener('resize', volver);
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(dibujarTodo);
  }
  if (window.ResizeObserver) {
    let ancho = 0;
    new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w !== ancho) { ancho = w; volver(); } }).observe(document.documentElement);
  }
  setInterval(() => { if (estado !== 'auth' && !document.hidden) cargar(); }, INTERVALO_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && estado !== 'auth') cargar(); });
})();
