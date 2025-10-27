const { pool } = require("../../config/conexion");
const puppeteer = require("puppeteer");
const { convertirFecha } = require("../../helpers/dates");
const querys = require("../../data/querys");


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const capturaLooker = async () => {
  try {

    const hoy = new Date();
    //const ano = hoy.getFullYear(); // Obtiene el año actual
    //const mes = hoy.getMonth() + 1; // 
    

    const ano = "2025";
    const mes = "07";
    const campanaId = "41";

    let res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
    let MesVentaID = res_fec_mes.rows[0].mes_venta_id;

    // LINUX SERVER 
    const browser = await puppeteer.launch({
      headless: "new", // O usa true si no funciona
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // MAC OSX
    //const browser = await puppeteer.launch({ headless: true, defaultViewport: null });
    
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    );

    const lookerURL = "https://lookerstudio.google.com/u/0/reporting/3a97ace1-9981-4e08-a99b-7e439a960812/page/p_dlhle9rhsd";
    await page.goto(lookerURL, {
      waitUntil: 'networkidle2',
      timeout: 120000
    });

    await page.screenshot({ path: 'debug_before.png', fullPage: true });

    await page.waitForSelector(".centerColsContainer");

    let allRows = [];
    let pageCount = 1;
    let totalRecords = 0;
    let recordsPerPage = 100; // 🔹 Se espera que haya 100 registros por página

    // 🔹 Detectar total de registros en la paginación
    totalRecords = await page.evaluate(() => {
      const paginationText = document.querySelector(".pageLabel")?.innerText;
      const match = paginationText ? paginationText.match(/\d+\s*-\s*\d+\s*\/\s*(\d+)/) : null;
      return match ? parseInt(match[1]) : 0;
    });

    console.log(`🔍 Total de registros detectados: ${totalRecords}`);
    console.log(`🔹 Detectado: ${recordsPerPage} registros por página.`);

    while (true) {
      let registrosCapturados = new Set();
      let intentos = 0;

      console.log(`📄 Capturando datos de la Página ${pageCount}...`);

      // 🔹 Reiniciar scroll arriba antes de capturar registros
      await page.evaluate(() => {
        document.querySelector(".centerColsContainer").scrollTop = 0;
      });
      await sleep(2000); // 🔹 Esperamos a que se acomode la página

      while (registrosCapturados.size < recordsPerPage && intentos < 20) {
        // 🔹 Scroll lento hasta el final para forzar carga de más registros
        await page.evaluate(() => {
          const container = document.querySelector(".centerColsContainer");
          if (container) container.scrollTop += 400;
        });

        await sleep(1500); // 🔹 Esperamos para que los nuevos registros carguen

        const rows = await page.evaluate(() => {
          return Array.from(document.querySelectorAll(".centerColsContainer .row")).map(row => {
            return Array.from(row.querySelectorAll(".cell-value")).map(cell => cell.innerText.trim());
          });
        });

        rows.forEach(row => registrosCapturados.add(JSON.stringify(row))); // 🔹 Guardamos sin duplicados

        console.log(`🔄 Intento ${intentos + 1}: Detectados ${registrosCapturados.size} registros.`);
        intentos++;
      }

      // Convertimos el Set a Array de nuevo
      const registrosPagina = Array.from(registrosCapturados).map(JSON.parse);
      allRows.push(...registrosPagina);
      console.log(`✅ Página ${pageCount} - Registros capturados: ${registrosPagina.length}`);

      // 🔹 Procesar cada fila capturada
      for (const [index, row] of registrosPagina.entries()) {
        try {
          if (row.length < 8) {
            console.warn(`⚠️ Fila ${index} no contiene suficientes columnas, se omitirá.`);
            continue;
          }

          // 🔹 Asignar columnas a variables
          let id = row[0];
          let certificado = row[1];
          let rut = row[2];
          let fecha_contrato = await convertirFecha(row[3]);
          let plan = row[4];
          let estado = row[6];
          let precio = parseFloat(row[5].replace(/[^0-9.-]+/g, ""));
          
          
          let beneficiarios = parseInt(row[7]) || 0;

          if (estado === "Activo") {
            estado = "EXITOSO";
          }

          // 🔹 Imprimir cada fila capturada
          console.log(
            `📌 Fila ${index}: ID: ${id}, Certificado: ${certificado}, Rut: ${rut}, Fecha: ${row[3]} --- ${fecha_contrato}, Plan: ${plan}, Precio: ${precio}, Estado: ${estado}, Beneficiarios: ${beneficiarios}`
          );

          // // 🔹 Ejecutar consulta UPDATE
          const query = `
            UPDATE 
                genesys_backend.cx_venta_ejecutivo
            SET 
                ven_eje_respuesta_fecha_contratacion = $1,
                ven_eje_respuesta_beneficiarios = $2,
                ven_eje_respuesta_estado = $3
            WHERE
                ven_eje_campana_id = $4 AND 
                ven_eje_mes_venta_id = $5 AND 
                SPLIT_PART(ven_eje_rut_cliente, '-', 1) = SPLIT_PART($6, '-', 1) AND
                ven_eje_respuesta_estado NOT IN 
                ('DUPLICADO', 'RECHAZA VENTA', 'CORTA', 'RECHAZADA POR COMPRA EN CYBER', 'EXITOSO', 'TIMEOUT', 'RECHAZADA POR CALIDAD')`;

          const values = [fecha_contrato, beneficiarios, estado, campanaId, MesVentaID, rut];

          const result = await pool.query(query, values);
          console.log(`✅ Registro actualizado en la base de datos - ID: ${id}, Resultados: ${result.rowCount}`);
        } catch (error) {
          console.error(`❌ Error procesando fila ${index}: ${error.message}`);
        }
      }

      // 🔹 Verificar si alcanzamos el total de registros
      if (allRows.length >= totalRecords) {
        console.log("✅ Se alcanzó el total de registros.");
        break;
      }

      // 🔹 Buscar el botón "Siguiente"
      const hasNextPage = await page.evaluate(() => {
        const nextButton = document.querySelector(".pageForward");
        return nextButton && !nextButton.classList.contains("disabled");
      });

      if (hasNextPage) {
        console.log("➡️ Pasando a la siguiente página...");
        await page.evaluate(() => {
          const nextButton = document.querySelector(".pageForward");
          if (nextButton) nextButton.click();
        });
        await sleep(7000);
        pageCount++;
      } else {
        console.log("🚫 No se detectó botón de 'Siguiente' o está deshabilitado, terminando.");
        break;
      }
    }

    console.log(`✅ Total de registros capturados: ${allRows.length}`);
    await browser.close();
    pool.end();
  } catch (error) {
    console.error("❌ Error en la ejecución del script:", error.message);
  }
};

capturaLooker();
