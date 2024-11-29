const csvParser = require("csv-parser");
const { Readable } = require("stream");
const moment = require("moment");

const { pool } = require("../../config/conexion");
const querys = require("../../data/querys");

const url = `https://docs.google.com/spreadsheets/d/1FvlZU1AUJoKrdLrtNaxo9nGBZvTAhligVbaEhDrp7XU/export?format=csv&gid=1765604646`;
const inicioLinea = 2424; // INICIO DE LECTURA DEL ARCHIVO

const leeGoogleSheet = async () => {
    try {
        console.clear();

        const hoy = new Date();

        const ano = hoy.getFullYear(); // Obtiene el año actual
        const mes = hoy.getMonth() + 1; // 
            

        // Parámetros previos a la ejecución
        const clienteID = "5";
       
        // Obtener `MesVentaID` y campañas
        const res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
        const MesVentaID = res_fec_mes.rows[0].mes_venta_id;
        const data = await pool.query(querys.obtieneCampanaID(clienteID));

        // Procesar campañas
        for (const campana of data.rows) {
            const campanaID = campana.cam_id;

            console.log(`Procesando campaña ID: ${campanaID}...`);

            // Descargar el archivo CSV desde Google Sheets
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Error al descargar el archivo: ${response.statusText}`);
            }

            const csvText = await response.text();
            const stream = Readable.from(csvText);

            // Reinicia el arreglo de resultados para cada campaña
            const rows = [];
            let rowIndex = 0;

            // Procesa el archivo CSV
            await new Promise((resolve, reject) => {
                stream
                    .pipe(csvParser({ headers: false })) // Desactiva los encabezados
                    .on("data", (row) => {
                        rowIndex++;
                        if (rowIndex > inicioLinea) {
                            // Mapea las columnas según índices
                            const rawFechaIngreso = row[0]?.toString().trim();
                            const rawFechaContrato = row[8]?.toString().trim();
                            const rawFechaFuga = row[10]?.toString().trim();

                            const fecha_ingreso = rawFechaIngreso
                                ? moment(rawFechaIngreso, "D/M/YYYY H:mm:ss", true).isValid()
                                    ? moment(rawFechaIngreso, "D/M/YYYY H:mm:ss").format("YYYY-MM-DD HH:mm:ss")
                                    : "Fecha inválida"
                                : null;

                            const fecha_contrato = rawFechaContrato
                                ? moment(rawFechaContrato, "D/M/YYYY", true).isValid()
                                    ? moment(rawFechaContrato, "D/M/YYYY").format("YYYY-MM-DD")
                                    : "Fecha inválida"
                                : null;

                            const fecha_fuga = rawFechaFuga
                                ? moment(rawFechaFuga, "D/M/YYYY", true).isValid()
                                    ? moment(rawFechaFuga, "D/M/YYYY").format("YYYY-MM-DD")
                                    : "Fecha inválida"
                                : null;

                            const rut = row[1]?.trim();
                            const telefono = row[4]?.trim();
                            const contrato = row[7]?.toString().trim();
                            const estado = row[11]?.toString().toUpperCase();

                            let beneficiarios = 0;
                            const beneficiariosRaw = row[9]?.trim();
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
                                beneficiarios = beneficiariosMap[beneficiariosRaw] || parseInt(beneficiariosRaw) || 0;
                            }

                            // Agregar solo si el contrato no es "DUPLICADO"
                            if (contrato !== "DUPLICADO") {
                                rows.push({
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
                    })
                    .on("end", resolve)
                    .on("error", reject);
            });

            // Procesar actualizaciones en la base de datos
            for (const update of rows) {
                try {
                    console.log(
                        `Actualizando fila para Mes ${update.MesVentaID} Campaña ${update.campanaID} con: ${update.fecha_ingreso}, ${update.rut}, ${update.beneficiarios}, ${update.estado}, ${update.telefono}, ${update.contrato}, ${update.fecha_contrato}}, ${update.fecha_fuga}`
                    );

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
                    console.error(`Error actualizando fila con RUT: ${update.rut} - Error: ${error.message}`);
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
        console.error("Error:", error.message);
    }
};

// Ejecutar la función
leeGoogleSheet();
