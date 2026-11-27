# Tablero financiero del gimnasio

Contenedor que lee un archivo Excel y muestra el tablero (Indicador de performance con Resumen ejecutivo, Resumen anual, Ingresos relativos, Detalle de ventas y Detalle de gastos, más la pestaña Metas) detrás de un login.
No usa base de datos: **el Excel se lee de nuevo cada vez que se genera un gráfico** y la página lo consulta sola
cada 15 segundos, así que lo que guardes en el Excel aparece en el tablero sin reiniciar nada.

## Despliegue: GitHub → imagen → servidor

El flujo es: subes el código a GitHub, GitHub Actions compila la imagen y la publica en GitHub Container Registry (ghcr.io),
y el servidor solo descarga esa imagen con `docker compose`. En el servidor no hay código ni se compila nada.

### 1. Subir el proyecto a GitHub (una sola vez)

1. En GitHub crea un repositorio vacío, por ejemplo `gimnasio-tablero` (puede ser privado).
2. Desde la carpeta del proyecto:
   ```
   git init -b main
   git add .
   git commit -m "Tablero financiero del gimnasio"
   git remote add origin git@github.com:TU-USUARIO/gimnasio-tablero.git
   git push -u origin main
   ```
   El `.gitignore` ya excluye `.env` y los archivos Excel: ni tus contraseñas ni tus datos se suben al repositorio.
3. Entra a la pestaña **Actions** del repositorio. El flujo "Publicar imagen" se ejecuta solo con ese primer push
   (tarda unos minutos). Si falla con un permiso, ve a *Settings → Actions → General → Workflow permissions* y elige **Read and write permissions**.
4. Al terminar, la imagen queda en `ghcr.io/tu-usuario/gimnasio-tablero:latest` (todo en minúsculas). La verás en la sección **Packages** de tu perfil o del repositorio.

### 2. Dejar que el servidor descargue la imagen

Elige una de las dos:

- **Imagen pública (lo más simple).** En GitHub: *Packages → gimnasio-tablero → Package settings → Change visibility → Public*.
  La imagen solo contiene el código del tablero: no lleva el Excel, ni usuarios, ni contraseñas.
- **Imagen privada.** Crea un token en GitHub (*Settings → Developer settings → Personal access tokens → Tokens (classic)*)
  con el permiso `read:packages` y, en el servidor, inicia sesión una vez:
  ```
  echo TU_TOKEN | docker login ghcr.io -u TU-USUARIO --password-stdin
  ```

### 3. Configurar y arrancar en el servidor

1. Crea una carpeta para el despliegue, por ejemplo `/srv/dev-disk-by-uuid-XXXX/compose/gimnasio`, y copia ahí solo `docker-compose.yml` y `.env.example`.
2. Renombra `.env.example` a `.env` y completa:
   - `IMAGEN`: la ruta de la imagen publicada, por ejemplo `ghcr.io/tu-usuario/gimnasio-tablero:latest`.
   - `EXCEL_RUTA_HOST`: **carpeta** del servidor donde está el Excel (la carpeta, no el archivo).
   - `EXCEL_ARCHIVO`: nombre del archivo (por defecto `Data_Base.xlsx`).
   - `SESSION_SECRET`: un texto largo y secreto (por ejemplo, `openssl rand -hex 32`).
3. Arranca:
   ```
   docker compose up -d
   ```
4. Abre `http://IP-DEL-SERVIDOR:8080` (o el `PUERTO` que definas).

Se monta la **carpeta** y no el archivo porque Excel y LibreOffice guardan creando un archivo nuevo; si montaras
solo el archivo, el contenedor seguiría viendo la versión vieja. La carpeta se monta de solo lectura: el tablero nunca modifica el Excel.

Si el contenedor no puede leer la carpeta ("Permission denied" en `docker compose logs`), ajusta `PUID` y `PGID` en `.env`
a un usuario y grupo con permiso de lectura sobre esa carpeta.

### 4. Publicar cambios y actualizar

- Cada `git push` a `main` vuelve a publicar la etiqueta `latest`. En el servidor: `docker compose pull && docker compose up -d`.
- Para versiones fijas, crea una etiqueta: `git tag v1.0.1 && git push origin v1.0.1`. Se publican `1.0.1`, `1.0` y `latest`
  (la última solo desde `main`). Así puedes poner `IMAGEN=ghcr.io/tu-usuario/gimnasio-tablero:1.0.1` y volver a una versión anterior cuando quieras.
- Las etiquetas con el código corto del commit (`sha-abc1234`) también se publican, por si necesitas una compilación exacta.

### Probar en tu computadora sin GitHub

```
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

## Variables de entorno

| Variable (.env) | Dentro del contenedor | Para qué sirve |
|---|---|---|
| `IMAGEN` (obligatoria) | — | Imagen publicada en GitHub que descarga el servidor |
| `EXCEL_RUTA_HOST` (obligatoria) | se monta en `/datos` | Carpeta del servidor donde está el Excel |
| `EXCEL_ARCHIVO` | `EXCEL_FILE` | Nombre del archivo Excel (por defecto `Data_Base.xlsx`) |
| `SESSION_SECRET` | `SESSION_SECRET` | Firma las sesiones. Si falta, las sesiones se cierran al reiniciar |
| `SESSION_HORAS` | `SESSION_HORAS` | Duración de la sesión (por defecto 12) |
| `COOKIE_SECURE` | `COOKIE_SECURE` | `true` si entras por HTTPS |
| `PUERTO` | — | Puerto publicado en el servidor (por defecto 8080) |
| `PUID` / `PGID` | — | Usuario y grupo con que corre el contenedor |

## Formato del Excel

Hojas que se leen, por nombre exacto:

- **Detalle Ingresos**: encabezados `Fecha`, `Turno`, `tipo`, `Efectivo`, `Electronico`, `Total` (se buscan por nombre en las primeras filas).
  Los ingresos de los resúmenes usan `Total` si trae valor; si no, `Efectivo + Electronico`. Tipos: `membrecias`/`membresias`, `mercancias`, `Consultas`;
  cualquier otro tipo (por ejemplo `excedente`) cuenta como "Otros".
  El tablero **Detalle de ventas** usa las columnas `Efectivo` y `Electronico` de cada venta (celda vacía = 0). Si en una fila `Total` es mayor que
  `Efectivo + Electronico`, esa diferencia no se puede clasificar y el tablero la avisa como "sin desglosar".
  Ese mismo tablero tiene el combo **Segregar por**: *Tipo de pago* (efectivo / electrónico) o *Turno*, que usa la columna `Turno`:
  `M` = matutino y `V` = vespertino. Cualquier otro código (por ejemplo `TM`, `TD`) o una celda de turno vacía se agrupa como
  "Otros turnos", que solo aparece en los meses que los traen. La columna `Turno` es opcional: sin ella, todo cae en "Otros turnos".
- **Detalle Egresos**: encabezados `Fecha`, `tipo`, `Efectivo`, `Electronico`, `Total`. Las categorías son **las que escribas en la columna `tipo`**:
  se muestran y se grafican con ese mismo nombre, sean cuales sean y las que se agreguen después (no hay lista fija). Solo se unifican las que difieren
  en mayúsculas, acentos o espacios (`NOMINA` = `Nómina`). Un mes se considera "completo" cuando tiene `Nómina` y `Renta`.
  **Gastos operativos** = `Nómina`, `Renta`, `Servicios`, `Insumos` y `Mercancía` (se reconocen con cualquier mayúscula/acento). Todo lo demás
  (Infraestructura, Máquinas…) son **gastos de expansión**. El check **Incluir gastos de expansión** del Resumen ejecutivo y del Resumen anual decide si el resultado,
  la gráfica y el semáforo restan todos los gastos (activo) o solo los operativos (apagado). El tablero **Detalle de gastos** siempre muestra los dos grupos.
- **Metas**: encabezados `Periodo`, `Meta ingresos`, `Meta socios`. `Periodo` es `Estándar` (una fila) o el mes como texto `AAAA-MM`.
  Meta vacía = ese mes usa la estándar. Si un mes se repite, vale la última fila. Las metas se cambian **solo en el Excel**; la pestaña Metas del tablero las muestra.
- **Usuarios**: columnas `user` y `pass`. En `pass` va el **SHA-256 de la contraseña**, no la contraseña.

### Estado de los gastos de un mes

El tablero marca el resultado de un mes como definitivo o provisional según si los gastos están completos. Se decide así:

- `sin captura`: el mes no tiene gastos, o suman 0.
- `completo`: el mes tiene gasto de **Nómina** y de **Renta**.
- `parcial`: hay gastos, pero falta Nómina o Renta.

Además, el mes en curso siempre es provisional.

### Contraseñas (SHA-256)

El hash es el SHA-256 de la contraseña en UTF-8, sin sal, en hexadecimal (64 caracteres; mayúsculas o minúsculas dan igual).

```
python3 app/generar_hash.py            # pide la contraseña sin mostrarla
printf '%s' 'mi-clave' | sha256sum     # en Linux
```

Formatea la columna `pass` como **Texto** para que Excel no convierta un hash a número. Un usuario cuyo valor no sea un SHA-256 válido no puede entrar
(el aviso aparece en `docker compose logs`). Si quitas un usuario de la hoja, pierde el acceso en su siguiente consulta.

Guarda el Excel con Excel o LibreOffice: guardan los valores calculados de las fórmulas. Un archivo escrito por herramientas que no los guardan
(por ejemplo, una librería de programación) se lee con celdas vacías donde había fórmulas.

## Seguridad

- Los datos de ingresos y gastos solo se entregan a quien tiene sesión; la validación del usuario y la contraseña se hace en el servidor.
- La sesión va en una cookie firmada, `HttpOnly` y `SameSite=Strict`. Cinco intentos fallidos desde una misma dirección bloquean el acceso un minuto.
- El contenedor sirve HTTP. Si el tablero se abre fuera de tu red local, ponle delante un proxy con HTTPS y define `COOKIE_SECURE=true`; si no, la contraseña viaja sin cifrar.
- El hash sin sal de una contraseña corta se puede adivinar por fuerza bruta si alguien obtiene el Excel. Usa contraseñas largas y distintas para cada usuario.

## Mantenimiento

- Ver mensajes: `docker compose logs -f tablero` (lectura inicial, avisos del Excel, inicios de sesión correctos y fallidos).
- Actualizar el tablero: `docker compose pull && docker compose up -d`.
- Revisar que está vivo: `http://IP:8080/salud`.

## Estructura

```
docker-compose.yml          el que se usa en el servidor (descarga la imagen)
docker-compose.local.yml    solo para compilar y probar en tu computadora
.env.example
.github/workflows/
  publicar-imagen.yml        compila y publica la imagen en ghcr.io
app/
  Dockerfile
  servidor.py        servidor HTTP, login y API
  lector_excel.py    lectura del Excel
  generar_hash.py    ayuda para crear el SHA-256 de una contraseña
  web/               el tablero (HTML, CSS, JS y d3)
```
