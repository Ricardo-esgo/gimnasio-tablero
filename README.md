# Tablero financiero del gimnasio (con base de datos)

Un solo contenedor con tres cosas: el **tablero** (Indicador de performance y Metas), la **base de datos SQLite** donde viven los cierres, gastos, metas y usuarios,
y una **API** para dar de alta cierres y gastos nuevos (la usará el lector de los chats). El Excel deja de ser la fuente: se usa una sola vez para llenar la base y después
se genera **un respaldo en Excel** cuando lo necesites.

## Qué guarda la base (`kpis.db`)

| Tabla | Columnas |
|---|---|
| `ingresos` (un registro por cierre) | fecha, turno, personal, mem_efectivo, mem_electronico, mer_efectivo, mer_electronico, excedente, **total** (la base lo calcula: suma de los cinco montos; el excedente puede ser negativo), **revisado** (0 = pendiente, 1 = aprobado), **estado** (semáforo de la situación: `verde` consistente, `amarillo` inconsistencia leve, `rojo` grave) |
| `egresos` | fecha, personal, tipo, concepto, efectivo, electronico, **total** (calculado), **revisado**, **estado** (igual que en ingresos) |
| `metas` | periodo (`estandar` o AAAA-MM), meta_ingresos, meta_socios, notas, lectura |
| `usuarios` | user, pass (SHA-256), perfil (`admin` o `user`), activo (1 o 0) |
| `bitacora`, `historial` | apoyo: de dónde vino cada registro cargado por la API (observaciones y mensajes de origen) y qué había antes de cada cambio hecho en pantalla |

Una base creada con una versión anterior se actualiza sola al arrancar (agrega `estado`, conserva el semáforo que ya traía la bitácora y deja anotada la versión del esquema).

Todos los registros cuentan para los indicadores, estén revisados o no. Lo revisado solo indica que ya lo aprobó un administrador.

## Quién ve qué

- **Cualquier usuario activo**: Indicador de performance y Metas (solo lectura).
- **Perfil `admin`**: además **Revisión**, **Usuarios**, edición de **Metas** y el botón *Descargar respaldo en Excel* (en Revisión, a la izquierda de «Instrucciones»).

### Revisión
Combos **Tabla** («Cierre de caja» o «Gasto») y **Mes** (por omisión cierres de caja y el último mes). Cada fila termina con la palomita **Revisado**:

- **Color de la fila**: *revisado* siempre es verde claro, sin importar su semáforo. *Sin revisar* toma el color de su `estado`: verde = sin color, amarillo = amarillo claro, rojo = rojo tenue.
  La columna **Situación** escribe el estado con su nombre: verde = «consistente», amarillo = «inconsistente», rojo = «error» (en la base y la API se guardan como verde / amarillo / rojo; no depende solo del color) y, en amarillo o rojo, la observación del análisis aparece debajo de la fila.
  El `estado` lo fija la carga automática: en pantalla solo se muestra. Quitar o poner la revisión no lo cambia, y un registro capturado a mano nace `verde`.
- **Distribución**: el título «Revisión de registros» lleva a su derecha la etiqueta **Instrucciones** (plegada), que no se mueve; al abrirla, el texto aparece debajo del título. Las columnas miden lo que su dato necesita (sin repartir el sobrante) y ninguna celda se parte en dos renglones. Turno y Tipo llevan además campos sin la flecha de lista: la lista de sugerencias aparece al escribir (o con la flecha ↓ del teclado). La tabla tiene un alto máximo de ~20 renglones con scroll propio; el encabezado y el pie (conteo y suma) quedan fijos. Lo mismo aplica a Usuarios para las instrucciones.
- **Mostrar revisados** (casilla, marcada por omisión): muestra todo el mes. Desmarcada, oculta las filas ya revisadas y deja solo las no revisadas; el pie dice «N de M registros» y la suma sigue lo visible.
- **Aceptar consistentes** (acción de texto con una palomita ✓, junto a la casilla). A su derecha, en la misma barra, **Agregar cierre** / **Agregar gasto** con el mismo estilo de texto, sin palomita: marca como revisados y guarda, de un clic, todos los registros **verdes sin revisar** de la tabla y el mes que estás viendo.
  A cada uno se le hace lo mismo que al pulsar su Guardar con la palomita puesta, con los datos que tenga en pantalla (incluidos tus cambios sin guardar): si el servidor
  encuentra un error o una advertencia, ese registro **no se guarda**, conserva tus cambios y su motivo queda bajo la fila; al final aparece la alerta «No fue posible guardar todos debido a inconsistencias en sus datos».
  Si todos son consistentes se guardan sin alerta. Mientras corre, la pantalla se bloquea con cursor de espera. Los amarillos y rojos nunca se aceptan en masa.
- Revisado = solo lectura. Si le **quitas la palomita**, se guarda al instante, la fila se vuelve editable y aparece **Eliminar**.
- Una fila editable no se guarda hasta pulsar **Guardar**. En ingresos se editan turno, membresías, mercancías y excedente; el total se recalcula solo.
  La fecha y el personal se capturan solo al crear el registro.
- **Agregar cierre / Agregar gasto** pone una fila nueva al final. Mínimo: fecha, turno, personal y total distinto de 0 (puede ser negativo). Una fila nueva puede guardarse ya como revisada.
- Al guardar, el servidor revisa inconsistencias (ya existe un cierre de esa fecha y turno, fecha futura o de hace más de 400 días, montos negativos o muy altos, turno que no es M/V/TM/TD,
  personal o categoría nunca vistos, posible gasto duplicado). Si hay, muestra la lista y **tú decides** si guardar de todos modos.
- **Eliminar** pide confirmación y solo existe en filas sin revisar. Se borra de forma definitiva (queda copia de lo que había en `historial`).

### Regla de «mes completo»
- Un mes es **completo** cuando sus gastos incluyen **Nómina y Renta** y además **todos sus cierres de caja están revisados**. Si no, el resultado del mes y del año se muestran como *provisionales* (con nota que explica la causa).
- Los gastos sin revisar no entran en la regla; solo los cierres. `egresos_mensual` trae `cierres_sin_revisar` por mes (viene de `kpis.py`).

### Usuarios
- Un usuario **activo** no se edita: primero se **inactiva** (pide confirmación). Los usuarios **no se borran**, solo se inactivan.
- La contraseña **nunca se muestra**. En un usuario editable puedes escribir una nueva; al guardar pide escribirla otra vez y, si no coinciden, no se guarda.
  Se almacena como SHA-256. Mínimo 8 caracteres.
- Para activar a alguien deben estar completos nombre, perfil y contraseña. Un usuario inactivo sí puede guardarse incompleto.
- No puedes inactivar tu propio usuario ni dejar el sistema sin un administrador activo. Un usuario inactivado pierde el acceso en su siguiente consulta.
  Consecuencia: **un admin no puede cambiar su propia contraseña**; la cambia otro admin (por eso conviene tener dos).

### Metas
Los admins editan una fila por periodo (`estandar` o AAAA-MM); no se borran, se deja vacía la meta que no aplique.

## La API de carga (`/api/v1`)

Solo **agrega** registros nuevos y consulta. No modifica ni borra: eso se hace en la pantalla Revisión.
Cada petición lleva `Authorization: Bearer <API_TOKEN_ESCRITURA>` (o la de lectura, solo para consultar).

| Método y ruta | Qué hace |
|---|---|
| `POST /api/v1/ingresos` | Un cierre (objeto) o varios (lista, o `{"registros":[...]}`) |
| `POST /api/v1/egresos` | Un gasto o varios |
| `POST /api/v1/registros` | Lote mezclado (cada uno con `"tabla":"ingresos"` o `"egresos"`) |
| `GET /api/v1/ingresos?mes=AAAA-MM`, `/egresos?mes=`, `/bitacora`, `/estado` | Consultas |

Cierre: `fecha, turno, personal, mem_efectivo, mem_electronico, mer_efectivo, mer_electronico, excedente`
(+ opcionales `id_origen, estado (verde|amarillo|rojo; por omisión verde), observaciones, fuente`). `estado` se guarda en la propia fila y las consultas `GET /api/v1/ingresos` y `/egresos` lo devuelven. Gasto: `fecha, personal, tipo, concepto, efectivo, electronico` y `id_origen` obligatorio.

- **Todo o nada**: un lote con un error no escribe nada (422 con la lista de errores). Máximo 200 registros.
- **Idempotente**: reenviar el mismo `id_origen` con los mismos datos responde `sin_cambios`. Con otros datos, 409 (se corrige en Revisión).
  Si el registro se eliminó en Revisión, tampoco se vuelve a cargar (409). En ingresos, si no mandas `id_origen` se usa `fecha|turno`.
- Un cierre de una fecha y turno que ya existen se rechaza (409); en pantalla, en cambio, es una advertencia que puedes aceptar.
- Los registros cargados entran **sin revisar**. Si tienen advertencias (categoría nueva, posible duplicado, etc.) se cargan igual y quedan en **amarillo** con la observación (si ya venían en rojo, siguen en rojo).
- Campos desconocidos, `total` o `revisado` → 422. `PUT`, `PATCH` y `DELETE` → 405.
- Se bloquea 60 s una dirección tras 5 claves incorrectas.

Para probar sin escribir código: importa `pruebas_api/KPIs_API_v2.postman_collection.json` en Postman (variables `base_url`, `token_escritura`, `token_lectura`),
o corre `python3 pruebas_api/simular_dia.py http://IP-DEL-NAS:8080 TU_TOKEN`.

## Respaldos y Excel

- Al arrancar y cada `RESPALDO_HORAS` (24) horas se guardan en `respaldos/` (dentro de tu carpeta de datos) una copia consistente `kpis-FECHA.db`
  y un Excel `kpis-FECHA.xlsx`; se conservan los últimos `RESPALDOS_CONSERVAR` (14) de cada uno.
- El Excel es **una hoja por tabla, tal cual están en la base** (mismos nombres de tabla y de columna, valores sin convertir, `total` incluido; las columnas DATE salen como fechas).
  Es dinámico: si más adelante agregas o renombras columnas o tablas, el respaldo las sigue sin tocar el código.
- El botón del tablero descarga el Excel **sin la hoja de usuarios** (no entregan contraseñas al navegador). Los del disco sí la llevan: guarda esa carpeta como lo que es, información sensible.
- Para volver a un respaldo: detén el contenedor, borra `kpis.db`, `kpis.db-wal` y `kpis.db-shm`, copia el `.db` del respaldo como `kpis.db` y arranca.

## Pasar del Excel a la base (primera vez)

1. En la carpeta de datos (`DB_KPIS`) deja tu `Data_Base.xlsx` (el original no se modifica nunca).
2. La carpeta debe poder **escribirse** por el usuario del contenedor. Por SSH: `chown -R 1007:1007 /ruta/DB_KPIS` (o ajusta `PUID`/`PGID`).
3. En `.env`: `DATOS_RUTA_HOST` (antes `EXCEL_RUTA_HOST`), `API_TOKEN_ESCRITURA`, `API_TOKEN_LECTURA` (opcional) y el resto como antes.
4. Publica la imagen (ver abajo) y arranca: `docker compose pull && docker compose up -d`.
5. Con la base vacía, el contenedor la llena solo desde el Excel y deja el informe en `docker compose logs tablero`: cierres, gastos y metas importados,
   cierres que sumaban 0 (se omiten) y las filas cuyo Total no cuadraba. **Los usuarios conservan su contraseña**; Ricardo queda `admin` y los demás `user`.
6. Entra y compara el tablero contra el que ya tenías. Con tus datos actuales, la comparación contra el lector del Excel dio lo mismo salvo tres diferencias esperadas:
   - Las Consultas (\$70 del 2026-01-24, turno M) ahora cuentan como **membresías** (antes eran "Otros ingresos").
   - Un cierre (2026-04-13 V) traía un Total de \$129 más que Efectivo + Electrónico; ahora el total se calcula y esa diferencia desaparece.
   - Ya no existen filas sueltas de excedente: el excedente va dentro de cada cierre.
   Además, Columna1, Columna2 y la hoja EDO FINANCIERO no se importan (los KPIs hacen esos cálculos).

Para volver a cargar desde el Excel (borra lo que haya en la base, previo respaldo): `docker exec -it tablero-gimnasio python importar.py /datos/Data_Base.xlsx /datos/kpis.db --reemplazar`.

## Despliegue: GitHub → imagen → servidor

El flujo es el de siempre: subes el código a GitHub, GitHub Actions compila la imagen y la publica en ghcr.io, y el servidor solo la descarga con `docker compose`.

1. Sube estos archivos a tu repositorio (`git add . && git commit && git push`). El `.gitignore` excluye `.env`, los Excel y las bases `.db`: ni tus claves ni tus datos se suben.
2. Espera a que termine la acción **Publicar imagen** (pestaña Actions).
3. En el servidor, en la carpeta de Compose, deja `docker-compose.yml` y tu `.env` (a partir de `.env.example`) y ejecuta `docker compose pull && docker compose up -d`.
4. Abre `http://IP-DEL-SERVIDOR:8080`.
5. Versiones fijas: `git tag v2.0.0 && git push origin v2.0.0` y usa `IMAGEN=ghcr.io/tu-usuario/gimnasio-tablero:2.0.0` para poder regresar a una anterior.

Probar en tu computadora sin GitHub: `docker compose -f docker-compose.yml -f docker-compose.local.yml up --build`.

## Variables de entorno

| Variable (.env) | Para qué sirve |
|---|---|
| `IMAGEN` (obligatoria) | Imagen publicada en GitHub |
| `DATOS_RUTA_HOST` (obligatoria) | Carpeta del servidor con la base, los respaldos y el Excel inicial. Con permiso de escritura |
| `EXCEL_ARCHIVO` | Excel con el que se llena la base la primera vez (por omisión `Data_Base.xlsx`) |
| `DB_ARCHIVO` | Nombre de la base (por omisión `kpis.db`) |
| `SESSION_SECRET` | Firma las sesiones. Si falta, se cierran al reiniciar |
| `API_TOKEN_ESCRITURA` / `API_TOKEN_LECTURA` | Claves de la API. Sin la de escritura, la API de carga está apagada |
| `SESSION_HORAS`, `COOKIE_SECURE`, `PUERTO`, `TZ` | Duración de sesión, HTTPS, puerto publicado, zona horaria |
| `RESPALDO_HORAS`, `RESPALDOS_CONSERVAR` | Frecuencia y cantidad de respaldos (0 horas = sin respaldos) |
| `PUID` / `PGID` | Usuario y grupo del contenedor (en tu servidor, 1007:1007) |

## Seguridad

- Los datos solo se entregan a quien tiene sesión; el usuario se vuelve a comprobar contra la base en cada consulta. Las funciones de administración se validan en el servidor, no solo se esconden en la pantalla.
- Sesión en cookie firmada, `HttpOnly` y `SameSite=Strict`; las operaciones que envían datos exigen contenido JSON. Cinco intentos fallidos de login desde una dirección la bloquean un minuto.
- La API usa claves distintas a las contraseñas y se bloquea tras claves incorrectas. No expongas el puerto a Internet: úsalo en tu red o por Tailscale. Si abres el tablero fuera, ponle delante un proxy con HTTPS y `COOKIE_SECURE=true`.
- El hash SHA-256 sin sal de una contraseña corta se puede adivinar si alguien obtiene la base. Usa contraseñas largas y distintas.
- Cada alta, cambio y eliminación hecha en pantalla o por API queda en la tabla `historial` con usuario, hora y lo que había antes.

## Mantenimiento

- Mensajes: `docker compose logs -f tablero`. Salud: `http://IP:8080/salud`. Actualizar: `docker compose pull && docker compose up -d`.
- La base usa el modo WAL: junto a `kpis.db` verás `kpis.db-wal` y `kpis.db-shm`. Son normales; no los borres con el contenedor encendido.
- Pruebas: `cd app && python -m unittest test_v2 -v` (reglas, API, usuarios, exportación, concurrencia, equivalencia con el lector del Excel) y, con el servidor encendido, `node test_e2e.js` (navegador real).

## Límites conocidos

- Un administrador no cambia su propia contraseña (lo hace otro admin).
- No hay pantalla para borrar metas ni usuarios (a propósito).
- El tablero no distingue revisado de no revisado en los indicadores.
- Los cierres con más de un personal en el Excel viejo se importaron con el personal que más filas tenía.

## Estructura

```
docker-compose.yml           el que se usa en el servidor (descarga la imagen)
docker-compose.local.yml     solo para compilar y probar en tu computadora
.env.example
.github/workflows/publicar-imagen.yml
pruebas_api/                 colección de Postman y simulador de un día de carga
test_e2e.js                  prueba con navegador real
app/
  servidor.py     servidor HTTP: tablero, sesiones por perfil, pantallas admin, API, respaldos
  bd.py           esquema SQLite, conexión, respaldo
  datos.py        reglas: validación, advertencias, edición/bloqueo, usuarios, metas, alta por API
  kpis.py         lee de la base lo que usa el tablero
  importar.py     carga inicial desde el Excel
  exportar.py     respaldo en Excel genérico (una hoja por tabla)
  lector_excel.py solo lo usa importar.py
  generar_hash.py ayuda para crear un SHA-256 de contraseña (ya no hace falta para uso normal)
  web/            el tablero (HTML, CSS, JS y d3) y admin.js (Revisión, Usuarios, Metas)
  test_v2.py      pruebas
```

## Cambiar el ícono de la pestaña
El ícono sale de tres archivos en `app/web/`: `favicon.svg` (el principal), `favicon-32.png` y `apple-touch-icon.png` (180×180 px). Reemplázalos conservando el nombre, haz commit y espera la imagen nueva.
Si el navegador no lo cambia, recarga con Ctrl+F5.
