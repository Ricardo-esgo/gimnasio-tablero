"""Reglas de negocio de ingresos, egresos y usuarios. Las usan por igual las pantallas (Revisión, Usuarios) y la API de alta.

Conceptos:
  - Errores (ErrorValidacion): impiden guardar. Ejemplo: fecha inválida, total en 0.
  - Advertencias (RequiereConfirmacion): se pueden guardar si la persona las acepta. Ejemplo: ya existe un cierre del mismo turno.
  - Un registro con revisado = 1 está bloqueado: lo único que se puede hacer es quitarle la palomita.
"""
import datetime
import hashlib
import json
import math
import re
import unicodedata

import bd as BD

CAMPOS_ING = ("mem_efectivo", "mem_electronico", "mer_efectivo", "mer_electronico", "excedente")
EDIT_ING = ("turno",) + CAMPOS_ING
CAMPOS_EGR = ("efectivo", "electronico")
EDIT_EGR = ("tipo", "concepto") + CAMPOS_EGR
TURNOS_USUALES = ("M", "V", "TM", "TD")
TIPOS_EGRESO_BASE = ["Nómina", "Renta", "Mercancia", "Insumos", "Servicios"]
ESTADOS = ("verde", "amarillo", "rojo")   # semáforo de la situación de un registro: coherente / inconsistencia leve / grave
GRANDE = 50_000
MAX_MONTO = 10_000_000
MIN_CLAVE = 8
PERFILES = ("admin", "user")


class ErrorValidacion(Exception):
    def __init__(self, detalles):
        self.detalles = detalles if isinstance(detalles, list) else [detalles]
        super().__init__("; ".join(self.detalles))


class RequiereConfirmacion(Exception):
    def __init__(self, avisos):
        self.avisos = avisos
        super().__init__("; ".join(avisos))


class Conflicto(Exception):
    pass


class NoExiste(Exception):
    pass


def norm(v):
    if v is None:
        return ""
    t = unicodedata.normalize("NFKD", str(v))
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", t).strip().lower()


def mxn(v):
    return "${:,.2f}".format(v)


# ------------------------------------------------------------------ campos

def _monto(v, campo, errores):
    if v is None or v == "":
        return 0.0
    if isinstance(v, bool):
        errores.append(f"{campo}: no es un número")
        return 0.0
    if isinstance(v, str):
        try:
            v = float(v.replace("$", "").replace(",", "").strip())
        except ValueError:
            errores.append(f"{campo}: '{v}' no es un número")
            return 0.0
    if not isinstance(v, (int, float)) or math.isnan(v) or math.isinf(v):
        errores.append(f"{campo}: no es un número válido")
        return 0.0
    if abs(v) > MAX_MONTO:
        errores.append(f"{campo}: {v} está fuera de rango")
        return 0.0
    return round(float(v), 2)


def _texto(v, campo, errores, obligatorio=False, maximo=80):
    t = re.sub(r"\s+", " ", str(v)).strip() if v is not None and not isinstance(v, bool) else ""
    if not t:
        if obligatorio:
            errores.append(f"{campo}: es obligatorio")
        return ""
    if len(t) > maximo:
        errores.append(f"{campo}: máximo {maximo} caracteres")
        return t[:maximo]
    return t


def _fecha(v, errores):
    if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v.strip()):
        errores.append("fecha: es obligatoria (AAAA-MM-DD)")
        return None
    try:
        datetime.date.fromisoformat(v.strip())
    except ValueError:
        errores.append(f"fecha: '{v}' no es una fecha real")
        return None
    return v.strip()


def _turno(v, errores):
    t = re.sub(r"\s+", "", str(v or "")).upper()
    if not re.fullmatch(r"[A-Z]{1,4}", t):
        errores.append("turno: es obligatorio (M, V, TM, TD…; hasta 4 letras)")
        return ""
    return t


def _avisos_fecha(fecha, hoy, avisos):
    if not fecha:
        return
    f = datetime.date.fromisoformat(fecha)
    if f > hoy + datetime.timedelta(days=1):
        avisos.append(f"La fecha {fecha} es futura.")
    elif (hoy - f).days > 400:
        avisos.append(f"La fecha {fecha} es de hace más de 400 días.")


# ------------------------------------------------------------------ validación

def validar_ingreso(con, d, id_actual=None, hoy=None):
    """d trae todos los campos del registro. Devuelve (valores, errores, advertencias)."""
    hoy = hoy or datetime.date.today()
    errores, avisos = [], []
    v = {"fecha": _fecha(d.get("fecha"), errores), "turno": _turno(d.get("turno"), errores),
         "personal": _texto(d.get("personal"), "personal", errores, obligatorio=True)}
    for c in CAMPOS_ING:
        v[c] = _monto(d.get(c), c, errores)
    v["revisado"] = 1 if d.get("revisado") in (1, True, "1") else 0
    v["estado"] = "verde"   # el semáforo lo fija la carga automática; a mano siempre es verde
    total = round(sum(v[c] for c in CAMPOS_ING), 2)
    if not errores and total == 0:
        errores.append("total: no puede ser 0; captura al menos un monto distinto de cero (puede ser negativo si es una pérdida)")
    if errores:
        return v, errores, avisos
    otro = con.execute("SELECT id FROM ingresos WHERE fecha=? AND turno=? AND id IS NOT ?", (v["fecha"], v["turno"], id_actual)).fetchone()
    if otro:
        avisos.append(f"Ya existe un cierre del turno {v['turno']} del {v['fecha']}.")
    _avisos_fecha(v["fecha"], hoy, avisos)
    if v["turno"] not in TURNOS_USUALES:
        avisos.append(f"El turno '{v['turno']}' no es M, V, TM ni TD.")
    if any(v[c] < 0 for c in CAMPOS_ING if c != "excedente"):
        avisos.append("Hay montos negativos en membresías o mercancías.")
    if abs(total) > GRANDE:
        avisos.append(f"El total ({mxn(total)}) es inusualmente alto.")
    conocidos = {norm(r[0]) for r in con.execute("SELECT DISTINCT personal FROM ingresos")}
    if conocidos and norm(v["personal"]) not in conocidos:
        avisos.append(f"El nombre '{v['personal']}' no aparece en cierres anteriores.")
    return v, errores, avisos


def categorias_egreso(con):
    cats = {}
    for r in con.execute("SELECT tipo FROM egresos GROUP BY tipo ORDER BY MIN(id)"):
        cats.setdefault(norm(r[0]), r[0])
    for t in TIPOS_EGRESO_BASE:
        cats.setdefault(norm(t), t)
    return cats


def validar_egreso(con, d, id_actual=None, hoy=None):
    hoy = hoy or datetime.date.today()
    errores, avisos = [], []
    v = {"fecha": _fecha(d.get("fecha"), errores),
         "personal": _texto(d.get("personal"), "personal", errores, obligatorio=True),
         "tipo": _texto(d.get("tipo"), "tipo", errores, obligatorio=True, maximo=60),
         "concepto": _texto(d.get("concepto"), "concepto", errores, obligatorio=True, maximo=200)}
    for c in CAMPOS_EGR:
        v[c] = _monto(d.get(c), c, errores)
    v["revisado"] = 1 if d.get("revisado") in (1, True, "1") else 0
    v["estado"] = "verde"
    total = round(v["efectivo"] + v["electronico"], 2)
    if not errores and total == 0:
        errores.append("total: no puede ser 0; captura efectivo o electrónico")
    if errores:
        return v, errores, avisos
    cats = categorias_egreso(con)
    canon = cats.get(norm(v["tipo"]))
    if canon:
        v["tipo"] = canon          # 'nomina' -> 'Nómina', como ya está en tus datos
    else:
        avisos.append(f"La categoría '{v['tipo']}' es nueva: no existe en los egresos anteriores.")
    dup = con.execute("SELECT id FROM egresos WHERE fecha=? AND lower(concepto)=lower(?) AND total=? AND id IS NOT ?",
                      (v["fecha"], v["concepto"], total, id_actual)).fetchone()
    if dup:
        avisos.append("Parece duplicado: ya hay un gasto con la misma fecha, concepto y total.")
    _avisos_fecha(v["fecha"], hoy, avisos)
    if total < 0:
        avisos.append("El total es negativo.")
    if abs(total) > GRANDE:
        avisos.append(f"El total ({mxn(total)}) es inusualmente alto.")
    conocidos = {norm(r[0]) for r in con.execute("SELECT DISTINCT personal FROM egresos")}
    if conocidos and norm(v["personal"]) not in conocidos:
        avisos.append(f"El nombre '{v['personal']}' no aparece en gastos anteriores.")
    return v, errores, avisos


VALIDAR = {"ingresos": validar_ingreso, "egresos": validar_egreso}
EDITABLES = {"ingresos": EDIT_ING, "egresos": EDIT_EGR}
COLS = {
    "ingresos": ("id", "fecha", "turno", "personal") + CAMPOS_ING + ("total", "revisado", "estado"),
    "egresos": ("id", "fecha", "personal", "tipo", "concepto") + CAMPOS_EGR + ("total", "revisado", "estado"),
}


# ------------------------------------------------------------------ lectura

def _fila(con, tabla, id_):
    r = con.execute(f"SELECT {','.join(COLS[tabla])} FROM {tabla} WHERE id=?", (id_,)).fetchone()
    return dict(r) if r else None


def _historial(con, usuario, tabla, registro, accion, antes, despues, reloj=None):
    con.execute("INSERT INTO historial(hora,usuario,tabla,registro,accion,antes,despues) VALUES(?,?,?,?,?,?,?)",
                (BD.ahora_iso(reloj), usuario, tabla, str(registro), accion,
                 json.dumps(antes, ensure_ascii=False) if antes is not None else None,
                 json.dumps(despues, ensure_ascii=False) if despues is not None else None))


def meses(con, tabla):
    return [r[0] for r in con.execute(f"SELECT DISTINCT substr(fecha,1,7) m FROM {tabla} ORDER BY m")]


def listar_revision(con, tabla, mes=None):
    """Filas de un mes (por omisión, el último disponible) con lo que dejó la carga automática (bitácora)."""
    if tabla not in COLS:
        raise ErrorValidacion("tabla: debe ser ingresos o egresos")
    disp = meses(con, tabla)
    if mes is not None and not re.fullmatch(r"\d{4}-\d{2}", str(mes)):
        raise ErrorValidacion("mes: debe ser AAAA-MM")
    mes = mes if mes in disp else (disp[-1] if disp else None)
    filas = []
    if mes:
        cols = ",".join("t." + c for c in COLS[tabla])
        for r in con.execute(f"""SELECT {cols}, b.observaciones AS carga_obs
                                 FROM {tabla} t LEFT JOIN bitacora b ON b.tabla=? AND b.registro_id=t.id
                                 WHERE substr(t.fecha,1,7)=? ORDER BY t.fecha, t.id""", (tabla, mes)):
            filas.append(dict(r))
    return {"tabla": tabla, "mes": mes, "meses": disp, "filas": filas, "sugerencias": sugerencias(con)}


def sugerencias(con):
    personal = sorted({r[0] for t in ("ingresos", "egresos") for r in con.execute(f"SELECT DISTINCT personal FROM {t}")}, key=norm)
    return {"personal": personal, "turnos": list(TURNOS_USUALES), "tipos_egreso": sorted(categorias_egreso(con).values(), key=norm)}


# ------------------------------------------------------------------ escritura desde pantalla

def _transaccion(con):
    con.execute("BEGIN IMMEDIATE")


def crear(con, tabla, d, usuario, confirmar=False, hoy=None, reloj=None):
    _transaccion(con)
    try:
        v, errores, avisos = VALIDAR[tabla](con, d, None, hoy)
        if errores:
            raise ErrorValidacion(errores)
        if avisos and not confirmar:
            raise RequiereConfirmacion(avisos)
        cols = [c for c in COLS[tabla] if c not in ("id", "total")]
        cur = con.execute(f"INSERT INTO {tabla}({','.join(cols)}) VALUES({','.join('?' * len(cols))})", [v[c] for c in cols])
        fila = _fila(con, tabla, cur.lastrowid)
        _historial(con, usuario, tabla, fila["id"], "creado", None, fila, reloj)
        con.execute("COMMIT")
        return fila
    except BaseException:
        con.execute("ROLLBACK")
        raise


def actualizar(con, tabla, id_, cambios, usuario, confirmar=False, hoy=None, reloj=None):
    _transaccion(con)
    try:
        actual = _fila(con, tabla, id_)
        if actual is None:
            raise NoExiste("El registro ya no existe.")
        pide = cambios.get("revisado", actual["revisado"])
        pide = 1 if pide in (1, True, "1") else 0
        editables = EDITABLES[tabla]
        if actual["revisado"] == 1:
            # bloqueado: lo único permitido es quitarle la palomita
            if pide != 0:
                raise Conflicto("El registro está revisado y no se puede modificar. Quita la palomita para editarlo.")
            if any(k in cambios and _distinto(cambios[k], actual[k]) for k in editables):
                raise Conflicto("El registro está revisado: primero quita la palomita y luego edítalo.")
            con.execute(f"UPDATE {tabla} SET revisado=0 WHERE id=?", (id_,))
            nuevo = _fila(con, tabla, id_)
            _historial(con, usuario, tabla, id_, "quitó la revisión", actual, nuevo, reloj)
            con.execute("COMMIT")
            return nuevo, []
        for k in ("fecha", "personal"):
            if k in cambios and _distinto(cambios[k], actual[k]) and norm(cambios[k]) != norm(actual[k]):
                raise ErrorValidacion(f"{k}: no se puede cambiar después de guardar; elimina el registro y vuelve a capturarlo")
        d = dict(actual)
        for k in editables:
            if k in cambios:
                d[k] = cambios[k]
        d["revisado"] = pide
        v, errores, avisos = VALIDAR[tabla](con, d, id_, hoy)
        if errores:
            raise ErrorValidacion(errores)
        if avisos and not confirmar:
            raise RequiereConfirmacion(avisos)
        sets = list(editables) + ["revisado"]
        con.execute(f"UPDATE {tabla} SET {','.join(s + '=?' for s in sets)} WHERE id=?", [v[s] for s in sets] + [id_])
        nuevo = _fila(con, tabla, id_)
        _historial(con, usuario, tabla, id_, "aprobó" if pide else "editó", actual, nuevo, reloj)
        con.execute("COMMIT")
        return nuevo, avisos
    except BaseException:
        con.execute("ROLLBACK")
        raise


def _distinto(a, b):
    try:
        return round(float(a or 0), 2) != round(float(b or 0), 2) if isinstance(b, (int, float)) else str(a or "").strip() != str(b or "").strip()
    except (TypeError, ValueError):
        return True


def borrar(con, tabla, id_, usuario, reloj=None):
    _transaccion(con)
    try:
        actual = _fila(con, tabla, id_)
        if actual is None:
            raise NoExiste("El registro ya no existe.")
        if actual["revisado"] == 1:
            raise Conflicto("Para eliminar un registro primero hay que quitarle la palomita de revisado.")
        con.execute(f"UPDATE bitacora SET registro_id=NULL WHERE tabla=? AND registro_id=?", (tabla, id_))
        con.execute(f"DELETE FROM {tabla} WHERE id=?", (id_,))
        _historial(con, usuario, tabla, id_, "eliminó", actual, None, reloj)
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise


# ------------------------------------------------------------------ usuarios

def huella_clave(clave):
    return hashlib.sha256(clave.encode("utf-8")).hexdigest()


def listar_usuarios(con):
    return [{"user": r["user"], "perfil": r["perfil"], "activo": int(r["activo"]), "tiene_clave": len(r["pass"]) == 64}
            for r in con.execute('SELECT "user", "pass", perfil, activo FROM usuarios ORDER BY "user" COLLATE NOCASE')]


def _usuario(con, nombre):
    r = con.execute('SELECT "user", "pass", perfil, activo FROM usuarios WHERE "user"=?', (nombre,)).fetchone()
    return dict(r) if r else None


def _admins_activos(con, excluyendo=None):
    return con.execute("SELECT COUNT(*) FROM usuarios WHERE perfil='admin' AND activo=1 AND \"user\" IS NOT ? COLLATE NOCASE", (excluyendo,)).fetchone()[0]


def _clave(datos, errores):
    clave = datos.get("clave")
    if clave in (None, ""):
        return None
    clave = str(clave)
    if clave != str(datos.get("clave_confirmacion", "")):
        errores.append("No se guardó porque el valor del password no es igual.")
        return None
    if len(clave) < MIN_CLAVE:
        errores.append(f"La contraseña debe tener al menos {MIN_CLAVE} caracteres.")
        return None
    return huella_clave(clave)


def _publico(u):
    return {"user": u["user"], "perfil": u["perfil"], "activo": int(u["activo"]), "tiene_clave": len(u["pass"]) == 64}


def guardar_usuario(con, original, datos, sesion, reloj=None):
    """original = nombre actual (None para uno nuevo). datos: user, perfil, activo, clave, clave_confirmacion."""
    _transaccion(con)
    try:
        errores = []
        actual = _usuario(con, original) if original else None
        if original and actual is None:
            raise NoExiste("El usuario ya no existe.")
        quiere_activo = 1 if datos.get("activo") in (1, True, "1") else 0
        if actual and actual["activo"] == 1:
            # activo = bloqueado: solo se permite inactivarlo
            if quiere_activo != 0:
                raise Conflicto("El usuario está activo: para editarlo primero hay que inactivarlo.")
            if norm(sesion) == norm(actual["user"]):
                raise Conflicto("No puedes inactivar tu propio usuario.")
            if actual["perfil"] == "admin" and _admins_activos(con, actual["user"]) == 0:
                raise Conflicto("Debe quedar al menos un administrador activo.")
            con.execute('UPDATE usuarios SET activo=0 WHERE "user"=?', (actual["user"],))
            _historial(con, sesion, "usuarios", actual["user"], "inactivó", _publico(actual), _publico(_usuario(con, actual["user"])), reloj)
            con.execute("COMMIT")
            return _publico(_usuario(con, actual["user"]))
        nombre = _texto(datos.get("user", actual["user"] if actual else ""), "user", errores, maximo=40)
        if nombre and not re.fullmatch(r"[\w .\-]{1,40}", nombre):
            errores.append("user: usa letras, números, espacios, punto, guion o guion bajo")
        perfil = datos.get("perfil", actual["perfil"] if actual else None) or None
        if perfil is not None and perfil not in PERFILES:
            errores.append("perfil: debe ser admin o user")
        nueva = _clave(datos, errores)
        clave_guardada = nueva or (actual["pass"] if actual else "")
        if nombre and norm(nombre) != norm(original or ""):
            if _usuario(con, nombre):
                errores.append(f"user: ya existe '{nombre}'")
        if quiere_activo:
            faltan = [n for n, ok in (("nombre", bool(nombre)), ("perfil", perfil is not None), ("contraseña", len(clave_guardada) == 64)) if not ok]
            if faltan:
                errores.append("Para activar un usuario deben estar completos: nombre, perfil y contraseña (falta " + ", ".join(faltan) + ").")
        if not nombre and not any(e.startswith("user") for e in errores):
            errores.append("user: es obligatorio")
        if errores:
            raise ErrorValidacion(errores)
        if actual:
            con.execute('UPDATE usuarios SET "user"=?, "pass"=?, perfil=?, activo=? WHERE "user"=?',
                        (nombre, clave_guardada, perfil, quiere_activo, actual["user"]))
            accion = "activó" if quiere_activo else "editó"
            antes = _publico(actual)
        else:
            con.execute('INSERT INTO usuarios("user","pass",perfil,activo) VALUES(?,?,?,?)', (nombre, clave_guardada, perfil, quiere_activo))
            accion, antes = "creó", None
        nuevo = _usuario(con, nombre)
        if not _admins_activos(con) and not (nuevo["perfil"] == "admin" and nuevo["activo"]):
            raise Conflicto("Debe quedar al menos un administrador activo.")
        _historial(con, sesion, "usuarios", nombre, accion, antes, _publico(nuevo), reloj)
        con.execute("COMMIT")
        return _publico(nuevo)
    except BaseException:
        con.execute("ROLLBACK")
        raise


def verificar_login(con, nombre, clave):
    """Devuelve el usuario (dict) si existe, está activo y la clave coincide; si no, None. Tiempo similar en todos los casos."""
    import hmac
    u = _usuario(con, nombre)
    esperado = u["pass"] if u and len(u["pass"]) == 64 else "0" * 64
    ok = hmac.compare_digest(huella_clave(clave), esperado)
    return u if (ok and u and u["activo"] == 1 and u["perfil"] and len(u["pass"]) == 64) else None


def usuario_activo(con, nombre):
    u = _usuario(con, nombre)
    return u if u and u["activo"] == 1 and u["perfil"] else None


# ------------------------------------------------------------------ metas (las edita el admin; no se borran)

def listar_metas(con):
    return [dict(r) for r in con.execute(
        "SELECT periodo, meta_ingresos, meta_socios, notas, lectura FROM metas ORDER BY CASE periodo WHEN 'estandar' THEN '' ELSE periodo END")]


def guardar_meta(con, periodo, datos, usuario, reloj=None):
    """Crea o actualiza la meta de un periodo ('estandar' o AAAA-MM). Una meta vacía = sin meta."""
    errores = []
    p = norm(periodo)
    if p in ("estandar", "standard"):
        p = "estandar"
    elif not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", str(periodo or "").strip()):
        errores.append("periodo: debe ser 'estandar' o un mes AAAA-MM")
    else:
        p = str(periodo).strip()
    valores = {}
    for campo in ("meta_ingresos", "meta_socios"):
        v = datos.get(campo)
        if v in (None, ""):
            valores[campo] = None
            continue
        mo = _monto(v, campo, errores)
        if mo < 0:
            errores.append(f"{campo}: no puede ser negativa")
        valores[campo] = mo
    for campo in ("notas", "lectura"):
        valores[campo] = _texto(datos.get(campo), campo, errores, maximo=300) or None
    if errores:
        raise ErrorValidacion(errores)
    _transaccion(con)
    try:
        antes = con.execute("SELECT * FROM metas WHERE periodo=?", (p,)).fetchone()
        con.execute("""INSERT INTO metas(periodo,meta_ingresos,meta_socios,notas,lectura) VALUES(?,?,?,?,?)
                       ON CONFLICT(periodo) DO UPDATE SET meta_ingresos=excluded.meta_ingresos, meta_socios=excluded.meta_socios,
                       notas=excluded.notas, lectura=excluded.lectura""",
                    (p, valores["meta_ingresos"], valores["meta_socios"], valores["notas"], valores["lectura"]))
        nuevo = dict(con.execute("SELECT * FROM metas WHERE periodo=?", (p,)).fetchone())
        _historial(con, usuario, "metas", p, "editó" if antes else "creó", dict(antes) if antes else None, nuevo, reloj)
        con.execute("COMMIT")
        return nuevo
    except BaseException:
        con.execute("ROLLBACK")
        raise


# ------------------------------------------------------------------ alta por API (solo agrega; nunca modifica ni borra)

PERMITIDOS = {
    "ingresos": {"fecha", "turno", "personal", *CAMPOS_ING, "id_origen", "estado", "observaciones", "fuente"},
    "egresos": {"fecha", "personal", "tipo", "concepto", *CAMPOS_EGR, "id_origen", "estado", "observaciones", "fuente"},
}


def _huella_carga(tabla, v):
    campos = ("fecha", "turno", "personal") + CAMPOS_ING if tabla == "ingresos" else ("fecha", "personal", "tipo", "concepto") + CAMPOS_EGR
    base = {c: v.get(c) for c in campos}
    return hashlib.sha256(json.dumps(base, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def registrar_lote(con, tabla_defecto, items, hoy=None, reloj=None, max_lote=200):
    """Alta de registros nuevos. Todo o nada: si uno falla, no se escribe ninguno.

    Cada registro queda con revisado = 0 y su origen anotado en la bitácora. Reenviar el mismo (mismo id_origen y mismos datos)
    es seguro: responde sin_cambios. Un registro que ya existe con otros datos, o que se eliminó en la revisión, se rechaza (409):
    las correcciones se hacen en la pantalla de Revisión, no por la API.
    """
    if not isinstance(items, list) or not items:
        raise ErrorValidacion("el lote está vacío")
    if len(items) > max_lote:
        raise ErrorValidacion(f"el lote trae {len(items)} registros; el máximo es {max_lote}")
    errores, conflictos, planes, vistos = [], [], [], set()
    _transaccion(con)
    try:
        for n, it in enumerate(items, 1):
            pre = f"registro {n}: "
            if not isinstance(it, dict):
                errores.append(pre + "debe ser un objeto JSON")
                continue
            tabla = it.get("tabla") or tabla_defecto
            if tabla not in PERMITIDOS:
                errores.append(pre + "tabla: debe ser 'ingresos' o 'egresos'")
                continue
            if "revisado" in it:
                errores.append(pre + "revisado: no se puede enviar por la API; la aprobación se hace en la pantalla de Revisión")
            extra = set(it) - PERMITIDOS[tabla] - {"tabla"}
            if extra:
                errores.append(pre + "campos desconocidos: " + ", ".join(sorted(extra)))
            estado = it.get("estado", "verde")
            if estado not in ESTADOS:
                errores.append(pre + "estado: debe ser verde, amarillo o rojo")
            v, errs, avisos = VALIDAR[tabla](con, {k: x for k, x in it.items() if k not in ("revisado",)}, None, hoy)
            v["revisado"] = 0
            errores += [pre + e for e in errs]
            id_origen = _texto(it.get("id_origen"), "id_origen", errores, maximo=120)
            if not id_origen:
                if tabla == "ingresos" and v.get("fecha") and v.get("turno"):
                    id_origen = f"{v['fecha']}|{v['turno']}"
                elif tabla == "egresos":
                    errores.append(pre + "id_origen: es obligatorio en egresos (por ejemplo el id del mensaje del chat); evita duplicados al reintentar")
            if errs or any(e.startswith(pre) for e in errores):
                continue
            llave = (tabla, id_origen)
            if llave in vistos:
                errores.append(pre + f"id_origen '{id_origen}' viene repetido en el lote")
                continue
            vistos.add(llave)
            huella = _huella_carga(tabla, v)
            previa = con.execute("SELECT registro_id, huella FROM bitacora WHERE tabla=? AND id_origen=?", (tabla, id_origen)).fetchone()
            if previa:
                if previa["registro_id"] is None:
                    conflictos.append(pre + f"'{id_origen}' ya se cargó y después se eliminó en la revisión; no se vuelve a cargar")
                elif previa["huella"] == huella:
                    planes.append(("sin_cambios", tabla, id_origen, previa["registro_id"], avisos, v, estado, it))
                else:
                    conflictos.append(pre + f"'{id_origen}' ya está registrado con otros datos (id {previa['registro_id']}); corrígelo en la pantalla de Revisión")
                continue
            if tabla == "ingresos":
                dup = con.execute("SELECT id FROM ingresos WHERE fecha=? AND turno=?", (v["fecha"], v["turno"])).fetchone()
                if dup:
                    conflictos.append(pre + f"ya existe un cierre del turno {v['turno']} del {v['fecha']} (id {dup['id']}); la API solo agrega cierres nuevos")
                    continue
            planes.append(("agregado", tabla, id_origen, None, avisos, v, estado, it))
        if errores:
            raise ErrorValidacion(errores)
        if conflictos:
            raise Conflicto(" | ".join(conflictos))
        resultados = []
        hora = BD.ahora_iso(reloj)
        for accion, tabla, id_origen, rid, avisos, v, estado, it in planes:
            if accion == "agregado":
                obs = _texto(it.get("observaciones"), "observaciones", [], maximo=1000)
                if avisos:
                    obs = (obs + " | " if obs else "") + "Advertencias: " + " ".join(avisos)
                    estado = "rojo" if estado == "rojo" else "amarillo"
                v["estado"] = estado
                cols = [c for c in COLS[tabla] if c not in ("id", "total")]
                cur = con.execute(f"INSERT INTO {tabla}({','.join(cols)}) VALUES({','.join('?' * len(cols))})", [v[c] for c in cols])
                rid = cur.lastrowid
                fuente = it.get("fuente")
                con.execute("INSERT INTO bitacora(hora,tabla,registro_id,id_origen,huella,estado,observaciones,fuente) VALUES(?,?,?,?,?,?,?,?)",
                            (hora, tabla, rid, id_origen, _huella_carga(tabla, v), estado, obs or None,
                             json.dumps(fuente, ensure_ascii=False) if fuente is not None else None))
                _historial(con, "api", tabla, rid, "cargó", None, _fila(con, tabla, rid), reloj)
            resultados.append({"id": rid, "tabla": tabla, "id_origen": id_origen, "accion": accion, "advertencias": avisos})
        con.execute("COMMIT")
        return resultados
    except BaseException:
        con.execute("ROLLBACK")
        raise
