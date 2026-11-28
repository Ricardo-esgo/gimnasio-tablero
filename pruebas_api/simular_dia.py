"""Simula la carga de un día contra la API (como lo haría el procesador de los chats) y muestra cada respuesta.

    python3 simular_dia.py http://IP-DEL-NAS:8080 TOKEN_ESCRITURA [AAAA-MM-DD]

Escenarios: cierre matutino, reenvío idéntico (no duplica), cierre vespertino con aviso, un intento de cambiar un
cierre ya cargado (la API lo rechaza: se corrige en Revisión), lote de egresos, lote con un error (se rechaza completo),
y un intento de borrar por la API (no existe). Todo queda como "sin revisar" en la pantalla Revisión.
Usa por omisión el día de hoy; cada ejecución en el mismo día repite los mismos ids, así que la segunda vez verás sin_cambios/409.
"""
import datetime
import json
import sys
import urllib.error
import urllib.request

base, token = sys.argv[1].rstrip("/"), sys.argv[2]
dia = sys.argv[3] if len(sys.argv) > 3 else datetime.date.today().isoformat()


def llamar(titulo, metodo, ruta, cuerpo=None):
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(base + ruta, data=datos, method=metodo,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            codigo, resp = r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        codigo, resp = e.code, json.loads(e.read() or b"{}")
    print(f"\n### {titulo}\n{metodo} {ruta} -> {codigo}\n{json.dumps(resp, ensure_ascii=False, indent=2)}")


matutino = {"fecha": dia, "turno": "M", "personal": "Jeremy", "mem_efectivo": 1450, "mer_efectivo": 72, "mer_electronico": 30,
            "excedente": -4, "id_origen": f"sim:{dia}:M", "estado": "verde", "fuente": {"chat": "ingresos", "mensajes": ["IMG-1", "IMG-2"]}}
vespertino = {"fecha": dia, "turno": "V", "personal": "Rodolfo", "mem_efectivo": 900, "mem_electronico": 300, "mer_efectivo": 134,
              "id_origen": f"sim:{dia}:V", "estado": "amarillo", "observaciones": "solo llegó la foto de la libreta; falta la del sistema"}

llamar("1. Cierre matutino", "POST", "/api/v1/ingresos", matutino)
llamar("2. Reenvío idéntico: no duplica", "POST", "/api/v1/ingresos", matutino)
llamar("3. Cierre vespertino (queda en amarillo)", "POST", "/api/v1/ingresos", vespertino)
llamar("4. Mismo cierre con otros montos: la API no corrige, responde 409", "POST", "/api/v1/ingresos", dict(vespertino, mer_efectivo=144))
llamar("5. Lote de egresos (2 gastos)", "POST", "/api/v1/egresos", {"registros": [
    {"id_origen": f"sim:{dia}:g1", "fecha": dia, "personal": "Ricardo", "tipo": "Insumos", "concepto": "Cloro y trapeadores", "efectivo": 320.5},
    {"id_origen": f"sim:{dia}:g2", "fecha": dia, "personal": "Ricardo", "tipo": "Servicios", "concepto": "Internet", "electronico": 170.01,
     "estado": "amarillo", "observaciones": "sin comprobante"}]})
llamar("6. Lote con un error: se rechaza completo y no escribe nada", "POST", "/api/v1/registros", [
    dict(matutino, tabla="ingresos", turno="TM", id_origen=f"sim:{dia}:TM"),
    {"tabla": "ingresos", "fecha": dia, "turno": "TD", "personal": "Jeremy", "mem_efectivo": "mucho", "id_origen": f"sim:{dia}:TD"}])
llamar("7. Intento de borrar por la API: no existe esa función", "DELETE", "/api/v1/ingresos/1")
llamar("8. Lo cargado hoy", "GET", f"/api/v1/ingresos?mes={dia[:7]}")
print("\nAhora entra al tablero como admin > Revisión: verás estos registros sin la palomita de Revisado.")
