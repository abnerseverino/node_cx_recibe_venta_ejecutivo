
const {pool} = require("../../config/conexion");
const puppeteer = require('puppeteer');


const { convertirFecha } = require("../../helpers/dates");
const querys = require("../../data/querys");


const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const capturaLooker= async () => {
    try{

        const hoy = new Date();

        const ano = hoy.getFullYear(); // Obtiene el año actual
        const mes = hoy.getMonth() + 1; // 
            
        //  Parametros de previos a la ejecucion 
        const campanaId         = "30";
    
        
        let res_fec_mes       = await pool.query(querys.obtieneMesID(ano,mes));
        let MesVentaID        = res_fec_mes.rows[0].mes_venta_id;

        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();

        // URL del reporte
        const lookerURL = 'https://lookerstudio.google.com/u/0/reporting/3a97ace1-9981-4e08-a99b-7e439a960812/page/p_ubm14sy9md';
        await page.goto(lookerURL, { waitUntil: 'networkidle2' });

        // Esperar a que cargue el contenedor principal
        await page.waitForSelector('.centerColsContainer');

        // Extraer datos
        const data = await page.evaluate(() => {
            // Seleccionar las filas
            const rows = Array.from(document.querySelectorAll('.centerColsContainer .row'));
            return rows.map(row => {
                // Para cada fila, extraer las celdas
                const cells = Array.from(row.querySelectorAll('.cell-value'));
                return cells.map(cell => cell.textContent.trim()); // Extraer texto de cada celda
            });
        });

        
        // Procesar datos
        for (const row of data) {
            // Asignar valores a variables
            let id = row[0];                     // Ejemplo: "1."
            let certificado = row[1];            // Ejemplo: "83797"
            let rut = row[2];                    // Ejemplo: "10691160-6"
            let fecha_contrato = await convertirFecha(row[3]); // Ejemplo: "26 nov 2024" -> "2024-11-26"
            let plan = row[4];                   // Ejemplo: "Plan SonriSana"
            let precio = parseFloat(row[5].replace(/[^0-9.-]+/g, '')); // Ejemplo: "$9.990" -> 9990
            let estado = row[6];                 // Ejemplo: "Activo"
            let beneficiarios = parseInt(row[7]); // Ejemplo: "1"
        
            if (estado === 'Activo') {
                estado = 'EXITOSO';
            }
        
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
        
            const values = [
                fecha_contrato,
                beneficiarios,
                estado,
                campanaId,
                MesVentaID,
                rut
            ];
        
            try {
                const result = await pool.query(query, values);
                console.log(`REGISTRO ACTUALIZADO MES: ${MesVentaID}, ID: ${id}, Rut: ${rut}, Fecha: ${fecha_contrato}, Estado: ${estado}, Beneficiarios: ${beneficiarios}`);
            } catch (error) {
                console.error(`Error al actualizar el registro para RUT: ${rut}`, error.message);
            }
        }

        await browser.close();
        pool.end();

    }catch(error){
        
        throw error;
    }

}

capturaLooker();
