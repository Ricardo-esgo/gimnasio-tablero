"""Respaldo en Excel de la base: una hoja por tabla, con los nombres y valores tal cual están en la base.

    python exportar.py /ruta/kpis.db /ruta/salida.xlsx [--sin-usuarios]

Es dinámico: lee la estructura de la base (PRAGMA table_xinfo), así que si agregas o renombras columnas o tablas
sigue funcionando sin tocar este archivo. Columnas declaradas como DATE salen como fechas de Excel; el resto, tal cual
(incluidas las calculadas como total). La tabla usuarios sale con las contraseñas ya convertidas (SHA-256), nunca en claro.
"""
import datetime
import io
import os
import re
import sys
import tempfile

import openpyxl
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

import bd as BD

_INVALIDOS = re.compile(r"[\[\]\*\?:/\\]")


def _hoja(nombre):
    return _INVALIDOS.sub("_", nombre)[:31]


def construir(ruta_db, incluir_usuarios=True, reloj=None):
    con = BD.conectar(ruta_db, solo_lectura=True)
    try:
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        tablas = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        # primero las tablas de datos en un orden natural; el resto, alfabético
        orden = ["ingresos", "egresos", "metas", "usuarios"]
        tablas = [t for t in orden if t in tablas] + [t for t in tablas if t not in orden]
        negrita = Font(bold=True)
        for t in tablas:
            if t == "usuarios" and not incluir_usuarios:
                continue
            info = con.execute(f'PRAGMA table_xinfo("{t}")').fetchall()
            cols = [(r["name"], (r["type"] or "").upper()) for r in info if not r["hidden"] in (1,)]
            ws = wb.create_sheet(_hoja(t))
            ws.append([c for c, _ in cols])
            for c in ws[1]:
                c.font = negrita
            fechas = [i for i, (_, tipo) in enumerate(cols) if tipo in ("DATE", "DATETIME", "TIMESTAMP")]
            sel = ",".join(f'"{c}"' for c, _ in cols)
            for fila in con.execute(f'SELECT {sel} FROM "{t}" ORDER BY rowid'):
                valores = list(fila)
                for i in fechas:
                    v = valores[i]
                    if isinstance(v, str):
                        try:
                            valores[i] = datetime.datetime.fromisoformat(v) if len(v) > 10 else datetime.date.fromisoformat(v)
                        except ValueError:
                            pass
                ws.append(valores)
            for i in fechas:
                for celda in ws.iter_cols(min_col=i + 1, max_col=i + 1, min_row=2):
                    for c in celda:
                        c.number_format = "yyyy-mm-dd" if cols[i][1] == "DATE" else "yyyy-mm-dd hh:mm:ss"
            ws.freeze_panes = "A2"
            for i, (nombre, _) in enumerate(cols, 1):
                ancho = max([len(nombre)] + [len(str(c.value)) for c in ws[get_column_letter(i)][1:60] if c.value is not None])
                ws.column_dimensions[get_column_letter(i)].width = min(max(ancho + 2, 8), 50)
        return wb
    finally:
        con.close()


def a_bytes(ruta_db, incluir_usuarios=True):
    buf = io.BytesIO()
    construir(ruta_db, incluir_usuarios).save(buf)
    return buf.getvalue()


def a_archivo(ruta_db, destino, incluir_usuarios=True):
    """Escritura atómica: archivo temporal y reemplazo."""
    carpeta = os.path.dirname(os.path.abspath(destino))
    os.makedirs(carpeta, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".exp-", suffix=".xlsx", dir=carpeta)
    os.close(fd)
    try:
        construir(ruta_db, incluir_usuarios).save(tmp)
        os.replace(tmp, destino)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return destino


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        raise SystemExit(__doc__)
    print(a_archivo(args[0], args[1], "--sin-usuarios" not in sys.argv))
