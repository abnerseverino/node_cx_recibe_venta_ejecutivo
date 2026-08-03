const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const csvParser = require("csv-parser");
const moment = require("moment");
const { pool } = require("../../config/conexion");
const querys = require("../../data/querys");

require("dotenv").config({ path: require("find-config")("../../.env") });

// Evita que un crash de bajo nivel (p.ej. el pipe con Chrome) tumbe el proceso
// sin dejar rastro y sin liberar el lock del script.
process.on("uncaughtException", (err) => {
  console.error("💥 uncaughtException:", err);
  liberarLockProceso();
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("💥 unhandledRejection:", err);
  liberarLockProceso();
  process.exit(1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// === PERFIL Y BINARIO FIJOS (usa siempre el perfil docs) ===
const CHROME_PROFILE_DIR = "/home/ubuntu/.config/chrome-profiles/docs2";
const CHROME_BIN = "/usr/bin/google-chrome"; // o cambia si tu binario está en otra ruta

// Lock a nivel de script: evita que dos corridas (p.ej. cron solapado)
// choquen sobre el mismo perfil persistente de Chrome, que es lo que
// produce el "ECONNRESET" al lanzar una segunda instancia sobre un
// perfil ya tomado por la corrida anterior.
const LOCK_FILE = path.join(__dirname, ".actualiza_ventas_v2.lock");

function adquirirLockProceso() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
    const vivo = pid && (() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    })();
    if (vivo) {
      console.error(`⛔ Ya hay una ejecución en curso (PID ${pid}). Abortando para no chocar con el perfil de Chrome.`);
      process.exit(1);
    }
    console.warn(`🧹 Lock huérfano de un PID ${pid} que ya no existe. Se limpia.`);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function liberarLockProceso() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// Limpia los archivos de lock que Chrome deja en el perfil persistente
// cuando una corrida anterior murió sin cerrar limpiamente (exactamente
// el escenario del crash: el proceso se cae antes de llegar al
// `finally { browser.close() }`), lo que impide que el próximo Chrome
// tome ese mismo userDataDir y lo hace morir de inmediato.
function limpiarLockPerfilChrome(profileDir) {
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const p = path.join(profileDir, f);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`🧹 Lock stale de Chrome eliminado: ${p}`);
      }
    } catch (e) {
      console.warn(`⚠️ No se pudo eliminar ${p}:`, e.message);
    }
  }
}

function looksLikeGoogleLogin(url) {
  const pats = ["accounts.google.com", "/ServiceLogin", "/signin", "identifier?"];
  return pats.some((p) => url.includes(p));
}

/**
 * Usa un perfil persistente fijo ("docs") con sesión ya iniciada en Google.
 * Descarga el CSV en ./downloads.
 */
async function downloadGoogleSheetAsCSV() {
  const sheetUrl =
    "https://docs.google.com/spreadsheets/d/1FvlZU1AUJoKrdLrtNaxo9nGBZvTAhligVbaEhDrp7XU/edit#gid=1765604646";

  const downloadPath = path.resolve(__dirname, "./downloads");
  if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

  for (const f of fs.readdirSync(downloadPath)) {
    if (f.endsWith(".csv")) {
      try { fs.unlinkSync(path.join(downloadPath, f)); } catch {}
    }
  }

  limpiarLockPerfilChrome(CHROME_PROFILE_DIR);

  const launchOpts = {
    headless: true,
    dumpio: true, // saca el stderr real de Chrome al log si vuelve a morir al lanzar
    executablePath: CHROME_BIN,
    userDataDir: CHROME_PROFILE_DIR,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--metrics-recording-only",
      "--mute-audio",
      "--disable-client-side-phishing-detection",
      "--disable-sync",
      "--disable-features=Translate,PrivacySandboxSettings4",
    ],
  };

  console.log("🗂  Usando perfil persistente:", CHROME_PROFILE_DIR);
  console.log("🧭 Ejecutando Chrome desde:", CHROME_BIN);

  const browser = await puppeteer.launch(launchOpts);

  try {
    browser.on("disconnected", () => {
      console.error("⚠️ Chrome se desconectó (Target closed). Revisa el binario o el perfil.");
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(90000);
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );

    // Permitir descarga
    const cdp = await page.target().createCDPSession();
    await cdp.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath,
    });

    // No cargamos el editor completo (/edit): es una SPA muy pesada en JS/WebGL
    // que en headless sin GPU cae a software rendering y puede tumbar Chrome
    // por memoria en servidores chicos (eso es lo que produce el "Target closed").
    // La sesión se valida directo contra la URL de export, que es liviana.
    const exportUrl = `${sheetUrl.split("/edit")[0]}/export?format=csv&gid=1765604646`;
    console.log("⬇️ Descargando CSV (validando sesión directo contra el export)...");
    try {
      await page.goto(exportUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    } catch (err) {
      if (!String(err.message).includes("net::ERR_ABORTED")) throw err;
    }

    if (looksLikeGoogleLogin(page.url())) {
      throw new Error(
        "El perfil DOCS no tiene sesión válida. Abre VNC, inicia sesión en Google en ese perfil y vuelve a ejecutar."
      );
    }

    // Esperar hasta 15 segundos que aparezca el CSV
    const waitEnd = Date.now() + 15000;
    let csvPath = null;
    while (Date.now() < waitEnd) {
      const files = fs
        .readdirSync(downloadPath)
        .filter((f) => f.endsWith(".csv"))
        .map((f) => path.join(downloadPath, f));
      if (files.length > 0) {
        csvPath = files[0];
        break;
      }
      await sleep(500);
    }

    if (!csvPath) {
      throw new Error("No se descargó ningún CSV en la carpeta " + downloadPath);
    }

    console.log("📂 Archivo descargado en:", csvPath);
    return csvPath;
  } finally {
    await browser.close();
  }
}

/**
 * Procesa el CSV descargado y actualiza la base de datos
 */
async function leeGoogleSheet() {
  try {
    console.clear();
    console.log("🚀 Iniciando proceso de descarga...");
    const csvPath = await downloadGoogleSheetAsCSV();

    console.log("📖 Procesando archivo CSV...");
    const rows = [];

   await new Promise((resolve, reject) => {
  let lineNumber = 0;

  fs.createReadStream(csvPath)
    .pipe(csvParser({ headers: false }))
    .on("data", (row) => {
      lineNumber++;
      const rowArray = Object.values(row);
      console.log(`📄 Línea ${lineNumber}:`, rowArray); // 🔹 Muestra el número de línea y su contenido completo

      const maxColumns = 13;
      const filledRow = [...rowArray, ...Array(maxColumns - rowArray.length).fill(null)];
      rows.push(filledRow);
    })
    .on("end", () => {
      console.log(`✅ Lectura de CSV finalizada. Total de líneas: ${lineNumber}`);
      resolve();
    })
    .on("error", (err) => {
      console.error("❌ Error leyendo el CSV:", err.message);
      reject(err);
    });
});

    const clienteID = "5";
    const hoy = new Date();
    const ano = hoy.getFullYear();
    const mes = hoy.getMonth() + 1;
      
      const filaInicio = 19123;

  //const ano ="2026";
 // const mes ="06";
      
    const res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
    const MesVentaID = res_fec_mes.rows[0].mes_venta_id;

    console.log(ano, mes, MesVentaID);

    const data = await pool.query(querys.obtieneCampanaID(clienteID));

    for (const campana of data.rows) {
      const campanaID = campana.cam_id;
      console.log(`Procesando campaña ID: ${campanaID}...`);

      const updates = [];
      for (let rowIndex = filaInicio; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        if (!row || !Array.isArray(row)) continue;

        const rut = row[1]?.trim();
        const telefono = row[4]?.trim();
        const contrato = row[7]?.toString().trim();
        let estadoRaw = row[11]?.toString().trim();  
        const estado = estadoRaw ? estadoRaw.toUpperCase() : "PENDIENTE";
        
        const rawFechaIngreso = row[0]?.toString().trim().replace(/\u200B/g, "");
        const rawFechaContrato = row[8]?.toString().trim();
        const rawFechaFuga = row[10]?.toString().trim();

        const fecha_ingreso = moment(rawFechaIngreso, [
          "YYYY-MM-DD HH:mm:ss",
          "D/M/YYYY H:mm:ss",
          "DD/MM/YYYY H:mm:ss",
          "M/D/YYYY H:mm:ss",
          "YYYY-M-D H:mm:ss",
          "YYYY/MM/DD H:mm:ss",
          "DD-MM-YYYY HH:mm:ss",
          "DD/MM/YYYY",
        ]).isValid()
          ? moment(rawFechaIngreso, [
              "YYYY-MM-DD HH:mm:ss",
              "D/M/YYYY H:mm:ss",
              "DD/MM/YYYY H:mm:ss",
              "M/D/YYYY H:mm:ss",
              "YYYY-M-D H:mm:ss",
              "YYYY/MM/DD H:mm:ss",
              "DD-MM-YYYY HH:mm:ss",
              "DD/MM/YYYY",
            ]).format("YYYY-MM-DD HH:mm:ss")
          : null;

        if (!fecha_ingreso) {
          console.warn(`⚠️ Fecha inválida en fila ${rowIndex + 1}, RUT: ${rut}`);
          continue;
        }

        const fecha_contrato = rawFechaContrato
          ? moment(rawFechaContrato, ["D/M/YYYY", "DD/MM/YYYY", "M/D/YYYY"]).isValid()
            ? moment(rawFechaContrato, ["D/M/YYYY", "DD/MM/YYYY", "M/D/YYYY"]).format("YYYY-MM-DD")
            : null
          : null;

        const fecha_fuga = rawFechaFuga
          ? moment(rawFechaFuga, ["D/M/YYYY", "DD/MM/YYYY", "M/D/YYYY"]).isValid()
            ? moment(rawFechaFuga, ["D/M/YYYY", "DD/MM/YYYY", "M/D/YYYY"]).format("YYYY-MM-DD")
            : null
          : null;

        console.log("fecha ingreso : ", fecha_ingreso, fecha_contrato, fecha_fuga);

        let beneficiarios = 0;
        const beneficiariosRaw = row[9]?.trim();
        if (beneficiariosRaw) {
          const map = {
            "2.99999999999999": 3,
            "0.799999999999999": 1,
            "0.8": 1,
            "1.6": 2,
            "3.2": 4,
            "4.99999999999999": 5,
            "5.9999999999999": 6,
            "5.99999999999999": 6,
            "6.99999999999999": 7,
          };
          beneficiarios = map[beneficiariosRaw] || parseInt(beneficiariosRaw) || 0;
        }

        if (contrato !== "DUPLICADO") {
          updates.push({
            fecha_ingreso,
            contrato,
            fecha_contrato,
            beneficiarios,
            fecha_fuga,
            estado,
            clienteID,
            campanaID,
            telefono,
            MesVentaID,
            rut,
          });
        }
      }

      // === UPDATE EN BASE ===
      for (const update of updates) {
        try {
          console.log(`Intentando update para RUT ${update.rut} con:`, update);
          const query = `
            UPDATE genesys_backend.cx_venta_ejecutivo
            SET
              ven_eje_respuesta_fecha_ingreso = $1,
              ven_eje_respuesta_contrato = $2,
              ven_eje_respuesta_fecha_contratacion = $3,
              ven_eje_respuesta_beneficiarios = $4,
              ven_eje_respuesta_fecha_fuga = $5,
              ven_eje_respuesta_estado = $6
            WHERE
              ven_eje_cliente_id = $7
              AND ven_eje_campana_id = $8
              AND ven_eje_telefono = TRIM($9)
              AND ven_eje_mes_venta_id = $10
              AND ven_eje_rut_cliente = TRIM($11)
              AND COALESCE(ven_eje_respuesta_estado, '') NOT IN (
              'DUPLICADO','RECHAZA VENTA','CORTA',
              'RECHAZADA POR COMPRA EN CYBER',
              'EXITOSO','TIMEOUT','RECHAZADA POR CALIDAD','RETRACTO'
            )
          `;
          const values = [
            update.fecha_ingreso,
            update.contrato,
            update.fecha_contrato,
            update.beneficiarios,
            update.fecha_fuga,
            update.estado,
            update.clienteID,
            update.campanaID,
            update.telefono,
            update.MesVentaID,
            update.rut,
          ];

          const result = await pool.query(query, values);
          if (result.rowCount > 0) {
              console.log(update.rut, ": ✅ ACTUALIZADO", update.fecha_ingreso);
            } else {
              console.warn(update.rut, ": ⚠️ NO SE ACTUALIZÓ - no encontró coincidencia en el WHERE");
            }
        } catch (error) {
          console.error(`❌ Error al actualizar ${update.rut}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error("❌ Error en leeGoogleSheet:", error.message);
  }
}

(async () => {
  adquirirLockProceso();
  try {
    await leeGoogleSheet();
    console.log("🏁 Proceso finalizado correctamente.");
  } catch (error) {
    console.error("❌ Error en el proceso completo:", error.message);
  } finally {
    liberarLockProceso();
  }
})();
