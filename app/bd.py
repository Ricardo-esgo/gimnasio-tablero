"""Base de datos SQLite de los KPIs del gimnasio: esquema, conexión, versión y respaldos.

Tablas de datos (lo que alimenta los KPIs):
  ingresos   un registro por cierre: fecha, turno, personal, mem_* (membresías), mer_* (mercancías), excedente,
             total (lo calcula la propia base: suma de los cinco montos), revisado (0 = pendiente, 1 = aprobado)
             y estado (semáforo de la situación del registro: verde = coherente, amarillo = inconsistencia leve, rojo = grave).
  egresos    un registro por gasto: fecha, personal, tipo, concepto, efectivo, electronico, total (calculado), revisado, estado.
  metas      periodo ('estandar' o AAAA-MM), meta_ingresos, meta_socios, notas, lectura.
  usuarios   user, pass (SHA-256), perfil (admin|user), activo.
Tablas de apoyo:
  bitacora   de dónde vino cada registro cargado por la API (estado verde/amarillo/rojo, observaciones, mensajes de origen).
  historial  copia de lo que había antes de cada cambio hecho desde la pantalla de Revisión y Usuarios.
"""
import datetime
import glob
import os
import sqlite3

VERSION_ESQUEMA = 2   # 2: columna estado (semáforo) en ingresos y egresos

ESQUEMA = """
CREATE TABLE IF NOT EXISTS ingresos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha            DATE NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    turno            TEXT NOT NULL CHECK (length(turno) BETWEEN 1 AND 4),
    personal         TEXT NOT NULL CHECK (length(personal) > 0),
    mem_efectivo     REAL NOT NULL DEFAULT 0,
    mem_electronico  REAL NOT NULL DEFAULT 0,
    mer_efectivo     REAL NOT NULL DEFAULT 0,
    mer_electronico  REAL NOT NULL DEFAULT 0,
    excedente        REAL NOT NULL DEFAULT 0,
    total            REAL GENERATED ALWAYS AS (ROUND(mem_efectivo + mem_electronico + mer_efectivo + mer_electronico + excedente, 2)) STORED,
    revisado         BIT NOT NULL DEFAULT 0 CHECK (revisado IN (0, 1)),
    estado           TEXT NOT NULL DEFAULT 'verde' CHECK (estado IN ('verde', 'amarillo', 'rojo'))
);
CREATE INDEX IF NOT EXISTS ix_ingresos_fecha ON ingresos(fecha, turno);

CREATE TABLE IF NOT EXISTS egresos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha       DATE NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    personal    TEXT NOT NULL CHECK (length(personal) > 0),
    tipo        TEXT NOT NULL CHECK (length(tipo) > 0),
    concepto    TEXT NOT NULL DEFAULT '',
    efectivo    REAL NOT NULL DEFAULT 0,
    electronico REAL NOT NULL DEFAULT 0,
    total       REAL GENERATED ALWAYS AS (ROUND(efectivo + electronico, 2)) STORED,
    revisado    BIT NOT NULL DEFAULT 0 CHECK (revisado IN (0, 1)),
    estado      TEXT NOT NULL DEFAULT 'verde' CHECK (estado IN ('verde', 'amarillo', 'rojo'))
);
CREATE INDEX IF NOT EXISTS ix_egresos_fecha ON egresos(fecha);

CREATE TABLE IF NOT EXISTS metas (
    periodo       TEXT PRIMARY KEY,
    meta_ingresos REAL,
    meta_socios   REAL,
    notas         TEXT,
    lectura       TEXT
);

CREATE TABLE IF NOT EXISTS usuarios (
    "user"  TEXT PRIMARY KEY COLLATE NOCASE,
    "pass"  TEXT NOT NULL DEFAULT '',
    perfil  TEXT CHECK (perfil IS NULL OR perfil IN ('admin', 'user')),
    activo  BIT NOT NULL DEFAULT 0 CHECK (activo IN (0, 1)),
    CHECK (activo = 0 OR (length("user") > 0 AND perfil IS NOT NULL AND length("pass") = 64))
);

CREATE TABLE IF NOT EXISTS bitacora (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    hora        TEXT NOT NULL,
    tabla       TEXT NOT NULL CHECK (tabla IN ('ingresos', 'egresos')),
    registro_id INTEGER,
    id_origen   TEXT NOT NULL,
    huella      TEXT NOT NULL,
    estado      TEXT NOT NULL DEFAULT 'verde' CHECK (estado IN ('verde', 'amarillo', 'rojo')),
    observaciones TEXT,
    fuente      TEXT,
    UNIQUE (tabla, id_origen)
);
CREATE INDEX IF NOT EXISTS ix_bitacora_registro ON bitacora(tabla, registro_id);

CREATE TABLE IF NOT EXISTS historial (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    hora     TEXT NOT NULL,
    usuario  TEXT NOT NULL,
    tabla    TEXT NOT NULL,
    registro TEXT NOT NULL,
    accion   TEXT NOT NULL,
    antes    TEXT,
    despues  TEXT
);
CREATE INDEX IF NOT EXISTS ix_historial_registro ON historial(tabla, registro);
"""


def ahora_iso(reloj=None):
    t = reloj() if reloj else datetime.datetime.now()
    return t.strftime("%Y-%m-%d %H:%M:%S")


def conectar(ruta, solo_lectura=False, espera_s=15):
    """Abre la base con transacciones manuales (BEGIN IMMEDIATE). Escritura: WAL + claves foráneas."""
    if solo_lectura:
        con = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=espera_s, isolation_level=None)
    else:
        con = sqlite3.connect(ruta, timeout=espera_s, isolation_level=None)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=FULL")
    con.execute("PRAGMA foreign_keys=ON")
    con.execute(f"PRAGMA busy_timeout={int(espera_s * 1000)}")
    con.row_factory = sqlite3.Row
    return con


def iniciar(ruta):
    """Crea la carpeta y las tablas que falten, y deja anotada la versión del esquema."""
    os.makedirs(os.path.dirname(os.path.abspath(ruta)), exist_ok=True)
    con = conectar(ruta)
    try:
        con.executescript(ESQUEMA)
        version = con.execute("PRAGMA user_version").fetchone()[0]
        if version == 0:
            con.execute(f"PRAGMA user_version = {VERSION_ESQUEMA}")
        elif version < VERSION_ESQUEMA:
            _migrar(con, version)
    finally:
        con.close()


def _migrar(con, desde):
    """Lleva una base de una versión anterior a la actual. Cada paso es seguro de repetir."""
    if desde < 2:
        # v2: columna estado en ingresos y egresos. Lo ya cargado por la API conserva el semáforo que dejó en la bitácora.
        for tabla in ("ingresos", "egresos"):
            if "estado" not in {r[1] for r in con.execute(f"PRAGMA table_info({tabla})")}:
                con.execute(f"ALTER TABLE {tabla} ADD COLUMN estado TEXT NOT NULL DEFAULT 'verde' "
                            "CHECK (estado IN ('verde', 'amarillo', 'rojo'))")
            con.execute(f"UPDATE {tabla} SET estado = (SELECT b.estado FROM bitacora b WHERE b.tabla = ? AND b.registro_id = {tabla}.id) "
                        f"WHERE EXISTS (SELECT 1 FROM bitacora b WHERE b.tabla = ? AND b.registro_id = {tabla}.id)", (tabla, tabla))
    con.execute(f"PRAGMA user_version = {VERSION_ESQUEMA}")


def respaldar(ruta, carpeta, conservar=14, reloj=None):
    """Copia consistente de la base (API de respaldo de SQLite, segura con la base en uso)."""
    os.makedirs(carpeta, exist_ok=True)
    t = reloj() if reloj else datetime.datetime.now()
    n = 0
    while True:   # el sufijo evita pisar dos respaldos del mismo segundo y mantiene el orden por nombre
        destino = os.path.join(carpeta, "kpis-" + t.strftime("%Y%m%d-%H%M%S") + f"-{n:02d}.db")
        if not os.path.exists(destino):
            break
        n += 1
    origen = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True)
    try:
        copia = sqlite3.connect(destino)
        try:
            origen.backup(copia)
        finally:
            copia.close()
    finally:
        origen.close()
    rotar(carpeta, "kpis-*.db", conservar)
    return destino


def rotar(carpeta, patron, conservar):
    viejos = sorted(glob.glob(os.path.join(carpeta, patron)))
    for v in (viejos[:-conservar] if conservar > 0 else []):
        try:
            os.remove(v)
        except OSError:
            pass
