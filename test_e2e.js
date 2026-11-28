// Prueba de punta a punta con un navegador real: node test_e2e.js  (el servidor debe estar en BASE_URL)
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8099';
const FOTOS = process.env.FOTOS || '/tmp/e2e-fotos';
require('fs').mkdirSync(FOTOS, { recursive: true });
let fallos = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { fallos++; console.log('  FALLA ' + m); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errores.push(m.text()); });  // los 401/403/409/422 que provoca la prueba a propósito no cuentan
  const entrar = async (u, p) => {
    await page.goto(BASE + '/');
    await page.fill('#l-user', u); await page.fill('#l-pass', p); await page.click('#btnLogin');
    await page.waitForSelector('#app:not([hidden])');
  };

  console.log('Usuario normal (Dan)');
  await entrar('Dan', 'clave-dan');
  ok(await page.isHidden('#btn-revision'), 'Dan no ve Revisión');
  ok(await page.isHidden('#btn-usuarios'), 'Dan no ve Usuarios');
  ok(await page.isVisible('#btn-metas'), 'Dan ve Metas');
  ok(await page.isHidden('#metas-editor'), 'Dan no ve el editor de metas');
  await page.goto(BASE + '/#revision'); await page.reload(); await page.waitForSelector('#app:not([hidden])');
  ok(await page.isVisible('#tab-resumen'), 'Dan no puede abrir #revision por la URL');
  const r = await page.evaluate(() => fetch('/api/admin/revision').then((x) => x.status));
  ok(r === 403, 'el servidor rechaza a Dan (403)');
  await page.click('#btnSalir');

  console.log('Administrador (Ricardo)');
  await entrar('Ricardo', 'clave-ricardo');
  ok(await page.isVisible('#btn-revision') && await page.isVisible('#btn-usuarios'), 'Ricardo ve Revisión y Usuarios');
  await page.screenshot({ path: FOTOS + '/1-resumen.png' });

  // ---- Semáforo: tres cierres cargados por la API con distinta situación
  const sufijo = Date.now();
  const cierre = (dia, turno, estado, obs) => ({ fecha: '2026-11-' + dia, turno, personal: 'Jeremy', mem_efectivo: 100, id_origen: 'e2e-' + sufijo + '-' + dia + turno, estado, observaciones: obs });
  const lote = { registros: [cierre('27', 'M', 'verde'), cierre('27', 'V', 'amarillo', 'falta la foto del sistema'), cierre('28', 'M', 'rojo', 'el total de la libreta no cuadra'), cierre('28', 'V', 'verde')].map((r) => Object.assign({ tabla: 'ingresos' }, r)) };
  const rp = await fetch(BASE + '/api/v1/registros', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tw' }, body: JSON.stringify(lote) });
  ok(rp.status === 200, 'la API carga tres cierres con semáforo (' + rp.status + ')');

  // ---- Revisión
  await page.click('#btn-revision');
  await page.waitForSelector('#rev-tabla-datos tbody tr[data-id]');
  ok((await page.inputValue('#rev-tabla')) === 'ingresos', 'combo por omisión: ingresos');
  ok(JSON.stringify(await page.$$eval('#rev-tabla option', (o) => o.map((x) => x.textContent))) === JSON.stringify(['Cierre de caja', 'Gasto']), 'opciones del combo: Cierre de caja y Gasto');
  const mesDefecto = await page.inputValue('#rev-mes');
  ok(mesDefecto === '2026-11', 'mes por omisión: el último (' + mesDefecto + ')');
  ok((await page.locator('#rev-tabla-datos tbody tr[data-id].is-locked').count()) > 0, 'filas revisadas bloqueadas');
  ok((await page.locator('#rev-tabla-datos tbody tr[data-id].is-locked input[type=number]').count()) === 0, 'las filas revisadas no tienen campos editables');
  const bg = (sel) => page.locator(sel).first().locator('td').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  const sinColor = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
  const cVerde = await bg('#rev-tabla-datos tbody tr.is-locked');
  const cNo = await bg('#rev-tabla-datos tbody tr.is-edicion.est-verde');
  const cAm = await bg('#rev-tabla-datos tbody tr.is-edicion.est-amarillo');
  const cRo = await bg('#rev-tabla-datos tbody tr.is-edicion.est-rojo');
  ok(!sinColor(cVerde), 'revisado: verde claro (' + cVerde + ')');
  ok(sinColor(cNo), 'sin revisar y consistente: sin color (' + cNo + ')');
  ok(!sinColor(cAm) && !sinColor(cRo) && cAm !== cRo && cAm !== cVerde && cRo !== cVerde, 'sin revisar: amarillo y rojo distintos entre sí y del revisado (' + cAm + ' / ' + cRo + ')');
  ok((await page.locator('#rev-tabla-datos tbody tr.adm-obsrow').count()) === 2, 'amarillo y rojo muestran su observación');
  ok((await page.locator('#rev-tabla-datos tbody tr.is-edicion.est-rojo .adm-pill').innerText()) === 'error', 'la situación se escribe en la fila: rojo = «error»');
  const etiquetas = await page.$$eval('#rev-tabla-datos tbody .adm-pill', (e) => [...new Set(e.map((x) => x.textContent))].sort());
  ok(JSON.stringify(etiquetas) === JSON.stringify(['consistente', 'error', 'inconsistente']), 'etiquetas de situación: consistente / inconsistente / error (' + etiquetas + ')');

  // ---- Distribución: Instrucciones junto al título, Mostrar revisados, grid con alto fijo
  const caja = (s) => page.locator(s).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right }; });
  const tit = await caja('#h-revision'), ins = await caja('#tab-revision .adm-cab summary');
  ok(ins.l > tit.r && Math.abs((ins.t + ins.b) / 2 - (tit.t + tit.b) / 2) < 14, 'Instrucciones cerradas: a la derecha del título, en el mismo renglón');
  await page.click('#tab-revision .adm-cab summary');
  const ins2 = await caja('#tab-revision .adm-cab summary');
  ok(Math.abs(ins2.l - ins.l) < 2 && Math.abs(ins2.t - ins.t) < 2, 'Instrucciones abiertas: la etiqueta no se mueve');
  const anchoLista = await page.locator('#tab-revision .adm-cab ul').evaluate((e) => e.getBoundingClientRect().width);
  const anchoTarjeta = await page.locator('#tab-revision .fg-card').evaluate((e) => e.getBoundingClientRect().width);
  ok(anchoLista > anchoTarjeta - 60, 'el texto de las instrucciones usa todo el ancho (' + Math.round(anchoLista) + ' de ' + Math.round(anchoTarjeta) + 'px)');
  const lista = await caja('#tab-revision .adm-cab ul');
  ok(lista.t >= tit.b - 1 && lista.l <= tit.l + 2, 'Instrucciones abiertas: el texto aparece debajo del título');
  await page.click('#tab-revision .adm-cab summary');
  ok((await caja('#tab-revision .adm-cab summary')).l > tit.r, 'al contraer la etiqueta sigue en su lugar');
  const sty = await page.locator('#rev-agregar').evaluate((e) => { const s = getComputedStyle(e); return { b: s.borderTopWidth, bg: s.backgroundColor, c: e.className }; });
  ok(sty.b === '0px' && sty.bg === 'rgba(0, 0, 0, 0)' && !sty.c.includes('adm-accion--ok'), 'Agregar cierre: mismo estilo de texto, sin palomita');
  ok((await page.textContent('#rev-aceptar')) === 'Aceptar consistentes' && (await page.locator('#rev-aceptar').evaluate((e) => getComputedStyle(e, '::before').content)).includes('✓'), 'Aceptar consistentes conserva su palomita');
  const ex = await caja('#rev-excel'), insB = await caja('#tab-revision .adm-cab summary');
  const estilo = (s) => page.locator(s).evaluate((e) => { const c = getComputedStyle(e); return [c.borderTopWidth, c.backgroundColor, c.textDecorationLine, c.fontSize, c.fontWeight].join('|'); });
  ok(ex.r <= insB.l && Math.abs((ex.t + ex.b) / 2 - (insB.t + insB.b) / 2) < 14, 'Descargar respaldo en Excel: a la izquierda de Instrucciones, en la misma fila');
  ok((await estilo('#rev-excel')) === (await estilo('#rev-aceptar')) && (await estilo('#rev-excel')) === (await estilo('#rev-agregar')), 'el botón de Excel tiene el mismo estilo que Aceptar consistentes y Agregar');
  ok((await page.getAttribute('#rev-excel', 'href')) === '/api/admin/exportar.xlsx', 'el botón de Excel apunta a la exportación');
  ok(await page.isChecked('#rev-ver-revisados'), 'Mostrar revisados viene marcado');
  ok((await caja('#rev-aceptar')).r <= (await caja('#rev-agregar')).l && Math.abs((await caja('#rev-aceptar')).t - (await caja('#rev-agregar')).t) < 6, 'Agregar cierre queda a la derecha de Aceptar consistentes, en la misma barra');
  ok((await caja('#rev-ver-revisados')).r < (await caja('#rev-aceptar')).l, 'Mostrar revisados queda a la izquierda de Aceptar consistentes');
  const totalFilas = await page.locator('#rev-tabla-datos tbody tr[data-id]').count();
  const sinRev = await page.locator('#rev-tabla-datos tbody tr[data-id].is-edicion').count();
  await page.click('#rev-ver-revisados');
  ok((await page.locator('#rev-tabla-datos tbody tr[data-id].is-locked').count()) === 0 && (await page.locator('#rev-tabla-datos tbody tr[data-id]').count()) === sinRev, 'sin marcar: solo quedan las no revisadas (' + sinRev + ' de ' + totalFilas + ')');
  ok((await page.innerText('#rev-tabla-datos tfoot th')).includes(sinRev + ' de ' + totalFilas), 'el pie indica "N de M registros"');
  await page.click('#rev-ver-revisados');
  ok((await page.locator('#rev-tabla-datos tbody tr[data-id]').count()) === totalFilas, 'al marcar de nuevo vuelve todo el mes');
  const gr = await page.locator('.adm-grid').first().evaluate((e) => ({ ch: e.clientHeight, sh: e.scrollHeight, ov: getComputedStyle(e).overflowY }));
  ok(gr.ch <= 20 * 36 + 60 && gr.ov === 'auto', 'el grid tiene alto máximo de ~20 renglones (' + gr.ch + 'px) y scroll propio');
  const geo = await page.evaluate(() => {
    const t = document.querySelector('#rev-tabla-datos'), c = t.closest('.adm-grid');
    const altos = [...t.querySelectorAll('tbody tr[data-id]')].map((r) => r.getBoundingClientRect().height);
    const cortados = [...t.querySelectorAll('input')].filter((e) => e.scrollWidth > e.clientWidth + 1).length;
    return { t: t.getBoundingClientRect().width, c: c.clientWidth, maxAlto: Math.max(...altos), cortados };
  });
  ok(geo.t < geo.c - 40, 'las columnas miden lo que su dato necesita: tabla ' + Math.round(geo.t) + ' de ' + geo.c + 'px');
  ok(geo.maxAlto < 46 && geo.cortados === 0, 'ninguna celda se parte en dos renglones ni se corta (alto máx. ' + Math.round(geo.maxAlto) + 'px)');

  // ---- Aceptar consistentes
  ok((await page.textContent('#rev-aceptar')) === 'Aceptar consistentes', 'botón "Aceptar consistentes" en Revisión');
  ok(!(await page.isDisabled('#rev-aceptar')), 'activo mientras haya consistentes sin revisar');
  const vFila = page.locator('#rev-tabla-datos tbody tr.is-edicion.est-verde').first();
  const vId = await vFila.getAttribute('data-id');
  for (const k of ['mem_efectivo', 'mem_electronico', 'mer_efectivo', 'mer_electronico', 'excedente']) await vFila.locator('input[data-k=' + k + ']').fill('0');
  await page.evaluate(() => { window.__espera = []; const d = document.getElementById('adm-dialogo'); new MutationObserver(() => { if (d.open && d.classList.contains('fg-dialog--espera')) window.__espera.push(getComputedStyle(d).cursor); }).observe(d, { attributes: true, childList: true, subtree: true }); });
  await page.click('#rev-aceptar');
  await page.waitForSelector('#adm-dialogo[open] #adm-d-aceptar');
  const txtAlerta = await page.textContent('#adm-dialogo');
  ok(txtAlerta.includes('No fue posible guardar todos') && txtAlerta.includes('debido a inconsistencias en sus datos'), 'alerta cuando alguno no es consistente');
  ok(txtAlerta.includes('Se guardaron 1 de 2'), 'se guardó en bloque solo el correcto (' + (txtAlerta.match(/Se guardaron \d+ de \d+/) || [''])[0] + ')');
  ok((await page.evaluate(() => window.__espera)).includes('wait'), 'mientras corre: pantalla bloqueada con cursor de espera');
  await page.click('#adm-d-aceptar');
  await page.waitForFunction(() => !document.getElementById('adm-dialogo').open);
  ok((await page.locator(`tr[data-id="${vId}"].is-edicion input[data-k=mem_efectivo]`).inputValue()) === '0', 'el registro no aceptado conserva los cambios del usuario');
  ok((await page.locator('#rev-tabla-datos tbody tr.adm-msgrow').count()) >= 1, 'el motivo queda bajo la fila');
  const bd = await page.evaluate(() => fetch('/api/v1/ingresos?mes=2026-11', { headers: { Authorization: 'Bearer tl' } }).then((r) => r.json()));
  ok(bd.filas.find((f) => String(f.id) === vId).revisado === 0, 'en la base sigue sin revisar');
  ok(bd.filas.filter((f) => f.estado === 'verde' && f.revisado === 0).length === 1, 'el otro consistente quedó revisado en la base');
  ok((await page.locator('#rev-tabla-datos tbody tr.is-edicion.est-amarillo, #rev-tabla-datos tbody tr.is-edicion.est-rojo').count()) === 2, 'amarillo y rojo no se aceptan en masa');
  await page.locator(`tr[data-id="${vId}"] input[data-k=mem_efectivo]`).fill('100');
  await page.click('#rev-aceptar');
  await page.waitForFunction(() => document.querySelectorAll('#rev-tabla-datos tr.is-edicion.est-verde').length === 0);
  ok(!(await page.evaluate(() => document.getElementById('adm-dialogo').open)), 'si todos son consistentes se guardan sin alerta');
  ok(await page.isDisabled('#rev-aceptar'), 'botón deshabilitado sin consistentes pendientes');

  // ---- Regla del mes completo: Nómina y Renta + todos los cierres de caja revisados
  const resumenDe = async (mes) => {
    await page.reload(); await page.waitForSelector('#app:not([hidden])');
    await page.click('#btn-resumen');
    await page.waitForSelector('#selPeriodo', { state: 'visible' });
    await page.selectOption('#selPeriodo', mes);
    await page.waitForFunction((m) => document.querySelector('#selPeriodo').value === m, mes);
    return page.locator('[data-draw=res_prov]').first().innerText();
  };
  const defOct = await resumenDe('2026-10');
  ok(defOct === 'del mes', 'octubre (gastos completos y cierres revisados): resultado definitivo (' + defOct + ')');
  await page.click('#btn-revision');
  await page.waitForSelector('#rev-tabla-datos tbody tr[data-id]');
  await page.selectOption('#rev-mes', '2026-10');
  await page.waitForFunction(() => document.querySelector('#rev-mes').value === '2026-10');
  await page.waitForSelector('#rev-tabla-datos tbody tr.is-locked');
  await page.locator('#rev-tabla-datos tbody tr.is-locked input[type=checkbox]').first().uncheck();
  await page.waitForSelector('#rev-tabla-datos tbody tr.is-edicion');
  const provOct = await resumenDe('2026-10');
  ok(provOct === 'provisional', 'al quitar la revisión de un cierre de octubre, su resultado pasa a provisional (' + provOct + ')');
  ok(!(await page.locator('.js-aviso-cierres').first().evaluate((e) => e.hidden)), 'aparece la nota de cierres sin revisar');
  await page.click('#btn-revision');
  await page.selectOption('#rev-mes', '2026-10');
  await page.waitForFunction(() => document.querySelector('#rev-mes').value === '2026-10');
  await page.waitForSelector('#rev-tabla-datos tbody tr.is-edicion');
  const fl = page.locator('#rev-tabla-datos tbody tr.is-edicion').first();
  await fl.locator('input[type=checkbox]').check();
  await fl.locator('.adm-guardar').click();
  await page.waitForFunction(() => document.querySelectorAll('#rev-tabla-datos tbody tr.is-edicion').length === 0);
  const defOct2 = await resumenDe('2026-10');
  ok(defOct2 === 'del mes', 'al volver a revisarlo, octubre vuelve a ser definitivo (' + defOct2 + ')');
  await page.click('#btn-revision');
  await page.waitForSelector('#rev-tabla-datos tbody tr[data-id]');
  await page.screenshot({ path: FOTOS + '/2-revision.png' });

  // desbloquear la primera fila
  const fila = page.locator('#rev-tabla-datos tbody tr[data-id]').first();
  const id = await fila.getAttribute('data-id');
  await fila.locator('.adm-chk input').uncheck();
  await page.waitForSelector(`tr[data-id="${id}"].is-edicion`);
  ok(await page.locator(`tr[data-id="${id}"] .adm-eliminar`).count() === 1, 'al quitar la palomita aparece Eliminar');
  const antes = await page.locator(`tr[data-id="${id}"] .adm-total`).innerText();
  await page.locator(`tr[data-id="${id}"] input[data-k=mem_efectivo]`).fill('1000');
  await page.locator(`tr[data-id="${id}"] input[data-k=excedente]`).fill('-50');
  const total = await page.locator(`tr[data-id="${id}"] .adm-total`).innerText();
  ok(total !== antes, 'el total se recalcula al escribir (' + antes + ' -> ' + total + ')');
  await page.locator(`tr[data-id="${id}"] .adm-guardar`).click();
  await page.waitForSelector(`tr[data-id="${id}"].is-edicion .adm-guardar:disabled`);
  ok(true, 'guardó sin advertencias');
  // marcar revisado de nuevo (se guarda con Guardar)
  await page.locator(`tr[data-id="${id}"] .adm-chk input`).check();
  await page.locator(`tr[data-id="${id}"] .adm-guardar`).click();
  await page.waitForSelector(`tr[data-id="${id}"].is-locked`);
  ok(true, 'vuelve a quedar bloqueada al guardar como revisada');
  const vistoDespues = await page.evaluate(() => fetch('/api/datos').then((x) => x.json()));
  ok(vistoDespues.ingresos_diarios.length > 0, 'el tablero sigue leyendo datos');

  // agregar cierre con duplicado: advertencia
  await page.click('#rev-agregar');
  const nueva = page.locator('tr[data-nueva="1"]');
  ok(await nueva.count() === 1, 'aparece una fila nueva al final');
  await page.click('tr[data-nueva="1"] .adm-guardar');
  ok((await page.locator('.adm-msgrow').innerText()).includes('fecha'), 'sin datos mínimos: error de fecha');
  const f0 = await page.locator(`tr[data-id="${id}"] td`).nth(0).innerText();
  const t0 = await page.locator(`tr[data-id="${id}"] td`).nth(1).innerText();
  const p0 = await page.locator(`tr[data-id="${id}"] td`).nth(2).innerText();
  await nueva.locator('input[data-k=fecha]').fill(f0);
  await nueva.locator('input[data-k=turno]').fill(t0);
  await nueva.locator('input[data-k=personal]').fill(p0);
  await nueva.locator('input[data-k=mem_efectivo]').fill('300');
  await page.click('tr[data-nueva="1"] .adm-guardar');
  await page.waitForSelector('#adm-dialogo[open]');
  ok((await page.locator('#adm-dialogo').innerText()).includes('Ya existe un cierre'), 'advertencia de cierre duplicado');
  await page.screenshot({ path: FOTOS + '/3-advertencia.png' });
  await page.click('#adm-d-cancelar');
  ok(await page.locator('tr[data-nueva="1"]').count() === 1, 'cancelar deja la fila sin guardar');
  await nueva.locator('input[data-k=turno]').fill('TD');
  await page.click('tr[data-nueva="1"] .adm-guardar');
  if (await page.locator('#adm-dialogo[open]').count()) await page.click('#adm-d-aceptar');   // (turno inusual / mes) si avisa, se acepta
  await page.waitForSelector('tr[data-nueva="1"]', { state: 'detached' });
  const nuevoId = await page.locator('#rev-tabla-datos tbody tr[data-id]').last().getAttribute('data-id');
  ok(await page.locator(`tr[data-id="${nuevoId}"].is-edicion`).count() === 1, 'el cierre nuevo queda guardado, sin revisar (editable)');

  // intentar salir con cambios sin guardar
  await page.locator(`tr[data-id="${nuevoId}"] input[data-k=mem_efectivo]`).fill('301');
  await page.click('#btn-usuarios');
  ok(await page.isVisible('#tab-revision'), 'no deja salir con cambios sin guardar');
  ok((await page.locator('#adm-revision .fg-msg--bad').first().innerText()).includes('sin guardar'), 'avisa que hay cambios sin guardar');
  await page.locator(`tr[data-id="${nuevoId}"] .adm-guardar`).click();
  await page.waitForSelector(`tr[data-id="${nuevoId}"] .adm-guardar:disabled`);

  // eliminar el cierre nuevo
  await page.locator(`tr[data-id="${nuevoId}"] .adm-eliminar`).click();
  await page.waitForSelector('#adm-dialogo[open]');
  ok((await page.locator('#adm-dialogo').innerText()).includes('definitiva'), 'advertencia antes de eliminar');
  await page.click('#adm-d-aceptar');
  await page.waitForSelector(`tr[data-id="${nuevoId}"]`, { state: 'detached' });
  ok(true, 'cierre eliminado');

  // egresos
  await page.selectOption('#rev-tabla', 'egresos');
  await page.waitForSelector('#rev-tabla-datos th:has-text("Concepto")');
  ok(await page.locator('#rev-agregar').innerText() === 'Agregar gasto', 'botón Agregar gasto');
  await page.click('#rev-agregar');
  await page.fill('tr[data-nueva="1"] input[data-k=fecha]', '2026-11-20');
  await page.fill('tr[data-nueva="1"] input[data-k=personal]', 'Ricardo');
  await page.fill('tr[data-nueva="1"] input[data-k=tipo]', 'Insumos');
  await page.fill('tr[data-nueva="1"] input[data-k=concepto]', 'cloro prueba');
  await page.fill('tr[data-nueva="1"] input[data-k=efectivo]', '90');
  await page.check('tr[data-nueva="1"] .adm-chk input');
  await page.click('tr[data-nueva="1"] .adm-guardar');
  if (await page.locator('#adm-dialogo[open]').count()) await page.click('#adm-d-aceptar');
  await page.waitForSelector('tr[data-nueva="1"]', { state: 'detached' });
  ok(await page.locator('#rev-tabla-datos tbody tr.is-locked').last().innerText().then((t) => t.includes('cloro prueba')), 'egreso guardado como revisado (bloqueado)');
  await page.screenshot({ path: FOTOS + '/4-egresos.png' });
  // lo deja como estaba: quitar palomita y eliminar
  const ult = page.locator('#rev-tabla-datos tbody tr.is-locked').last();
  await ult.locator('.adm-chk input').uncheck();
  await page.locator('#rev-tabla-datos tbody tr.is-edicion .adm-eliminar').click();
  await page.click('#adm-d-aceptar');
  await page.waitForTimeout(400);

  // ---- Usuarios
  await page.click('#btn-usuarios');
  await page.waitForSelector('#usr-tabla tbody tr[data-user]');
  ok(await page.locator('#usr-tabla tbody tr.is-locked').count() === 2, 'los 2 usuarios activos están bloqueados');
  ok(await page.locator('#usr-tabla input[type=password]').count() === 0, 'no hay campos de contraseña en usuarios activos');
  ok(!(await page.content()).includes('7657f8255871'), 'el hash de la contraseña no aparece en la página');
  ok(await page.locator('tr[data-user="Ricardo"] .adm-chk input').isDisabled(), 'no puedes inactivar tu propio usuario');
  await page.screenshot({ path: FOTOS + '/5-usuarios.png' });
  await page.click('#usr-agregar');
  await page.fill('tr[data-nueva="1"] input[type=text]', 'Lupe');
  await page.fill('tr[data-nueva="1"] input[type=password]', 'lupe-clave-1');
  await page.check('tr[data-nueva="1"] .adm-chk input');
  await page.click('tr[data-nueva="1"] .adm-guardar');
  await page.waitForSelector('#adm-dialogo[open]');
  await page.fill('#adm-d-clave2', 'otra-cosa-xx');
  await page.click('#adm-d-aceptar');
  await page.waitForSelector('.adm-msgrow');
  ok((await page.locator('.adm-msgrow').innerText()).includes('no se guardó porque el valor del password no es igual'.replace('no se', 'No se')), 'mensaje de contraseñas distintas');
  ok(await page.locator('tr[data-nueva="1"] input[type=password]').inputValue() === '', 'tras el error la contraseña se borra y hay que escribirla otra vez');
  await page.locator('tr[data-nueva="1"] select').selectOption('user');
  await page.fill('tr[data-nueva="1"] input[type=password]', 'lupe-clave-1');
  await page.click('tr[data-nueva="1"] .adm-guardar');
  await page.waitForSelector('#adm-dialogo[open]');
  await page.fill('#adm-d-clave2', 'lupe-clave-1');
  await page.click('#adm-d-aceptar');
  await page.waitForSelector('tr[data-user="Lupe"].is-locked');
  ok(true, 'usuario creado, activo y bloqueado');
  // inactivar para editar
  await page.locator('tr[data-user="Lupe"] .adm-chk input').uncheck();
  await page.waitForSelector('#adm-dialogo[open]');
  await page.click('#adm-d-aceptar');
  await page.waitForSelector('tr[data-user="Lupe"].is-edicion');
  ok(await page.locator('tr[data-user="Lupe"] input[type=password]').inputValue() === '', 'la contraseña nunca se muestra (campo vacío al editar)');
  ok(await page.locator('tr[data-user="Lupe"] .adm-eliminar').count() === 0, 'no hay botón de borrar usuarios');

  // ---- Metas
  await page.click('#btn-metas');
  await page.waitForSelector('#met-tabla tbody tr');
  ok(await page.isVisible('#metas-editor'), 'Ricardo ve el editor de metas');
  await page.click('#met-agregar');
  await page.fill('#met-tabla tr.is-nueva input[aria-label=Periodo]', '2026-12');
  await page.fill('#met-tabla tr.is-nueva input[aria-label="Meta de ingresos"]', '33000');
  await page.click('#met-tabla tr.is-nueva .adm-guardar');
  await page.waitForSelector('#met-tabla tr.is-nueva', { state: 'detached' });
  ok(true, 'meta 2026-12 guardada');
  await page.screenshot({ path: FOTOS + '/6-metas.png', fullPage: true });
  await page.click('#btnSalir');

  // Lupe (inactiva) no puede entrar; Dan sigue bien
  await page.fill('#l-user', 'Lupe'); await page.fill('#l-pass', 'lupe-clave-1'); await page.click('#btnLogin');
  await page.waitForSelector('#msg-login-bad:not([hidden])');
  ok(true, 'un usuario inactivo no puede entrar');

  ok(errores.length === 0, 'sin errores en la consola' + (errores.length ? ': ' + errores.join(' | ') : ''));
  await browser.close();
  console.log(fallos ? `\n${fallos} FALLAS` : '\nTODO BIEN');
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
