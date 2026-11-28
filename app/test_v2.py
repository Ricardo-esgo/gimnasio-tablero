"""Pruebas de la versión con SQLite: reglas, pantalla de revisión, usuarios, API de solo alta, exportación y concurrencia.
    python -m unittest test_v2 -v
"""
import concurrent.futures
import hashlib
import http.client
import json
import os
import sqlite3
import tempfile
import threading
import unittest

_TMP = tempfile.mkdtemp()
os.environ.update({"DB_DIR": _TMP, "SESSION_SECRET": "s" * 32, "API_TOKEN_ESCRITURA": "tw", "API_TOKEN_LECTURA": "tl", "RESPALDO_HORAS": "0"})
import bd as BD          # noqa: E402
import datos as D        # noqa: E402
import exportar          # noqa: E402
import kpis              # noqa: E402
import servidor as S     # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

XLSX = os.environ.get("XLSX_PRUEBA", "/mnt/user-data/attachments/5b6f3604-1711-5e9d-88d7-879a37b48c3d/93265198-Data_Base_3.xlsx")


def h(c):
    return hashlib.sha256(c.encode()).hexdigest()


def base_nueva():
    ruta = os.path.join(tempfile.mkdtemp(), "t.db")
    BD.iniciar(ruta)
    con = BD.conectar(ruta)
    con.execute('INSERT INTO usuarios("user","pass",perfil,activo) VALUES("Ricardo",?,"admin",1)', (h("clave-ricardo"),))
    con.execute('INSERT INTO usuarios("user","pass",perfil,activo) VALUES("Dan",?,"user",1)', (h("clave-dan"),))
    return con, ruta


CIERRE = {"fecha": "2026-11-20", "turno": "M", "personal": "Jeremy", "mem_efectivo": 1000, "mer_efectivo": 50}


class Reglas(unittest.TestCase):
    def setUp(self):
        self.con, self.ruta = base_nueva()

    def tearDown(self):
        self.con.close()

    def test_total_calculado_y_negativo(self):
        f = D.crear(self.con, "ingresos", dict(CIERRE, excedente=-20, mem_electronico=100), "Ricardo", confirmar=True)
        self.assertEqual(f["total"], 1130.0)
        self.assertEqual(f["revisado"], 0)
        g = D.crear(self.con, "ingresos", dict(CIERRE, turno="V", mem_efectivo=0, mer_efectivo=0, excedente=-40), "Ricardo", confirmar=True)
        self.assertEqual(g["total"], -40.0)

    def test_mes_completo_exige_nomina_renta_y_cierres_revisados(self):
        """Regla del tablero: mes completo = Nómina y Renta + todos los cierres de caja del mes revisados."""
        c1 = D.crear(self.con, "ingresos", dict(CIERRE, fecha="2026-10-05"), "Ricardo", confirmar=True)
        c2 = D.crear(self.con, "ingresos", dict(CIERRE, fecha="2026-10-06", turno="V"), "Ricardo", confirmar=True)
        for tipo in ("Nómina", "Renta"):
            D.crear(self.con, "egresos", {"fecha": "2026-10-07", "personal": "Jeremy", "tipo": tipo, "concepto": tipo, "efectivo": 500}, "Ricardo", confirmar=True)

        def estado():
            filas = [r for r in kpis.egresos_mensual(self.con) if r["mes"] == "2026-10"]
            self.assertTrue(filas)
            return filas[0]["estado"], filas[0]["cierres_sin_revisar"]
        self.assertEqual(estado(), ("completo", 2))       # gastos completos, pero los dos cierres siguen sin revisar
        D.actualizar(self.con, "ingresos", c1["id"], {"revisado": 1}, "Ricardo", confirmar=True)
        self.assertEqual(estado(), ("completo", 1))
        D.actualizar(self.con, "ingresos", c2["id"], {"revisado": 1}, "Ricardo", confirmar=True)
        self.assertEqual(estado(), ("completo", 0))       # ahora sí: Nómina, Renta y todos los cierres revisados
        D.actualizar(self.con, "ingresos", c2["id"], {"revisado": 0}, "Ricardo", confirmar=True)
        self.assertEqual(estado(), ("completo", 1))       # quitar la revisión lo vuelve provisional otra vez
        # otro mes con cierres sin revisar no afecta a éste
        D.crear(self.con, "ingresos", dict(CIERRE, fecha="2026-09-01"), "Ricardo", confirmar=True)
        self.assertEqual(estado(), ("completo", 1))

    def test_estado_semaforo_manual_y_no_editable(self):
        f = D.crear(self.con, "ingresos", dict(CIERRE, estado="rojo"), "Ricardo", confirmar=True)
        self.assertEqual(f["estado"], "verde")            # a mano siempre verde; el semáforo lo fija la carga automática
        self.con.execute("UPDATE ingresos SET estado='rojo' WHERE id=?", (f["id"],))
        g, _ = D.actualizar(self.con, "ingresos", f["id"], {"mem_efectivo": 1200, "estado": "verde"}, "Ricardo", confirmar=True)
        self.assertEqual(g["estado"], "rojo")             # editar montos o aprobar no toca el semáforo
        g, _ = D.actualizar(self.con, "ingresos", f["id"], {"revisado": 1}, "Ricardo", confirmar=True)
        h2, _ = D.actualizar(self.con, "ingresos", f["id"], {"revisado": 0}, "Ricardo", confirmar=True)
        self.assertEqual((g["estado"], h2["estado"]), ("rojo", "rojo"))   # al quitar la revisión conserva su color
        with self.assertRaises(sqlite3.IntegrityError):
            self.con.execute("UPDATE ingresos SET estado='azul' WHERE id=?", (f["id"],))
        e = D.crear(self.con, "egresos", {"fecha": "2026-11-02", "personal": "Jeremy", "tipo": "Servicios", "concepto": "luz", "efectivo": 100}, "Ricardo", confirmar=True)
        self.assertEqual(e["estado"], "verde")

    def test_migracion_v1_a_v2(self):
        ruta = os.path.join(tempfile.mkdtemp(), "viejo.db")
        con = sqlite3.connect(ruta)
        con.executescript("""
            CREATE TABLE ingresos (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha DATE NOT NULL, turno TEXT NOT NULL, personal TEXT NOT NULL,
                mem_efectivo REAL NOT NULL DEFAULT 0, mem_electronico REAL NOT NULL DEFAULT 0, mer_efectivo REAL NOT NULL DEFAULT 0,
                mer_electronico REAL NOT NULL DEFAULT 0, excedente REAL NOT NULL DEFAULT 0,
                total REAL GENERATED ALWAYS AS (ROUND(mem_efectivo + mem_electronico + mer_efectivo + mer_electronico + excedente, 2)) STORED,
                revisado BIT NOT NULL DEFAULT 0);
            CREATE TABLE egresos (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha DATE NOT NULL, personal TEXT NOT NULL, tipo TEXT NOT NULL,
                concepto TEXT NOT NULL DEFAULT '', efectivo REAL NOT NULL DEFAULT 0, electronico REAL NOT NULL DEFAULT 0,
                total REAL GENERATED ALWAYS AS (ROUND(efectivo + electronico, 2)) STORED, revisado BIT NOT NULL DEFAULT 0);
            CREATE TABLE bitacora (id INTEGER PRIMARY KEY AUTOINCREMENT, hora TEXT NOT NULL, tabla TEXT NOT NULL, registro_id INTEGER,
                id_origen TEXT NOT NULL, huella TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'verde', observaciones TEXT, fuente TEXT);
            INSERT INTO ingresos(fecha,turno,personal,mem_efectivo,revisado) VALUES('2026-11-01','M','Jeremy',500,1),('2026-11-01','V','Rodolfo',300,0);
            INSERT INTO egresos(fecha,personal,tipo,concepto,efectivo) VALUES('2026-11-02','Ricardo','Renta','x',800);
            INSERT INTO bitacora(hora,tabla,registro_id,id_origen,huella,estado) VALUES('2026-11-01 10:00:00','ingresos',2,'a','h','rojo'),('2026-11-02 10:00:00','egresos',1,'b','h','amarillo');
            PRAGMA user_version = 1;""")
        con.close()
        BD.iniciar(ruta)
        BD.iniciar(ruta)                      # repetir es seguro
        con = BD.conectar(ruta)
        try:
            self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], BD.VERSION_ESQUEMA)
            self.assertEqual([r[0] for r in con.execute("SELECT estado FROM ingresos ORDER BY id")], ["verde", "rojo"])
            self.assertEqual(con.execute("SELECT estado FROM egresos").fetchone()[0], "amarillo")
            with self.assertRaises(sqlite3.IntegrityError):
                con.execute("UPDATE ingresos SET estado='azul'")
        finally:
            con.close()

    def test_errores_bloquean(self):
        for malo, texto in [({"fecha": "2026-13-40"}, "fecha"), ({"turno": ""}, "turno"), ({"personal": " "}, "personal"),
                            ({"mem_efectivo": "abc"}, "mem_efectivo"), ({"mem_efectivo": 0, "mer_efectivo": 0}, "total")]:
            with self.assertRaises(D.ErrorValidacion) as cm:
                D.crear(self.con, "ingresos", dict(CIERRE, **malo), "Ricardo", confirmar=True)
            self.assertIn(texto, str(cm.exception))
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM ingresos").fetchone()[0], 0)

    def test_duplicado_pide_confirmacion(self):
        D.crear(self.con, "ingresos", CIERRE, "Ricardo", confirmar=True)
        with self.assertRaises(D.RequiereConfirmacion) as cm:
            D.crear(self.con, "ingresos", CIERRE, "Ricardo")
        self.assertTrue(any("Ya existe un cierre" in a for a in cm.exception.avisos))
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM ingresos").fetchone()[0], 1)
        D.crear(self.con, "ingresos", CIERRE, "Ricardo", confirmar=True)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM ingresos").fetchone()[0], 2)

    def test_cierre_limpio_se_guarda_sin_confirmar(self):
        D.crear(self.con, "ingresos", CIERRE, "Ricardo", confirmar=True)   # conoce a Jeremy
        f = D.crear(self.con, "ingresos", dict(CIERRE, fecha="2026-11-21"), "Ricardo", hoy=__import__("datetime").date(2026, 11, 28))
        self.assertEqual(f["fecha"], "2026-11-21")

    def test_revisado_bloquea_y_desbloquea(self):
        f = D.crear(self.con, "ingresos", dict(CIERRE, revisado=1), "Ricardo", confirmar=True)
        with self.assertRaises(D.Conflicto):
            D.actualizar(self.con, "ingresos", f["id"], {"mem_efectivo": 5}, "Ricardo")
        with self.assertRaises(D.Conflicto):
            D.borrar(self.con, "ingresos", f["id"], "Ricardo")
        nuevo, _ = D.actualizar(self.con, "ingresos", f["id"], {"revisado": 0}, "Ricardo")
        self.assertEqual(nuevo["revisado"], 0)
        nuevo, _ = D.actualizar(self.con, "ingresos", f["id"], {"mem_efectivo": 2000, "turno": "V"}, "Ricardo", confirmar=True)
        self.assertEqual((nuevo["total"], nuevo["turno"]), (2050.0, "V"))
        nuevo, _ = D.actualizar(self.con, "ingresos", f["id"], {"revisado": 1}, "Ricardo")
        self.assertEqual(nuevo["revisado"], 1)
        acciones = [r[0] for r in self.con.execute("SELECT accion FROM historial WHERE tabla='ingresos' ORDER BY id")]
        self.assertEqual(acciones, ["creado", "quitó la revisión", "editó", "aprobó"])

    def test_fecha_y_personal_no_se_cambian(self):
        f = D.crear(self.con, "ingresos", CIERRE, "Ricardo", confirmar=True)
        with self.assertRaises(D.ErrorValidacion):
            D.actualizar(self.con, "ingresos", f["id"], {"fecha": "2026-11-01"}, "Ricardo")

    def test_borrar_no_revisado(self):
        f = D.crear(self.con, "ingresos", CIERRE, "Ricardo", confirmar=True)
        D.borrar(self.con, "ingresos", f["id"], "Ricardo")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM ingresos").fetchone()[0], 0)
        with self.assertRaises(D.NoExiste):
            D.borrar(self.con, "ingresos", f["id"], "Ricardo")

    def test_egresos(self):
        e = {"fecha": "2026-11-05", "personal": "Ricardo", "tipo": "nomina", "concepto": "Sueldo Rodolfo", "efectivo": 1350}
        D.crear(self.con, "egresos", e, "Ricardo", confirmar=True)
        with self.assertRaises(D.RequiereConfirmacion) as cm:
            D.crear(self.con, "egresos", e, "Ricardo")
        self.assertTrue(any("duplicado" in a for a in cm.exception.avisos))
        with self.assertRaises(D.RequiereConfirmacion) as cm:
            D.crear(self.con, "egresos", dict(e, tipo="Gimnasio nuevo", concepto="otra"), "Ricardo")
        self.assertTrue(any("nueva" in a for a in cm.exception.avisos))
        with self.assertRaises(D.ErrorValidacion):
            D.crear(self.con, "egresos", dict(e, efectivo=0, concepto="x"), "Ricardo", confirmar=True)
        with self.assertRaises(D.ErrorValidacion):
            D.crear(self.con, "egresos", dict(e, concepto=""), "Ricardo", confirmar=True)
        f = D.crear(self.con, "egresos", dict(e, concepto="Sueldo B", tipo="NOMINA"), "Ricardo", confirmar=True)
        self.assertEqual(f["tipo"], "Nómina")   # 'nomina' y 'NOMINA' se unifican con la forma de siempre

    def test_usuarios(self):
        with self.assertRaises(D.Conflicto):   # activo => bloqueado
            D.guardar_usuario(self.con, "Dan", {"perfil": "admin", "activo": 1}, "Ricardo")
        u = D.guardar_usuario(self.con, "Dan", {"activo": 0}, "Ricardo")
        self.assertEqual(u["activo"], 0)
        with self.assertRaises(D.ErrorValidacion) as cm:   # contraseñas distintas
            D.guardar_usuario(self.con, "Dan", {"user": "Dan", "perfil": "user", "activo": 0, "clave": "nueva-clave-1", "clave_confirmacion": "otra"}, "Ricardo")
        self.assertIn("no es igual", str(cm.exception))
        D.guardar_usuario(self.con, "Dan", {"user": "Dan", "perfil": "user", "activo": 1, "clave": "nueva-clave-1", "clave_confirmacion": "nueva-clave-1"}, "Ricardo")
        self.assertEqual(self.con.execute('SELECT "pass" FROM usuarios WHERE "user"="Dan"').fetchone()[0], h("nueva-clave-1"))
        self.assertIsNotNone(D.verificar_login(self.con, "dan", "nueva-clave-1"))
        self.assertIsNone(D.verificar_login(self.con, "dan", "mala"))

    def test_usuario_nuevo_incompleto_y_activacion(self):
        u = D.guardar_usuario(self.con, None, {"user": "Maria", "activo": 0}, "Ricardo")   # inactivo incompleto: se permite
        self.assertEqual((u["perfil"], u["tiene_clave"]), (None, False))
        with self.assertRaises(D.ErrorValidacion) as cm:
            D.guardar_usuario(self.con, "Maria", {"user": "Maria", "activo": 1}, "Ricardo")
        self.assertIn("perfil", str(cm.exception))
        self.assertIn("contraseña", str(cm.exception))
        D.guardar_usuario(self.con, "Maria", {"user": "Maria", "perfil": "user", "activo": 1, "clave": "abcdefgh1", "clave_confirmacion": "abcdefgh1"}, "Ricardo")
        self.assertIsNone(D.verificar_login(self.con, "Maria", ""))
        with self.assertRaises(D.ErrorValidacion):   # nombre repetido sin importar mayúsculas
            D.guardar_usuario(self.con, None, {"user": "maria", "activo": 0}, "Ricardo")
        with self.assertRaises(D.ErrorValidacion):   # clave corta
            D.guardar_usuario(self.con, None, {"user": "Pedro", "perfil": "user", "activo": 0, "clave": "corta", "clave_confirmacion": "corta"}, "Ricardo")

    def test_no_inactivarse_ni_quedarse_sin_admin(self):
        with self.assertRaises(D.Conflicto):
            D.guardar_usuario(self.con, "Ricardo", {"activo": 0}, "Ricardo")
        D.guardar_usuario(self.con, "Dan", {"activo": 0}, "Ricardo")
        D.guardar_usuario(self.con, "Dan", {"user": "Dan", "perfil": "admin", "activo": 1}, "Ricardo")
        D.guardar_usuario(self.con, "Ricardo", {"activo": 0}, "Dan")   # ya hay otro admin: ahora sí
        with self.assertRaises(D.Conflicto):
            D.guardar_usuario(self.con, "Dan", {"activo": 0}, "Ricardo")   # inactivaría al último admin... (Ricardo inactivo ya no puede, pero la regla de base lo frena)

    def test_check_de_base_activo_incompleto(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.con.execute('INSERT INTO usuarios("user","pass",perfil,activo) VALUES("X","",NULL,1)')

    def test_sin_borrado_de_usuarios(self):
        self.assertFalse(hasattr(D, "borrar_usuario"))


class Importacion(unittest.TestCase):
    @unittest.skipUnless(os.path.exists(XLSX), "no está el Excel de prueba")
    def test_equivalencia_con_el_lector_del_excel(self):
        import importar
        import lector_excel as LE
        ruta = os.path.join(tempfile.mkdtemp(), "i.db")
        inf = importar.importar(XLSX, ruta)
        self.assertEqual((inf["cierres"], inf["egresos"], inf["metas"]), (489, 236, 13))
        con = BD.conectar(ruta, solo_lectura=True)
        nuevo, viejo = kpis.leer_todo(con), LE.leer_todo(XLSX)
        self.assertTrue(all(r["cierres_sin_revisar"] == 0 for r in nuevo["egresos_mensual"]))   # lo histórico entra revisado
        self.assertEqual([{k: v for k, v in r.items() if k != "cierres_sin_revisar"} for r in nuevo["egresos_mensual"]], viejo["egresos_mensual"])
        self.assertEqual(nuevo["metas"], viejo["metas"])
        od = {r["fecha"]: r for r in viejo["ingresos_diarios"]}
        for n in nuevo["ingresos_diarios"]:
            o = od[n["fecha"]]
            esperado = (round(o["membresias"] + o["consultas"], 2), o["mercancias"], o["excedente"], o["total"])
            if n["fecha"] == "2026-04-13":     # el Total del Excel traía 129 de más; ahora se calcula
                esperado = (esperado[0] - 129, esperado[1], esperado[2], esperado[3] - 129)
            self.assertEqual((n["membresias"], n["mercancias"], n["excedente"], n["total"]), esperado, n["fecha"])
        self.assertEqual(len(nuevo["ingresos_diarios"]), len(od))
        self.assertEqual(con.execute("SELECT COUNT(*) FROM ingresos WHERE revisado=0").fetchone()[0], 0)
        self.assertEqual(sorted(tuple(r) for r in con.execute('SELECT "user",perfil,activo FROM usuarios')), [("Dan", "user", 1), ("Ricardo", "admin", 1)])
        con.close()


class Exportacion(unittest.TestCase):
    def test_dinamica(self):
        import openpyxl
        con, ruta = base_nueva()
        D.crear(con, "ingresos", CIERRE, "Ricardo", confirmar=True)
        destino = os.path.join(tempfile.mkdtemp(), "x.xlsx")
        exportar.a_archivo(ruta, destino)
        wb = openpyxl.load_workbook(destino)
        self.assertEqual([c.value for c in wb["ingresos"][1]][:4], ["id", "fecha", "turno", "personal"])
        self.assertIn("total", [c.value for c in wb["ingresos"][1]])
        con.execute("ALTER TABLE egresos ADD COLUMN nota TEXT")
        con.execute("ALTER TABLE ingresos RENAME COLUMN excedente TO sobrante")
        con.execute("CREATE TABLE extra (a INTEGER, b TEXT)")
        con.execute("INSERT INTO extra VALUES (1,'x')")
        exportar.a_archivo(ruta, destino)
        wb = openpyxl.load_workbook(destino)
        self.assertIn("nota", [c.value for c in wb["egresos"][1]])
        self.assertIn("sobrante", [c.value for c in wb["ingresos"][1]])
        self.assertEqual([c.value for c in wb["extra"][2]], [1, "x"])
        self.assertEqual(wb["ingresos"]["B2"].value.year, 2026)
        sin = exportar.construir(ruta, incluir_usuarios=False)
        self.assertNotIn("usuarios", sin.sheetnames)
        con.close()


class Servidor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.con, ruta = base_nueva()
        S.RUTA_DB = ruta
        cls.ruta = ruta
        cls.srv = S.Servidor(("127.0.0.1", 0), S.Manejador)
        cls.puerto = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        S._fallos.clear()
        S._fallos_api.clear()
        for t in ("ingresos", "egresos", "bitacora", "historial"):
            self.con.execute(f"DELETE FROM {t}")
        self.con.execute("DELETE FROM usuarios WHERE \"user\" NOT IN ('Ricardo','Dan')")
        self.con.execute("UPDATE usuarios SET activo=1, perfil=CASE \"user\" WHEN 'Ricardo' THEN 'admin' ELSE 'user' END")

    def llamar(self, metodo, ruta, cuerpo=None, cookie=None, token=None, crudo=None, tipo="application/json"):
        c = http.client.HTTPConnection("127.0.0.1", self.puerto, timeout=15)
        cab = {}
        if cookie:
            cab["Cookie"] = cookie
        if token:
            cab["Authorization"] = "Bearer " + token
        datos = crudo if crudo is not None else (json.dumps(cuerpo).encode() if cuerpo is not None else None)
        if datos is not None:
            cab["Content-Type"] = tipo
        c.request(metodo, ruta, body=datos, headers=cab)
        r = c.getresponse()
        cuerpo_r = r.read()
        try:
            j = json.loads(cuerpo_r)
        except Exception:
            j = cuerpo_r
        sc = r.getheader("Set-Cookie")
        c.close()
        return r.status, j, sc

    def entrar(self, u="Ricardo", p="clave-ricardo"):
        st, j, sc = self.llamar("POST", "/api/login", {"usuario": u, "clave": p})
        self.assertEqual(st, 200, j)
        return sc.split(";")[0]

    # --- sesión y roles
    def test_login_y_perfil(self):
        ck = self.entrar()
        self.assertEqual(self.llamar("GET", "/api/sesion", cookie=ck)[1], {"usuario": "Ricardo", "perfil": "admin"})
        self.assertEqual(self.llamar("GET", "/api/sesion", cookie=self.entrar("dan", "clave-dan"))[1]["perfil"], "user")
        self.assertEqual(self.llamar("GET", "/api/datos")[0], 401)
        self.assertEqual(self.llamar("POST", "/api/login", {"usuario": "Ricardo", "clave": "mala"})[0], 401)

    def test_user_no_entra_a_admin(self):
        ck = self.entrar("Dan", "clave-dan")
        for m, r in [("GET", "/api/admin/revision"), ("GET", "/api/admin/usuarios"), ("GET", "/api/admin/exportar.xlsx"),
                     ("POST", "/api/admin/ingresos"), ("DELETE", "/api/admin/ingresos/1")]:
            self.assertEqual(self.llamar(m, r, {"datos": {}}, cookie=ck)[0], 403, r)
        self.assertEqual(self.llamar("GET", "/api/datos", cookie=ck)[0], 200)
        self.assertEqual(self.llamar("GET", "/api/admin/revision")[0], 401)

    def test_inactivo_pierde_acceso_al_instante(self):
        ck = self.entrar("Dan", "clave-dan")
        self.con.execute("UPDATE usuarios SET activo=0 WHERE \"user\"='Dan'")
        self.assertEqual(self.llamar("GET", "/api/datos", cookie=ck)[0], 401)
        self.assertEqual(self.llamar("POST", "/api/login", {"usuario": "Dan", "clave": "clave-dan"})[0], 401)

    def test_bloqueo_por_intentos(self):
        for _ in range(5):
            self.llamar("POST", "/api/login", {"usuario": "Ricardo", "clave": "x"})
        self.assertEqual(self.llamar("POST", "/api/login", {"usuario": "Ricardo", "clave": "clave-ricardo"})[0], 429)

    # --- pantalla de revisión
    def test_flujo_revision(self):
        ck = self.entrar()
        self.con.execute("INSERT INTO ingresos(fecha,turno,personal,mem_efectivo) VALUES('2026-10-01','M','Rodolfo',10)")
        st, j, _ = self.llamar("POST", "/api/admin/ingresos", {"datos": CIERRE}, cookie=ck)
        self.assertEqual(st, 409)    # personal nunca visto -> advertencia
        self.assertTrue(j["requiere_confirmacion"])
        st, j, _ = self.llamar("POST", "/api/admin/ingresos", {"datos": CIERRE, "confirmar": True}, cookie=ck)
        self.assertEqual(st, 201)
        id_ = j["fila"]["id"]
        st, j, _ = self.llamar("GET", "/api/admin/revision?tabla=ingresos&mes=2026-11", cookie=ck)
        self.assertEqual([f["id"] for f in j["filas"]], [id_])
        self.assertEqual(self.llamar("PUT", f"/api/admin/ingresos/{id_}", {"cambios": {"revisado": 1}}, cookie=ck)[0], 200)
        self.assertEqual(self.llamar("PUT", f"/api/admin/ingresos/{id_}", {"cambios": {"mem_efectivo": 1}}, cookie=ck)[0], 409)
        self.assertEqual(self.llamar("DELETE", f"/api/admin/ingresos/{id_}", cookie=ck)[0], 409)
        self.assertEqual(self.llamar("PUT", f"/api/admin/ingresos/{id_}", {"cambios": {"revisado": 0}}, cookie=ck)[0], 200)
        self.assertEqual(self.llamar("DELETE", f"/api/admin/ingresos/{id_}", cookie=ck)[0], 200)
        self.assertEqual(self.llamar("PUT", f"/api/admin/ingresos/{id_}", {"cambios": {"revisado": 0}}, cookie=ck)[0], 404)

    def test_kpis_leen_lo_guardado(self):
        ck = self.entrar()
        self.llamar("POST", "/api/admin/ingresos", {"datos": dict(CIERRE, excedente=-10), "confirmar": True}, cookie=ck)
        d = self.llamar("GET", "/api/datos", cookie=ck)[1]
        self.assertEqual(d["ingresos_diarios"], [{"fecha": "2026-11-20", "membresias": 1000.0, "mercancias": 50.0, "excedente": -10.0, "total": 1040.0}])
        self.assertTrue(any(v["concepto"] == "otros" and v["total"] == -10 for v in d["ventas_mes"]))

    def test_usuarios_por_http(self):
        ck = self.entrar()
        st, j, _ = self.llamar("POST", "/api/admin/usuarios", {"datos": {"user": "Lupe", "activo": 0}}, cookie=ck)
        self.assertEqual(st, 200)
        self.assertNotIn("pass", json.dumps(j))
        st, j, _ = self.llamar("PUT", "/api/admin/usuarios/Lupe", {"datos": {"user": "Lupe", "perfil": "user", "activo": 1, "clave": "abcdefgh1", "clave_confirmacion": "abcdefgh2"}}, cookie=ck)
        self.assertEqual(st, 422)
        self.assertIn("no es igual", j["error"])
        st, j, _ = self.llamar("PUT", "/api/admin/usuarios/Lupe", {"datos": {"user": "Lupe", "perfil": "user", "activo": 1, "clave": "abcdefgh1", "clave_confirmacion": "abcdefgh1"}}, cookie=ck)
        self.assertEqual(st, 200)
        self.assertEqual(self.llamar("DELETE", "/api/admin/usuarios/Lupe", cookie=ck)[0], 404)   # no existe el borrado
        listado = self.llamar("GET", "/api/admin/usuarios", cookie=ck)[1]
        self.assertTrue(all(set(u) == {"user", "perfil", "activo", "tiene_clave"} for u in listado["usuarios"]))
        self.assertEqual(self.llamar("PUT", "/api/admin/usuarios/Ricardo", {"datos": {"activo": 0}}, cookie=ck)[0], 409)

    def test_metas(self):
        ck = self.entrar()
        st, j, _ = self.llamar("PUT", "/api/admin/metas/2026-12", {"datos": {"meta_ingresos": 35000, "meta_socios": "", "notas": "diciembre"}}, cookie=ck)
        self.assertEqual((st, j["meta"]["meta_ingresos"], j["meta"]["meta_socios"]), (200, 35000.0, None))
        self.assertEqual(self.llamar("PUT", "/api/admin/metas/2026-13", {"datos": {}}, cookie=ck)[0], 422)
        self.assertEqual(self.llamar("PUT", "/api/admin/metas/2026-12", {"datos": {"meta_ingresos": -5}}, cookie=ck)[0], 422)
        self.assertEqual(self.llamar("PUT", "/api/admin/metas/Est%C3%A1ndar", {"datos": {"meta_ingresos": 30000}}, cookie=ck)[0], 200)
        self.assertIn({"id": "2026-12", "ingresos": 35000.0, "socios": None}, self.llamar("GET", "/api/datos", cookie=ck)[1]["metas"])
        self.assertEqual(self.llamar("PUT", "/api/admin/metas/2026-12", {"datos": {}}, cookie=self.entrar("Dan", "clave-dan"))[0], 403)
        self.assertEqual(self.llamar("DELETE", "/api/admin/metas/2026-12", cookie=ck)[0], 404)

    def test_exportar_solo_admin_y_sin_hashes_por_omision(self):
        ck = self.entrar()
        st, cuerpo, _ = self.llamar("GET", "/api/admin/exportar.xlsx", cookie=ck)
        self.assertEqual(st, 200)
        self.assertTrue(cuerpo.startswith(b"PK"))
        import io, openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(cuerpo))
        self.assertIn("ingresos", wb.sheetnames)
        self.assertNotIn("usuarios", wb.sheetnames)

    # --- API de alta
    def test_api_tokens(self):
        self.assertEqual(self.llamar("POST", "/api/v1/ingresos", CIERRE)[0], 401)
        self.assertEqual(self.llamar("POST", "/api/v1/ingresos", CIERRE, token="mala")[0], 401)
        self.assertEqual(self.llamar("POST", "/api/v1/ingresos", CIERRE, token="tl")[0], 403)
        self.assertEqual(self.llamar("GET", "/api/v1/ingresos", token="tl")[0], 200)
        self.assertEqual(self.llamar("GET", "/api/v1/estado", token="tw")[0], 200)

    def test_api_solo_agrega(self):
        st, j, _ = self.llamar("POST", "/api/v1/ingresos", dict(CIERRE, id_origen="m1"), token="tw")
        self.assertEqual(st, 200, j)
        self.assertEqual(j["resumen"], {"agregado": 1})
        rid = j["resultados"][0]["id"]
        for m in ("PUT", "PATCH", "DELETE"):
            self.assertEqual(self.llamar(m, f"/api/v1/ingresos/{rid}", {"mem_efectivo": 1}, token="tw")[0], 405)
        self.assertEqual(self.llamar("DELETE", "/api/v1/ingresos", token="tw")[0], 405)
        self.assertEqual(self.con.execute("SELECT mem_efectivo,revisado FROM ingresos").fetchone()[:], (1000.0, 0))

    def test_api_idempotencia_y_conflictos(self):
        p = dict(CIERRE, id_origen="m1")
        self.assertEqual(self.llamar("POST", "/api/v1/ingresos", p, token="tw")[1]["resumen"], {"agregado": 1})
        self.assertEqual(self.llamar("POST", "/api/v1/ingresos", p, token="tw")[1]["resumen"], {"sin_cambios": 1})
        st, j, _ = self.llamar("POST", "/api/v1/ingresos", dict(p, mem_efectivo=1234), token="tw")   # otros datos, mismo origen
        self.assertEqual(st, 409)
        st, j, _ = self.llamar("POST", "/api/v1/ingresos", dict(CIERRE, id_origen="m2"), token="tw")   # mismo fecha+turno, otro origen
        self.assertEqual(st, 409)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM ingresos").fetchone()[0], 1)
        # borrado en la pantalla: la API no lo vuelve a cargar
        ck = self.entrar()
        rid = self.con.execute("SELECT id FROM ingresos").fetchone()[0]
        self.llamar("DELETE", f"/api/admin/ingresos/{rid}", cookie=ck)
        self.assertEqual(self.llamar("POST", "/api/v1/ingresos", p, token="tw")[0], 409)

    def test_api_estricta(self):
        for extra, codigo in [({"revisado": 1}, 422), ({"total": 5}, 422), ({"basura": 1}, 422), ({"estado": "azul"}, 422)]:
            self.assertEqual(self.llamar("POST", "/api/v1/ingresos", dict(CIERRE, id_origen="e", **extra), token="tw")[0], codigo, extra)
        self.assertEqual(self.llamar("POST", "/api/v1/ingresos", dict(CIERRE, fecha="mañana"), token="tw")[0], 422)
        self.assertEqual(self.llamar("POST", "/api/v1/egresos", {"fecha": "2026-11-03", "personal": "R", "tipo": "Insumos", "concepto": "x", "efectivo": 10}, token="tw")[0], 422)  # falta id_origen
        self.assertEqual(self.llamar("POST", "/api/v1/ingresos", crudo=b"{no es json", token="tw")[0], 400)
        self.assertEqual(self.llamar("POST", "/api/v1/ingresos", crudo=b"{}", token="tw", tipo="text/plain")[0], 415)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM ingresos").fetchone()[0], 0)

    def test_lote_todo_o_nada_y_advertencias(self):
        lote = {"registros": [dict(CIERRE, id_origen="a"), dict(CIERRE, turno="V", id_origen="b", mem_efectivo="no")]}
        self.assertEqual(self.llamar("POST", "/api/v1/registros", lote, token="tw")[0], 422)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM ingresos").fetchone()[0], 0)
        lote = [dict(CIERRE, tabla="ingresos", id_origen="a"),
                {"tabla": "egresos", "fecha": "2026-11-03", "personal": "Ricardo", "tipo": "Limpieza especial", "concepto": "cloro", "efectivo": 90, "id_origen": "g1"}]
        st, j, _ = self.llamar("POST", "/api/v1/registros", lote, token="tw")
        self.assertEqual((st, j["resumen"]), (200, {"agregado": 2}))
        self.assertIn("nueva", " ".join(j["resultados"][1]["advertencias"]))      # categoría nueva: se carga, con aviso
        self.assertEqual(self.con.execute("SELECT estado FROM bitacora WHERE tabla='egresos'").fetchone()[0], "amarillo")
        self.assertEqual(self.con.execute("SELECT revisado FROM egresos").fetchone()[0], 0)

    def test_estado_por_api_y_pantalla(self):
        lote = [dict(CIERRE, tabla="ingresos", id_origen="v", estado="verde"),
                dict(CIERRE, tabla="ingresos", turno="V", id_origen="r", estado="rojo", observaciones="foto ilegible"),
                {"tabla": "egresos", "fecha": "2026-11-03", "personal": "Ricardo", "tipo": "Limpieza especial", "concepto": "cloro", "efectivo": 90, "id_origen": "g1"}]
        st, j, _ = self.llamar("POST", "/api/v1/registros", lote, token="tw")
        self.assertEqual(st, 200, j)
        est = {r[0]: r[1] for r in self.con.execute("SELECT turno, estado FROM ingresos")}
        self.assertEqual(est, {"M": "verde", "V": "rojo"})
        self.assertEqual(self.con.execute("SELECT estado FROM egresos").fetchone()[0], "amarillo")   # categoría nueva -> amarillo
        st, j, _ = self.llamar("POST", "/api/v1/ingresos", dict(CIERRE, fecha="2026-11-21", id_origen="x", estado="naranja"), token="tw")
        self.assertEqual(st, 422)
        st, j, _ = self.llamar("GET", "/api/v1/ingresos?mes=2026-11", token="tl")
        self.assertEqual(sorted(f["estado"] for f in j["filas"]), ["rojo", "verde"])
        ck = self.entrar()
        st, j, _ = self.llamar("GET", "/api/admin/revision?tabla=ingresos&mes=2026-11", cookie=ck)
        fila_roja = next(f for f in j["filas"] if f["estado"] == "rojo")
        self.assertEqual(fila_roja["carga_obs"], "foto ilegible")
        st, j, _ = self.llamar("PUT", f"/api/admin/ingresos/{fila_roja['id']}", {"cambios": {"estado": "verde", "mem_efectivo": 900}, "confirmar": True}, cookie=ck)
        self.assertEqual((st, j["fila"]["estado"]), (200, "rojo"))        # desde la pantalla no se cambia el semáforo
        st, j, _ = self.llamar("PUT", f"/api/admin/ingresos/{fila_roja['id']}", {"cambios": {"revisado": 1}}, cookie=ck)
        self.assertEqual((st, j["fila"]["estado"], j["fila"]["revisado"]), (200, "rojo", 1))   # aprobado: conserva el dato, la pantalla lo pinta verde

    def test_cuerpo_enorme(self):
        for _ in range(25):
            st, _, _ = self.llamar("POST", "/api/v1/ingresos", crudo=b'{"a":"' + b"x" * 1_100_000 + b'"}', token="tw")
            self.assertEqual(st, 413)

    def test_concurrencia_mismo_registro(self):
        p = dict(CIERRE, id_origen="carrera")
        with concurrent.futures.ThreadPoolExecutor(20) as ex:
            res = list(ex.map(lambda _: self.llamar("POST", "/api/v1/ingresos", p, token="tw"), range(40)))
        self.assertEqual(sorted({r[0] for r in res}), [200, 409] if any(r[0] == 409 for r in res) else [200])
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM ingresos").fetchone()[0], 1)
        self.assertEqual(sum(1 for r in res if r[0] == 200 and r[1]["resumen"].get("agregado")), 1)

    def test_lecturas_y_escrituras_a_la_vez(self):
        ck = self.entrar()
        def escribir(i):
            return self.llamar("POST", "/api/v1/ingresos", dict(CIERRE, fecha=(__import__("datetime").date(2026, 1, 1) + __import__("datetime").timedelta(days=i)).isoformat(), turno="TM", id_origen=f"c{i}", personal="Jeremy"), token="tw")[0]
        def leer(_):
            return self.llamar("GET", "/api/datos", cookie=ck)[0]
        with concurrent.futures.ThreadPoolExecutor(16) as ex:
            e = list(ex.map(escribir, range(60)))
            l = list(ex.map(leer, range(60)))
        self.assertEqual(set(e), {200})
        self.assertEqual(set(l), {200})


if __name__ == "__main__":
    unittest.main()
