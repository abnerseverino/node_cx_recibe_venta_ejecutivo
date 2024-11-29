const {pool} = require("../../../config/conexion");
const {mostrarMenuRecuperacion}    = require("../../../helpers/mensajes");

const moment = require('moment');



const funciones= require("../../../helpers/funciones");
const querys = require("../../../data/querys");
const ExcelJS = require('exceljs');
const dates = require("../../../helpers/dates");



const main = async()=>{

    
        
        try{

            let respuesta =  await mostrarMenuRecuperacion();
            

            console.log(respuesta[0]);

            //  Parametros de previos a la ejecucion 

            const clienteID         = "5";
            const ano               =  respuesta[0];
            const mes               =  respuesta[1];
            const campanaID         =  respuesta[2];
            const filename          = `${ano}${mes}_recuperacion.xlsx`; // nombre de archivo contactos
            const path              =`../../../ENTRADA/${ano}${mes}/${filename}`;

            let hoja = "";

            if(campanaID == 22){

                hoja = "RECUPERADAS TMK";

            }else if(campanaID ==23){

                hoja = "RECUPERADAS C2C";

            }
            
            
            // inicia ejecucion del programa
       
                
            const workbook = new ExcelJS.Workbook();

            await workbook.xlsx.readFile(path);

            let sheet = workbook.getWorksheet(hoja);
            
            //let ultimoRegistro = sheet.actualRowCount +1
            
            console.log(`total de registros ${ sheet.actualRowCount}`)

            for (let i = 2; i <=  sheet.actualRowCount; i++) {

            if(sheet.getRow(i).getCell(5).toString()!=="") 
            {
                    let fecha = '';

                if (sheet.getRow(i).getCell(1).toString() !== "") 
                {
                    let date_excel      =   sheet.getRow(i).getCell(1).toString();
                    let fecha_correcta  = new Date(date_excel);
                    
                        fecha = fecha_correcta.toISOString().split('T')[0];
                }else
                {
                        fecha = null;
                }

                    const rut           =   sheet.getRow(i).getCell(3).toString();
                    const telefono      =   sheet.getRow(i).getCell(5).toString();
                
                    let res             =   await pool.query(querys.obtieneRecuperadorID(sheet.getRow(i).getCell(10).toString()));
                    let recuperador     =   res.rows[0].ejecutivo_id;

                    console.log(fecha, rut,telefono, recuperador);

                        const query = `UPDATE 
                                                genesys_backend.cx_venta_ejecutivo
                                            SET 
                                                ven_eje_recuperado_por = $1 , 
                                                ven_eje_fecha_recuperacion = $2,
                                                ven_eje_respuesta_estado = 'RECUPERADA Y PENDIENTE POR RED SALUD'
                                            WHERE
                                                ven_eje_campana_id = $3 and
                                                ven_eje_telefono = $4 and 
                                                ven_eje_rut_cliente=$5 and
                                                ven_eje_respuesta_estado in ('NO INGRESA','FALLIDO')`
                        const values = [
                                    recuperador,
                                    fecha,
                                    campanaID,
                                    telefono,
                                    rut 
                                    ];
                        
                        await  pool.query(query, values);
                    

                           
            }
        }

        }catch(error){
            
            throw error;

        }

    }


   

    main();
    