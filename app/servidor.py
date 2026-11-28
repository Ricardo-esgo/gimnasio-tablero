"""Servidor del tablero financiero del gimnasio: tablero + base SQLite + API de carga, todo en un solo contenedor.

Solo usa la biblioteca estándar de Python y openpyxl. Variables de entorno:
  DB_DIR               carpeta de la base dentro del contenedor (por defecto /datos). Debe poder ESCRIBIRSE.
  DB_FILE              nombre de la base (por defecto kpis.db)
  EXCEL_INICIAL        Excel con el que se llena la base la primera vez (solo si la base está vacía). Por defecto
                       Data_Base.xlsx dentro de DB_DIR. Si no existe, la base arranca vacía.
  PORT                 puerto interno (por defecto 8080)
  SESSION_SECRET       texto largo y secreto para firmar las sesiones
  SESSION_HORAS        duración de una sesión en horas (por defecto 12)
  COOKIE_SECURE        "true" si el tablero se sirve por HTTPS
  API_TOKEN_ESCRITURA  clave para dar de alta cierres y gastos por la API (sin ella, la API de carga queda apagada)
  API_TOKEN_LECTURA    clave opcional para consultar por la API sin poder escribir
  RESPALDO_HORAS       cada cuántas horas se respalda la base y se genera un Excel (por defecto 24; 0 = no)
  RESPALDOS_CONSERVAR  cuántos respaldos guardar de cada tipo (por defecto 14)

Quién puede qué:
  - Cualquier usuario activo ve el tablero.
  - Solo perfil admin usa /api/admin/* (Revisión, Usuarios, Excel de respaldo).
  - La API /api/v1/* solo AGREGA registros nuevos (y consulta). No modifica ni borra: eso se hace en la pantalla.
"""
import base64
import datetime
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import bd as BD
import datos as D
import exportar
import kpis

DB_DIR = os.environ.get("DB_DIR", "/datos")
DB_FILE = os.environ.get("DB_FILE", "kpis.db")
RUTA_DB = str(Path(DB_DIR) / DB_FILE)
EXCEL_INICIAL = os.environ.get("EXCEL_INICIAL") or str(Path(DB_DIR) / "Data_Base.xlsx")
PORT = int(os.environ.get("PORT", "8080"))
SESION_HORAS = float(os.environ.get("SESSION_HORAS", "12"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").strip().lower() in ("1", "true", "si", "sí", "yes")
SECRETO = (os.environ.get("SESSION_SECRET") or "").encode() or secrets.token_bytes(32)
SECRETO_FIJO = bool(os.environ.get("SESSION_SECRET"))
TOKEN_ESCRITURA = (os.environ.get("API_TOKEN_ESCRITURA") or "").strip()
TOKEN_LECTURA = (os.environ.get("API_TOKEN_LECTURA") or "").strip()
RESPALDO_HORAS = float(os.environ.get("RESPALDO_HORAS", "24"))
RESPALDOS_CONSERVAR = int(os.environ.get("RESPALDOS_CONSERVAR", "14"))
CARPETA_RESPALDOS = str(Path(DB_DIR) / "respaldos")
WEB = Path(__file__).parent / "web"
COOKIE = "sesion_gimnasio"
MAX_ADMIN = 20_000
MAX_API = 1_000_000

_fallos = {}      # intentos fallidos de login por dirección: 5 fallos bloquean 60 s
_fallos_api = {}  # claves de API incorrectas por dirección
_candado = threading.Lock()


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


# ---------- Sesión firmada ----------

def _firma(texto):
    return hmac.new(SECRETO, texto.encode(), hashlib.sha256).hexdigest()


def crear_token(nombre):
    exp = int(time.time() + SESION_HORAS * 3600)
    cuerpo = base64.urlsafe_b64encode(nombre.encode()).decode().rstrip("=") + "." + str(exp)
    return cuerpo + "." + _firma(cuerpo)


def leer_token(token):
    try:
        b64, exp, firma = token.split(".")
        if not hmac.compare_digest(firma, _firma(b64 + "." + exp)) or int(exp) < time.time():
            return None
        return base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)).decode()
    except Exception:
        return None


def _bloqueado(tabla, ip, ahora):
    with _candado:
        n, hasta = tabla.get(ip, (0, 0))
        return int(hasta - ahora) + 1 if hasta > ahora else 0


def _fallo(tabla, ip, ahora):
    with _candado:
        n, _ = tabla.get(ip, (0, 0))
        n += 1
        tabla[ip] = (0, ahora + 60) if n >= 5 else (n, 0)


class Manejador(BaseHTTPRequestHandler):
    server_version = "TableroGimnasio"
    protocol_version = "HTTP/1.1"

    def log_message(self, formato, *args):
        pass

    # --- utilidades ---
    def _enviar(self, codigo, datos, tipo, cabeceras=None):
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(datos)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (cabeceras or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(datos)

    def _json(self, codigo, cuerpo, cabeceras=None):
        self._enviar(codigo, json.dumps(cuerpo, ensure_ascii=False).encode(), "application/json; charset=utf-8", cabeceras)

    def _cookie(self):
        for parte in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = parte.strip().partition("=")
            if k == COOKIE:
                return v
        return ""

    def _set_cookie(self, valor, max_age):
        extra = "; Secure" if COOKIE_SECURE else ""
        return {"Set-Cookie": f"{COOKIE}={valor}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{extra}"}

    def _ip(self):
        return self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()

    def _cuerpo(self, maximo):
        """(objeto, None) o (None, (codigo, mensaje)). Si el cuerpo es demasiado grande lo lee y lo descarta antes de contestar."""
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return None, (415, "el contenido debe ser application/json")
        try:
            largo = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None, (400, "Content-Length no válido")
        if largo <= 0:
            return None, (400, "falta el cuerpo de la solicitud")
        if largo > maximo:
            restante = min(largo, maximo * 20)
            while restante > 0:
                trozo = self.rfile.read(min(65536, restante))
                if not trozo:
                    break
                restante -= len(trozo)
            self.close_connection = True
            return None, (413, f"el cuerpo supera {maximo} bytes")
        try:
            return json.loads(self.rfile.read(largo)), None
        except Exception:
            return None, (400, "el cuerpo no es JSON válido")

    def _con(self, solo_lectura=False):
        return BD.conectar(RUTA_DB, solo_lectura=solo_lectura)

    def _sesion(self, con):
        """Usuario activo de la sesión (dict) o None. Se vuelve a consultar en cada solicitud: si lo inactivan, pierde el acceso."""
        nombre = leer_token(self._cookie())
        return D.usuario_activo(con, nombre) if nombre else None

    # --- despacho ---
    def do_GET(self):
        self._despachar("GET")

    def do_POST(self):
        self._despachar("POST")

    def do_PUT(self):
        self._despachar("PUT")

    def do_PATCH(self):
        self._despachar("PUT")

    def do_DELETE(self):
        self._despachar("DELETE")

    do_HEAD = do_GET

    def _despachar(self, metodo):
        try:
            partes = urlsplit(self.path)
            ruta, consulta = partes.path, {k: v[0] for k, v in parse_qs(partes.query).items()}
            if ruta.startswith("/api/v1/") or ruta == "/api/v1":
                return self._api_v1(metodo, ruta, consulta)
            if ruta.startswith("/api/admin/"):
                return self._admin(metodo, ruta, consulta)
            if metodo == "GET" or self.command == "HEAD":
                if ruta == "/salud":
                    return self._json(200, {"ok": True})
                if ruta == "/api/sesion":
                    return self._sesion_actual()
                if ruta == "/api/datos":
                    return self._datos()
                if ruta.startswith("/api/"):
                    return self._json(404, {"error": "no existe"})
                return self._estatico(ruta)
            if metodo == "POST" and ruta == "/api/login":
                return self._login()
            if metodo == "POST" and ruta == "/api/logout":
                return self._json(200, {"ok": True}, self._set_cookie("", 0))
            return self._json(404, {"error": "no existe"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # nunca dejar la conexión colgada
            log(f"error interno en {self.command} {self.path}: {type(e).__name__}: {e}")
            try:
                self._json(500, {"error": "error interno"})
            except Exception:
                pass

    # --- sesión y tablero ---
    def _sesion_actual(self):
        con = self._con(True)
        try:
            u = self._sesion(con)
        finally:
            con.close()
        if not u:
            return self._json(401, {"error": "sin sesión"})
        return self._json(200, {"usuario": u["user"], "perfil": u["perfil"]})

    def _login(self):
        ip, ahora = self._ip(), time.time()
        espera = _bloqueado(_fallos, ip, ahora)
        if espera:
            return self._json(429, {"error": "demasiados intentos", "espera": espera})
        cuerpo, err = self._cuerpo(MAX_ADMIN)
        if err or not isinstance(cuerpo, dict):
            return self._json(400, {"error": "solicitud no válida"})
        nombre, clave = str(cuerpo.get("usuario", "")).strip(), str(cuerpo.get("clave", ""))
        con = self._con(True)
        try:
            u = D.verificar_login(con, nombre, clave)
        finally:
            con.close()
        if not u:
            _fallo(_fallos, ip, ahora)
            log(f"login fallido para '{nombre[:30]}' desde {ip}")
            return self._json(401, {"error": "usuario o contraseña incorrectos"})
        with _candado:
            _fallos.pop(ip, None)
        log(f"login correcto: {u['user']} ({u['perfil']})")
        return self._json(200, {"usuario": u["user"], "perfil": u["perfil"]},
                          self._set_cookie(crear_token(u["user"]), int(SESION_HORAS * 3600)))

    def _datos(self):
        con = self._con(True)
        try:
            u = self._sesion(con)
            if not u:
                return self._json(401, {"error": "sin sesión"})
            todo = kpis.leer_todo(con)
        finally:
            con.close()
        todo.update({"archivo": DB_FILE, "leido_en": time.strftime("%Y-%m-%dT%H:%M:%S"), "advertencia": None, "perfil": u["perfil"]})
        self._json(200, todo)

    # --- administración (solo perfil admin) ---
    def _error_dominio(self, e):
        if isinstance(e, D.ErrorValidacion):
            return self._json(422, {"error": "; ".join(e.detalles), "detalles": e.detalles})
        if isinstance(e, D.RequiereConfirmacion):
            return self._json(409, {"requiere_confirmacion": True, "avisos": e.avisos, "error": "hay advertencias que confirmar"})
        if isinstance(e, D.Conflicto):
            return self._json(409, {"error": str(e)})
        if isinstance(e, D.NoExiste):
            return self._json(404, {"error": str(e)})
        raise e

    def _admin(self, metodo, ruta, q):
        con = self._con(metodo == "GET")
        try:
            u = self._sesion(con)
            if not u:
                return self._json(401, {"error": "sin sesión"}, self._set_cookie("", 0))
            if u["perfil"] != "admin":
                return self._json(403, {"error": "solo para administradores"})
            sub = ruta[len("/api/admin/"):].strip("/")
            m = re.fullmatch(r"(ingresos|egresos)(?:/(\d+))?", sub)
            try:
                if sub == "revision" and metodo == "GET":
                    return self._json(200, D.listar_revision(con, q.get("tabla", "ingresos"), q.get("mes")))
                if sub == "exportar.xlsx" and metodo == "GET":
                    datos = exportar.a_bytes(RUTA_DB, incluir_usuarios=q.get("usuarios") == "1")
                    nombre = "kpis-" + time.strftime("%Y%m%d-%H%M") + ".xlsx"
                    return self._enviar(200, datos, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                        {"Content-Disposition": f'attachment; filename="{nombre}"'})
                if sub == "usuarios" and metodo == "GET":
                    return self._json(200, {"usuarios": D.listar_usuarios(con), "yo": u["user"]})
                if sub == "metas" and metodo == "GET":
                    return self._json(200, {"metas": D.listar_metas(con)})
                mm = re.fullmatch(r"metas/([^/]+)", sub)
                if mm and metodo == "PUT":
                    cuerpo, err = self._cuerpo(MAX_ADMIN)
                    if err:
                        return self._json(err[0], {"error": err[1]})
                    if not isinstance(cuerpo, dict) or not isinstance(cuerpo.get("datos"), dict):
                        return self._json(400, {"error": "falta 'datos'"})
                    return self._json(200, {"meta": D.guardar_meta(con, unquote(mm.group(1)), cuerpo["datos"], u["user"])})
                if m:
                    return self._admin_registro(con, u, metodo, m.group(1), m.group(2))
                mu = re.fullmatch(r"usuarios(?:/(.+))?", sub)
                if mu and metodo in ("POST", "PUT"):
                    cuerpo, err = self._cuerpo(MAX_ADMIN)
                    if err:
                        return self._json(err[0], {"error": err[1]})
                    if not isinstance(cuerpo, dict) or not isinstance(cuerpo.get("datos"), dict):
                        return self._json(400, {"error": "falta 'datos'"})
                    original = unquote(mu.group(1)) if mu.group(1) else None
                    if (metodo == "PUT") != (original is not None):
                        return self._json(405, {"error": "método no permitido"})
                    res = D.guardar_usuario(con, original, cuerpo["datos"], u["user"])
                    return self._json(200, {"usuario": res})
            except (D.ErrorValidacion, D.RequiereConfirmacion, D.Conflicto, D.NoExiste) as e:
                return self._error_dominio(e)
            return self._json(404, {"error": "no existe"})
        finally:
            con.close()

    def _admin_registro(self, con, u, metodo, tabla, id_):
        if metodo == "POST" and id_ is None:
            cuerpo, err = self._cuerpo(MAX_ADMIN)
            if err:
                return self._json(err[0], {"error": err[1]})
            if not isinstance(cuerpo, dict) or not isinstance(cuerpo.get("datos"), dict):
                return self._json(400, {"error": "falta 'datos'"})
            fila = D.crear(con, tabla, cuerpo["datos"], u["user"], confirmar=cuerpo.get("confirmar") is True)
            return self._json(201, {"fila": fila})
        if metodo == "PUT" and id_ is not None:
            cuerpo, err = self._cuerpo(MAX_ADMIN)
            if err:
                return self._json(err[0], {"error": err[1]})
            if not isinstance(cuerpo, dict) or not isinstance(cuerpo.get("cambios"), dict):
                return self._json(400, {"error": "falta 'cambios'"})
            fila, avisos = D.actualizar(con, tabla, int(id_), cuerpo["cambios"], u["user"], confirmar=cuerpo.get("confirmar") is True)
            return self._json(200, {"fila": fila, "avisos": avisos})
        if metodo == "DELETE" and id_ is not None:
            D.borrar(con, tabla, int(id_), u["user"])
            return self._json(200, {"ok": True})
        return self._json(405, {"error": "método no permitido"})

    # --- API de carga (/api/v1): solo agrega y consulta ---
    def _token_api(self):
        """'escritura' | 'lectura' | None según la cabecera Authorization: Bearer ..."""
        ip, ahora = self._ip(), time.time()
        if _bloqueado(_fallos_api, ip, ahora):
            return "bloqueado"
        auth = self.headers.get("Authorization") or ""
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if token and TOKEN_ESCRITURA and hmac.compare_digest(token, TOKEN_ESCRITURA):
            return "escritura"
        if token and TOKEN_LECTURA and hmac.compare_digest(token, TOKEN_LECTURA):
            return "lectura"
        _fallo(_fallos_api, ip, ahora)
        return None

    def _api_v1(self, metodo, ruta, q):
        if not TOKEN_ESCRITURA and not TOKEN_LECTURA:
            return self._json(503, {"error": "la API está apagada: define API_TOKEN_ESCRITURA"})
        sub = ruta[len("/api/v1"):].strip("/")
        rol = self._token_api()
        if rol == "bloqueado":
            return self._json(429, {"error": "demasiados intentos con clave incorrecta"})
        if rol is None:
            return self._json(401, {"error": "falta o es incorrecta la clave (Authorization: Bearer ...)"}, {"WWW-Authenticate": "Bearer"})
        if metodo == "GET":
            return self._api_consulta(sub, q)
        if metodo == "POST" and sub in ("ingresos", "egresos", "registros"):
            if rol != "escritura":
                return self._json(403, {"error": "esta clave solo permite consultar"})
            cuerpo, err = self._cuerpo(MAX_API)
            if err:
                return self._json(err[0], {"error": err[1]})
            if isinstance(cuerpo, dict) and "registros" in cuerpo:
                items = cuerpo["registros"]
            else:
                items = [cuerpo] if isinstance(cuerpo, dict) else cuerpo
            con = self._con()
            try:
                try:
                    res = D.registrar_lote(con, None if sub == "registros" else sub, items)
                except (D.ErrorValidacion, D.Conflicto) as e:
                    return self._error_dominio(e)
                except D.RequiereConfirmacion as e:
                    return self._error_dominio(e)
            finally:
                con.close()
            resumen = {}
            for r in res:
                resumen[r["accion"]] = resumen.get(r["accion"], 0) + 1
            log(f"API: lote de {len(res)} -> {resumen}")
            return self._json(200, {"resultados": res, "resumen": resumen})
        if metodo in ("PUT", "DELETE") or sub in ("ingresos", "egresos", "registros"):
            return self._json(405, {"error": "la API solo agrega registros nuevos; modificar o borrar se hace en la pantalla de Revisión"},
                              {"Allow": "GET, POST"})
        return self._json(404, {"error": "no existe"})

    def _api_consulta(self, sub, q):
        con = self._con(True)
        try:
            if sub == "estado":
                return self._json(200, {"ok": True, "version_esquema": con.execute("PRAGMA user_version").fetchone()[0],
                                        "ingresos": con.execute("SELECT COUNT(*) FROM ingresos").fetchone()[0],
                                        "egresos": con.execute("SELECT COUNT(*) FROM egresos").fetchone()[0]})
            if sub in ("ingresos", "egresos"):
                mes = q.get("mes")
                if mes is not None and not re.fullmatch(r"\d{4}-\d{2}", mes):
                    return self._json(422, {"error": "mes: debe ser AAAA-MM"})
                cols = ",".join(D.COLS[sub])
                filtro, args = ("WHERE substr(fecha,1,7)=?", [mes]) if mes else ("", [])
                filas = [dict(r) for r in con.execute(f"SELECT {cols} FROM {sub} {filtro} ORDER BY fecha, id LIMIT 5000", args)]
                return self._json(200, {"tabla": sub, "filas": filas})
            if sub == "bitacora":
                filas = [dict(r) for r in con.execute("SELECT id,hora,tabla,registro_id,id_origen,estado,observaciones FROM bitacora ORDER BY id DESC LIMIT 200")]
                return self._json(200, {"filas": filas})
            return self._json(404, {"error": "no existe"})
        finally:
            con.close()

    # --- archivos del tablero ---
    def _estatico(self, ruta):
        if ruta in ("", "/"):
            ruta = "/index.html"
        destino = (WEB / ruta.lstrip("/")).resolve()
        if WEB.resolve() not in destino.parents or not destino.is_file():
            return self._json(404, {"error": "no existe"})
        datos = destino.read_bytes()
        tipo = mimetypes.guess_type(destino.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", tipo + ("; charset=utf-8" if tipo.startswith("text/") or tipo.endswith("javascript") else ""))
        self.send_header("Content-Length", str(len(datos)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(datos)


# ---------- arranque ----------

class Servidor(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64   # el valor por omisión (5) reinicia conexiones cuando llegan muchas a la vez


def hacer_respaldo():
    """Copia de la base + Excel (con usuarios; se queda en la carpeta del servidor). Rota ambos."""
    r1 = BD.respaldar(RUTA_DB, CARPETA_RESPALDOS, RESPALDOS_CONSERVAR)
    marca = time.strftime("%Y%m%d-%H%M%S")
    r2 = exportar.a_archivo(RUTA_DB, os.path.join(CARPETA_RESPALDOS, f"kpis-{marca}.xlsx"), incluir_usuarios=True)
    BD.rotar(CARPETA_RESPALDOS, "kpis-*.xlsx", RESPALDOS_CONSERVAR)
    return r1, r2


def _hilo_respaldos():
    while True:
        time.sleep(RESPALDO_HORAS * 3600)
        try:
            hacer_respaldo()
            log("respaldo diario listo")
        except Exception as e:
            log(f"AVISO: falló el respaldo: {type(e).__name__}: {e}")


def preparar_base():
    BD.iniciar(RUTA_DB)
    con = BD.conectar(RUTA_DB)
    try:
        usuarios = con.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0]
        datos = con.execute("SELECT (SELECT COUNT(*) FROM ingresos)+(SELECT COUNT(*) FROM egresos)").fetchone()[0]
    finally:
        con.close()
    if usuarios == 0 and datos == 0 and Path(EXCEL_INICIAL).is_file():
        import importar
        log(f"Base vacía: cargando datos iniciales desde {EXCEL_INICIAL}")
        importar.imprimir(importar.importar(EXCEL_INICIAL, RUTA_DB))
    con = BD.conectar(RUTA_DB, solo_lectura=True)
    try:
        for t in ("ingresos", "egresos", "metas", "usuarios"):
            log(f"  {t}: {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
        if not con.execute("SELECT 1 FROM usuarios WHERE activo=1 AND perfil='admin'").fetchone():
            log("AVISO: no hay ningún administrador activo; nadie podrá entrar. Revisa el Excel inicial o la tabla usuarios.")
    finally:
        con.close()


def main():
    log(f"Base: {RUTA_DB}")
    if not SECRETO_FIJO:
        log("AVISO: SESSION_SECRET no está definido; las sesiones se cerrarán al reiniciar el contenedor")
    if not TOKEN_ESCRITURA:
        log("AVISO: API_TOKEN_ESCRITURA no está definido; la API de carga está apagada")
    try:
        preparar_base()
    except (OSError, sqlite3.OperationalError) as e:
        log(f"ERROR: no pude abrir o crear la base en {RUTA_DB} ({e}). La carpeta debe existir y poder ESCRIBIRSE por el usuario del "
            f"contenedor (PUID:PGID del .env). Ejemplo: chown -R 1007:1007 /ruta/de/tu/carpeta")
        sys.exit(1)
    if RESPALDO_HORAS > 0:
        try:
            hacer_respaldo()
            log("respaldo al arrancar listo")
        except Exception as e:
            log(f"AVISO: no se pudo respaldar al arrancar: {type(e).__name__}: {e}")
        threading.Thread(target=_hilo_respaldos, daemon=True).start()
    log(f"Escuchando en el puerto {PORT}")
    Servidor(("0.0.0.0", PORT), Manejador).serve_forever()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).parent))
    main()
