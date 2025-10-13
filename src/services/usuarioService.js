import axios from 'axios';
import config from '../config/env.js'; // o ../config/env.js según tu proyecto

const DOMAIN = config.DOMAIN;

// 🔍 Buscar usuario por número de teléfono
export async function buscarUsuarioPorNumero(numero) {
  const url = `${DOMAIN}/asistente_virtual/public/api/users/number/${numero}`;
  try {
    const response = await axios.get(url);
    return response.data; // { id, name, lastname, number }
  } catch (error) {
    if (error.response?.status === 404) {
      return null; // Usuario no encontrado
    }
    console.error("❌ Error consultando usuario:", error.message);
    throw error;
  }
}
