"""Servidor del tablero financiero del gimnasio.

Solo usa la biblioteca estándar de Python y openpyxl. Variables de entorno:
  EXCEL_DIR       carpeta donde está el Excel dentro del contenedor (por defecto /datos)
  EXCEL_FILE      nombre del archivo Excel (por defecto Data_Base.xlsx)
  PORT            puerto interno (por defecto 8080)
  SESSION_SECRET  texto largo y secreto para firmar las sesiones (si falta, se genera uno al arrancar
                  y las sesiones se pierden al reiniciar)
  SESSION_HORAS   duración de una sesión en horas (por defecto 12)
  COOKIE_SECURE   "true" si el tablero se sirve por HTTPS (por defecto false)
"""
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import lector_excel as excel

EXCEL_DIR = os.environ.get("EXCEL_DIR", "/datos")
EXCEL_FILE = os.environ.get("EXCEL_FILE", "Data_Base.xlsx")
PORT = int(os.environ.get("PORT", "8080"))
SESION_HORAS = float(os.environ.get("SESSION_HORAS", "12"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").strip().lower() in ("1", "true", "si", "sí", "yes")
SECRETO = (os.environ.get("SESSION_SECRET") or "").encode() or secrets.token_bytes(32)
SECRETO_FIJO = bool(os.environ.get("SESSION_SECRET"))
WEB = Path(__file__).parent / "web"
RUTA_EXCEL = str(Path(EXCEL_DIR) / EXCEL_FILE)
COOKIE = "sesion_gimnasio"

# Intentos fallidos por dirección: 5 fallos bloquean 60 segundos.
_fallos = {}
_candado = threading.Lock()
# Última lectura buena, por si el Excel se está guardando justo en ese momento.
_ultima = {"datos": None, "cuando": None}
_lectura = threading.Lock()


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


# ---------- Sesión firmada (sin base de datos) ----------

def _firma(texto):
    return hmac.new(SECRETO, texto.encode(), hashlib.sha256).hexdigest()


def crear_token(nombre):
    exp = int(time.time() + SESION_HORAS * 3600)
    cuerpo = base64.urlsafe_b64encode(nombre.encode()).decode().rstrip("=") + "." + str(exp)
    return cuerpo + "." + _firma(cuerpo)


def leer_token(token):
    """Devuelve el nombre de usuario si el token es válido y no ha vencido."""
    try:
        b64, exp, firma = token.split(".")
        if not hmac.compare_digest(firma, _firma(b64 + "." + exp)) or int(exp) < time.time():
            return None
        return base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)).decode()
    except Exception:
        return None


def huella(clave):
    return hashlib.sha256(clave.encode("utf-8")).hexdigest()


def leer_excel():
    """Abre el Excel en este momento. Si falla, regresa la última lectura buena con una advertencia."""
    with _lectura:
        try:
            datos = excel.leer_todo(RUTA_EXCEL)
            _ultima["datos"], _ultima["cuando"] = datos, time.time()
            return datos, None
        except excel.ErrorExcel as e:
            if _ultima["datos"] is not None:
                return _ultima["datos"], f"{e} Se muestran los últimos datos leídos."
            raise


class Manejador(BaseHTTPRequestHandler):
    server_version = "TableroGimnasio"
    protocol_version = "HTTP/1.1"

    def log_message(self, formato, *args):
        pass  # sin ruido; los eventos importantes se escriben con log()

    # --- utilidades ---
    def _json(self, codigo, cuerpo, cabeceras=None):
        datos = json.dumps(cuerpo, ensure_ascii=False).encode()
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (cabeceras or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(datos)

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

    def _cuerpo_json(self):
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return None
        try:
            largo = int(self.headers.get("Content-Length") or 0)
            if largo <= 0 or largo > 10_000:
                return None
            return json.loads(self.rfile.read(largo))
        except Exception:
            return None

    # --- rutas ---
    def do_GET(self):
        ruta = urlsplit(self.path).path
        if ruta == "/salud":
            return self._json(200, {"ok": True})
        if ruta == "/api/sesion":
            nombre = leer_token(self._cookie())
            return self._json(200, {"usuario": nombre}) if nombre else self._json(401, {"error": "sin sesión"})
        if ruta == "/api/datos":
            return self._datos()
        if ruta.startswith("/api/"):
            return self._json(404, {"error": "no existe"})
        return self._estatico(ruta)

    def do_POST(self):
        ruta = urlsplit(self.path).path
        if ruta == "/api/login":
            return self._login()
        if ruta == "/api/logout":
            return self._json(200, {"ok": True}, self._set_cookie("", 0))
        return self._json(404, {"error": "no existe"})

    def _login(self):
        ip = self._ip()
        ahora = time.time()
        with _candado:
            n, hasta = _fallos.get(ip, (0, 0))
            if hasta > ahora:
                return self._json(429, {"error": "demasiados intentos", "espera": int(hasta - ahora) + 1})
        cuerpo = self._cuerpo_json()
        if not isinstance(cuerpo, dict):
            return self._json(400, {"error": "solicitud no válida"})
        nombre = str(cuerpo.get("usuario", "")).strip()
        clave = str(cuerpo.get("clave", ""))
        try:
            usuarios = leer_excel()[0]["usuarios"]
        except excel.ErrorExcel as e:
            log(f"login: {e}")
            return self._json(503, {"error": "no se pudo leer la lista de usuarios"})
        registro = usuarios.get(nombre.lower())
        esperado = registro[1] if registro else "0" * 64
        ok = hmac.compare_digest(huella(clave), esperado) and registro is not None and len(esperado) == 64
        if not ok:
            with _candado:
                n, _ = _fallos.get(ip, (0, 0))
                n += 1
                _fallos[ip] = (n, ahora + 60 if n >= 5 else 0)
                if n >= 5:
                    _fallos[ip] = (0, ahora + 60)
            log(f"login fallido para '{nombre[:30]}' desde {ip}")
            return self._json(401, {"error": "usuario o contraseña incorrectos"})
        with _candado:
            _fallos.pop(ip, None)
        log(f"login correcto: {registro[0]}")
        return self._json(200, {"usuario": registro[0]}, self._set_cookie(crear_token(registro[0]), int(SESION_HORAS * 3600)))

    def _datos(self):
        nombre = leer_token(self._cookie())
        if not nombre:
            return self._json(401, {"error": "sin sesión"})
        try:
            datos, aviso = leer_excel()
        except excel.ErrorExcel as e:
            log(f"datos: {e}")
            return self._json(503, {"error": str(e)})
        if nombre.lower() not in datos["usuarios"]:  # el usuario ya no está en la hoja Usuarios
            return self._json(401, {"error": "sin sesión"}, self._set_cookie("", 0))
        self._json(200, {
            "ingresos_diarios": datos["ingresos_diarios"],
            "egresos_mensual": datos["egresos_mensual"],
            "ventas_mes": datos["ventas_mes"],
            "metas": datos["metas"],
            "archivo": EXCEL_FILE,
            "leido_en": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "advertencia": aviso,
        })

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
        self.wfile.write(datos)


def main():
    log(f"Excel: {RUTA_EXCEL}")
    if not Path(RUTA_EXCEL).is_file():
        log("AVISO: todavía no existe ese archivo; revisa EXCEL_RUTA_HOST y EXCEL_ARCHIVO en el .env")
    if not SECRETO_FIJO:
        log("AVISO: SESSION_SECRET no está definido; las sesiones se cerrarán al reiniciar el contenedor")
    try:
        datos, _ = leer_excel()
        log(f"Lectura inicial: {len(datos['ingresos_diarios'])} días de ingresos, {len(datos['egresos_mensual'])} filas de gastos, "
            f"{len(datos['metas'])} metas, {len(datos['usuarios'])} usuarios")
        sin_hash = [u for u, (_, h) in datos["usuarios"].items() if len(h) != 64]
        if sin_hash:
            log("AVISO: estos usuarios no tienen un SHA-256 válido (64 caracteres hexadecimales) y no podrán entrar: " + ", ".join(sin_hash))
    except excel.ErrorExcel as e:
        log(f"AVISO: {e}")
    ThreadingHTTPServer.daemon_threads = True
    log(f"Escuchando en el puerto {PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Manejador).serve_forever()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).parent))
    main()
