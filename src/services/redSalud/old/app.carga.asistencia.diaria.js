const {pool} = require ("../../config/conexion.js");
const { obtenerFechaHoy } = require("../../helpers/funciones.js");
const { obtieneMesID } = require("../../data/querys.js");
const {mostrarMenuAsistencia}    = require("../../helpers/mensajes");


const Asiste    = true;

const main = async() =>{

    try{

        let respuesta =  await mostrarMenuAsistencia();
            

        console.log(respuesta[0]);

        //  Parametros de previos a la ejecucion 

        const ano               =  respuesta[0];
        const mes               =  respuesta[1];
        
        const fecha     =   (await obtenerFechaHoy());
        

        // TMK         
        // 94   17955354-6	Catalina Zuñiga
        //170   17050583-2	Johanna Valeria	Cordini
        //176   13447132-8	Karen Mariela	Moraga  
        //207   13700371-6	Marianela	Lagos
        //209   16625099-4	Victor Arancibia
        //231   9147185-K	Myriam Nuvia	Apablaza
        //236   12605891-8	Guinella del Carmen	Orellana
        //242	15781438-9	Andrea Valenzuela        
        //244	12528853-7	Elaine Cabrera
        //245	5780625-7	Fresia Lagos
        //258   22126672-2	Greiny	Mendez
        //259   18422250-7	Gina	Cabrera
        //260   16626002-7	Estefania	Salgado
        //273   16451325-4	Karen Alejandra	Lopez
        //277   18962877-3	Emili Alejandra	Rios
        //43	13298347-4	Sofia	Lopez
        //272   12512342-2  Sandra Friz

              
        //C2C
        // 38   15327712-5	Aaron Tejeda
        // 232  16925705-1	Paloma Paz	Perez   

        //TTE
        
        //DDE   
        // 21	13559382-6	Karin Retamales
        // 32   17562854-1  Claudia Celis
        //230   17666496-7	Gipsy Constanza	Aguilar
        
        //STAFF
        //41    16876474-k	Sofia	Richer
        //175   13301775-5	Hugo Ortega
        // 28	15544686-2	Ignacio Contreras 
        //264   18302299-7	Karina Alejandro Arellano

        //  DAVILA
        //  22  13914484-8	 Ivan Muñoz
        //  279 11395110-9	Celia Ester	Moreno
        //  280 18612847-8	Paulina del Pilar	Aguilera

        // SANASALUD
        //275 16069594-3	Pamela Alejandra Libeer
        //278 16876463-4	Karin Nathali Torres
        
        

        const numeros       = [21,22,28,41,32,38,43,94,170,175,176,207,209,230,231,232,236,242,244,245,258,259,260,264,272,273,275,277,278,279,280];
        
        
        for (let i = 0; i < numeros.length; i++) {

            let ejecutivoId = `${numeros[i]}`;
            let resultado   = await pool.query(obtieneMesID(ano,mes));
            let MesVentaID  = resultado.rows[0].mes_venta_id;


                console.log(fecha, ejecutivoId,MesVentaID,Asiste);

                const query = `INSERT INTO genesys_backend.cx_asistencia_ejecutivo (
                    asi_eje_usuario_id,
                    asi_eje_mes_venta_id,
                    asi_eje_fecha,
                    asi_eje_asiste
                        )
                        VALUES($1, $2, $3, $4)`;
                const values = [
                                ejecutivoId,
                                MesVentaID,
                                fecha,  
                                Asiste];
                await pool.query(query, values);


            }
        
        
    }catch(error)
    {
        throw error;
    }

}


main();
