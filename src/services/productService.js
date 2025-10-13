import axios from 'axios';
import config from '../config/env.js';

const API_BASE = `${config.DOMAIN}/asistente_virtual/public/api/products`;

export async function buscarProductoPorSKU(sku) {
  const response = await axios.get(`${API_BASE}/sku/${sku}`);
  return response.data;
}

export async function buscarPorFichaTecnica(query) {
  const response = await axios.get(`${API_BASE}?specs=${encodeURIComponent(query)}`);
  return Array.isArray(response.data) ? response.data : [response.data];
}

export async function obtenerStockPorId(productId) {
  const response = await axios.get(`${API_BASE}/${productId}/stock`);
  return response.data;
}

export async function obtenerTodosLosProductos() {
  const response = await axios.get(`${API_BASE}`);
  return response.data;
}



