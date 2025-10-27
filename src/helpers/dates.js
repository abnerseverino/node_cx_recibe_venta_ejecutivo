const moment = require("moment");

const fechaFormatoBD = async()=>{

    let date    =   new Date();

    const year  = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day   = String(date.getDate()).padStart(2, '0')
  
    return `${year}-${month}-${day}`
  }

const obtenerDiaAnterior = async()=>{

    const today = new Date();
    const dayOfWeek = today.getDay();
    const workingDays = [1, 2, 3, 4, 5];

    if (workingDays.includes(dayOfWeek)) {
        today.setDate(today.getDate());
    }

    while (!workingDays.includes(today.getDay())) {
        today.setDate(today.getDate());
    }

    const month = today.getMonth() + 1;
    const year = today.getFullYear();
    const formattedDay = today.getDate().toString().padStart(2, '0');
    const formattedMonth = month.toString().padStart(2, '0');

    return `${year}${formattedMonth}${formattedDay}`;
}

const obtenerPrimerDiaMes = async()=>{

    const fechaMes = new Date();
    const mes = fechaMes.getMonth() + 1;
    const ano = fechaMes.getFullYear();

   
    const primerDia = moment(new Date(ano, mes - 1, 1)).format("YYYYMMDD");
    const ultimoDia = moment(new Date(ano, mes, 0)).format("YYYYMMDD");

    

    return {
        primerDia,
        ultimoDia,
    };

  }

  const obtenerAnoMes = async()=>{

    const fechaMes = new Date();

    const year = fechaMes.getFullYear();
    const month = String(fechaMes.getMonth() + 1).padStart(2, '0')
    const day   = String(fechaMes.getDate()).padStart(2, '0')
    
  
    anoMes  =  `${year}${month}`;

    
    return {
        anoMes
    };

}


const obtenerPrimerYUltimoDia = (year, month) => {
    const primerDia = new Date(year, month - 1, 1);
    const ultimoDia = new Date(year, month, 0);
  
    return {
      primerDia,
      ultimoDia,
    };
  }

  function getCurrentMonthAndYear(){

    const fechaMes = new Date();
    const mes = fechaMes.getMonth() + 1;
    const ano = fechaMes.getFullYear();

    return { mes, ano }
  }

    const obtenerDiasLaborales = (primerDia, ultimoDia) => {
    const diasLaborales = [1, 2, 3, 4, 5]; 
    const fechasLaborales = [];

    let fechaActual = new Date(primerDia); 

    while (fechaActual <= ultimoDia) {
        const diaSemana = fechaActual.getDay();

        if (diasLaborales.includes(diaSemana)) {
        const yyyy = fechaActual.getFullYear();
        const mm = String(fechaActual.getMonth() + 1).padStart(2, '0');
        const dd = String(fechaActual.getDate()).padStart(2, '0');
        const fechaFormato = `${dd}-${mm}-${yyyy}`;

        fechasLaborales.push(fechaFormato);
        }

        fechaActual.setDate(fechaActual.getDate() + 1);
    }

    return fechasLaborales;
    }

    const { mes, ano} = getCurrentMonthAndYear()

    //let ano = "2023";
    //let mes = "12";

    const { primerDia, ultimoDia } = obtenerPrimerYUltimoDia(ano, mes);

    const fechasLaborales = obtenerDiasLaborales(primerDia, ultimoDia);



const convierteFechaAAAMMMDD = async(fecha)=>{

      // Separar la fecha por los guiones
      const [dia, mes, año] = fecha.split('-');
  
      // Formatear la fecha en "YYYY-MM-DD"
      const fechaFormateada = `${año}-${mes}-${dia}`;
  
      return fechaFormateada;
  }

  const convertirFecha = async (fecha) => {
    const mesesEs = {
      "ene": "01", "feb": "02", "mar": "03", "abr": "04", "may": "05", "jun": "06",
      "jul": "07", "ago": "08", "sep": "09", "sept": "09", "set": "09",
      "oct": "10", "nov": "11", "dic": "12"
    };
  
    const mesesEn = {
      "jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06",
      "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12"
    };
  
    // 🔹 Convertir a minúsculas, eliminar comas y limpiar espacios
    const partes = fecha.toLowerCase().replace(/,/g, "").trim().split(" ");
  
    if (partes.length !== 3) {
      throw new Error(`Formato de fecha inesperado: ${fecha}`);
    }
  
    let [mes, dia, anio] = partes;
  
    // 🔹 Detectar si el primer valor es un número (Formato español: "7 mar 2025")
    if (!isNaN(parseInt(mes))) {
      [dia, mes, anio] = partes;
    }
  
    // 🔹 Detectar si el mes es en inglés o español
    let mesNumerico = mesesEs[mes] || mesesEn[mes];
  
    if (!mesNumerico) {
      throw new Error(`Mes no reconocido en fecha: ${fecha}`);
    }
  
    // 🔹 Asegurar que el día tenga dos dígitos
    dia = dia.padStart(2, "0");
  
    // 🔹 Devolver en formato "YYYY-MM-DD"
    return `${anio}-${mesNumerico}-${dia}`;
  };


module.exports = {

    obtenerDiaAnterior,
    fechasLaborales,
    obtenerPrimerDiaMes,
    obtenerAnoMes,
    fechaFormatoBD,
    convierteFechaAAAMMMDD,
    convertirFecha
}