"""Calcula el SHA-256 de una contraseña, para pegarlo en la columna "pass" de la hoja Usuarios.

Uso:  python3 generar_hash.py            (pide la contraseña sin mostrarla)
      python3 generar_hash.py "clave"    (la recibe como argumento)
"""
import getpass
import hashlib
import sys

clave = sys.argv[1] if len(sys.argv) > 1 else getpass.getpass("Contraseña: ")
print(hashlib.sha256(clave.encode("utf-8")).hexdigest())
