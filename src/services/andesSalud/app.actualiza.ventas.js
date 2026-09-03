const fs = require("fs");
const path = require("path");
const { pool } = require("../../config/conexion");
const puppeteer = require("puppeteer");
const { convertirFecha } = require("../../helpers/dates");
const querys = require("../../data/querys");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Perfil dedicado (no el default del sistema: Chrome bloquea el debugging
// remoto de Puppeteer sobre el perfil de escritorio por defecto) donde
// quedó logueada la cuenta de Google con acceso al reporte de AndesSalud.
// La sesión se inicia manualmente una vez por VNC; este script solo la
// reutiliza. Mismo patrón que redSalud/alemana (docs2).
const CHROME_PROFILE_DIR = "/home/ubuntu/.config/chrome-profiles/andessalud";
// El perfil lo crea/mantiene el Chrome real de escritorio (v141+), muy por
// delante del Chromium que trae empaquetado el paquete "puppeteer" (v131):
// abrir ese perfil con una versión tan distinta hace crashear Chrome al
// instante ("Target closed"). Hay que usar el mismo binario real.
const CHROME_BIN = "/usr/bin/google-chrome";

const campanaID = 78;

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

// Permite forzar un mes puntual con --ano=YYYY --mes=M (ej. para correr un
// mes ya cerrado a mano); sin esos argumentos usa el mes actual.
function obtenerAnoMes() {
  const argAno = process.argv.find((a) => a.startsWith("--ano="));
  const argMes = process.argv.find((a) => a.startsWith("--mes="));
  const hoy = new Date();
  const ano = argAno ? parseInt(argAno.split("=")[1], 10) : hoy.getFullYear();
  const mes = argMes ? parseInt(argMes.split("=")[1], 10) : hoy.getMonth() + 1;
  return { ano, mes };
}

/**
 * El reporte ahora trae varias tablas ".centerColsContainer" en la misma
 * página (Ventas, Bajas, y una tabla vieja que ya no se usa), cada una con
 * su propio wrapper "div.table" que contiene sus propios encabezados y su
 * propia paginación (pageForward/pageBack/pageLabel). Se identifica la
 * tabla buscando un encabezado distintivo (que solo esa tabla tiene), no
 * por posición/orden, para no depender de que el layout no cambie.
 */
async function encontrarTabla(page, headerDistintivo) {
  const handle = await page.evaluateHandle((headerDistintivo) => {
    const containers = Array.from(document.querySelectorAll(".centerColsContainer"));
    for (const c of containers) {
      const wrapper = c.parentElement && c.parentElement.parentElement;
      if (!wrapper) continue;
      const headers = Array.from(wrapper.querySelectorAll(".headerCell")).map((h) =>
        h.innerText.trim()
      );
      if (headers.some((h) => h.includes(headerDistintivo))) return wrapper;
    }
    return null;
  }, headerDistintivo);

  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    return null;
  }
  return element;
}

/** Lee todas las filas de una tabla específica (su wrapper), paginando dentro de ese wrapper. */
async function leerTablaCompleta(page, wrapperHandle, maxPaginas) {
  const allRows = [];
  let pageCount = 1;

  while (pageCount <= maxPaginas) {
    const capturadas = new Set();
    let intentos = 0;

    await page.evaluate((wrapper) => {
      const cc = wrapper.querySelector(".centerColsContainer");
      if (cc) cc.scrollTop = 0;
    }, wrapperHandle);
    await sleep(1500);

    while (capturadas.size < 100 && intentos < 20) {
      await page.evaluate((wrapper) => {
        const cc = wrapper.querySelector(".centerColsContainer");
        if (cc) cc.scrollTop += 400;
      }, wrapperHandle);
      await sleep(1200);

      const rows = await page.evaluate((wrapper) => {
        return Array.from(wrapper.querySelectorAll(".centerColsContainer .row")).map((row) =>
          Array.from(row.querySelectorAll(".cell-value")).map((cell) => cell.innerText.trim())
        );
      }, wrapperHandle);

      rows.forEach((r) => capturadas.add(JSON.stringify(r)));
      intentos++;
    }

    const registrosPagina = Array.from(capturadas).map(JSON.parse);
    allRows.push(...registrosPagina);
    console.log(`   📄 Página ${pageCount}: ${registrosPagina.length} filas`);

    const hasNext = await page.evaluate((wrapper) => {
      const btn = wrapper.querySelector(".pageForward");
      return !!btn && !btn.classList.contains("disabled");
    }, wrapperHandle);

    if (!hasNext) break;

    const firstCellBefore = registrosPagina?.[0]?.[0] || "";

    await page.evaluate((wrapper) => {
      const btn = wrapper.querySelector(".pageForward");
      if (btn) btn.click();
    }, wrapperHandle);

    let changed = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const firstCellNow = await page.evaluate((wrapper) => {
        const td = wrapper.querySelector(".centerColsContainer .row .cell-value");
        return td ? td.innerText.trim() : "";
      }, wrapperHandle);
      if (firstCellNow && firstCellNow !== firstCellBefore) {
        changed = true;
        break;
      }
    }
    if (!changed) break;

    pageCount++;
  }

  return allRows;
}

/**
 * Aplica el UPDATE de estado/fecha (Query1), el refresco incondicional de
 * beneficiarios (Query2) y el chequeo de "rut no encontrado", igual que
 * davila. Si `forzar` es true (caso Bajas => RETRACTO), el UPDATE de estado
 * no respeta la protección de "no pisar estados finales" — a pedido
 * explícito, para que RETRACTO se aplique aunque la venta ya esté EXITOSO.
 */
async function actualizaRegistro({ certificado, rut, fecha_contrato, beneficiarios, estado, MesVentaID, forzar }) {
  const query1 = forzar
    ? `
      UPDATE genesys_backend.cx_venta_ejecutivo
      SET
        ven_eje_respuesta_fecha_contratacion = $1,
        ven_eje_respuesta_beneficiarios = $2,
        ven_eje_respuesta_estado = $3
      WHERE
        ven_eje_campana_id = ${campanaID} AND
        ven_eje_mes_venta_id = $4 AND
        ven_eje_rut_cliente = $5;
    `
    : `
      UPDATE genesys_backend.cx_venta_ejecutivo
      SET
        ven_eje_respuesta_fecha_contratacion = $1,
        ven_eje_respuesta_beneficiarios = $2,
        ven_eje_respuesta_estado = $3
      WHERE
        ven_eje_campana_id = ${campanaID} AND
        ven_eje_mes_venta_id = $4 AND
        ven_eje_rut_cliente = $5 AND
        ven_eje_respuesta_estado NOT IN
        ('DUPLICADO','RECHAZA VENTA','CORTA',
         'RECHAZADA POR COMPRA EN CYBER','EXITOSO',
         'TIMEOUT','RECHAZADA POR CALIDAD');
    `;

  try {
    const result1 = await pool.query(query1, [fecha_contrato, beneficiarios, estado, MesVentaID, rut]);
    console.log(
      `✅ Certificado ${certificado} Rut ${rut} → ${estado} (fecha=${fecha_contrato}, benef=${beneficiarios}): actualizados ${result1.rowCount}`
    );
  } catch (error) {
    console.error(`❌ Error actualizando certificado ${certificado} rut ${rut}:`, error.message);
    return;
  }

  try {
    const query2 = `
      UPDATE genesys_backend.cx_venta_ejecutivo
      SET ven_eje_respuesta_beneficiarios = $1
      WHERE
        ven_eje_campana_id = ${campanaID} AND
        ven_eje_mes_venta_id = $2 AND
        ven_eje_rut_cliente = $3;
    `;
    await pool.query(query2, [beneficiarios, MesVentaID, rut]);
  } catch (error) {
    console.error(`❌ Error Query2 (beneficiarios) rut ${rut}:`, error.message);
  }

  try {
    const existeResult = await pool.query(
      `SELECT 1 FROM genesys_backend.cx_venta_ejecutivo
       WHERE ven_eje_campana_id = ${campanaID}
         AND SPLIT_PART(ven_eje_rut_cliente, '-', 1) = SPLIT_PART($1, '-', 1)
       LIMIT 1;`,
      [rut]
    );
    if (existeResult.rowCount === 0) {
      console.warn(`❗ Rut no encontrado: ${rut}`);
    }
  } catch {}
}

const capturaLooker = async () => {
  let browser;
  try {
    const { ano, mes } = obtenerAnoMes();

    const res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
    const MesVentaID = res_fec_mes.rows[0].mes_venta_id;

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

    // URL de página actualizada: el slug viejo (p_pvr8ol3t5d) quedó
    // invalidado cuando se reestructuró el reporte en dos tablas.
    const lookerURL =
      "https://datastudio.google.com/reporting/745213f7-e6f9-498c-b6fa-f053a047f18a/page/p_a1crcxg36d";
    await page.goto(lookerURL, { waitUntil: "networkidle2", timeout: 120000 });
    await page.waitForSelector(".centerColsContainer");
    await sleep(2000);

    // Se lee TODO el contenido de ambas tablas primero (solo interacción con
    // la página, rápido) y recién después se hacen los UPDATEs a la BD
    // (lento: 3 queries secuenciales por certificado). Si se entrelazan
    // lectura del DOM y escritura a la BD en el mismo tramo largo, Looker
    // Studio puede refrescarse solo de fondo y dejar el frame de Puppeteer
    // "detached" a mitad de camino.
    console.log("🔍 Buscando tabla de Ventas...");
    const wrapperVentas = await encontrarTabla(page, "Correo titular");
    const filasVentas = wrapperVentas ? await leerTablaCompleta(page, wrapperVentas, 20) : [];
    if (!wrapperVentas) {
      console.warn("⚠️ No se encontró la tabla de Ventas (encabezado 'Correo titular').");
    } else {
      console.log(`✅ Ventas: ${filasVentas.length} filas capturadas en total`);
    }

    console.log("🔍 Buscando tabla de Bajas...");
    const wrapperBajas = await encontrarTabla(page, "Motivo baja");
    const filasBajas = wrapperBajas ? await leerTablaCompleta(page, wrapperBajas, 20) : [];
    if (!wrapperBajas) {
      console.warn("⚠️ No se encontró la tabla de Bajas (encabezado 'Motivo baja').");
    } else {
      console.log(`✅ Bajas: ${filasBajas.length} filas capturadas en total`);
    }

    // Ya no se necesita la página/el navegador: se cierra antes de la parte
    // lenta (los UPDATEs) para no dejarlo esperando innecesariamente.
    try {
      await browser.close();
    } catch {}
    browser = null;

    // === VENTAS => EXITOSO ===
    // La tabla Ventas trae una fila por cada "Rut Asegurado" (persona
    // cubierta), no una fila por certificado: un mismo Certificado puede
    // repetirse con distinto Rut Asegurado. Beneficiarios = cantidad de
    // filas que comparten el mismo Certificado. Ventas es un histórico
    // acumulado (no "solo lo activo") — un certificado que después aparece
    // en Bajas también sigue apareciendo acá.
    const porCertificado = new Map();
    for (const row of filasVentas) {
      if (row.length < 13) continue;
      const certificado = row[0];
      const rut = row[1];
      const fechaCompraRaw = row[8];
      if (!porCertificado.has(certificado)) {
        porCertificado.set(certificado, { rut, fechaCompraRaw, count: 0 });
      }
      porCertificado.get(certificado).count++;
    }

    for (const [certificado, info] of porCertificado) {
      let fecha_contrato;
      try {
        fecha_contrato = await convertirFecha(info.fechaCompraRaw);
      } catch (error) {
        console.warn(`⚠️ Certificado ${certificado}: fecha inválida "${info.fechaCompraRaw}" (${error.message})`);
        continue;
      }

      await actualizaRegistro({
        certificado,
        rut: info.rut,
        fecha_contrato,
        beneficiarios: info.count,
        estado: "EXITOSO",
        MesVentaID,
        forzar: false,
      });
    }

    // === BAJAS => RETRACTO (forzado, sin importar el estado actual) ===
    // Se procesa DESPUÉS de Ventas a propósito: si un certificado aparece en
    // ambas listas (vendido y luego dado de baja), Bajas debe ganar.
    for (const row of filasBajas) {
      if (row.length < 12) continue;

      const certificado = row[0];
      const rut = row[1];
      const fechaSuscripcionRaw = row[6];
      const beneficiarios = parseInt(row[11]) || 0;

      let fecha_contrato;
      try {
        fecha_contrato = await convertirFecha(fechaSuscripcionRaw);
      } catch (error) {
        console.warn(`⚠️ Certificado ${certificado}: fecha inválida "${fechaSuscripcionRaw}" (${error.message})`);
        continue;
      }

      await actualizaRegistro({
        certificado,
        rut,
        fecha_contrato,
        beneficiarios,
        estado: "RETRACTO",
        MesVentaID,
        forzar: true,
      });
    }

    const ajusteQuery = `
      UPDATE genesys_backend.cx_venta_ejecutivo
      SET ven_eje_venta_adicional = GREATEST(
        ven_eje_respuesta_beneficiarios - ven_eje_venta_titular, 0
      )
      WHERE ven_eje_campana_id = ${campanaID} AND
            ven_eje_mes_venta_id = $1 AND
            ven_eje_respuesta_beneficiarios > 0;
    `;
    await pool.query(ajusteQuery, [MesVentaID]);
    console.log("✅ Ajuste final aplicado a ven_eje_venta_adicional");
  } catch (error) {
    console.error("❌ Error en la ejecución del script:", error.message);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    try {
      await pool.end();
    } catch {}
  }
};

capturaLooker();
