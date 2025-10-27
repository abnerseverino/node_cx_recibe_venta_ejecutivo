const { pool } = require("../../../config/conexion");
const moment = require("moment");
const querys = require("../../../data/querys");
const ExcelJS = require("exceljs");
const { mostarMenuActualizaEstado } = require("../../../helpers/mensajes");

const leeArchivoExcel = async () => {

  try {
    console.clear();

    const respuesta = await mostarMenuActualizaEstado();
    console.log(respuesta[0]);

    // Parámetros previos a la ejecución
    const clienteID = "5";
    const ano = respuesta[0];
    const mes = respuesta[1];
    const filename = `${ano}${mes}_respuesta.xlsx`;
    const path = `../../../ENTRADA/RedSalud/${ano}${mes}/${filename}`;

    // Obtener `MesVentaID` y campañas
    const res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
    const MesVentaID = res_fec_mes.rows[0].mes_venta_id;
    const data = await pool.query(querys.obtieneCampanaID(clienteID));

    // Leer el archivo Excel
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    const sheet = workbook.getWorksheet(1); // Usar la primera hoja

    // Procesar campañas
    for (const campana of data.rows) {
      console.log(`Procesando Red Salud Campaña: ${campana.cam_id}`);
      const campanaID = campana.cam_id;

      const updates = []; // Almacenar actualizaciones pendientes

      for (let i = 3; i <= sheet.actualRowCount; i++) {
        let beneficiarios = 0;
        const row = sheet.getRow(i);

        // Extraer y validar datos
        const fecha_ingreso = moment(row.getCell(1).toString())
            .add(4, "hours")
            .format("YYYY-MM-DD HH:mm:ss");
        const rut = row.getCell(2).toString().trim();
        const telefono = row.getCell(5).toString().trim();
        const contrato = row.getCell(8).toString().trim();
        let fecha_contrato = row.getCell(9).toString()
            ? moment(row.getCell(9).toString()).add(4, "hours").format("YYYY-MM-DD")
            : null;
        
        // Validar y mapear beneficiarios
     // Valor por defecto si no se encuentra un valor válido

        const beneficiariosRaw = row.getCell(10).toString().trim(); // Obtener el valor como string
        if (beneficiariosRaw) {
            const beneficiariosMap = {
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
            // Intentar mapear o asignar el valor numérico directo
            beneficiarios = beneficiariosMap[beneficiariosRaw] || parseInt(beneficiariosRaw) || 0;
        }

        let fecha_fuga = row.getCell(11).toString()
            ? moment(row.getCell(11).toString()).format("YYYY-MM-DD")
            : null;
        let estado = row.getCell(12).toString().toUpperCase();

        // Validar que la fila tiene datos esenciales antes de continuar
        if (!rut || !telefono || !estado) {
            console.warn(`Fila ${i} omitida: faltan datos esenciales (RUT, teléfono o estado)`);
            continue;
        }

        // Actualizar solo si el contrato no es "DUPLICADO"
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

    
      // Ejecutar actualizaciones en la base de datos
      for (const update of updates) {
        try {

            console.log(`Actualizado fila para  ${campanaID} con: ${update.fecha_contrato}, ${update.rut}, ${update.MesVentaID}, ${update.beneficiarios}, ${update.estado}, ${update.telefono}`);

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
              ven_eje_cliente_id = $7 AND 
              ven_eje_campana_id = $8 AND 
              ven_eje_telefono = TRIM($9) AND 
              ven_eje_mes_venta_id = $10 AND 
              ven_eje_rut_cliente = TRIM($11) AND
              ven_eje_respuesta_estado NOT IN ('DUPLICADO', 'RECHAZA VENTA', 'CORTA', 'RECHAZADA POR COMPRA EN CYBER', 'EXITOSO', 'TIMEOUT', 'RECHAZADA POR CALIDAD')`;

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

          await pool.query(query, values);

            

        } catch (error) {

          console.error(

            `Error actualizando fila con RUT: ${update.rut} - Error: ${error.message}`

          );
        }
      }

      // Actualizar registros con condiciones especiales
       /// REGISTROS CON ERRORES  :  ESTADO EXITOSO PERO CON CONTRATO = NO
       let queryU1 = `update 
                genesys_backend.cx_venta_ejecutivo 
            set 
                ven_eje_respuesta_estado = 'PENDIENTE POR RED SALUD' 
            where 
                ven_eje_cliente_id = '${clienteID}' and 
                ven_eje_campana_id = '${campanaID}' and 
                ven_eje_respuesta_contrato='NO' and 
                ven_eje_respuesta_estado = 'EXITOSO' and
                ven_eje_mes_venta_id='${MesVentaID}'`;
        await pool.query(queryU1);


        /// REGISTROS CON ERRORES  :  ESTADOS EN VACIO SE DEJAN COMO PENDIENTE POR RED SALUD
        let queryU2 = `update 
                genesys_backend.cx_venta_ejecutivo 
            set 
                ven_eje_respuesta_estado = 'PENDIENTE POR RED SALUD' 
            where 
                ven_eje_cliente_id = '${clienteID}' and 
                ven_eje_campana_id = '${campanaID}' and 
                ven_eje_mes_venta_id='${MesVentaID}' and
                ven_eje_respuesta_estado in ('','PENDIENTE') or 
                ven_eje_respuesta_estado is null`;
        await pool.query(queryU2);


        /// REGISTROS QUE FUERAN RECUPERADOS Y CONTINUAN PENDIENTES POR RED SALUD
        let queryU3 = `update 
                genesys_backend.cx_venta_ejecutivo 
            set 
                ven_eje_respuesta_estado = 'RECUPERADA Y PENDIENTE POR RED SALUD' 
            where 
                ven_eje_cliente_id = '${clienteID}' and 
                ven_eje_campana_id = '${campanaID}' and 
                ven_eje_respuesta_estado in ('NO INGRESA','FALLIDO') and
                ven_eje_recuperado_por > 0 and
                ven_eje_mes_venta_id='${MesVentaID}'`;
        await pool.query(queryU3);


        /// REGISTROS QUE ESTAN CON ESTADO DE RETRACTO
        let queryU4 = `update 
            genesys_backend.cx_venta_ejecutivo 
        set 
            ven_eje_respuesta_estado = 'RETRACTO' 
        where 
            ven_eje_cliente_id = '${clienteID}' and 
            ven_eje_campana_id = '${campanaID}' and 
            ven_eje_respuesta_contrato ='RETRACTO' and 
            ven_eje_mes_venta_id='${MesVentaID}'`;
        await pool.query(queryU4);

    }

  } catch (error) {
    console.error("Error general:", error);
  }
};

leeArchivoExcel();

