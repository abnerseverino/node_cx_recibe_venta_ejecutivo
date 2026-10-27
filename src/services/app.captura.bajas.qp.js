#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { pool } = require("../config/conexion");
const puppeteer = require("puppeteer");
const { convertirFecha } = require("../helpers/dates");
const { esPantallaLoginGoogle, notificaSesionVencida, marcaSesionOk } = require("../helpers/alertaSesionGoogle");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =========================
// CONFIG
// =========================
// Reporte 745213f7 (el mismo de davila/andesSalud), página de bajas. Sin
// "/u/N": en el servidor el perfil solo tiene su propia cuenta.
const LOOKER_URL =
  "https://datastudio.google.com/reporting/745213f7-e6f9-498c-b6fa-f053a047f18a/page/p_vsizma8fud";

// --dry-run: lee y muestra los encabezados y las filas, pero no escribe en la BD.
const DRY_RUN = process.argv.includes("--dry-run");

// Mismo perfil de Chrome autenticado (y mismo binario real) que usan
// davila y andesSalud: la sesión de Google se inicia a mano una vez por VNC y
// este script solo la reutiliza. Como comparten perfil, el cron debe
// lanzarse con run_lock.sh y la clave de lock "chrome_profile_andessalud".
const CHROME_PROFILE_DIR = "/home/ubuntu/.config/chrome-profiles/andessalud";
const CHROME_BIN = "/usr/bin/google-chrome";

const INFORMADOR = "QUEPLAN";
const REQUIRED_COLUMNS = 10;

// El reporte viene ordenado por Fecha Baja de la más nueva a la más antigua
// (100 filas por página), así que las primeras páginas traen las bajas
// recientes. Por defecto se leen solo las primeras 3 (~300 filas, varias
// semanas): la carga es idempotente (no duplica) y evita recorrer todo el
// historial en cada corrida. `--endPage=all` recorre todo el reporte.
const DEFAULT_MAX_PAGES = 3;

const SELECTORS = {
  container: ".centerColsContainer",
  row: ".centerColsContainer .row",
  cell: ".cell-value",
  next: ".pageForward",
  back: ".pageBack",
};

function getCliArg(name) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1] : null;
}

function parsePositiveInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function normalizarTexto(value) {
  return String(value ?? "").trim();
}

function normalizarRut(value) {
  return String(value ?? "").trim().toUpperCase();
}

function parseBeneficiarios(value) {
  const limpio = String(value ?? "")
    .replace(/[^\d-]/g, "")
    .trim();

  const n = parseInt(limpio, 10);
  return Number.isNaN(n) ? 0 : n;
}

function buildRowKey(row) {
  return JSON.stringify(row.map((v) => String(v ?? "").trim()));
}

function buildBusinessKey({
  certificado,
  rut,
  fecha_baja,
  codigo_producto,
  organizacion,
}) {
  return [
    String(certificado ?? "").trim(),
    String(rut ?? "").trim().toUpperCase(),
    String(fecha_baja ?? "").trim(),
    String(codigo_producto ?? "").trim(),
    String(organizacion ?? "").trim(),
  ].join("|");
}

// Limpia locks stale que impiden lanzar Chrome si una corrida anterior
// (o una sesión de escritorio) murió sin cerrar limpiamente.
function limpiarLockPerfilChrome(profileDir) {
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const p = path.join(profileDir, f);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }
}

async function clickIfEnabled(page, selector) {
  return page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    if (!btn) return false;
    if (btn.classList.contains("disabled")) return false;
    btn.click();
    return true;
  }, selector);
}

async function resetScrollTop(page) {
  await page.evaluate((selector) => {
    const container = document.querySelector(selector);
    if (container) container.scrollTop = 0;
  }, SELECTORS.container);
}

async function getScrollState(page) {
  return page.evaluate((selector) => {
    const container = document.querySelector(selector);
    if (!container) {
      return {
        exists: false,
        scrollTop: 0,
        clientHeight: 0,
        scrollHeight: 0,
        atBottom: true,
      };
    }

    const scrollTop = container.scrollTop || 0;
    const clientHeight = container.clientHeight || 0;
    const scrollHeight = container.scrollHeight || 0;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 5;

    return {
      exists: true,
      scrollTop,
      clientHeight,
      scrollHeight,
      atBottom,
    };
  }, SELECTORS.container);
}

async function scrollDown(page, amount = 500) {
  await page.evaluate(
    ({ selector, amount }) => {
      const container = document.querySelector(selector);
      if (container) container.scrollTop += amount;
    },
    { selector: SELECTORS.container, amount }
  );
}

async function extractVisibleRows(page) {
  return page.evaluate(
    ({ rowSelector, cellSelector }) => {
      return Array.from(document.querySelectorAll(rowSelector)).map((row) =>
        Array.from(row.querySelectorAll(cellSelector)).map((cell) =>
          (cell.innerText || "").trim()
        )
      );
    },
    { rowSelector: SELECTORS.row, cellSelector: SELECTORS.cell }
  );
}

async function waitForTable(page) {
  await page.waitForSelector(SELECTORS.container, { timeout: 120000 });
  await sleep(2500);
}

async function goToPage(page, targetPage) {
  if (targetPage <= 1) return;

  for (let i = 1; i < targetPage; i++) {
    const moved = await clickIfEnabled(page, SELECTORS.next);
    if (!moved) break;
    await sleep(2500);
  }
}

async function captureAllRowsFromCurrentPage(page) {
  const seen = new Set();
  let stagnantRounds = 0;
  let attempts = 0;
  let lastSize = 0;

  await resetScrollTop(page);
  await sleep(1500);

  while (attempts < 60) {
    const rows = await extractVisibleRows(page);

    for (const row of rows) {
      if (Array.isArray(row) && row.length > 0) {
        seen.add(buildRowKey(row));
      }
    }

    const currentSize = seen.size;
    const stateBefore = await getScrollState(page);

    if (currentSize === lastSize) {
      stagnantRounds++;
    } else {
      stagnantRounds = 0;
    }

    lastSize = currentSize;

    if (stateBefore.atBottom && stagnantRounds >= 3) {
      break;
    }

    await scrollDown(page, 500);
    await sleep(1200);

    const stateAfter = await getScrollState(page);

    if (
      stateBefore.scrollTop === stateAfter.scrollTop &&
      stateAfter.atBottom &&
      stagnantRounds >= 2
    ) {
      break;
    }

    attempts++;
  }

  return Array.from(seen).map((r) => JSON.parse(r));
}

async function existeBaja({
  certificado,
  rut,
  fecha_baja,
  codigo_producto,
  organizacion,
}) {
  const query = `
    SELECT 1
    FROM genesys_backend.cx_venta_ejecutivo_baja b
    WHERE b.ven_eje_baj_certificado = $1
      AND b.ven_eje_baj_rut = $2
      AND b.ven_eje_baj_fecha_baja = $3
      AND b.ven_eje_baj_codigo_producto = $4
      AND b.ven_eje_baj_organizacion = $5
    LIMIT 1
  `;

  return pool.query(query, [
    certificado,
    rut,
    fecha_baja,
    codigo_producto,
    organizacion,
  ]);
}

async function insertarBaja({
  certificado,
  rut,
  fecha_contrato,
  fecha_baja,
  plan,
  codigo_producto,
  canal,
  organizacion,
  beneficiarios,
  informador,
}) {
  const query = `
    INSERT INTO genesys_backend.cx_venta_ejecutivo_baja (
      ven_eje_baj_certificado,
      ven_eje_baj_rut,
      ven_eje_baj_fecha_contratacion,
      ven_eje_baj_fecha_baja,
      ven_eje_baj_plan,
      ven_eje_baj_codigo_producto,
      ven_eje_baj_canal,
      ven_eje_baj_organizacion,
      ven_eje_baj_beneficiarios,
      ven_eje_baj_informador
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `;

  return pool.query(query, [
    certificado,
    rut,
    fecha_contrato,
    fecha_baja,
    plan,
    codigo_producto,
    canal,
    organizacion,
    beneficiarios,
    informador,
  ]);
}

const capturaLooker = async () => {
  const startTime = new Date();
  console.log(`⏱️ Proceso iniciado: ${startTime.toLocaleString("es-CL")}\n`);

  let browser;

  try {
    const startPage = parsePositiveInt(getCliArg("startPage"), 1);
    const endPageArg = getCliArg("endPage");
    const endPage =
      endPageArg === "all"
        ? Infinity
        : Math.max(
            parsePositiveInt(endPageArg, startPage + DEFAULT_MAX_PAGES - 1),
            startPage
          );

    limpiarLockPerfilChrome(CHROME_PROFILE_DIR);

    browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
      executablePath: CHROME_BIN,
      userDataDir: CHROME_PROFILE_DIR,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    );

    await page.goto(LOOKER_URL, {
      waitUntil: "networkidle2",
      timeout: 120000,
    });

    if (esPantallaLoginGoogle(page.url())) {
      await notificaSesionVencida({ script: "captura bajas QP", urlFinal: page.url() });
      throw new Error("Sesión de Google vencida: la página redirigió a " + page.url());
    }

    try {
      await page.waitForSelector(SELECTORS.container, { timeout: 120000 });
    } catch (e) {
      // La sesión puede estar bien y aun así la cuenta no tener permiso sobre
      // este reporte puntual: Looker muestra un aviso en vez de la tabla.
      const textoPagina = await page
        .evaluate(() => document.body?.innerText || "")
        .catch(() => "");
      if (/no puede acceder|no tienes acceso|solicitar acceso|you need access|request access|can't access/i.test(textoPagina)) {
        throw new Error(
          "La cuenta de Google del perfil no tiene acceso al reporte de bajas (Looker): pedir a Queplan que lo comparta con esa cuenta."
        );
      }
      throw e;
    }

    marcaSesionOk();
    await sleep(2500);

    // Se loguea el layout real para detectar a tiempo si Looker reordena columnas.
    const layout = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".centerColsContainer")).map((c) => {
        const w = c.parentElement && c.parentElement.parentElement;
        return Array.from((w || document).querySelectorAll(".headerCell")).map((h) =>
          h.innerText.trim()
        );
      })
    );
    console.log(`🧩 Tablas en la página: ${layout.length}`);
    layout.forEach((h, i) => console.log(`   Tabla ${i + 1} encabezados: ${JSON.stringify(h)}`));
    if (DRY_RUN) console.log("🧪 MODO DRY-RUN: no se escribe en la BD");

    console.log(
      `📌 Rango a procesar: página ${startPage} a ${endPage === Infinity ? "la última" : endPage}`
    );

    await goToPage(page, startPage);

    let insertedCount = 0;
    let skippedDuplicatesInRun = 0;
    let skippedDuplicatesInDb = 0;
    let skippedInvalidRows = 0;
    let skippedConversionRows = 0;
    let pageCounter = startPage;

    const globalBusinessKeys = new Set();

    while (pageCounter <= endPage) {
      console.log(`\n📄 Página ${pageCounter}`);

      const registros = await captureAllRowsFromCurrentPage(page);
      console.log(`✅ Capturadas ${registros.length} filas únicas en página`);

      const fechasBajaPagina = [];

      for (const [idx, row] of registros.entries()) {
        if (!Array.isArray(row) || row.length < REQUIRED_COLUMNS) {
          skippedInvalidRows++;
          console.warn(
            `⚠️ Fila ${idx} ignorada: se esperaban al menos ${REQUIRED_COLUMNS} columnas y llegaron ${row?.length || 0}`
          );
          continue;
        }

        const [
          _id,
          certificadoRaw,
          rutRaw,
          fechaContrRaw,
          fechaBajaRaw,
          planRaw,
          codigoProductoRaw,
          canalRaw,
          organizacionRaw,
          beneficiariosRaw = "0",
        ] = row;

        const certificado = normalizarTexto(certificadoRaw);
        const rut = normalizarRut(rutRaw);
        const plan = normalizarTexto(planRaw);
        const codigo_producto = normalizarTexto(codigoProductoRaw);
        const canal = normalizarTexto(canalRaw);
        const organizacion = normalizarTexto(organizacionRaw);
        const beneficiarios = parseBeneficiarios(beneficiariosRaw);

        if (!certificado || !rut || !fechaContrRaw || !fechaBajaRaw || !organizacion) {
          skippedInvalidRows++;
          console.warn(
            `⚠️ Fila ${idx} omitida: faltan campos obligatorios`
          );
          continue;
        }

        let fecha_contrato;
        let fecha_baja;

        try {
          fecha_contrato = await convertirFecha(fechaContrRaw);
          fecha_baja = await convertirFecha(fechaBajaRaw);
        } catch (e) {
          skippedConversionRows++;
          console.warn(
            `⚠️ Fila ${idx} omitida: error convirtiendo fecha - ${e.message}`
          );
          continue;
        }

        fechasBajaPagina.push(fecha_baja);

        const businessKey = buildBusinessKey({
          certificado,
          rut,
          fecha_baja,
          codigo_producto,
          organizacion,
        });

        if (globalBusinessKeys.has(businessKey)) {
          skippedDuplicatesInRun++;
          continue;
        }

        globalBusinessKeys.add(businessKey);

        try {
          if (DRY_RUN) {
            console.log(`🧪 Fila ${idx}: ${JSON.stringify([certificado, rut, fecha_contrato, fecha_baja, plan, codigo_producto, canal, organizacion, beneficiarios])}`);
            continue;
          }

          const dup = await existeBaja({
            certificado,
            rut,
            fecha_baja,
            codigo_producto,
            organizacion,
          });

          if (dup.rowCount > 0) {
            skippedDuplicatesInDb++;
            continue;
          }

          const res = await insertarBaja({
            certificado,
            rut,
            fecha_contrato,
            fecha_baja,
            plan,
            codigo_producto,
            canal,
            organizacion,
            beneficiarios,
            informador: INFORMADOR,
          });

          if (res.rowCount > 0) {
            insertedCount += res.rowCount;
            console.log(
              `✅ Fila ${idx} insertada | RUT=${rut} | Org=${organizacion} | Cert=${certificado}`
            );
          }
        } catch (e) {
          console.error(`❌ Error insertando fila ${idx}: ${e.message}`);
        }
      }

      // Si el orden cambiara (más antigua primero), las primeras páginas ya no
      // serían las bajas recientes y habría que revisar el reporte.
      if (
        fechasBajaPagina.length > 1 &&
        fechasBajaPagina[0] < fechasBajaPagina[fechasBajaPagina.length - 1]
      ) {
        console.warn(
          `⚠️ Página ${pageCounter}: las fechas de baja suben (${fechasBajaPagina[0]} → ${fechasBajaPagina[fechasBajaPagina.length - 1]}); el reporte ya no parece ordenado de la más nueva a la más antigua.`
        );
      }

      if (pageCounter < endPage) {
        const moved = await clickIfEnabled(page, SELECTORS.next);
        if (!moved) {
          if (endPage === Infinity) {
            console.log(`ℹ️ Página ${pageCounter} es la última del reporte.`);
          } else {
            console.warn(
              `⚠️ No fue posible avanzar desde la página ${pageCounter}. Se detiene el proceso.`
            );
          }
          break;
        }
        await sleep(3000);
      }

      pageCounter++;
    }

    console.log("\n🏁 Resumen final");
    console.log(`✅ Total filas insertadas: ${insertedCount}`);
    console.log(`⚠️ Filas inválidas omitidas: ${skippedInvalidRows}`);
    console.log(`⚠️ Filas omitidas por fecha inválida: ${skippedConversionRows}`);
    console.log(`⚠️ Duplicados omitidos en memoria: ${skippedDuplicatesInRun}`);
    console.log(`⚠️ Duplicados ya existentes en BD: ${skippedDuplicatesInDb}`);
  } catch (e) {
    console.error("❌ Error general:", e.message);
    // Sin esto el wrapper run_lock.sh reportaba "DONE OK" aunque no se
    // hubiera capturado nada.
    process.exitCode = 1;
  } finally {
    try {
      if (browser) await browser.close();
    } catch (e) {
      console.error("❌ Error cerrando browser:", e.message);
    }

    try {
      await pool.end();
    } catch (e) {
      console.error("❌ Error cerrando pool:", e.message);
    }

    const endTime = new Date();
    console.log(`⏱️ Proceso terminado: ${endTime.toLocaleString("es-CL")}`);
  }
};

capturaLooker();