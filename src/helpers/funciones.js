const {pool} = require("../config/conexion.js");
const {existeVenta} = require("../data/querys.js");
const moment = require('moment-timezone');

function padToTwoDigits(number) {
    return number.toString().padStart(2, '0');
}


const obtenerFechaHoraActual = async()=>
{

        try {

            const now = new Date();
            const year = now.getFullYear();
            const month = padToTwoDigits(now.getMonth() + 1); // Los meses en JavaScript son 0-indexados
            const day = padToTwoDigits(now.getDate());

            const hours = padToTwoDigits(now.getHours());
            const minutes = padToTwoDigits(now.getMinutes());
            const seconds = padToTwoDigits(now.getSeconds());

            return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

        }catch(error)
        {

            throw error;
        }
    
}


const validaExisteVenta = async (interaccionID)=>{
        try{

            const result =  await pool.query(existeVenta(interaccionID));

            if(result.rows[0].ventas > 0)
               {
                   return "SI";
       
               }else{
       
                    return "NO";
               }
   

        }catch(error){

            throw error;
        }

}

const formateaFechaBD = async(fecha)=>{
    
    try{

        const formatoEntrada    = 'DD/MM/YY HH:mm:ss';
        const zonaHoraria       = 'America/Santiago';

        let fechaF              =  moment.tz(fecha, zonaHoraria);
            fechaF              =   fechaF.subtract(-8, 'hours');
        const fechaFormateada   =   fechaF.format('YYYY-MM-DDTHH:mm:ss');
            
        return fechaFormateada;    

    }catch(error)
    {
        throw error;
    }
    
}

const formateaFechaVenta = async(fecha)=>{
    
    try{

        const formatoEntrada    = 'DD/MM/YY';
        const zonaHoraria       = 'America/Santiago';

        let fechaF              =  moment.tz(fecha, zonaHoraria);
            fechaF              =   fechaF.subtract(-8, 'hours');
        const fechaFormateada   =   fechaF.format('YYYY-MM-DD');
            
        return fechaFormateada;    

    }catch(error)
    {
        throw error;
    }
    
}


const obtenerFechaHoy = async()=>
    {
    
            try {
    
                const now = new Date();
                const year = now.getFullYear();
                const month = padToTwoDigits(now.getMonth() + 1); // Los meses en JavaScript son 0-indexados
                const day = padToTwoDigits(now.getDate());
    

                return `${year}-${month}-${day}`;
    
            }catch(error)
            {
    
                throw error;
            }
        
    }

    const obtenerAnoMes = async()=>
        {
        
                try {
        
                    const now = new Date();
                    const year = now.getFullYear();
                    const month = padToTwoDigits(now.getMonth() + 1); // Los meses en JavaScript son 0-indexados
                    const day = padToTwoDigits(now.getDate());
        
    
                    return `${year}-${month}`;
        
                }catch(error)
                {
        
                    throw error;
                }
            
        }


        const obtenerAnoMesJunto = async()=>
            {
            
                    try {
            
                        const now = new Date();
                        const year = now.getFullYear();
                        const month = padToTwoDigits(now.getMonth() + 1); // Los meses en JavaScript son 0-indexados
                        const day = padToTwoDigits(now.getDate());
            
        
                        return `${year}${month}`;
            
                    }catch(error)
                    {
            
                        throw error;
                    }
                
            }

    
module.exports={

    obtenerFechaHoraActual,
    validaExisteVenta,
    formateaFechaBD,
    obtenerFechaHoy,
    formateaFechaVenta,
    obtenerAnoMes,
    obtenerAnoMesJunto
}