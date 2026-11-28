"""Carga inicial: pasa tu libro de Excel a la base SQLite con el esquema nuevo (una sola vez).

    python importar.py /ruta/Data_Base.xlsx /ruta/kpis.db [--reemplazar]

Reglas de la conversión (todas quedan en el informe que imprime):
  - Detalle Ingresos: las filas del mismo (fecha, turno) se juntan en UN cierre.
      membrecias y consultas -> mem_efectivo / mem_electronico
      mercancias             -> mer_efectivo / mer_electronico
      cualquier otro tipo (excedente) -> excedente (suma de su Total)
    Personal = el que más filas tiene en ese cierre. Columna1 y Columna2 se descartan.
  - El total ya no se copia: lo calcula la base (membresías + mercancías + excedente). Si en el Excel un Total no
    cuadraba con Efectivo + Electrónico, el informe lo lista.
  - Todo lo importado entra como revisado = 1 (es histórico y ya lo validaste).
  - Detalle Egresos: tal cual, celdas vacías = 0, revisado = 1.
  - Metas: periodo, meta ingresos, meta socios, notas y lectura.
  - Usuarios: Ricardo = admin, los demás = user; todos activos si traen contraseña (SHA-256) válida.
No modifica el Excel. Si la base ya tiene datos, se niega salvo que pases --reemplazar (que primero respalda).
"""
import collections
import os
import sys

import bd as BD
import lector_excel as LE

PERFIL_ADMIN = ("ricardo",)


def _montos(fila, cols):
    """(efectivo, electrónico, total_excel) de una fila del Excel."""
    efe, ele = LE._forma_pago(fila, cols)
    total = LE._monto(fila, cols)
    return efe, ele, total


def leer_ingresos(wb):
    filas = LE._filas(wb, LE.HOJA_INGRESOS)
    inicio, cols = LE._encabezados(filas, ["fecha", "tipo"])
    cierres = collections.OrderedDict()
    descartadas = 0
    for fila in filas[inicio + 1:]:
        f = LE._fecha(LE._celda(fila, cols, "fecha"))
        if f is None:
            descartadas += 1 if any(v is not None for v in fila[:9]) else 0
            continue
        turno = LE._turno(LE._celda(fila, cols, "turno"))
        c = cierres.setdefault((f.isoformat(), turno), {
            "personal": collections.Counter(), "mem_efectivo": 0.0, "mem_electronico": 0.0,
            "mer_efectivo": 0.0, "mer_electronico": 0.0, "excedente": 0.0, "descuadres": []})
        persona = " ".join(str(LE._celda(fila, cols, "personal") or "").split())
        if persona:
            c["personal"][persona] += 1
        clave = LE._TIPO_INGRESO.get(LE._norm(LE._celda(fila, cols, "tipo")), "excedente")
        efe, ele, total = _montos(fila, cols)
        if clave in ("membresias", "consultas"):
            c["mem_efectivo"] += efe
            c["mem_electronico"] += ele
            dif = round(total - (efe + ele), 2)
        elif clave == "mercancias":
            c["mer_efectivo"] += efe
            c["mer_electronico"] += ele
            dif = round(total - (efe + ele), 2)
        else:
            c["excedente"] += total
            dif = 0.0
        if dif:
            c["descuadres"].append(dif)
    return cierres, descartadas


def leer_egresos(wb):
    filas = LE._filas(wb, LE.HOJA_EGRESOS)
    inicio, cols = LE._encabezados(filas, ["fecha", "tipo"])
    salida, descartadas = [], 0
    for fila in filas[inicio + 1:]:
        f = LE._fecha(LE._celda(fila, cols, "fecha"))
        if f is None:
            descartadas += 1 if any(v is not None for v in fila[:7]) else 0
            continue
        efe, ele = LE._forma_pago(fila, cols)
        tipo = " ".join(str(LE._celda(fila, cols, "tipo") or "").split()) or "Sin categoría"
        salida.append((f.isoformat(), " ".join(str(LE._celda(fila, cols, "personal") or "").split()) or "Sin nombre",
                       tipo, " ".join(str(LE._celda(fila, cols, "concepto") or "").split()), round(efe, 2), round(ele, 2)))
    return salida, descartadas


def leer_metas(wb):
    filas = LE._filas(wb, LE.HOJA_METAS)
    inicio, cols = LE._encabezados(filas, ["periodo", "meta ingresos", "meta socios"])
    por_id = collections.OrderedDict()
    for fila in filas[inicio + 1:]:
        pid = LE._periodo(LE._celda(fila, cols, "periodo"))
        if pid is None:
            continue
        ing = LE._numero(LE._celda(fila, cols, "meta ingresos"))
        soc = LE._numero(LE._celda(fila, cols, "meta socios"))
        notas = LE._celda(fila, cols, "notas")
        lectura = LE._celda(fila, cols, "lectura")
        por_id[pid] = (pid, ing if ing is not None and ing >= 0 else None, soc if soc is not None and soc >= 0 else None,
                       str(notas).strip() if notas not in (None, "") else None,
                       str(lectura).strip() if lectura not in (None, "") else None)
    return list(por_id.values())


def importar(ruta_excel, ruta_db, reemplazar=False, reloj=None):
    wb = LE.abrir(ruta_excel)
    try:
        cierres, desc_ing = leer_ingresos(wb)
        egresos, desc_egr = leer_egresos(wb)
        metas = leer_metas(wb)
        usuarios = LE.usuarios(wb)
    finally:
        wb.close()

    BD.iniciar(ruta_db)
    con = BD.conectar(ruta_db)
    informe = {"cierres": 0, "cierres_en_cero": [], "descuadres": [], "egresos": 0, "metas": len(metas), "usuarios": [],
               "filas_ingresos_sin_fecha": desc_ing, "filas_egresos_sin_fecha": desc_egr, "respaldo": None}
    try:
        hay = con.execute("SELECT (SELECT COUNT(*) FROM ingresos)+(SELECT COUNT(*) FROM egresos)").fetchone()[0]
        if hay:
            if not reemplazar:
                raise SystemExit("La base ya tiene datos. Si quieres cargar de nuevo desde el Excel usa --reemplazar (hace respaldo antes).")
            informe["respaldo"] = BD.respaldar(ruta_db, os.path.join(os.path.dirname(os.path.abspath(ruta_db)), "respaldos"), reloj=reloj)
        con.execute("BEGIN IMMEDIATE")
        try:
            for t in ("ingresos", "egresos", "metas", "usuarios", "bitacora", "historial"):
                con.execute(f"DELETE FROM {t}")
            con.execute("DELETE FROM sqlite_sequence WHERE name IN ('ingresos','egresos','bitacora','historial')")
            for (fecha, turno), c in sorted(cierres.items()):
                vals = [round(c[k], 2) for k in ("mem_efectivo", "mem_electronico", "mer_efectivo", "mer_electronico", "excedente")]
                if round(sum(vals), 2) == 0:
                    informe["cierres_en_cero"].append(f"{fecha} {turno}")
                    continue
                personal = c["personal"].most_common(1)[0][0] if c["personal"] else "Sin nombre"
                con.execute("INSERT INTO ingresos(fecha,turno,personal,mem_efectivo,mem_electronico,mer_efectivo,mer_electronico,excedente,revisado)"
                            " VALUES(?,?,?,?,?,?,?,?,1)", [fecha, turno, personal] + vals)
                informe["cierres"] += 1
                if c["descuadres"]:
                    informe["descuadres"].append({"fecha": fecha, "turno": turno, "diferencia": round(sum(c["descuadres"]), 2)})
            for fecha, personal, tipo, concepto, efe, ele in egresos:
                con.execute("INSERT INTO egresos(fecha,personal,tipo,concepto,efectivo,electronico,revisado) VALUES(?,?,?,?,?,?,1)",
                            (fecha, personal, tipo, concepto, efe, ele))
                informe["egresos"] += 1
            con.executemany("INSERT INTO metas(periodo,meta_ingresos,meta_socios,notas,lectura) VALUES(?,?,?,?,?)", metas)
            for _, (nombre, huella) in sorted(usuarios.items()):
                valido = len(huella) == 64 and all(ch in "0123456789abcdef" for ch in huella)
                perfil = "admin" if nombre.lower() in PERFIL_ADMIN else "user"
                con.execute('INSERT INTO usuarios("user","pass",perfil,activo) VALUES(?,?,?,?)',
                            (nombre, huella if valido else "", perfil, 1 if valido else 0))
                informe["usuarios"].append(f"{nombre} ({perfil}{'' if valido else ', INACTIVO: sin contraseña válida'})")
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
    finally:
        con.close()
    return informe


def imprimir(inf):
    print(f"Cierres importados: {inf['cierres']}   Egresos: {inf['egresos']}   Metas: {inf['metas']}")
    print("Usuarios:", ", ".join(inf["usuarios"]) or "ninguno")
    if inf["cierres_en_cero"]:
        print(f"Cierres omitidos por sumar 0 ({len(inf['cierres_en_cero'])}):", ", ".join(inf["cierres_en_cero"]))
    if inf["descuadres"]:
        print("Cierres cuyo Total en el Excel no cuadraba con Efectivo + Electrónico (ahora el total se calcula):")
        for d in inf["descuadres"]:
            print(f"   {d['fecha']} {d['turno']}: el Excel traía {d['diferencia']:+.2f} de diferencia")
    if inf["filas_ingresos_sin_fecha"] or inf["filas_egresos_sin_fecha"]:
        print(f"Filas con datos pero sin fecha válida (ignoradas): ingresos {inf['filas_ingresos_sin_fecha']}, egresos {inf['filas_egresos_sin_fecha']}")
    if inf["respaldo"]:
        print("Respaldo previo:", inf["respaldo"])


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        raise SystemExit(__doc__)
    imprimir(importar(args[0], args[1], "--reemplazar" in sys.argv))
