import OpenAI from "openai";
import config from "../config/env.js";

const client = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
});

const openAiService = async (message) => {
    try {
        const response = await client.chat.completions.create({
            messages: [
              {
                role: 'system',
                content: 'Eres parte de un servicio de asistencia online y debes de comportarte como un veterinario de un comercio llamado "MedPet". Resuelve las preguntas lo más simple posible, con una explicación posible. Si es una emergencia o debe de llamarnos (MedPet). Debes de responde en texto simple como si fuera un mensaje de un bot conversacional, no saludes, no generas conversación, solo respondes con la pregunta del usuario.'
              },
              { role: 'user', content: message }
            ],
            model: 'gpt-4o'
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error(error);
    }
}

export const detectarIntencion = async (mensaje) => {
  try {
    const response = await client.chat.completions.create({
      messages: [
        {
          role: 'system',
          content:
            `Eres un modelo de clasificación de intención para un asistente virtual de WhatsApp. 
Clasifica el mensaje del usuario y responde únicamente con una palabra clave entre estas:

- "registro_cliente"
- "generar_cotizacion"
- "agendar_cita"
- "pregunta_general"
- "ninguna"

Solo responde una de esas palabras clave. No expliques nada.`
        },
        { role: 'user', content: mensaje }
      ],
      model: 'gpt-4o'
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error detectando intención:", error.message);
    return "ninguna";
  }
};

export const extraerDatosCliente = async (mensaje) => {
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `Eres un asistente que interpreta mensajes de WhatsApp para registrar clientes en una base de datos. Devuelve un JSON con las siguientes claves, incluso si están vacías:

- name
- ruc
- contact_name
- contact_email
- contact_phone
- address
- assigned_user_id (usa siempre el valor 1)

No expliques nada. Devuelve solo el JSON válido.

Ejemplo:
Mensaje:
"""
Registrar cliente
Nombre del cliente: INVERSIONES CHOCLITO VERDE S.A.C.
RUC: 20523408292
Nombre del contacto: Luis Ramírez
Correo del contacto: lramirez@acme.com
Teléfono del contacto: +51999888777
Dirección: Av. Industrial 123, Lima
"""

Respuesta:
{
  "name": "INVERSIONES CHOCLITO VERDE S.A.C.",
  "ruc": "20523408292",
  "contact_name": "Luis Ramírez",
  "contact_email": "lramirez@acme.com",
  "contact_phone": "+51999888777",
  "address": "Av. Industrial 123, Lima",
  "assigned_user_id": 1
}
`
        },
        {
          role: 'user',
          content: mensaje
        }
      ]
    });

    const jsonText = response.choices[0].message.content.trim();

    // Limpiar cualquier texto adicional (por seguridad)
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    const jsonClean = jsonText.substring(start, end + 1);

    return JSON.parse(jsonClean);
  } catch (error) {
    console.error("❌ Error al extraer datos del cliente:", error.message);
    return null;
  }
};

export const transcribirAudio = async (audioStream) => {
  try {
    const transcription = await client.audio.transcriptions.create({
      file: audioStream,
      model: "whisper-1",
      response_format: "text"
    });
    return transcription;
  } catch (error) {
    console.error("❌ Error al usar Whisper:", error.response?.data || error.message);
    return null;
  }
};

export async function detectarIntencionStock(texto) {
  // Lógica simple por palabras clave, puedes expandir luego
  const lower = texto.toLowerCase();
  const preguntaStock = /(hay|tienen|queda|quedan).*(en stock|disponible|disponibles)/;
  const tieneSKU = /\bsku\b|\d{3,}\.\d{4}-\d/;

  if (preguntaStock.test(lower) || lower.includes("stock")) {
    return 'consultar_stock';
  } else if (tieneSKU || lower.includes("compresor") || lower.match(/\b\d+\s*hp\b/)) {
    return 'consultar_existencia';
  }
  return 'otro';
}

export async function buscarProductoConLLM(productos, mensaje) {
  const prompt = `
Eres un asistente virtual de ventas de compresores de aire.

Debes buscar productos que coincidan con lo que el usuario solicita, prestando especial atención a:

- Tipo de compresor (pistón, tornillo, scroll, etc.)
- Potencia del motor (HP)
- Volumen del tanque
- SKU si es que se menciona

Esta es la lista de productos disponibles (JSON):

${JSON.stringify(productos, null, 2)}

El usuario ha enviado este mensaje:
"${mensaje}"

Devuelve un array JSON (máximo 3 productos) que coincidan con la solicitud.
Cada producto debe contener: id, sku, descripcion, data_technical, sale, cfm.
Si no hay coincidencias exactas, devuelve un array vacío: []
`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Eres un asistente que filtra productos en base a consultas de usuarios.' },
        { role: 'user', content: prompt }
      ]
    });

    const text = response.choices[0].message.content.trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    const json = text.substring(start, end + 1);

    return JSON.parse(json);
  } catch (error) {
    console.error("❌ Error en buscarProductoConLLM:", error.message);
    return []; // devuelve array vacío si algo falla
  }
}

export async function buscarProductosSimilares(productos, mensaje) {
  const prompt = `
Eres un asistente virtual de ventas de compresores de aire.

El usuario ha solicitado un producto específico, pero no hay coincidencias exactas en la base de datos. Tu tarea es buscar productos similares en base a:

- Potencia del motor (HP): encuentra los más cercanos al valor mencionado (por ejemplo, si pidió 20 HP y no hay, puedes mostrarle uno de 15 HP o 25 HP).
- Tipo de compresor (pistón, tornillo, scroll, etc.): si se menciona, prioriza mantenerlo.
- Volumen del tanque (litros): si se menciona, trata de aproximarlo también.
- SKU: si se parece al solicitado o contiene un patrón similar.

Esta es la lista de productos disponibles (formato JSON):

${JSON.stringify(productos, null, 2)}

Este fue el mensaje original del usuario:
"${mensaje}"

Devuelve un array JSON (máximo 3 productos) que se parezcan a lo que el usuario solicitó.
Cada producto debe incluir: id, sku, descripcion, data_technical, sale.
Responde solo con el array JSON. No pongas explicaciones ni texto adicional.
`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Eres un asistente que recomienda productos similares si no hay coincidencias exactas.' },
        { role: 'user', content: prompt }
      ]
    });

    const text = response.choices[0].message.content.trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    
    if (start === -1 || end === -1) {
      throw new Error("No se encontró un array JSON válido.");
    }

    const jsonArray = text.substring(start, end + 1);
    return JSON.parse(jsonArray);

  } catch (error) {
    console.error("❌ Error en buscarProductosSimilares:", error.message);
    return [];
  }
}

export default openAiService;