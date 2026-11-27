"""Lee el libro de Excel del gimnasio y lo convierte en los datos que usa el tablero.

Hojas que se leen (por nombre):
  - "Detalle Ingresos": una fila por venta (Fecha, Turno, Personal, tipo, Efectivo, Electronico, Total); Turno M = matutino, V = vespertino.
  - "Detalle Egresos":  una fila por gasto (Fecha, Personal, tipo, Concepto, Efectivo, Electronico, Total).
  - "Metas":            Periodo ("Estándar" o AAAA-MM), Meta ingresos, Meta socios.
  - "Usuarios":         user, pass (la columna pass guarda el SHA-256 de la contraseña).

El libro se abre de nuevo en cada lectura, así que los cambios guardados en el Excel se ven al siguiente gráfico.
"""
import datetime
import re
import unicodedata

import openpyxl
from openpyxl.utils.datetime import from_excel

HOJA_INGRESOS = "Detalle Ingresos"
HOJA_EGRESOS = "Detalle Egresos"
HOJA_METAS = "Metas"
HOJA_USUARIOS = "Usuarios"


class ErrorExcel(Exception):
    """El archivo no se pudo leer o le falta una hoja o columna necesaria."""


def _norm(valor):
    """Minúsculas, sin acentos ni espacios sobrantes: 'Nómina ' -> 'nomina'."""
    if valor is None:
        return ""
    t = unicodedata.normalize("NFKD", str(valor))
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", t).strip().lower()


def _numero(valor):
    if isinstance(valor, bool) or valor is None:
        return None
    if isinstance(valor, (int, float)):
        return float(valor)
    if isinstance(valor, str):
        t = valor.replace("$", "").replace(",", "").strip()
        try:
            return float(t)
        except ValueError:
            return None
    return None


def _fecha(valor):
    if isinstance(valor, datetime.datetime):
        return valor.date()
    if isinstance(valor, datetime.date):
        return valor
    if isinstance(valor, (int, float)) and not isinstance(valor, bool) and valor > 20000:
        try:
            return from_excel(valor).date()
        except Exception:
            return None
    if isinstance(valor, str):
        t = valor.strip()
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y", "%d-%m-%Y"):
            try:
                return datetime.datetime.strptime(t, fmt).date()
            except ValueError:
                pass
    return None


def _filas(wb, nombre):
    if nombre not in wb.sheetnames:
        raise ErrorExcel(f'Falta la hoja "{nombre}" en el Excel.')
    return list(wb[nombre].iter_rows(values_only=True))


def _encabezados(filas, requeridos, maximo=15):
    """Busca la fila de encabezados: la primera que trae todos los nombres requeridos.
    Devuelve (indice_de_fila, {nombre_normalizado: columna})."""
    for i, fila in enumerate(filas[:maximo]):
        cols = {}
        for j, v in enumerate(fila):
            n = _norm(v)
            if n and n not in cols:
                cols[n] = j
        if all(r in cols for r in requeridos):
            return i, cols
    raise ErrorExcel("No encontré los encabezados " + ", ".join(requeridos) + ".")


def _monto(fila, cols):
    total = _numero(fila[cols["total"]]) if "total" in cols and cols["total"] < len(fila) else None
    if total is not None:
        return total
    def celda(nombre):
        j = cols.get(nombre)
        return (_numero(fila[j]) if j is not None and j < len(fila) else None) or 0.0
    return celda("efectivo") + celda("electronico")


def _celda(fila, cols, nombre):
    j = cols.get(nombre)
    return fila[j] if j is not None and j < len(fila) else None


# ---------- Ingresos ----------

_TIPO_INGRESO = {
    "membresias": "membresias", "membresia": "membresias", "membrecias": "membresias", "membrecia": "membresias",
    "mercancias": "mercancias", "mercancia": "mercancias",
    "consultas": "consultas", "consulta": "consultas",
}


def ingresos_diarios(wb):
    """Ingresos por día y tipo: membresias, mercancias, consultas, excedente y total."""
    filas = _filas(wb, HOJA_INGRESOS)
    inicio, cols = _encabezados(filas, ["fecha", "tipo"])
    por_dia = {}
    for fila in filas[inicio + 1:]:
        f = _fecha(_celda(fila, cols, "fecha"))
        if f is None:
            continue
        clave = _TIPO_INGRESO.get(_norm(_celda(fila, cols, "tipo")), "excedente")
        d = por_dia.setdefault(f, {"membresias": 0.0, "mercancias": 0.0, "consultas": 0.0, "excedente": 0.0})
        d[clave] += _monto(fila, cols)
    return [{"fecha": f.isoformat(), **{k: round(v, 2) for k, v in por_dia[f].items()},
             "total": round(sum(por_dia[f].values()), 2)} for f in sorted(por_dia)]


def _forma_pago(fila, cols):
    """(efectivo, electrónico) de una fila; una celda vacía vale 0."""
    def celda(nombre):
        j = cols.get(nombre)
        return (_numero(fila[j]) if j is not None and j < len(fila) else None) or 0.0
    return celda("efectivo"), celda("electronico")


_GRUPO_PAGO = {"membresias": "membresias", "mercancias": "mercancias"}  # lo demás (consultas, excedente…) es "otros"


# ---------- Ventas por mes, turno y tipo ----------

def _turno(valor):
    """Código de turno tal como lo escribieron (M, V, TM, TD…) en mayúsculas; vacío = 'SIN'."""
    t = re.sub(r"\s+", "", str(valor or "")).upper()
    return t or "SIN"


def ventas_mensual(wb):
    """Ventas por mes, turno y tipo (membresias | mercancias | otros) con su desglose efectivo / electrónico.

    Una fila por (mes, turno, concepto). 'total' es la columna Total del Excel (o efectivo + electrónico si falta);
    sirve para avisar cuando una venta trae más Total que Efectivo + Electrónico.
    """
    filas = _filas(wb, HOJA_INGRESOS)
    inicio, cols = _encabezados(filas, ["fecha", "tipo"])
    acum = {}
    for fila in filas[inicio + 1:]:
        f = _fecha(_celda(fila, cols, "fecha"))
        if f is None:
            continue
        clave = _TIPO_INGRESO.get(_norm(_celda(fila, cols, "tipo")), "excedente")
        concepto = _GRUPO_PAGO.get(clave, "otros")
        llave = (f.strftime("%Y-%m"), _turno(_celda(fila, cols, "turno")), concepto)
        efe, ele = _forma_pago(fila, cols)
        a = acum.setdefault(llave, [0.0, 0.0, 0.0])
        a[0] += efe
        a[1] += ele
        a[2] += _monto(fila, cols)
    return [{"mes": m, "turno": t, "concepto": c, "efectivo": round(v[0], 2), "electronico": round(v[1], 2), "total": round(v[2], 2)}
            for (m, t, c), v in sorted(acum.items())]


# ---------- Egresos ----------

def egresos_mensual(wb):
    """Suma los gastos por mes y categoría y dice si el mes está capturado por completo.

    Las categorías son EXACTAMENTE las del Excel (columna tipo): no se renombran ni se fijan en el código.
    Solo se unifican las que difieren en mayúsculas, acentos o espacios ("NOMINA" y "Nómina" son una sola);
    el nombre que se muestra es el primero que aparece en el libro.

    Estado de los gastos de un mes:
      - "sin captura": no hay filas o suman 0.
      - "completo":    tiene gasto de Nómina y de Renta (los gastos fijos del mes).
      - "parcial":     hay gastos, pero falta Nómina o Renta.
    """
    filas = _filas(wb, HOJA_EGRESOS)
    inicio, cols = _encabezados(filas, ["fecha", "tipo"])
    nombres = {}   # clave normalizada -> nombre tal como lo escribieron en el Excel (el primero)
    meses = {}
    for fila in filas[inicio + 1:]:
        f = _fecha(_celda(fila, cols, "fecha"))
        if f is None:
            continue
        crudo = re.sub(r"\s+", " ", str(_celda(fila, cols, "tipo") or "")).strip() or "Sin categoría"
        clave = _norm(crudo)
        nombre = nombres.setdefault(clave, crudo)
        mes = f.strftime("%Y-%m")
        cats = meses.setdefault(mes, {})
        cats[clave] = cats.get(clave, 0.0) + _monto(fila, cols)
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
            salida.append({"mes": mes, "categoria": nombres[clave], "monto": round(cats[clave], 2), "estado": estado})
    return salida


# ---------- Metas ----------

def _periodo(valor):
    """'Estándar' -> 'estandar'; fecha o texto AAAA-MM -> 'AAAA-MM'; otra cosa -> None."""
    if isinstance(valor, (datetime.datetime, datetime.date)):
        return f"{valor.year:04d}-{valor.month:02d}"
    n = _norm(valor)
    if n in ("estandar", "estandard", "standard"):
        return "estandar"
    m = re.fullmatch(r"(\d{4})-(\d{1,2})", n)
    if m and 1 <= int(m.group(2)) <= 12:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}"
    return None


def metas(wb):
    """Una fila por periodo; si un mes se repite, vale la última. Meta vacía = None."""
    filas = _filas(wb, HOJA_METAS)
    inicio, cols = _encabezados(filas, ["periodo", "meta ingresos", "meta socios"])
    por_id = {}
    for fila in filas[inicio + 1:]:
        pid = _periodo(_celda(fila, cols, "periodo"))
        if pid is None:
            continue
        ing = _numero(_celda(fila, cols, "meta ingresos"))
        soc = _numero(_celda(fila, cols, "meta socios"))
        por_id[pid] = {"id": pid, "ingresos": ing if ing is not None and ing >= 0 else None,
                       "socios": soc if soc is not None and soc >= 0 else None}
    return list(por_id.values())


# ---------- Usuarios ----------

_COL_USUARIO = ("user", "usuario", "nombre")
_COL_CLAVE = ("pass", "password", "contrasena", "clave", "hash", "sha256")


def usuarios(wb):
    """{usuario_en_minusculas: (nombre, sha256_en_minusculas)}. La columna pass guarda el SHA-256."""
    filas = _filas(wb, HOJA_USUARIOS)
    if not filas:
        return {}
    cabecera = [_norm(v) for v in filas[0]]
    cu = next((cabecera.index(n) for n in _COL_USUARIO if n in cabecera), 0)
    cc = next((cabecera.index(n) for n in _COL_CLAVE if n in cabecera), 1)
    salida = {}
    for fila in filas[1:]:
        if max(cu, cc) >= len(fila):
            continue
        nombre = str(fila[cu]).strip() if fila[cu] is not None else ""
        huella = str(fila[cc]).strip().lower() if fila[cc] is not None else ""
        if nombre:
            salida[nombre.lower()] = (nombre, huella)
    return salida


def abrir(ruta):
    try:
        return openpyxl.load_workbook(ruta, read_only=True, data_only=True)
    except FileNotFoundError:
        raise ErrorExcel(f"No encontré el archivo {ruta}.")
    except Exception as e:  # archivo abierto a medias, dañado, bloqueado…
        raise ErrorExcel(f"No pude leer el Excel ({type(e).__name__}).")


def leer_todo(ruta):
    wb = abrir(ruta)
    try:
        return {
            "ingresos_diarios": ingresos_diarios(wb),
            "egresos_mensual": egresos_mensual(wb),
            "ventas_mes": ventas_mensual(wb),
            "metas": metas(wb),
            "usuarios": usuarios(wb),
        }
    finally:
        wb.close()
