# node_cx_recibe_venta_ejecutivo

> Verificado el 2026-09-25 contra el código local y el servidor de producción (solo lectura).
> Lo que no pude comprobar está marcado como "por confirmar".

## 1. Qué es y cómo se ejecuta

Conjunto de scripts Node.js (CommonJS, sin framework) que **concilian las ventas de los clientes** (Alemana, Davila,
AndesSalud, Colmena, RedSalud, etc.) contra la tabla `genesys_backend.cx_venta_ejecutivo` de Postgres. Cada script
obtiene la "respuesta" del cliente (portal web, reporte Looker Studio, Google Sheets o archivo en S3) y actualiza
el estado de la venta (EXITOSO / RETRACTO / RECHAZADA… / PENDIENTE), certificado, beneficiarios, sucursal, etc.

- Se ejecutan **por cron** en `server-cx` (ver sección 2). No hay API, CLI unificado ni tests
  (`package.json` no tiene scripts útiles; `npm test` es el placeholder).
- Scraping con `puppeteer`; conexión a BD en `src/config/conexion.js` (lee `.env` con `dotenv` + `find-config`).
- El `README.md` es antiguo (2024) y solo describe la carga manual de RedSalud (`app.paso1/paso2`, que ya no existen).

## 2. Scripts y crons (producción)

Zona horaria del servidor: `America/Santiago` (-03/-04). Los horarios son hora local del servidor.

| Script (`src/services/…`) | Qué hace | Parámetros | Cron en producción |
|---|---|---|---|
| `davila/app.actualiza.ventas.js` | Looker (`/page/sAMLE`), tabla única. Campañas 29, 37, 45 (Exámenes y Urgencias / CAR / C2C). Lee máx. 3 páginas. `Inactivo` → RETRACTO forzado | `--ano=YYYY --mes=M` (por defecto mes actual) | `*/30 9-21 * * 1-6` vía `run_lock.sh` (clave `chrome_profile_andessalud`) |
| `andesSalud/app.actualiza.ventas.js` | Looker (`/page/p_a1crcxg36d`), tablas **Ventas** (→ EXITOSO, agrupa por Certificado) y **Bajas** (→ RETRACTO forzado). Campaña 78. Guarda snapshot crudo en `cx_venta_looker` | `--ano --mes` | `*/30 9-21 * * 1-6` vía `run_lock.sh` (misma clave de lock que davila) |
| `alemana/app.actualiza.ventas.js` | Portal Alemana (login con `ALEMANA_RUT/PASS`), lee hasta `MAX_PAGINAS = 100`. Campañas 34, 35, 44, 65, 50 (Vida, Renta, MACC, EGRA, ACC) | `--ano --mes` | `*/30 9-21 * * 1-6` (node directo, sin lock) |
| `colmena/app.actualiza.ventas.js` | Lee xlsx de S3 (`bucket-cx-sftp`, prefijo `colmena/in/reportes/`), solo archivos modificados hoy/ayer. Campaña 43. Cruza por Rut; N° Póliza y Fecha Emisión → EXITOSO | `--ano --mes` (no afecta el filtro hoy/ayer) | `0 10 * * *` |
| `app.captura.bajas.qp.js` | Captura bajas desde Looker (informador `QUEPLAN`) hacia `cx_venta_ejecutivo_baja` | `--<arg>=` vía `getCliArg` (por confirmar cuáles) | `07 00 * * 1-5` (log `log_node_cx_bajas.log`) |
| `redSalud/app.actualiza.ventas.v2.js` | Google Sheets de RedSalud Dental (cliente 5, campaña 22) | — | **Comentado** (`00 10,12,14 * * 1-6`). El mes está hardcodeado a propósito en producción |
| `sanaSalud/*`, `bice-vida/*`, `vida-integra/*`, `alpes/*`, `everest/*`, `bollek-dentalcoop/*`, `metlife/*` | Looker (reporte `3a97ace1-…`) por cliente | — | **Comentados o sin cron** (por confirmar cuáles siguen vigentes) |
| `davila/app.identifica.ventas.usuario.js`, `redSalud/app.actualiza.fecha_ingreso.js` | Utilitarios manuales | — | Sin cron |

Crons de mantenimiento relacionados:
- **Catch-up de mes cerrado**: días 1-3 de cada mes a las 06:01 (davila), 06:11 (andesSalud), 06:21 (alemana), con `--ano/--mes` del mes anterior. A las 06:00 se vacían sus logs `*_catchup_*`.
- `0 9 * * 1-6` trunca los logs `log_node_cx_recibe_venta_ejecutivo*.log`.
- `*/45 9-21 * * 1-5` mata procesos Chrome de puppeteer con más de 2400 s de antigüedad (no todos, para no matar corridas vivas).
- `00 9-23 * * *` hace `rm -rf /tmp/*` (**cuidado**: borra archivos temporales/logs de pruebas cada hora; los locks de `run_lock.sh` están en `/tmp`).

### `src/services/run_lock.sh`
Wrapper con `flock`: `run_lock.sh SCRIPT LOGFILE [CLAVE_LOCK] [args extra para node…]`. Lock en `/tmp/venta_ejecutivo_<clave>.lock`,
espera hasta 20 min. davila y andesSalud comparten la clave `chrome_profile_andessalud` porque usan el mismo perfil de Chrome.

## 3. Flujo y reglas de negocio

- **Mes**: `querys.obtieneMesID(ano, mes)` → `cx_mes_venta.mes_ven_id` (ej. 28=Jul, 29=Ago, 30=Sep 2026). Sin `--mes` usan el mes en curso,
  por lo que un PENDIENTE de un mes anterior solo se corrige con `--mes` (por eso existe el catch-up).
- **Match** del UPDATE a `cx_venta_ejecutivo`: rut + campaña + mes (`ven_eje_mes_venta_id`). Alemana compara solo el rut base (sin dígito verificador).
- **Protección de estados**: la Query1 no pisa estados terminales (`DUPLICADO, RECHAZA VENTA, CORTA, RECHAZADA POR COMPRA EN CYBER, EXITOSO, TIMEOUT, RECHAZADA POR CALIDAD`;
  Alemana usa una lista más corta). La Query2 (beneficiarios, certificado, sucursal) **no** tiene protección. RETRACTO por bajas/Inactivo se **fuerza** ignorando el estado actual.
- **Un rut con varias propuestas** (Alemana): EXITOSO (EMITIDA) gana siempre; entre no-EXITOSO gana la más reciente (primera vista, el portal lista de nueva a antigua).
- **Looker (AndesSalud/davila)**: se lee TODO el DOM primero, se cierra el navegador y recién después se escribe en BD (evita "detached Frame").
  Varias tablas por página: se identifican por un encabezado distintivo, no por posición. `ven_eje_venta_adicional` se recalcula al final.
- **Fechas**: `helpers/dates.js` `convertirFecha` (acepta `sep/sept/set`).
- **`cx_venta_looker`** (snapshot crudo AndesSalud): unique `(cliente, tabla_origen, campana_id, mes_venta_id, n_certificado)`; el mes se deriva de la fecha de cada fila
  (Ventas: Fecha compra; Bajas: Fecha baja), no del `--mes` de la corrida. Sin FK hacia `cx_venta_ejecutivo` (decisión del dueño). Creada directo en BD, sin migración en el repo.
- **Alerta de sesión de Google** (`helpers/alertaSesionGoogle.js`, usada por davila y andesSalud): si tras `page.goto` la URL es `accounts.google.com`,
  envía correo a `ALERTA_MAIL_TO` (máx. 1 cada 24 h; estado en `/home/ubuntu/node_procesos/logs/alerta_sesion_google.json`) y falla con error claro.

## 4. Integraciones externas

- **Postgres** (schema `genesys_backend`): `cx_venta_ejecutivo` (principal), `cx_venta_ejecutivo_baja`, `cx_venta_looker`, `cx_mes_venta`, `cam_campana`, `usu_usuario`.
  Campañas relevantes: 29 Exámenes y Urgencias, 37 …CAR, 45 …C2C, 43 Colmena Urgencias, 78 AS Exámenes, 34 Vida, 35 Renta, 44 MACC, 65 EGRA, 50 ACC, 22 Soy RedSalud Dental.
- **Looker Studio / Data Studio**: reporte `745213f7-…` (davila `/page/sAMLE`, AndesSalud `/page/p_a1crcxg36d`; el slug viejo `p_pvr8ol3t5d` redirige en silencio a davila) y reporte `3a97ace1-…` (resto de clientes). Requiere login de Google.
- **Portal Alemana** (`ventadigital.alemanaseguros.cl`), **Google Sheets** (RedSalud), **AWS S3** (`bucket-cx-sftp`, IAM `userBucket` con ListBucket/GetObject), **SMTP** (alertas, nodemailer).
- **Variables del `.env`** (solo nombres): `DB_HOST DB_PORT DB_NAME DB_USER DB_PASS`, `ALEMANA_RUT ALEMANA_PASS`, `AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION AWS_S3_BUCKET`,
  `GOOGLE_EMAIL GOOGLE_PASSWORD` (solo scripts RedSalud viejos), y **solo en producción**: `SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS ALERTA_MAIL_TO` (opcional `ALERTA_MAIL_FROM`, `ALERTA_ESTADO_DIR`).
  El `.env` local **no** tiene las `SMTP_*`/`ALERTA_*`.

## 5. Producción

- Host `server-cx`, usuario `ubuntu`, llave `~/Documents/Work/B2it/b2itEC2.pem` (solo la ruta).
  **El alias solo no autentica**: usar `ssh -i ~/Documents/Work/B2it/b2itEC2.pem ubuntu@server-cx`.
- Proyecto: `/home/ubuntu/node_procesos/node_cx_recibe_venta_ejecutivo`. Logs: `/home/ubuntu/node_procesos/logs/` (`log_node_cx_recibe_venta_ejecutivo_<cliente>.log`, `_catchup_*`, `log_node_cx_bajas.log`). No usar `/tmp` para nada persistente.
- Chrome real: `/usr/bin/google-chrome` (v141+), perfil dedicado `/home/ubuntu/.config/chrome-profiles/andessalud` (cuenta Google logueada a mano por VNC). Hay que pasar `executablePath` (el Chromium de puppeteer v131 crashea con ese perfil).
- **Sesión de Google**: expira periódicamente ("Verifica que eres tú"). Síntoma: `Waiting for selector .centerColsContainer failed` en el 100% de las corridas. Solución: VNC → abrir Chrome con ese perfil, iniciar sesión, abrir el reporte y **cerrar Chrome por completo**. Ahora hay alerta por correo.
- Disco raíz de 15G, ajustado (revisar `df -h /` antes de asumir bug de código cuando Chrome falle raro).
- El servidor **no se actualiza con git**: se despliega copiando archivos (scp) y `npm install` puntual. Ver convenciones.

## 6. Proyectos relacionados en el servidor

En `/home/ubuntu/node_procesos/`: `node_cx_ingreso_ventas` (probablemente carga las ventas que este proyecto concilia, por confirmar; su `run_ingreso_ventas_lock.sh` fue el patrón de `run_lock.sh`),
`node_cx_colmena` (versión anterior del proceso Colmena, cron comentado), `node_cx_api_kiubo` (fuente de las `SMTP_*` copiadas), `node_cx_reporte_gestion`, `node_cx_altas`, `node_carga_base_cliente`.
No encontré proyectos que importen código de este. Dependencias reales entre ellos: por confirmar.

## 7. Estado del repo y pendientes

- **RIESGO: `.env` está trackeado en git** (y no está en `.gitignore`; el historial lo contiene desde el commit `81307b9`). También hay tracked: `cookies.json` de varios clientes, capturas `.png` y ~217 archivos de perfiles de Chrome (`redSalud/.puppeteer_profile`, `redSalud/chrome-profile`). Recomendado: sacar del índice, agregar a `.gitignore` y rotar credenciales (BD, Alemana, AWS, Google).
- **RIESGO: `src/services/alemana/b2itEC2.pem`** (llave SSH) está sin trackear pero tampoco ignorada: fácil de commitear por error. Moverla fuera del repo y agregar `*.pem` a `.gitignore`.
- **RIESGO: `alemana/app.actualiza.ventas.js` líneas 19-20** tienen credenciales de respaldo hardcodeadas (`|| "…"`) para `ALEMANA_RUT/PASS`. Quitarlas.
- `.gitignore` solo ignora `node_modules` y `ENTRADA`. Existen `.git 2/` (carpeta duplicada), `davila/app.actualiza.ventas copy.js`, `*.bk`, `alemana/...bkp.js`, `datos_looker.json`, `looker_data.json`: ruido/deuda.
- `package.json` con ~243 dependencias listadas (muchas transitivas) y sin scripts; no hay tests.
- **Local vs producción**: el git del servidor está atrasado (HEAD `1c8863c`) y con cambios sin commit (`.env`, `package.json`, `dates.js`, `redSalud/…v2`, `sanaSalud/…`, además de `.bak_*`). Producción manda: **comparar (diff) antes de sobreescribir cualquier archivo**.
- Cambios locales sin commitear al 2026-09-25: `.env`, `app.captura.bajas.qp.js`, `vida-integra/…dental.js`, borrado de scripts viejos de redSalud, y carpetas nuevas `alpes/`, `everest/` (por confirmar si se desea versionarlas).
- RedSalud (`v2`): en producción el mes está hardcodeado ("2026/07") a propósito; **no** cambiarlo a dinámico sin preguntar.

## 8. Hallazgos ya investigados (no repetir)

- "Requesting main frame too early" en davila: era solapamiento de corridas + `pkill` de todo Chrome → resuelto con `run_lock.sh` y pkill por antigüedad.
- Disco al 100% (ago-2026) rompía Chrome; se limpió caché de npm y backups viejos. Backup diario de BD (~2.3G) en `node_cx_backup_database` sin rotación.
- Looker Studio reestructuró AndesSalud (03-sep-2026): desapareció "Estado Contratación"; hoy Ventas = Activo, Bajas = Inactivo.
- Un rut con varias propuestas provocaba que una antigua pisara a la nueva (Alemana): regla EXITOSO-gana implementada (16-sep-2026).
- RUTs "sin match" a veces difieren solo en el dígito verificador (ej. `16521420-9` vs `-K`): es error de digitación, no bug.
- `20267014-8` (AndesSalud) sale "Rut no encontrado": es venta de oct-2025, fuera del mes en curso; esperado.
- En davila, `.cell-value` row[0] es el número de fila de Looker (desplaza los índices de columnas).
- Hay un caso abierto sin cerrar: rut `12896548-3` (Excel BAJAS DAVILA 08.2026, fila 28) no está en campaña 29; falta revisar campañas 37 y 45.

## 9. Convenciones de trabajo

- Responder y comentar en **español**; commits en español, terminados con la línea `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **No hacer commit ni push sin que se pida.** El push por HTTPS falla: usar `git push git@github.com:abnerseverino/node_cx_recibe_venta_ejecutivo.git main`.
- **Escrituras en producción solo con petición explícita** (deploy, editar crontab, tocar `.env`). Antes: respaldo con timestamp (`.bak_YYYYMMDD_HHMMSS`) y diff contra lo que hay en el servidor. Nunca `git pull` en el servidor.
- Nunca truncar la salida de un proceso real corriendo por SSH (`| head -N` mata el script con SIGPIPE): redirigir a archivo y luego leer.
- Nunca mostrar valores del `.env` ni credenciales; consultar la BD con un script temporal dentro del proyecto (usa `src/config/conexion.js`) y borrarlo. Solo lectura salvo pedido.
- Para pruebas en el servidor, logs en `/home/ubuntu/node_procesos/logs/`, no en `/tmp`.

## 10. Mantenimiento de este archivo

- Actualizarlo **en la misma sesión** en que haya un cambio relevante (script nuevo, cambio de cron, pendiente resuelto, hallazgo importante, cambio en producción) y avisar al usuario qué se modificó.
- Fechar lo que caduca ("verificado el AAAA-MM-DD"); mantener solo lo estable, sin conteos puntuales.
- Quitar de la sección 7 lo que ya se resolvió.
- Nunca incluir secretos (contraseñas, tokens, llaves, valores del `.env`).
