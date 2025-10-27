const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const csvParser = require("csv-parser");
const moment = require("moment");
const { pool } = require("../../config/conexion");
const querys = require("../../data/querys");

require("dotenv").config({ path: require("find-config")("../../.env") });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const googleCredentials = {
  email: process.env.GOOGLE_EMAIL,
  password: process.env.GOOGLE_PASSWORD,
};

async function downloadGoogleSheetAsCSV() {
  const sheetUrl = "https://docs.google.com/spreadsheets/d/1FvlZU1AUJoKrdLrtNaxo9nGBZvTAhligVbaEhDrp7XU/edit#gid=1765604646";
  const downloadPath = path.resolve(__dirname, "./downloads");
  if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);

  fs.readdirSync(downloadPath).forEach(file => {
    if (file.endsWith(".csv")) fs.unlinkSync(path.join(downloadPath, file));
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.goto("https://accounts.google.com/signin/v2/identifier", { waitUntil: "networkidle2" });

    await page.waitForSelector("input[type='email']", { visible: true });
    await page.type("input[type='email']", googleCredentials.email, { delay: 80 });
    await page.click("#identifierNext");

    await page.waitForNavigation({ waitUntil: "networkidle2" });
    await page.type("input[type='password']", googleCredentials.password, { delay: 80 });
    await page.click("#passwordNext");

    await page.waitForNavigation({ waitUntil: "networkidle2" });
    await sleep(3000);

    await page.goto(sheetUrl, { waitUntil: "networkidle2" });
    await sleep(3000);

    const cdpSession = await page.target().createCDPSession();
    await cdpSession.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadPath,
    });

    const exportUrl = sheetUrl.split("/edit")[0] + "/export?format=csv";

    try {
      await page.goto(exportUrl, { waitUntil: "networkidle2" });
    } catch (err) {
      if (!err.message.includes("net::ERR_ABORTED")) throw err;
    }

    await sleep(5000);

    const downloadedFiles = fs.readdirSync(downloadPath)
      .filter(f => f.endsWith(".csv"))
      .map(f => path.join(downloadPath, f));

    if (downloadedFiles.length === 0) throw new Error("No se descargó ningún CSV");
    return downloadedFiles[0];
  } finally {
    await browser.close();
  }
}

async function actualizaSoloFechaIngreso() {
  console.clear();
  console.log("Iniciando descarga y actualización de fecha_ingreso...");

  const csvPath = await downloadGoogleSheetAsCSV();
  console.log("CSV descargado:", csvPath);

  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(csvParser({ headers: false }))
      .on("data", (row) => {
        const rowArray = Object.values(row);
        const maxColumns = 13;
        rows.push([...rowArray, ...Array(maxColumns - rowArray.length).fill(null)]);
      })
      .on("end", resolve)
      .on("error", reject);
  });

  const clienteID = "5";
  const hoy = new Date();
  const ano = hoy.getFullYear();
  const mes = hoy.getMonth() + 1;

  const res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
  const MesVentaID = res_fec_mes.rows[0].mes_venta_id;

  const data = await pool.query(querys.obtieneCampanaID(clienteID));

  for (const campana of data.rows) {
    const campanaID = campana.cam_id;
    console.log(`Procesando campaña ID: ${campanaID}...`);

    for (let rowIndex = 7214; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const rawFechaIngreso = row[0]?.toString().trim();
      const rut = row[1]?.trim();
      const telefono = row[4]?.trim();

      if (!rut || !telefono || !rawFechaIngreso) continue;

      const fecha_ingreso = moment(rawFechaIngreso, [
        "YYYY-MM-DD HH:mm:ss",
        "D/M/YYYY H:mm:ss",
        "DD/MM/YYYY H:mm:ss",
        "M/D/YYYY H:mm:ss",
        "YYYY-M-D H:mm:ss",
        "YYYY/MM/DD H:mm:ss",
        "DD-MM-YYYY HH:mm:ss",
        "DD/MM/YYYY"
      ]).isValid()
        ? moment(rawFechaIngreso, [
            "YYYY-MM-DD HH:mm:ss",
            "D/M/YYYY H:mm:ss",
            "DD/MM/YYYY H:mm:ss",
            "M/D/YYYY H:mm:ss",
            "YYYY-M-D H:mm:ss",
            "YYYY/MM/DD H:mm:ss",
            "DD-MM-YYYY HH:mm:ss",
            "DD/MM/YYYY"
          ]).format("YYYY-MM-DD HH:mm:ss")
        : null;

      if (!fecha_ingreso) {
        console.warn(`⚠️ Fecha inválida en fila ${rowIndex + 1}, RUT: ${rut}`);
        continue;
      }

      try {
        const updateQuery = `
          UPDATE genesys_backend.cx_venta_ejecutivo
          SET ven_eje_respuesta_fecha_ingreso = $1
          WHERE ven_eje_cliente_id = $2
            AND ven_eje_campana_id = $3
            AND ven_eje_telefono = TRIM($4)
            AND ven_eje_mes_venta_id = $5
            AND ven_eje_rut_cliente = TRIM($6)
        `;
        const values = [
          fecha_ingreso,
          clienteID,
          campanaID,
          telefono,
          MesVentaID,
          rut
        ];

        const result = await pool.query(updateQuery, values);
        if (result.rowCount > 0) {
          console.log(`✅ ${rut} actualizado con fecha: ${fecha_ingreso}`);
        }
      } catch (err) {
        console.error(`❌ Error actualizando RUT ${rut}:`, err.message);
      }
    }
  }

  pool.end();
  console.log("🏁 Proceso finalizado.");
}

actualizaSoloFechaIngreso();
