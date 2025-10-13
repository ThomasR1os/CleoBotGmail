import axios from 'axios';
import config from '../config/env.js';

const DOMAIN = config.DOMAIN;

/** Normaliza: solo dígitos */
const cleanRuc = ruc => (ruc || '').toString().replace(/\D+/g, '');

/** 🔍 Obtener lista de clientes */
export async function listarClientes() {
  const url = `${DOMAIN}/asistente_virtual/public/api/clients`;
  const { data } = await axios.get(url, { timeout: 10000 });
  return data;
}

/** 🔎 Verificar si un RUC ya está registrado (usa by-ruc/{ruc}) */
export async function verificarRuc(ruc) {
  const nro = (ruc || '').toString().replace(/\D+/g, '');
  const url = `${DOMAIN}/asistente_virtual/public/api/clients/by-ruc/${nro}`;
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return data; // { cliente: {...}, asesor: {...} | null }
  } catch (error) {
    if (error?.response?.status === 404) return null;
    throw error;
  }
}


/** 📝 Registrar cliente (el backend completa name/address con Decolecta) */
export async function registrarCliente(payload) {
  const ruc = cleanRuc(payload.ruc);
  // Envía lo mínimo necesario; name/address los pondrá el backend
  const body = {
    ruc,
    contact_name: payload.contact_name,
    contact_email: payload.contact_email,
    contact_phone: payload.contact_phone,
    assigned_user_id: payload.assigned_user_id,
    // Si quieres permitir dirección de contacto, la puedes pasar;
    // el backend la sobrescribe con SUNAT igualmente:
    address: payload.address
  };

  const url = `${DOMAIN}/asistente_virtual/public/api/clients`;
  const { data } = await axios.post(url, body, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' }
  });

  // data viene del backend ya con: id, ruc, name (SUNAT), address (SUNAT), _mensaje
  return { success: true, data };
}

export async function verificarOwnership(ruc, number) {
  const url = `${DOMAIN}/asistente_virtual/public/api/clients/verificar-ownership`;
  const payload = { ruc: String(ruc).trim(), number: String(number).trim() };
  const { data } = await axios.post(url, payload);
  return data; // { allowed, exists, reason?, cliente?, asesor? }
}