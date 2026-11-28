"""Lee de la base SQLite lo que necesita el tablero. Entrega la misma forma de datos que entregaba el lector del Excel.

Todos los totales salen de las columnas de la base; aquí solo se agrupa y se suma.
  ingresos_diarios  por día: membresias, mercancias, excedente, total
  ventas_mes        por mes, turno y concepto (membresias | mercancias | otros = excedente) con efectivo / electronico / total
  egresos_mensual   por mes y categoría (categorías tal como están en la base; solo se unifican mayúsculas/acentos) + estado de los gastos del mes + cierres_sin_revisar
  metas             por periodo: ingresos, socios
Todos los registros cuentan para los KPIs, estén revisados o no.
"""
import datetime
import re
import unicodedata


def _norm(valor):
    if valor is None:
        return ""
    t = unicodedata.normalize("NFKD", str(valor))
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", t).strip().lower()


def ingresos_diarios(con):
    return [{"fecha": r["fecha"], "membresias": round(r["mem"], 2), "mercancias": round(r["mer"], 2),
             "excedente": round(r["exc"], 2), "total": round(r["total"], 2)}
            for r in con.execute("""SELECT fecha, SUM(mem_efectivo+mem_electronico) mem, SUM(mer_efectivo+mer_electronico) mer,
                                           SUM(excedente) exc, SUM(total) total
                                    FROM ingresos GROUP BY fecha ORDER BY fecha""")]


def ventas_mensual(con):
    sql = """
    SELECT mes, turno, concepto, SUM(efectivo) efectivo, SUM(electronico) electronico, SUM(total) total FROM (
        SELECT substr(fecha,1,7) mes, turno, 'membresias' concepto, mem_efectivo efectivo, mem_electronico electronico,
               mem_efectivo+mem_electronico total FROM ingresos
        UNION ALL
        SELECT substr(fecha,1,7), turno, 'mercancias', mer_efectivo, mer_electronico, mer_efectivo+mer_electronico FROM ingresos
        UNION ALL
        SELECT substr(fecha,1,7), turno, 'otros', excedente, 0, excedente FROM ingresos
    ) GROUP BY mes, turno, concepto
    HAVING ROUND(ABS(SUM(efectivo))+ABS(SUM(electronico))+ABS(SUM(total)),2) <> 0
    ORDER BY mes, turno, concepto"""
    return [{"mes": r["mes"], "turno": r["turno"], "concepto": r["concepto"], "efectivo": round(r["efectivo"], 2),
             "electronico": round(r["electronico"], 2), "total": round(r["total"], 2)} for r in con.execute(sql)]


def egresos_mensual(con):
    """Estado de los gastos del mes: 'sin captura' (suma 0), 'completo' (hay Nómina y Renta) o 'parcial'.

    Cada fila trae además cierres_sin_revisar: cuántos cierres de caja del mes siguen sin revisar. Un mes está completo solo si
    su estado es 'completo' (Nómina y Renta) y cierres_sin_revisar es 0; si no, su resultado es provisional.
    """
    sin_revisar = {r["mes"]: r["n"] for r in con.execute(
        "SELECT substr(fecha,1,7) mes, COUNT(*) n FROM ingresos WHERE revisado = 0 GROUP BY mes")}
    nombres, meses = {}, {}
    for r in con.execute("SELECT substr(fecha,1,7) mes, tipo, SUM(total) monto FROM egresos GROUP BY mes, tipo ORDER BY MIN(id)"):
        crudo = re.sub(r"\s+", " ", r["tipo"]).strip() or "Sin categoría"
        clave = _norm(crudo)
        nombres.setdefault(clave, crudo)
        cats = meses.setdefault(r["mes"], {})
        cats[clave] = cats.get(clave, 0.0) + r["monto"]
    salida = []
    for mes in sorted(meses):
        cats = meses[mes]
        if round(sum(cats.values()), 2) == 0:
            estado = "sin captura"
        elif cats.get("nomina", 0) > 0 and cats.get("renta", 0) > 0:
            estado = "completo"
        else:
            estado = "parcial"
        for clave in sorted(cats, key=lambda k: nombres[k].lower()):
            salida.append({"mes": mes, "categoria": nombres[clave], "monto": round(cats[clave], 2), "estado": estado,
                           "cierres_sin_revisar": sin_revisar.get(mes, 0)})
    return salida


def metas(con):
    return [{"id": r["periodo"], "ingresos": r["meta_ingresos"], "socios": r["meta_socios"]}
            for r in con.execute("SELECT periodo, meta_ingresos, meta_socios FROM metas ORDER BY CASE periodo WHEN 'estandar' THEN '' ELSE periodo END")]


def leer_todo(con):
    return {"ingresos_diarios": ingresos_diarios(con), "egresos_mensual": egresos_mensual(con),
            "ventas_mes": ventas_mensual(con), "metas": metas(con)}
