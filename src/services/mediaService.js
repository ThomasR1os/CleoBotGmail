import axios from 'axios';
import config from '../config/env.js';

export const obtenerUrlMedia = async (mediaId) => {
  const url = `https://graph.facebook.com/${config.API_VERSION}/${mediaId}`;
  const headers = {
    Authorization: `Bearer ${config.API_TOKEN}`
  };

  const response = await axios.get(url, { headers });
  return response.data.url;
};

export const descargarMedia = async (mediaUrl) => {
  try {
    const response = await axios.get(mediaUrl, {
      responseType: 'stream',
      headers: {
        Authorization: `Bearer ${config.API_TOKEN}`
      }
    });
    return response.data;
  } catch (error) {
    console.error("❌ Error al descargar media:", error.message);
    return null;
  }
};
