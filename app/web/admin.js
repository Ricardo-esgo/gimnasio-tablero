/* Pantallas de administración: Revisión (ingresos y egresos), Usuarios y edición de Metas. Solo las ve el perfil admin.
   Reglas que cumple esta pantalla (el servidor las vuelve a verificar, aquí solo se muestran):
   - Un registro revisado (o un usuario activo) está bloqueado: se muestra como texto. Quitarle la palomita se guarda de inmediato
     y lo vuelve editable; ahí aparece el botón Eliminar.
   - Las filas editables o nuevas no se guardan hasta pulsar Guardar. Si el servidor encuentra advertencias, se piden confirmar.
   - Nada de lo que se escribe en una contraseña se conserva: al guardar o salir se borra del formulario. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const nombreMes = (m) => (/^\d{4}-\d{2}$/.test(m) ? MESES[+m.slice(5) - 1] + ' ' + m.slice(0, 4) : m);
  const num = (v) => { const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

  /* Construye elementos sin innerHTML: todo texto entra como texto. */
  const h = (tag, attrs, ...hijos) => {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    hijos.flat().forEach((c) => { if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  };
  const vaciar = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const poner = (raiz, ...xs) => raiz.append(...xs.filter((x) => x !== null && x !== undefined && x !== false));

  const api = async (metodo, ruta, cuerpo) => {
    let r;
    try {
      r = await fetch(ruta, {
        method: metodo, credentials: 'same-origin', cache: 'no-store',
        headers: cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      });
    } catch (e) {
      return { ok: false, status: 0, datos: { error: 'No hay conexión con el servidor. Inténtalo otra vez.' } };
    }
    let datos = {};
    try { datos = await r.json(); } catch (e) { /* sin cuerpo */ }
    if (r.status === 401) window.dispatchEvent(new Event('dash:sesion-vencida'));
    return { ok: r.ok, status: r.status, datos };
  };

  /* ---------- Cuadro de diálogo ---------- */
  /* dialogo({titulo, parrafos, lista, campos:[{id,etiqueta,tipo}], aceptar, cancelar, peligro}) -> Promise<{ok, valores}> */
  const dialogo = (o) => new Promise((resolve) => {
    const dlg = $('adm-dialogo');
    vaciar(dlg);
    const campos = (o.campos || []).map((c) => ({ c, input: h('input', { class: 'fg-in', type: c.tipo || 'text', id: 'adm-d-' + c.id, autocomplete: 'new-password', required: true }) }));
    const msg = h('p', { class: 'fg-msg fg-msg--bad', role: 'alert', hidden: true });
    const form = h('form', { method: 'dialog', class: 'adm-dlg-form' },
      h('h2', { class: 'fg-h', text: o.titulo }),
      (o.parrafos || []).map((t) => h('p', { class: 'fg-cap', text: t })),
      o.lista && o.lista.length ? h('ul', { class: 'adm-dlg-lista' }, o.lista.map((t) => h('li', { text: t }))) : null,
      campos.map(({ c, input }) => h('label', { for: input.id, class: 'adm-dlg-lbl' }, c.etiqueta, input)),
      msg,
      h('div', { class: 'fg-actions' },
        o.sinCancelar ? null : h('button', { type: 'button', class: 'fg-btn', id: 'adm-d-cancelar', text: o.cancelar || 'Cancelar', onclick: () => dlg.close('cancelar') }),
        h('button', { type: 'submit', value: 'aceptar', class: 'fg-btn ' + (o.peligro ? 'fg-btn--bad' : 'fg-btn--pri'), id: 'adm-d-aceptar', text: o.aceptar || 'Aceptar' })));
    form.addEventListener('submit', () => { dlg.returnValue = 'aceptar'; });
    dlg.append(form);
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'aceptar';
      const valores = {};
      campos.forEach(({ c, input }) => { valores[c.id] = input.value; input.value = ''; });
      vaciar(dlg);
      resolve({ ok, valores });
    }, { once: true });
    dlg.returnValue = 'cancelar';
    dlg.showModal();
    const primero = campos[0] ? campos[0].input : $(o.sinCancelar ? 'adm-d-aceptar' : 'adm-d-cancelar');
    primero.focus();
  });

  /* Bloquea toda la pantalla con un cuadro modal (cursor de espera, Esc no lo cierra) mientras corre un proceso largo. */
  const bloquear = (texto) => {
    const dlg = $('adm-dialogo');
    vaciar(dlg);
    const msg = h('p', { class: 'fg-cap', role: 'status', id: 'adm-espera-texto', text: texto });
    dlg.classList.add('fg-dialog--espera');
    dlg.append(h('div', { class: 'adm-dlg-form' }, h('h2', { class: 'fg-h', text: 'Un momento' }), msg));
    const noCerrar = (ev) => ev.preventDefault();
    dlg.addEventListener('cancel', noCerrar);
    dlg.returnValue = 'espera';
    dlg.showModal();
    return {
      texto: (t) => { msg.textContent = t; },
      // Se espera al evento 'close': si llegara tarde, cerraría el siguiente cuadro que se abra.
      cerrar: () => new Promise((fin) => {
        dlg.removeEventListener('cancel', noCerrar);
        dlg.classList.remove('fg-dialog--espera');
        dlg.addEventListener('close', () => { vaciar(dlg); fin(); }, { once: true });
        dlg.close('espera');
      }),
    };
  };

  /* ---------- Estado general ---------- */
  let perfil = null;
  let yo = null;
  let activa = null;
  const rev = { verRevisados: true, tabla: 'ingresos', mes: null, meses: [], filas: [], sug: { personal: [], turnos: [], tipos_egreso: [] }, aviso: '' };
  const usr = { filas: [], aviso: '' };
  const met = { filas: [], aviso: '' };

  const hayCambios = (filas) => filas.some((f) => f.nuevo || f.sucio);
  const hayCambiosAbiertos = () => hayCambios(rev.filas) || hayCambios(usr.filas) || hayCambios(met.filas);
  const avisoSalir = () => {
    const txt = 'Hay cambios sin guardar. Guárdalos o descártalos antes de salir.';
    [rev, usr, met].forEach((e) => { if (hayCambios(e.filas)) { e.aviso = txt; } });
    pintarTodo();
  };
  window.addEventListener('beforeunload', (ev) => { if (perfil === 'admin' && hayCambiosAbiertos()) { ev.preventDefault(); ev.returnValue = ''; } });

  /* ---------- Piezas comunes ---------- */
  const mensaje = (texto, bueno) => (texto ? h('p', { class: 'fg-msg ' + (bueno ? 'fg-msg--ok' : 'fg-msg--bad'), role: 'status', text: texto }) : null);

  const celdaTexto = (txt, clase) => h('td', { class: clase || '', text: txt === null || txt === undefined || txt === '' ? '—' : String(txt) });

  /* Ancho de los campos de texto: lo justo para el dato más largo de la columna (más un margen para escribir). */
  const anchoCol = {};
  const MIN_ANCHO = { turno: 3, personal: 10, tipo: 6, concepto: 20 };
  const claseCol = (c) => (c.tipo === 'monto' ? 'num' : '') + (c.justa ? ' adm-justa' : '');
  const campoEntrada = (f, c, alCambiar) => {
    const comun = { class: 'fg-in adm-in adm-in--' + c.tipo, 'aria-label': c.t, value: f.v[c.k] === null || f.v[c.k] === undefined ? '' : f.v[c.k] };
    const attrs = c.tipo === 'monto' ? { type: 'number', step: '0.01', inputMode: 'decimal', ...comun }
      : c.tipo === 'fecha' ? { type: 'date', ...comun }
        : { type: 'text', maxLength: c.max || 80, ...comun };
    attrs['data-k'] = c.k;
    const inp = h('input', attrs);
    if (c.lista) inp.setAttribute('list', 'adm-dl-' + c.lista);
    if (c.tipo === 'texto' && anchoCol[c.k]) inp.style.width = 'calc(' + anchoCol[c.k] * (c.justa ? 0.9 : 1) + 'ch + ' + (c.justa ? 10 : 16) + 'px)';
    if (c.justa) inp.classList.add('adm-in--justo');
    inp.addEventListener('input', () => { f.v[c.k] = inp.value; f.sucio = true; f.msg = ''; alCambiar(); });
    return inp;
  };

  /* ================================================================ REVISIÓN */

  const COLS = {
    ingresos: [
      { k: 'fecha', t: 'Fecha', tipo: 'fecha', soloNuevo: true },
      { k: 'turno', t: 'Turno', tipo: 'texto', lista: 'turnos', max: 4, justa: true },
      { k: 'personal', t: 'Personal', tipo: 'texto', lista: 'personal', soloNuevo: true },
      { k: 'mem_efectivo', t: 'Membresías efectivo', tipo: 'monto' },
      { k: 'mem_electronico', t: 'Membresías electrónico', tipo: 'monto' },
      { k: 'mer_efectivo', t: 'Mercancías efectivo', tipo: 'monto' },
      { k: 'mer_electronico', t: 'Mercancías electrónico', tipo: 'monto' },
      { k: 'excedente', t: 'Excedente', tipo: 'monto' },
    ],
    egresos: [
      { k: 'fecha', t: 'Fecha', tipo: 'fecha', soloNuevo: true },
      { k: 'personal', t: 'Personal', tipo: 'texto', lista: 'personal', soloNuevo: true },
      { k: 'tipo', t: 'Tipo', tipo: 'texto', lista: 'tipos', max: 60, justa: true },
      { k: 'concepto', t: 'Concepto', tipo: 'texto', max: 200 },
      { k: 'efectivo', t: 'Efectivo', tipo: 'monto' },
      { k: 'electronico', t: 'Electrónico', tipo: 'monto' },
    ],
  };
  const MONTOS = { ingresos: ['mem_efectivo', 'mem_electronico', 'mer_efectivo', 'mer_electronico', 'excedente'], egresos: ['efectivo', 'electronico'] };
  const EDITABLES = { ingresos: ['turno', 'mem_efectivo', 'mem_electronico', 'mer_efectivo', 'mer_electronico', 'excedente'], egresos: ['tipo', 'concepto', 'efectivo', 'electronico'] };
  const SINGULAR = { ingresos: 'cierre', egresos: 'egreso' };

  const filaDesdeServidor = (s, tabla) => {
    const v = {};
    COLS[tabla].forEach((c) => { v[c.k] = s[c.k]; });
    v.revisado = s.revisado;
    return { srv: s, v, nuevo: false, sucio: false, msg: '' };
  };
  const filaNueva = (tabla) => {
    const v = { revisado: 0 };
    COLS[tabla].forEach((c) => { v[c.k] = c.tipo === 'monto' ? '' : ''; });
    return { srv: null, v, nuevo: true, sucio: true, msg: '' };
  };
  const bloqueada = (f) => !f.nuevo && f.srv.revisado === 1;
  const totalFila = (f, tabla) => MONTOS[tabla].reduce((a, k) => a + num(f.v[k]), 0);

  const cargarRevision = async (tabla, mes) => {
    const r = await api('GET', '/api/admin/revision?tabla=' + encodeURIComponent(tabla) + (mes ? '&mes=' + encodeURIComponent(mes) : ''));
    if (!r.ok) { rev.aviso = r.datos.error || 'No se pudo cargar la revisión.'; pintarRevision(); return; }
    rev.tabla = r.datos.tabla;
    rev.mes = r.datos.mes;
    rev.meses = r.datos.meses;
    rev.sug = r.datos.sugerencias;
    rev.filas = r.datos.filas.map((s) => filaDesdeServidor(s, rev.tabla));
    rev.aviso = '';
    pintarRevision();
  };

  const pintarRevision = () => {
    const raiz = $('adm-revision');
    if (!raiz || perfil !== 'admin') return;
    const tabla = rev.tabla;
    const cols = COLS[tabla];
    cols.forEach((c) => { if (c.tipo === 'texto') anchoCol[c.k] = Math.min(46, Math.max(MIN_ANCHO[c.k] || 8, ...rev.filas.map((f) => String(f.v[c.k] === null || f.v[c.k] === undefined ? '' : f.v[c.k]).length + (c.justa ? 0 : 3)))); });
    const selTabla = h('select', { class: 'dash-select', id: 'rev-tabla', 'aria-label': 'Tabla' },
      h('option', { value: 'ingresos', text: 'Cierre de caja', selected: tabla === 'ingresos' }),
      h('option', { value: 'egresos', text: 'Gasto', selected: tabla === 'egresos' }));
    const meses = rev.meses.slice().reverse();
    const selMes = h('select', { class: 'dash-select', id: 'rev-mes', 'aria-label': 'Mes' },
      meses.length ? meses.map((m) => h('option', { value: m, text: nombreMes(m), selected: m === rev.mes })) : h('option', { value: '', text: 'Sin registros' }));
    const cambiarVista = (sel, revertir) => () => {
      if (hayCambios(rev.filas)) { revertir(); avisoSalir(); return; }
      cargarRevision(selTabla.value, sel === 'tabla' ? null : selMes.value);
    };
    selTabla.addEventListener('change', cambiarVista('tabla', () => { selTabla.value = rev.tabla; }));
    selMes.addEventListener('change', cambiarVista('mes', () => { selMes.value = rev.mes || ''; }));

    const botonAgregar = h('button', { type: 'button', class: 'adm-accion', id: 'rev-agregar', text: tabla === 'ingresos' ? 'Agregar cierre' : 'Agregar gasto', onclick: () => {
      const f = filaNueva(tabla);
      rev.filas.push(f);
      rev.aviso = '';
      pintarRevision();
      const ultima = raiz.querySelector('tr[data-nueva="1"]:last-of-type input');
      if (ultima) ultima.focus();
    } });
    const barra = h('div', { class: 'adm-bar' },
      h('label', { class: 'fg-f' }, h('span', { text: 'Tabla' }), selTabla),
      h('label', { class: 'fg-f' }, h('span', { text: 'Mes' }), selMes),
      h('div', { class: 'adm-der adm-acc' },
        casillaRevisados(),
        botonCoherentes(),
        botonAgregar));

    const cabecera = h('tr', null,
      cols.map((c) => h('th', { class: claseCol(c), text: c.t })),
      h('th', { class: 'num', text: 'Total' }),
      h('th', { text: 'Situación' }),
      h('th', { text: 'Revisado' }),
      h('th', { text: '' }));
    const cuerpo = h('tbody', null);
    if (!visibles().length) cuerpo.append(h('tr', null, h('td', { colspan: cols.length + 4, class: 'fg-empty', text: rev.filas.length ? 'No hay registros sin revisar en este mes.' : 'No hay registros en este mes.' })));
    visibles().forEach((f) => cuerpo.append(...filaRevision(f, tabla, cols)));

    const cuantos = visibles().length;
    const delMes = rev.filas.length;
    const suma = visibles().reduce((a, f) => a + totalFila(f, tabla), 0);
    const pie = h('tfoot', null, h('tr', null,
      h('th', { colspan: cols.length, text: (cuantos === delMes ? cuantos : cuantos + ' de ' + delMes) + (delMes === 1 ? ' registro' : ' registros') }),
      h('td', { class: 'num', id: 'rev-suma', text: mxn.format(suma) }),
      h('td', { colspan: 3 })));

    const dl = (id, lista) => h('datalist', { id: 'adm-dl-' + id }, (lista || []).map((x) => h('option', { value: x })));
    vaciar(raiz);
    poner(raiz,
      barra,
      mensaje(rev.aviso, false),
      h('div', { class: 'fg-scroll adm-grid' }, h('table', { class: 'fg-table adm-tabla', id: 'rev-tabla-datos' }, h('thead', null, cabecera), cuerpo, pie)),
      dl('personal', rev.sug.personal), dl('turnos', rev.sug.turnos), dl('tipos', rev.sug.tipos_egreso));
  };

  /* El estado se guarda como verde / amarillo / rojo; en pantalla se escribe con su nombre. */
  const ETIQUETA_ESTADO = { verde: 'consistente', amarillo: 'inconsistente', rojo: 'error' };

  const filaRevision = (f, tabla, cols) => {
    const bloq = bloqueada(f);
    const estado = f.srv ? f.srv.estado : null;   // semáforo que dejó la carga automática: verde, amarillo o rojo
    // Color de la fila: revisado = verde claro (sin importar el semáforo); sin revisar = según su semáforo (verde sin color, amarillo, rojo).
    const tr = h('tr', { class: bloq ? 'is-locked' : (f.nuevo ? 'is-nueva' : 'is-edicion est-' + (estado || 'verde')), 'data-nueva': f.nuevo ? '1' : null, 'data-id': f.srv ? String(f.srv.id) : null, 'data-estado': estado });
    const totalTd = h('td', { class: 'num adm-total', text: mxn.format(totalFila(f, tabla)) });
    const btnGuardar = h('button', { type: 'button', class: 'fg-btn fg-btn--sm fg-btn--pri adm-guardar', text: 'Guardar' });
    const refrescar = () => {
      if (!f.msg && tr.nextSibling && tr.nextSibling.classList && tr.nextSibling.classList.contains('adm-msgrow')) tr.nextSibling.remove();
      totalTd.textContent = mxn.format(totalFila(f, tabla));
      btnGuardar.disabled = !(f.nuevo || f.sucio) || f.ocupado === true;
      const s = $('rev-suma');
      if (s) s.textContent = mxn.format(visibles().reduce((a, x) => a + totalFila(x, tabla), 0));
    };
    cols.forEach((c) => {
      if (bloq || (c.soloNuevo && !f.nuevo)) {
        const val = f.v[c.k];
        tr.append(h('td', { class: claseCol(c), text: c.tipo === 'monto' ? mxn.format(num(val)) : (val === '' || val === null ? '—' : val) }));
      } else {
        tr.append(h('td', { class: claseCol(c) }, campoEntrada(f, c, refrescar)));
      }
    });
    tr.append(totalTd);

    // Situación de la revisión (semáforo): la fija el análisis automático; aquí solo se muestra, con su texto para no depender del color
    const obs = f.srv && f.srv.carga_obs;
    tr.append(h('td', null, estado
      ? h('span', { class: 'fg-pill fg-pill--' + estado + ' adm-pill', title: obs || ('Situación: ' + ETIQUETA_ESTADO[estado]), text: ETIQUETA_ESTADO[estado] })
      : h('span', { class: 'fg-mut', text: '—' })));

    // Revisado
    const chk = h('input', { type: 'checkbox', checked: f.v.revisado === 1 || f.v.revisado === true, 'aria-label': 'Revisado' });
    chk.addEventListener('change', async () => {
      if (bloq) {   // quitar la palomita de un registro guardado: se guarda de inmediato
        if (chk.checked) { chk.checked = false; return; }
        chk.disabled = true;
        const r = await api('PUT', '/api/admin/' + tabla + '/' + f.srv.id, { cambios: { revisado: 0 } });
        if (r.ok) { const nueva = filaDesdeServidor(r.datos.fila, tabla); nueva.carga = f.carga; Object.assign(f, nueva); rev.aviso = ''; }
        else { chk.checked = true; chk.disabled = false; f.msg = r.datos.error || 'No se pudo quitar la revisión.'; if (r.status === 404) { cargarRevision(rev.tabla, rev.mes); return; } }
        pintarRevision();
      } else {
        f.v.revisado = chk.checked ? 1 : 0;
        f.sucio = true;
        refrescar();
      }
    });
    tr.append(h('td', { class: 'adm-chk' }, chk));

    // Acciones
    const acciones = h('td', { class: 'act' });
    const caja = h('div', { class: 'adm-acc' });
    acciones.append(caja);
    if (!bloq) {
      btnGuardar.addEventListener('click', () => guardarRevision(f, tabla, false));
      caja.append(btnGuardar);
      if (f.nuevo) {
        caja.append(h('button', { type: 'button', class: 'fg-btn fg-btn--sm adm-descartar', text: 'Descartar', onclick: () => { rev.filas = rev.filas.filter((x) => x !== f); pintarRevision(); } }));
      } else {
        caja.append(h('button', { type: 'button', class: 'fg-btn fg-btn--sm fg-btn--bad adm-eliminar', text: 'Eliminar', onclick: () => eliminarRevision(f, tabla) }));
      }
    }
    tr.append(acciones);
    refrescar();
    const filas = [tr];
    if (!bloq && !f.nuevo && estado && estado !== 'verde' && obs) {
      filas.push(h('tr', { class: 'adm-obsrow est-' + estado }, h('td', { colspan: cols.length + 4 }, h('span', { class: 'fg-mut', text: 'Observación del análisis: ' + obs }))));
    }
    if (f.msg) filas.push(h('tr', { class: 'adm-msgrow' }, h('td', { colspan: cols.length + 4 }, mensaje(f.msg, false))));
    return filas;
  };

  const guardarRevision = async (f, tabla, confirmar) => {
    f.ocupado = true;
    f.msg = '';
    let r;
    if (f.nuevo) {
      r = await api('POST', '/api/admin/' + tabla, { datos: { ...f.v, revisado: f.v.revisado ? 1 : 0 }, confirmar });
    } else {
      const cambios = { revisado: f.v.revisado ? 1 : 0 };
      EDITABLES[tabla].forEach((k) => { cambios[k] = f.v[k]; });
      r = await api('PUT', '/api/admin/' + tabla + '/' + f.srv.id, { cambios, confirmar });
    }
    f.ocupado = false;
    if (r.status === 409 && r.datos.requiere_confirmacion) {
      const d = await dialogo({ titulo: 'Revisa antes de guardar', parrafos: ['Se encontró lo siguiente. Si es correcto, puedes guardar de todos modos.'], lista: r.datos.avisos, aceptar: 'Guardar de todos modos', cancelar: 'Volver a editar' });
      if (d.ok) return guardarRevision(f, tabla, true);
      pintarRevision();
      return;
    }
    if (!r.ok) {
      f.msg = r.datos.error || 'No se pudo guardar.';
      if (r.status === 404) { await cargarRevision(rev.tabla, rev.mes); return; }
      pintarRevision();
      return;
    }
    const guardada = r.datos.fila;
    const mesGuardado = String(guardada.fecha).slice(0, 7);
    if (mesGuardado !== rev.mes) {   // la fila pertenece a otro mes: sale de esta lista
      rev.filas = rev.filas.filter((x) => x !== f);
      if (!hayCambios(rev.filas)) { await cargarRevision(tabla, mesGuardado); rev.aviso = ''; return; }
      rev.aviso = 'Se guardó en ' + nombreMes(mesGuardado) + '. Guarda o descarta lo pendiente para ver ese mes.';
      if (!rev.meses.includes(mesGuardado)) { rev.meses.push(mesGuardado); rev.meses.sort(); }
      pintarRevision();
      return;
    }
    const nueva = filaDesdeServidor(guardada, tabla);
    nueva.carga = f.carga || null;
    Object.assign(f, nueva);
    rev.aviso = '';
    pintarRevision();
  };

  /* Aceptar consistentes: a cada registro sin revisar y en verde se le hace lo mismo que al pulsar su Guardar con la palomita puesta.
     Solo se guardan los que el servidor acepta sin errores ni advertencias; los demás quedan como estaban, con los cambios del usuario. */
  const coherentesPendientes = () => rev.filas.filter((f) => !f.nuevo && f.srv.revisado !== 1 && f.srv.estado === 'verde');
  const motivoRechazo = (r) => (r.datos && r.datos.requiere_confirmacion ? r.datos.avisos.join(' ') : ((r.datos && r.datos.error) || 'No se pudo guardar.'));
  const resumenFila = (f, tabla) => (tabla === 'ingresos' ? f.srv.fecha + ' turno ' + f.srv.turno : f.srv.fecha + ' ' + f.srv.tipo + ' (' + f.srv.concepto + ')');

  const aceptarCoherentes = async () => {
    const lista = coherentesPendientes();
    if (!lista.length || rev.ocupado) return;
    rev.ocupado = true;
    const tabla = rev.tabla;
    const espera = bloquear('Revisando y guardando 0 de ' + lista.length + '…');
    const fallidas = [];
    let guardadas = 0;
    try {
      for (let i = 0; i < lista.length; i += 1) {
        const f = lista[i];
        espera.texto('Revisando y guardando ' + (i + 1) + ' de ' + lista.length + '…');
        const cambios = { revisado: 1 };
        EDITABLES[tabla].forEach((k) => { cambios[k] = f.v[k]; });
        const r = await api('PUT', '/api/admin/' + tabla + '/' + f.srv.id, { cambios, confirmar: false });
        if (r.ok) { Object.assign(f, filaDesdeServidor(r.datos.fila, tabla)); guardadas += 1; }
        else { f.v.revisado = 0; f.msg = 'No se aceptó: ' + motivoRechazo(r); fallidas.push(resumenFila(f, tabla) + ': ' + motivoRechazo(r)); }
      }
    } finally {
      await espera.cerrar();
      rev.ocupado = false;
    }
    rev.aviso = '';
    pintarRevision();
    if (fallidas.length) {
      await dialogo({
        titulo: 'No fue posible guardar todos',
        parrafos: ['No fue posible guardar todos debido a inconsistencias en sus datos. Se guardaron ' + guardadas + ' de ' + lista.length + '. Los demás conservan tus cambios y siguen sin revisar; el motivo está bajo cada fila.'],
        lista: fallidas, aceptar: 'Entendido', sinCancelar: true,
      });
    }
  };

  /* Filas que se ven: todas, o solo las sin revisar si se desmarca "Mostrar revisados". */
  const visibles = () => (rev.verRevisados ? rev.filas : rev.filas.filter((f) => !bloqueada(f)));
  const casillaRevisados = () => {
    const c = h('input', { type: 'checkbox', id: 'rev-ver-revisados', checked: rev.verRevisados });
    c.addEventListener('change', () => { rev.verRevisados = c.checked; pintarRevision(); });
    return h('label', { class: 'adm-ver', for: 'rev-ver-revisados' }, c, h('span', { text: 'Mostrar revisados' }));
  };

  const botonCoherentes = () => {
    const n = coherentesPendientes().length;
    return h('button', { type: 'button', class: 'adm-accion adm-accion--ok', id: 'rev-aceptar', text: 'Aceptar consistentes', disabled: n === 0,
      title: n ? 'Marca como revisados y guarda los ' + n + ' registros consistentes sin revisar de esta lista' : 'No hay registros consistentes sin revisar en esta lista', onclick: aceptarCoherentes });
  };

  const eliminarRevision = async (f, tabla) => {
    const resumen = tabla === 'ingresos'
      ? f.srv.fecha + ', turno ' + f.srv.turno + ', ' + f.srv.personal + ', total ' + mxn.format(f.srv.total)
      : f.srv.fecha + ', ' + f.srv.tipo + ' (' + f.srv.concepto + '), total ' + mxn.format(f.srv.total);
    const d = await dialogo({
      titulo: 'Eliminar ' + SINGULAR[tabla], parrafos: ['Vas a eliminar: ' + resumen + '.', 'Se borra de forma definitiva y los indicadores dejarán de contarlo. ¿Continuar?'],
      aceptar: 'Sí, eliminar', cancelar: 'No, conservar', peligro: true,
    });
    if (!d.ok) return;
    const r = await api('DELETE', '/api/admin/' + tabla + '/' + f.srv.id);
    if (r.ok || r.status === 404) { rev.filas = rev.filas.filter((x) => x !== f); rev.aviso = ''; if (!rev.filas.length) { await cargarRevision(tabla, rev.mes); return; } pintarRevision(); return; }
    f.msg = r.datos.error || 'No se pudo eliminar.';
    pintarRevision();
  };

  /* ================================================================ USUARIOS */

  const filaUsuario = (s) => ({ srv: s, v: { user: s.user, perfil: s.perfil || '', activo: s.activo, clave: '' }, nuevo: false, sucio: false, msg: '' });
  const usuarioNuevo = () => ({ srv: null, v: { user: '', perfil: '', activo: 0, clave: '' }, nuevo: true, sucio: true, msg: '' });
  const usrBloqueado = (f) => !f.nuevo && f.srv.activo === 1;
  const esYo = (f) => !f.nuevo && yo && f.srv.user.toLowerCase() === yo.toLowerCase();

  const cargarUsuarios = async () => {
    const r = await api('GET', '/api/admin/usuarios');
    if (!r.ok) { usr.aviso = r.datos.error || 'No se pudo cargar la lista de usuarios.'; pintarUsuarios(); return; }
    usr.filas = r.datos.usuarios.map(filaUsuario);
    usr.aviso = '';
    pintarUsuarios();
  };

  const pintarUsuarios = () => {
    const raiz = $('adm-usuarios');
    if (!raiz || perfil !== 'admin') return;
    const cuerpo = h('tbody', null);
    usr.filas.forEach((f) => cuerpo.append(...filaUsuarioDom(f)));
    vaciar(raiz);
    poner(raiz,
      mensaje(usr.aviso, false),
      h('div', { class: 'fg-scroll' }, h('table', { class: 'fg-table adm-tabla', id: 'usr-tabla' },
        h('thead', null, h('tr', null, ['Usuario', 'Perfil', 'Contraseña', 'Activo', ''].map((t) => h('th', { text: t })))), cuerpo)),
      h('div', { class: 'fg-actions adm-pie' },
        h('button', { type: 'button', class: 'fg-btn fg-btn--pri', id: 'usr-agregar', text: 'Agregar usuario', onclick: () => {
          usr.filas.push(usuarioNuevo()); usr.aviso = ''; pintarUsuarios();
          const ult = raiz.querySelector('tr[data-nueva="1"] input'); if (ult) ult.focus();
        } })));
  };

  const filaUsuarioDom = (f) => {
    const bloq = usrBloqueado(f);
    const tr = h('tr', { class: bloq ? 'is-locked' : (f.nuevo ? 'is-nueva' : 'is-edicion'), 'data-nueva': f.nuevo ? '1' : null, 'data-user': f.srv ? f.srv.user : null });
    const btnGuardar = h('button', { type: 'button', class: 'fg-btn fg-btn--sm fg-btn--pri adm-guardar', text: 'Guardar' });
    const refrescar = () => {
      if (!f.msg && tr.nextSibling && tr.nextSibling.classList && tr.nextSibling.classList.contains('adm-msgrow')) tr.nextSibling.remove();
      btnGuardar.disabled = !(f.nuevo || f.sucio) || f.ocupado === true;
    };
    if (bloq) {
      tr.append(celdaTexto(f.srv.user), celdaTexto(f.srv.perfil), h('td', { class: 'fg-mut', text: '••••••••' }));
    } else {
      const inUser = h('input', { class: 'fg-in adm-in', type: 'text', maxLength: 40, value: f.v.user, 'aria-label': 'Usuario', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
      inUser.addEventListener('input', () => { f.v.user = inUser.value; f.sucio = true; f.msg = ''; refrescar(); });
      const selPerfil = h('select', { class: 'dash-select', 'aria-label': 'Perfil' },
        h('option', { value: '', text: '(sin perfil)', selected: !f.v.perfil }),
        h('option', { value: 'admin', text: 'admin', selected: f.v.perfil === 'admin' }),
        h('option', { value: 'user', text: 'user', selected: f.v.perfil === 'user' }));
      selPerfil.addEventListener('change', () => { f.v.perfil = selPerfil.value; f.sucio = true; f.msg = ''; refrescar(); });
      const inClave = h('input', { class: 'fg-in adm-in', type: 'password', value: '', autocomplete: 'new-password', 'aria-label': 'Nueva contraseña',
        placeholder: f.nuevo ? 'Contraseña' : (f.srv.tiene_clave ? 'Sin cambio' : 'Falta contraseña') });
      inClave.addEventListener('input', () => { f.v.clave = inClave.value; f.sucio = true; f.msg = ''; refrescar(); });
      tr.append(h('td', null, inUser), h('td', null, selPerfil), h('td', null, inClave));
    }
    const chk = h('input', { type: 'checkbox', checked: f.v.activo === 1 || f.v.activo === true, 'aria-label': 'Activo', disabled: bloq && esYo(f), title: bloq && esYo(f) ? 'No puedes inactivar tu propio usuario' : null });
    chk.addEventListener('change', async () => {
      if (bloq) {
        if (chk.checked) { chk.checked = false; return; }
        const d = await dialogo({ titulo: 'Inactivar usuario', parrafos: ['“' + f.srv.user + '” dejará de poder entrar al tablero. Después podrás editarlo y volver a activarlo.'], aceptar: 'Inactivar', cancelar: 'Cancelar', peligro: true });
        if (!d.ok) { chk.checked = true; return; }
        const r = await api('PUT', '/api/admin/usuarios/' + encodeURIComponent(f.srv.user), { datos: { activo: 0 } });
        if (r.ok) { Object.assign(f, filaUsuario(r.datos.usuario)); usr.aviso = ''; }
        else { f.msg = r.datos.error || 'No se pudo inactivar.'; chk.checked = true; }
        pintarUsuarios();
      } else {
        f.v.activo = chk.checked ? 1 : 0; f.sucio = true; f.msg = ''; refrescar();
      }
    });
    tr.append(h('td', { class: 'adm-chk' }, chk));
    const acc = h('td', { class: 'act' });
    const cajaU = h('div', { class: 'adm-acc' });
    acc.append(cajaU);
    if (!bloq) {
      btnGuardar.addEventListener('click', () => guardarUsuario(f));
      cajaU.append(btnGuardar);
      if (f.nuevo) cajaU.append(h('button', { type: 'button', class: 'fg-btn fg-btn--sm adm-descartar', text: 'Descartar', onclick: () => { usr.filas = usr.filas.filter((x) => x !== f); pintarUsuarios(); } }));
    }
    tr.append(acc);
    refrescar();
    const filas = [tr];
    if (f.msg) filas.push(h('tr', { class: 'adm-msgrow' }, h('td', { colspan: 5 }, mensaje(f.msg, false))));
    return filas;
  };

  const guardarUsuario = async (f) => {
    const datos = { user: f.v.user, perfil: f.v.perfil || null, activo: f.v.activo ? 1 : 0 };
    if (f.v.clave) {
      const d = await dialogo({ titulo: 'Confirma la contraseña', parrafos: ['Para guardar la nueva contraseña, vuelve a escribirla.'], campos: [{ id: 'clave2', etiqueta: 'Repite la nueva contraseña', tipo: 'password' }], aceptar: 'Guardar', cancelar: 'Cancelar' });
      if (!d.ok) return;
      datos.clave = f.v.clave;
      datos.clave_confirmacion = d.valores.clave2;
    }
    f.ocupado = true; f.msg = '';
    const r = f.nuevo ? await api('POST', '/api/admin/usuarios', { datos }) : await api('PUT', '/api/admin/usuarios/' + encodeURIComponent(f.srv.user), { datos });
    f.ocupado = false;
    datos.clave = datos.clave_confirmacion = undefined;
    f.v.clave = '';
    if (!r.ok) { f.msg = r.datos.error || 'No se pudo guardar.'; if (r.status === 404) { await cargarUsuarios(); return; } pintarUsuarios(); return; }
    Object.assign(f, filaUsuario(r.datos.usuario));
    usr.aviso = '';
    pintarUsuarios();
  };

  /* ================================================================ METAS */

  const filaMeta = (s) => ({ srv: s, v: { periodo: s.periodo, meta_ingresos: s.meta_ingresos, meta_socios: s.meta_socios, notas: s.notas || '', lectura: s.lectura || '' }, nuevo: false, sucio: false, msg: '' });
  const metaNueva = () => ({ srv: null, v: { periodo: '', meta_ingresos: '', meta_socios: '', notas: '', lectura: '' }, nuevo: true, sucio: true, msg: '' });

  const cargarMetas = async () => {
    const r = await api('GET', '/api/admin/metas');
    if (!r.ok) { met.aviso = r.datos.error || 'No se pudieron cargar las metas.'; pintarMetas(); return; }
    met.filas = r.datos.metas.map(filaMeta);
    met.aviso = '';
    pintarMetas();
  };

  const pintarMetas = () => {
    const raiz = $('adm-metas');
    if (!raiz || perfil !== 'admin') return;
    const cuerpo = h('tbody', null);
    met.filas.forEach((f) => {
      const btn = h('button', { type: 'button', class: 'fg-btn fg-btn--sm fg-btn--pri adm-guardar', text: 'Guardar', disabled: !(f.nuevo || f.sucio) });
      const campo = (k, tipo, etiqueta, extra) => {
        const i = h('input', { class: 'fg-in adm-in adm-in--' + (tipo === 'number' ? 'monto' : 'texto'), type: tipo, step: tipo === 'number' ? '0.01' : null, value: f.v[k] === null || f.v[k] === undefined ? '' : f.v[k], 'aria-label': etiqueta, ...(extra || {}) });
        i.addEventListener('input', () => { f.v[k] = i.value; f.sucio = true; f.msg = ''; btn.disabled = false; });
        return i;
      };
      btn.addEventListener('click', async () => {
        btn.disabled = true; f.msg = '';
        const periodo = f.nuevo ? f.v.periodo : f.srv.periodo;
        const r = await api('PUT', '/api/admin/metas/' + encodeURIComponent(periodo.trim()), { datos: { meta_ingresos: f.v.meta_ingresos, meta_socios: f.v.meta_socios, notas: f.v.notas, lectura: f.v.lectura } });
        if (r.ok) { Object.assign(f, filaMeta(r.datos.meta)); met.aviso = ''; await cargarMetas(); return; }
        f.msg = r.datos.error || 'No se pudo guardar.'; pintarMetas();
      });
      cuerpo.append(h('tr', { class: f.nuevo ? 'is-nueva' : '', 'data-periodo': f.srv ? f.srv.periodo : null },
        h('td', null, f.nuevo ? campo('periodo', 'text', 'Periodo', { placeholder: 'AAAA-MM', maxLength: 8 }) : h('span', { text: f.srv.periodo })),
        h('td', null, campo('meta_ingresos', 'number', 'Meta de ingresos')),
        h('td', null, campo('meta_socios', 'number', 'Meta de socios')),
        h('td', null, campo('notas', 'text', 'Notas', { maxLength: 300 })),
        h('td', { class: 'act' }, btn)));
      if (f.msg) cuerpo.append(h('tr', { class: 'adm-msgrow' }, h('td', { colspan: 5 }, mensaje(f.msg, false))));
    });
    vaciar(raiz);
    poner(raiz,
      mensaje(met.aviso, false),
      h('div', { class: 'fg-scroll' }, h('table', { class: 'fg-table adm-tabla', id: 'met-tabla' },
        h('thead', null, h('tr', null, ['Periodo', 'Meta de ingresos', 'Meta de socios', 'Notas', ''].map((t) => h('th', { text: t })))), cuerpo)),
      h('div', { class: 'fg-actions adm-pie' }, h('button', { type: 'button', class: 'fg-btn', id: 'met-agregar', text: 'Agregar meta', onclick: () => { met.filas.push(metaNueva()); pintarMetas(); } })));
  };

  /* ================================================================ interfaz pública */

  const pintarTodo = () => { pintarRevision(); pintarUsuarios(); pintarMetas(); };

  window.Admin = {
    iniciar(p, nombre) { perfil = p; yo = nombre; activa = null; },
    detener() {
      perfil = null; yo = null; activa = null;
      rev.filas = []; usr.filas = []; met.filas = [];
      ['adm-revision', 'adm-usuarios', 'adm-metas'].forEach((id) => { const e = $(id); if (e) vaciar(e); });
    },
    puedeSalir() {
      if (perfil === 'admin' && hayCambiosAbiertos()) { avisoSalir(); return false; }
      return true;
    },
    activar(nombre) {
      if (perfil !== 'admin') return;
      activa = nombre;
      if (nombre === 'revision') cargarRevision(rev.tabla, rev.mes);
      else if (nombre === 'usuarios') cargarUsuarios();
      else if (nombre === 'metas') cargarMetas();
    },
  };
})();
