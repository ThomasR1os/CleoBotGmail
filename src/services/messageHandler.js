import whatsappService from "./whatsappService.js";
import appendToSheet from "./googleSheetsService.js";
import openAiService, {
  detectarIntencion,
  extraerDatosCliente,
  transcribirAudio as transcribirDesdeOpenAI,
  detectarIntencionStock,
  buscarProductoConLLM,
  buscarProductosSimilares,
} from "./openAiService.js";
import {
  registrarCliente,
  verificarRuc,
  verificarOwnership,
} from "./clienteService.js";
import { buscarUsuarioPorNumero } from "./usuarioService.js";
import { obtenerUrlMedia, descargarMedia } from "./mediaService.js";
import { guardarStreamEnArchivo } from "./utils/audioUtils.js"; // ajusta la ruta si es necesario
import {
  buscarProductoPorSKU,
  buscarPorFichaTecnica,
  obtenerStockPorId,
  obtenerTodosLosProductos,
} from "./productService.js";
import config from "../config/env.js";
import fs from "fs";
import { pipeline } from "stream";
import { promisify } from "util";

import axios from "axios";
const DOMAIN = config.DOMAIN;

class MessageHandler {
  constructor() {
    this.appointmentState = {};
    this.assistandState = {};
    this.quotationState = {};
    this.editionState = {};
  }

  async handleIncomingMessage(message, senderInfo) {
    console.log("📩 Nuevo mensaje recibido:", message.type, message);

    try {
      await whatsappService.markAsRead(message.id);
    } catch (err) {
      console.warn("⚠️ No se pudo marcar como leído:", err.message);
    }

    const numero = message.from;
    const numeroSinPrefijo = numero.replace("@c.us", "").replace("+", "");
    const usuario = await buscarUsuarioPorNumero(numeroSinPrefijo);
    if (!usuario) {
      await whatsappService.sendMessage(
        numero,
        `❌ Tu número *${numeroSinPrefijo}* no está registrado como usuario autorizado.\nPor favor contacta al administrador para habilitar tu acceso.`
      );
      return;
    }

    const incomingMessage = message.text?.body?.trim();
    const option =
      message?.interactive?.button_reply?.id ||
      message?.interactive?.list_reply?.id;
    const estadoEdicion = this.editionState[numero];

    const text = message.text?.body?.trim();
    if (message?.type === "interactive") {
      if (option === "finalizar_cotizacion") {
        const state = this.quotationState[numero];
        if (!state || state.products.length === 0) {
          await whatsappService.sendMessage(
            numero,
            "❌ No hay productos en la cotización."
          );
          return;
        }

        let resumen = "🧾 *Resumen de productos:*";
        state.products.forEach((p, i) => {
          resumen += `\n${i + 1}. *${p.descripcion}*\nSKU: ${p.sku}`;
        });

        await whatsappService.sendMessage(numero, resumen);

        await whatsappService.sendInteractiveButtons(
          numero,
          "¿Qué deseas hacer antes de generar la cotización?",
          [
            {
              type: "reply",
              reply: { id: "confirmar_cotizacion", title: "✅ Confirmar" },
            },
            {
              type: "reply",
              reply: { id: "modificar_cotizacion", title: "✏️ Modificar" },
            },
            {
              type: "reply",
              reply: { id: "agregar_mas", title: "➕ Agregar más" },
            },
          ]
        );
        return;
      }

      if (option === "modificar_cotizacion") {
        const state = this.quotationState[numero];
        const productos = state.products;

        if (!productos || productos.length === 0) {
          await whatsappService.sendMessage(
            numero,
            "❌ No hay productos en la cotización para modificar."
          );
          return;
        }

        this.editionState[numero] = {
          step: "seleccion",
          productos: productos,
          currentIndex: 0,
        };

        await this.mostrarProductoParaEditar(numero);
        return;
      }

      if (
        option === "confirmar_cotizacion" &&
        !this.quotationState[numero]?.step
      ) {
        this.quotationState[numero].cotizandoLibre = false;
        await whatsappService.sendMessage(
          numero,
          "🎉 Vamos a iniciar la cotización. Por favor ingresa el RUC del cliente."
        );
        await this.handleCrearCabeceraCotizacion(numero, "");
        return;
      }

      if (option?.startsWith("editar_cantidad_")) {
        const index = parseInt(option.replace("editar_cantidad_", ""));
        this.editionState[numero].selectedIndex = index;
        this.editionState[numero].step = "esperando_cantidad";
        await whatsappService.sendMessage(
          numero,
          "✏️ Ingresa la nueva cantidad para el producto seleccionado:"
        );
        return;
      }

      if (option?.startsWith("editar_precio_")) {
        const index = parseInt(option.replace("editar_precio_", ""));
        this.editionState[numero] = {
          selectedIndex: index,
          step: "esperando_precio",
        };
        await whatsappService.sendMessage(
          numero,
          "💰 Ingresa el nuevo precio para este producto:"
        );
        return;
      }

      if (option?.startsWith("editar_descuento_")) {
        const index = parseInt(option.replace("editar_descuento_", ""));
        this.editionState[numero] = {
          selectedIndex: index,
          step: "esperando_descuento",
        };
        await whatsappService.sendMessage(
          numero,
          "🔻 Ingresa el descuento en porcentaje (por ejemplo, 10):"
        );
        return;
      }

      if (option?.startsWith("eliminar_producto_")) {
        const index = parseInt(option.replace("eliminar_producto_", ""));
        const productos = this.quotationState[numero].products;

        productos.splice(index, 1); // eliminar producto

        if (productos.length === 0) {
          delete this.editionState[numero];
          await whatsappService.sendMessage(
            numero,
            "🗑️ Producto eliminado. No hay más productos en la cotización."
          );
          return;
        }

        // 👇 Asegurar que el índice no se pase
        const nuevoIndex = Math.min(index, productos.length - 1);
        this.editionState[numero] = {
          step: "seleccion",
          productos: productos,
          currentIndex: nuevoIndex,
          selectedIndex: nuevoIndex,
        };

        await whatsappService.sendMessage(
          numero,
          "🗑️ Producto eliminado. Continuemos con el siguiente:"
        );
        await this.mostrarProductoParaEditar(numero);
        return;
      }

      if (option?.startsWith("edit_")) {
        const index = parseInt(option.replace("edit_", ""));
        this.editionState[numero].selectedIndex = index;

        await whatsappService.sendInteractiveButtons(
          numero,
          "¿Qué deseas hacer con este producto?",
          [
            {
              type: "reply",
              reply: { id: "editar_cantidad", title: "✏️ Cambiar cantidad" },
            },
            {
              type: "reply",
              reply: { id: "eliminar_producto", title: "🗑️ Eliminar" },
            },
          ]
        );
        return;
      }

      if (option === "editar_cantidad") {
        this.editionState[numero].step = "esperando_cantidad";
        await whatsappService.sendMessage(
          numero,
          "✏️ Ingresa la nueva cantidad para el producto seleccionado:"
        );
        return;
      }

      if (option === "eliminar_producto") {
        const index = this.editionState[numero].selectedIndex;
        this.quotationState[numero].products.splice(index, 1);
        delete this.editionState[numero];
        await whatsappService.sendMessage(
          numero,
          "🗑️ Producto eliminado de la cotización."
        );
        return;
      }

      if (option === "ver_siguiente") {
        if (!this.assistandState[numero]) return;

        this.assistandState[numero].currentIndex += 1;
        const siguiente =
          this.assistandState[numero].productosSimilares[
            this.assistandState[numero].currentIndex
          ];

        if (!siguiente) {
          await whatsappService.sendMessage(
            numero,
            "✅ No hay más productos similares."
          );
          delete this.assistandState[numero];
          return;
        }

        await this.mostrarProductoSimil(numero, usuario);
        return;
      }

      if (option === "ver_similares") {
        const estado = this.assistandState[numero];
        if (
          !estado ||
          !estado.productosSimilares ||
          estado.productosSimilares.length === 0
        ) {
          await whatsappService.sendMessage(
            numero,
            "❌ No tengo productos similares para mostrarte en este momento."
          );
          delete this.assistandState[numero];
          return;
        }

        // Mostrar el primer producto similar
        await this.mostrarProductoSimil(numero, usuario);
        return;
      }

      if (option?.startsWith("cotizar_")) {
        const productId = option.split("_")[1];
        const productos = await obtenerTodosLosProductos();
        const producto = productos.find((p) => p.id == productId);

        if (!producto) {
          await whatsappService.sendMessage(
            numero,
            "❌ Producto no encontrado."
          );
          return;
        }

        if (!this.quotationState[numero]) {
          this.quotationState[numero] = {
            cotizandoLibre: true,
            clientId: usuario.id,
            products: [],
          };
        }

        this.quotationState[numero].products.push({
          product_id: producto.id,
          sku: producto.sku,
          descripcion: producto.descripcion,
          final_price: parseFloat(producto.sale), // Precio base del producto
          quantity: 1,
          discount: 0,
        });

        await whatsappService.sendMessage(
          numero,
          `       ✅ Producto agregado:\n*${producto.descripcion}*\nSKU: ${
            producto.sku
          }\n💰 Precio de lista: USD ${parseFloat(producto.sale).toFixed(
            2
          )}\nCantidad: 1\nDescuento: 0%`
        );

        await whatsappService.sendInteractiveButtons(
          numero,
          "¿Deseas agregar más productos o finalizar la cotización?",
          [
            {
              type: "reply",
              reply: { id: "agregar_mas", title: "➕ Agregar más" },
            },
            {
              type: "reply",
              reply: { id: "finalizar_cotizacion", title: "✅ Finalizar" },
            },
          ]
        );
        return;
      }

      if (option === "cancelar_similares") {
        delete this.assistandState[numero];
        await whatsappService.sendMessage(
          numero,
          "✅ Entendido. No mostraré compresores similares."
        );
        return;
      }

      if (option === "agregar_mas") {
        await whatsappService.sendMessage(
          numero,
          "✏️ Escribe la descripción o SKU del nuevo producto que deseas agregar."
        );
        return;
      }
    }

    if (message?.type === "audio" || message?.type === "voice") {
      const numero = message.from;
      const numeroSinPrefijo = numero.replace("@c.us", "").replace("+", "");

      try {
        const mediaUrl = await obtenerUrlMedia(message.audio.id);
        const tempPath = `./temp/${message.audio.id}.ogg`;

        const audioStream = await descargarMedia(mediaUrl);
        if (!audioStream)
          throw new Error("No se pudo obtener el stream de audio");

        const streamPipeline = promisify(pipeline);

        await streamPipeline(audioStream, fs.createWriteStream(tempPath));

        const transcripcion = await this.transcribirAudio(tempPath);

        fs.unlinkSync(tempPath); // limpiar archivo temporal

        if (transcripcion) {
          console.log("🗣️ Transcripción:", transcripcion);

          // Simula un mensaje de texto para procesarlo por el mismo flujo
          await this.handleIncomingMessage(
            {
              ...message,
              type: "text",
              text: { body: transcripcion },
            },
            senderInfo
          );
        } else {
          await whatsappService.sendMessage(
            numero,
            "❌ No pude transcribir tu audio. Intenta enviar un mensaje más claro."
          );
        }
      } catch (error) {
        console.error("❌ Error al procesar audio:", error.message);
        await whatsappService.sendMessage(
          numero,
          "❌ Ocurrió un error al procesar tu mensaje de voz."
        );
      }

      return; // Evita que el flujo continúe como si fuera texto normal
    }

    if (message?.type === "text") {
      const incomingMessage = message.text.body.trim();
      const lower = incomingMessage?.toLowerCase?.() || "";

      // 🟢 Si está en flujo de cabecera, redirige el mensaje
      if (this.quotationState[numero]?.step) {
        await this.handleCrearCabeceraCotizacion(numero, incomingMessage);
        return;
      }

      // ✅ PRIMERO: manejar edición de producto si está activa
      if (estadoEdicion?.step === "esperando_precio") {
        const precio = parseFloat(incomingMessage);
        if (isNaN(precio) || precio <= 0) {
          await whatsappService.sendMessage(
            numero,
            "⚠️ Ingresa un precio válido mayor a 0."
          );
          return;
        }

        this.quotationState[numero].products[
          estadoEdicion.selectedIndex
        ].final_price = precio;

        delete this.editionState[numero];

        await whatsappService.sendMessage(
          numero,
          `✅ Precio actualizado a USD ${precio.toFixed(2)}.`
        );
        await whatsappService.sendInteractiveButtons(
          numero,
          "¿Deseas modificar otro producto o finalizar?",
          [
            {
              type: "reply",
              reply: { id: "modificar_cotizacion", title: "✏️ Modificar" },
            },
            {
              type: "reply",
              reply: { id: "confirmar_cotizacion", title: "✅ Confirmar" },
            },
          ]
        );
        return;
      }

      if (estadoEdicion?.step === "esperando_cantidad") {
        const cantidad = parseInt(incomingMessage);
        if (isNaN(cantidad) || cantidad <= 0) {
          await whatsappService.sendMessage(
            numero,
            "⚠️ Ingresa una cantidad válida (número entero mayor a 0)."
          );
          return;
        }

        this.quotationState[numero].products[
          estadoEdicion.selectedIndex
        ].quantity = cantidad;

        delete this.editionState[numero];

        await whatsappService.sendMessage(
          numero,
          `✅ Cantidad actualizada a *${cantidad}* unidad(es).`
        );
        await whatsappService.sendInteractiveButtons(
          numero,
          "¿Deseas modificar otro producto o finalizar?",
          [
            {
              type: "reply",
              reply: { id: "modificar_cotizacion", title: "✏️ Modificar" },
            },
            {
              type: "reply",
              reply: { id: "confirmar_cotizacion", title: "✅ Confirmar" },
            },
          ]
        );
        return;
      }

      if (estadoEdicion?.step === "esperando_descuento") {
        const descuento = parseFloat(incomingMessage);
        if (isNaN(descuento) || descuento < 0 || descuento > 100) {
          await whatsappService.sendMessage(
            numero,
            "⚠️ Ingresa un descuento válido entre 0 y 100."
          );
          return;
        }

        this.quotationState[numero].products[
          estadoEdicion.selectedIndex
        ].discount = descuento;

        delete this.editionState[numero];

        await whatsappService.sendMessage(
          numero,
          `✅ Descuento actualizado a *${descuento}%*.`
        );
        await whatsappService.sendInteractiveButtons(
          numero,
          "¿Deseas modificar otro producto o finalizar?",
          [
            {
              type: "reply",
              reply: { id: "modificar_cotizacion", title: "✏️ Modificar" },
            },
            {
              type: "reply",
              reply: { id: "confirmar_cotizacion", title: "✅ Confirmar" },
            },
          ]
        );
        return;
      }

      // ⛔ SOLO si no está editando, permitimos búsqueda
      if (this.quotationState[numero]?.cotizandoLibre) {
        await this.handleConsultaProducto(numero, incomingMessage, usuario);
        return;
      }

      const intencionStock = await detectarIntencionStock(lower);
      if (
        intencionStock === "consultar_stock" ||
        intencionStock === "consultar_existencia"
      ) {
        await this.handleConsultaProducto(numero, incomingMessage, usuario);
        return;
      }
    }

    if (option === "siguiente_producto") {
      this.editionState[message.from].currentIndex++;
      await this.mostrarProductoParaEditar(message.from);
      return;
    }

    if (option === "anterior_producto") {
      this.editionState[message.from].currentIndex--;
      await this.mostrarProductoParaEditar(message.from);
      return;
    }

    const lower = incomingMessage?.toLowerCase?.() || "";

    if (estadoEdicion?.step === "esperando_precio") {
      const precio = parseFloat(incomingMessage);
      if (isNaN(precio) || precio <= 0) {
        await whatsappService.sendMessage(
          numero,
          "⚠️ Ingresa un precio válido mayor a 0."
        );
        return;
      }

      this.quotationState[numero].products[
        estadoEdicion.selectedIndex
      ].final_price = precio;

      delete this.editionState[numero];

      await whatsappService.sendMessage(
        numero,
        `✅ Precio actualizado a USD ${precio.toFixed(2)}.`
      );
      await whatsappService.sendInteractiveButtons(
        numero,
        "¿Deseas modificar otro producto o finalizar?",
        [
          {
            type: "reply",
            reply: { id: "modificar_cotizacion", title: "✏️ Modificar" },
          },
          {
            type: "reply",
            reply: { id: "confirmar_cotizacion", title: "✅ Confirmar" },
          },
        ]
      );
      return;
    }

    if (estadoEdicion?.step === "esperando_descuento") {
      const descuento = parseFloat(incomingMessage);
      if (isNaN(descuento) || descuento < 0 || descuento > 100) {
        await whatsappService.sendMessage(
          numero,
          "⚠️ Ingresa un descuento válido entre 0 y 100."
        );
        return;
      }

      this.quotationState[numero].products[
        estadoEdicion.selectedIndex
      ].discount = descuento;
      delete this.editionState[numero];

      await whatsappService.sendMessage(
        numero,
        `✅ Descuento actualizado a ${descuento}%.`
      );
      await whatsappService.sendInteractiveButtons(
        numero,
        "¿Deseas modificar otro producto o finalizar?",
        [
          {
            type: "reply",
            reply: { id: "modificar_cotizacion", title: "✏️ Modificar" },
          },
          {
            type: "reply",
            reply: { id: "confirmar_cotizacion", title: "✅ Confirmar" },
          },
        ]
      );
      return;
    }

    if (this.quotationState[numero]?.cotizandoLibre) {
      await this.handleConsultaProducto(numero, incomingMessage, usuario);
      return;
    }

    const intencionStock = await detectarIntencionStock(lower);
    if (
      intencionStock === "consultar_stock" ||
      intencionStock === "consultar_existencia"
    ) {
      await this.handleConsultaProducto(numero, incomingMessage, usuario);
      return;
    }

    if (
      option === "confirmar_cotizacion" &&
      this.quotationState[numero]?.step === undefined
    ) {
      this.quotationState[numero].cotizandoLibre = false; // ⛔ Desactiva búsqueda libre

      await whatsappService.sendMessage(
        numero,
        "🎉 Felicidades, estás a punto de entrar a la cotización."
      );

      await this.handleCrearCabeceraCotizacion(numero, "");
      return;
    }

    // 🟢 Si ya hay un paso activo (como esperando_ruc), continuar aunque el mensaje sea botón
    if (
      option === "confirmar_cotizacion" &&
      this.quotationState[numero]?.step
    ) {
      await this.handleCrearCabeceraCotizacion(numero, "");
      return;
    }

    // audio & voice, etc. se mantiene igual...
  }

  async mostrarProductoSimil(numero, usuario) {
    const estado = this.assistandState[numero];
    if (!estado) return;

    const producto = estado.productosSimilares[estado.currentIndex];

    if (!producto) {
      await whatsappService.sendMessage(
        numero,
        "✅ No hay más productos similares."
      );
      delete this.assistandState[numero];
      return;
    }

    // Verifica si ya fue agregado a la cotización
    const cotizados = this.quotationState[numero]?.products || [];
    const yaCotizado = cotizados.some((p) => p.product_id == producto.id);

    if (yaCotizado) {
      // Avanza al siguiente si hay más
      estado.currentIndex += 1;

      const siguiente = estado.productosSimilares[estado.currentIndex];
      if (siguiente) {
        await this.mostrarProductoSimil(numero, usuario); // Llama recursivamente
      } else {
        await whatsappService.sendMessage(
          numero,
          "✅ Ya has agregado todos los productos similares sugeridos."
        );
        delete this.assistandState[numero];
      }
      return;
    }

    const stock = await obtenerStockPorId(producto.id);
    let mensaje = `🔄 Producto similar:\n*${producto.descripcion}*\nSKU: *${producto.sku}*`;

    const motor = producto.data_technical?.match(/potencia.+?hp/i)?.[0];
    const tanque = producto.data_technical?.match(/volumen.+?\d+.+?lts?/i)?.[0];
    const cfm = producto.data_technical?.match(/(\d+(\.\d+)?)\s*cfm/i)?.[1];

    if (motor) mensaje += `\n⚙️ ${motor}`;
    if (tanque) mensaje += `\n🛢️ ${tanque}`;
    if (producto.sale)
      mensaje += `\n💰 Precio: *USD ${parseFloat(producto.sale).toFixed(2)}*`;
    if (cfm) mensaje += `\n🌬️ CFM: *${cfm}*`;

    if (stock.total_stock > 0) {
      mensaje += `\n✅ Stock: *${stock.total_stock}* unidades`;
    } else {
      mensaje += `\n⚠️ Sin stock disponible.`;
    }

    const botones = [
      {
        type: "reply",
        reply: { id: `cotizar_${producto.id}`, title: "🛒 Cotizar este" },
      },
    ];

    if (estado.currentIndex < estado.productosSimilares.length - 1) {
      botones.push({
        type: "reply",
        reply: { id: "ver_siguiente", title: "⏭️ Ver siguiente" },
      });
    } else {
      botones.push({
        type: "reply",
        reply: { id: "cancelar_similares", title: "Cancelar" },
      });
    }

    await whatsappService.sendInteractiveButtons(numero, mensaje, botones);
  }

  async handleRegistrarCliente(numero, mensaje) {
    const datos = await extraerDatosCliente(mensaje);

    const numeroSinPrefijo = numero.replace("@c.us", "").replace("+", "");
    const usuario = await buscarUsuarioPorNumero(numeroSinPrefijo);
    if (!usuario) {
      await whatsappService.sendMessage(
        numero,
        `❌ Tu número *${numeroSinPrefijo}* no está registrado como usuario autorizado.\nPor favor contacta al administrador para habilitar tu acceso.`
      );
      return;
    }

    // Solo exige RUC; nombre ya lo pondrá el backend
    if (!datos?.ruc) {
      await whatsappService.sendMessage(
        numero,
        `📋 Para registrar un cliente, indícame al menos el *RUC*.\nEjemplo:\nRegistrar cliente\nRUC: 20123456789\nContacto: Ana Vega\nEmail: ana@empresa.com\nTeléfono: +51999...\nDirección: (opcional)`
      );
      return;
    }

    try {
      const existente = await verificarRuc(datos.ruc);
      if (existente) {
        const c = existente.cliente;
        const a = existente.asesor;
        const asesorTxt = a
          ? `\nPertenece al asesor *${a.nombre} ${a.apellido}* 📞 ${a.telefono}`
          : "";
        await whatsappService.sendMessage(
          numero,
          `⚠️ Este cliente ya está registrado como *${c.name}* (RUC ${c.ruc}).${asesorTxt}`
        );
        return;
      }

      // Completa el assigned_user_id
      datos.assigned_user_id = usuario.id;

      const resultado = await registrarCliente(datos);
      if (resultado.success) {
        const r = resultado.data; // viene desde CI4 con name/address oficiales
        await whatsappService.sendMessage(
          numero,
          `✅ Cliente registrado correctamente:\n\n*${r.name}*\nRUC: ${
            r.ruc
          }\n📍 ${r.address ?? "Sin dirección SUNAT"}`
        );
      } else {
        await whatsappService.sendMessage(numero, `⚠️ ${resultado.message}`);
      }
    } catch (error) {
      console.error(
        "Error al registrar cliente:",
        error?.response?.data || error.message
      );
      await whatsappService.sendMessage(
        numero,
        "❌ Ocurrió un error al registrar el cliente."
      );
    }
  }

  parsearClienteDesdeMensaje(texto) {
    const partes = texto.split(",");
    const datos = {};

    partes.forEach((parte) => {
      const p = parte.trim();

      if (p.toLowerCase().startsWith("registrar cliente")) {
        datos.name = p.replace(/registrar cliente/i, "").trim();
      } else if (p.toLowerCase().includes("ruc")) {
        datos.ruc = p.replace(/ruc/i, "").trim();
      } else if (p.toLowerCase().includes("contacto")) {
        datos.contact_name = p.replace(/contacto/i, "").trim();
      } else if (p.toLowerCase().includes("email")) {
        datos.contact_email = p.replace(/email/i, "").trim();
      } else if (
        p.toLowerCase().includes("teléfono") ||
        p.toLowerCase().includes("telefono")
      ) {
        datos.contact_phone = p.replace(/tel[eé]fono/i, "").trim();
      } else if (
        p.toLowerCase().includes("dirección") ||
        p.toLowerCase().includes("direccion")
      ) {
        datos.address = p.replace(/direcci[oó]n/i, "").trim();
      }
    });

    datos.assigned_user_id = 1;
    return datos;
  }

  async handleAssistandFlow(to, message) {
    const response = await openAiService(message);
    await whatsappService.sendMessage(to, response);
  }

  async handleMenuOption(to, option) {
    let response;
    switch (option) {
      case "option_1":
        this.appointmentState[to] = { step: "name" };
        response = "Por favor, ingresa tu nombre:";
        break;
      case "option_4":
        this.quotationState[to] = { step: "clientName" };
        response =
          "Vamos a crear una cotización. ¿Cuál es el nombre del cliente?";
        break;
      default:
        response =
          "Lo siento, no entendí tu selección. Elige una de las opciones del menú.";
    }
    await whatsappService.sendMessage(to, response);
  }

  async handleAppointmentFlow(to, message) {
    const state = this.appointmentState[to];
    let response;

    switch (state.step) {
      case "name":
        state.name = message;
        state.step = "petName";
        response = "Gracias, ¿Cuál es el nombre de tu Mascota?";
        break;
      case "petName":
        state.petName = message;
        state.step = "petType";
        response = "¿Qué tipo de mascota es? (perro, gato, etc.)";
        break;
      case "petType":
        state.petType = message;
        state.step = "reason";
        response = "¿Cuál es el motivo de la consulta?";
        break;
      case "reason":
        state.reason = message;
        response = this.completeAppointment(to);
        break;
    }
    await whatsappService.sendMessage(to, response);
  }

  completeAppointment(to) {
    const appointment = this.appointmentState[to];
    delete this.appointmentState[to];

    const userData = [
      to,
      appointment.name,
      appointment.petName,
      appointment.petType,
      appointment.reason,
      new Date().toISOString(),
    ];

    appendToSheet(userData);

    return `Gracias por agendar tu cita. 
  Resumen:
  - Nombre: ${appointment.name}
  - Mascota: ${appointment.petName}
  - Tipo: ${appointment.petType}
  - Motivo: ${appointment.reason}`;
  }

  async handleQuotationFlow(to, message) {
    const state = this.quotationState[to];
    let response;

    switch (state.step) {
      case "clientName":
        state.clientName = message;
        state.clientId = await this.getOrCreateClient(state.clientName);
        state.products = [];
        state.step = "product";
        response =
          "Indica el SKU del producto a agregar (o escribe 'finalizar').";
        break;
      case "product":
        if (message.toLowerCase() === "finalizar") {
          const quotationId = await this.createQuotation(state);
          await this.sendQuotationPDF(to, quotationId);
          delete this.quotationState[to];
          return;
        }
        state.currentProductSku = message;
        state.step = "price";
        response = "¿Cuál será el precio final?";
        break;
      case "price":
        state.currentProductPrice = parseFloat(message);
        state.step = "quantity";
        response = "¿Cuántas unidades?";
        break;
      case "quantity":
        state.currentProductQuantity = parseInt(message);
        state.products.push({
          sku: state.currentProductSku,
          price: state.currentProductPrice,
          quantity: state.currentProductQuantity,
        });
        state.step = "product";
        response = "Producto agregado. Ingresa otro SKU o escribe 'finalizar'.";
        break;
    }

    await whatsappService.sendMessage(to, response);
  }

  async sendWelcomeMenu(to) {
    const menuMessage = "Elige una Opción";
    const buttons = [
      { type: "reply", reply: { id: "option_1", title: "Agendar cita" } },
      { type: "reply", reply: { id: "option_4", title: "Generar cotización" } },
    ];

    await whatsappService.sendInteractiveButtons(to, menuMessage, buttons);
  }

  async transcribirAudio(filePath) {
    try {
      const fileStream = fs.createReadStream(filePath);

      const transcription = await transcribirDesdeOpenAI(fileStream); // debe ser solo el stream del archivo .ogg
      return transcription.text || transcription; // por si devuelve { text: ... }
    } catch (error) {
      console.error("❌ Error al transcribir audio:", error.message);
      return null;
    }
  }

  async handleConsultaProducto(numero, mensaje, usuario) {
    try {
      console.log("🟡 Mensaje recibido:", mensaje);
      const productos = await obtenerTodosLosProductos();
      console.log(`📦 Se cargaron ${productos.length} productos desde la API`);

      if (!mensaje || typeof mensaje !== "string") {
        console.warn(
          "❌ Mensaje inválido para consulta de productos:",
          mensaje
        );
        return;
      }
      const submensajes = mensaje
        .toLowerCase()
        .split(/ y | o |,|\/|;/i)
        .map((s) => s.trim())
        .filter((s) => s.length > 2);
      console.log("🧩 Subconsultas detectadas:", submensajes);

      for (const sub of submensajes) {
        console.log("🔍 Procesando subconsulta:", sub);
        const coincidenciasCrudas = await buscarProductoConLLM(productos, sub);
        const coincidencias = Array.isArray(coincidenciasCrudas)
          ? coincidenciasCrudas
          : [coincidenciasCrudas];

        // Validar si ya fue cotizado el único producto encontrado
        if (coincidencias.length === 1) {
          const yaCotizado = this.quotationState[numero]?.products?.some(
            (p) => p.product_id == coincidencias[0].id
          );

          if (yaCotizado) {
            await whatsappService.sendMessage(
              numero,
              `✅ Ya agregaste el único producto que coincide con: *"${sub}"* a tu cotización.\nSi deseas ver otras opciones, intenta buscar por otro modelo o potencia.`
            );
            continue;
          }
        }

        if (
          !coincidencias ||
          coincidencias.length === 0 ||
          !coincidencias[0].id
        ) {
          const similares = await buscarProductosSimilares(productos, sub);
          const lista = Array.isArray(similares) ? similares : [similares];

          if (!lista || lista.length === 0 || !lista[0].id) {
            await whatsappService.sendMessage(
              numero,
              `❌ No encontré productos similares a: *"${sub}"*.`
            );
            continue;
          }

          // Guardamos el estado para mostrar productos uno por uno
          this.assistandState[numero] = {
            mensajeOriginal: sub,
            productosSimilares: lista,
            currentIndex: 0,
          };

          await whatsappService.sendMessage(
            numero,
            `❌ No encontré productos que coincidan con: *"${sub}"*.\nPero puedo sugerirte algunos similares.`
          );

          await whatsappService.sendInteractiveButtons(
            numero,
            `¿Deseas ver compresores similares?`,
            [
              {
                type: "reply",
                reply: { id: "ver_similares", title: "Ver similares" },
              },
              {
                type: "reply",
                reply: { id: "cancelar_similares", title: "No, gracias" },
              },
            ]
          );
          continue;
        }

        for (const producto of coincidencias) {
          const yaCotizado = this.quotationState[numero]?.products?.some(
            (p) => p.product_id == producto.id
          );
          if (yaCotizado) continue;

          let mensajeProducto = `🔍 *Producto:*\n*${producto.descripcion}*\nSKU: *${producto.sku}*`;

          if (producto.sale) {
            mensajeProducto += `\n💲 Precio: *USD ${parseFloat(
              producto.sale
            ).toFixed(2)}*`;
          }

          if (producto.cfm) {
            mensajeProducto += `\n🔧 CFM: *${producto.cfm}*`;
          }

          const motor = producto.data_technical?.match(/potencia.+?hp/i)?.[0];
          const tanque =
            producto.data_technical?.match(/volumen.+?\d+.+?lts?/i)?.[0];
          if (motor) mensajeProducto += `\n⚙️ ${motor}`;
          if (tanque) mensajeProducto += `\n🛢️ ${tanque}`;

          const stock = await obtenerStockPorId(producto.id);
          console.log(`📦 Stock para producto ID ${producto.id}:`, stock);

          if (stock.total_stock > 0) {
            mensajeProducto += `\n\n✅ *¡Sí tenemos stock!*`;
            mensajeProducto += `\nTotal: *${stock.total_stock}* unidades`;
            for (const alm of stock.almacenes) {
              mensajeProducto += `\n🏢 ${alm.warehouse_name}: ${alm.stock}`;
            }
          } else {
            mensajeProducto += `\n\n⚠️ El producto está registrado pero *no tiene stock disponible*.`;
          }

          // 🟢 Enviar mensaje informativo
          await whatsappService.sendMessage(numero, mensajeProducto);

          // 🟢 Asegurar estado de cotización libre
          if (!this.quotationState[numero]) {
            this.quotationState[numero] = {
              cotizandoLibre: true,
              clientId: usuario.id,
              products: [],
            };
          }

          // 🟢 Botón para cotizar este producto
          await whatsappService.sendInteractiveButtons(
            numero,
            "¿Deseas cotizar este producto?",
            [
              {
                type: "reply",
                reply: {
                  id: `cotizar_${producto.id}`,
                  title: "🛒 Cotizar este",
                },
              },
            ]
          );
        }
      }
    } catch (error) {
      console.error("❌ Error en consulta múltiple:", error.message);
      await whatsappService.sendMessage(
        numero,
        "❌ Ocurrió un error al procesar tu solicitud."
      );
    }
  }

  async mostrarProductoParaEditar(numero) {
    const estado = this.editionState[numero];
    const productos = estado.productos;
    const i = estado.currentIndex;
    const p = productos[i];

    let mensaje = `🧾 *Producto ${i + 1} de ${productos.length}*\n`;
    mensaje += `📦 *${p.descripcion}*\nSKU: *${p.sku}*\n`;
    mensaje += `💰 Precio actual: *USD ${parseFloat(p.final_price).toFixed(
      2
    )}*\n`;
    mensaje += `🔢 Cantidad: *${p.quantity}*\n`;
    mensaje += `🔻 Descuento: *${p.discount}%*`;

    await whatsappService.sendMessage(numero, mensaje);

    // Primera fase: opciones de edición (máximo 3)
    await whatsappService.sendInteractiveButtons(
      numero,
      "¿Qué deseas modificar?",
      [
        {
          type: "reply",
          reply: { id: `editar_precio_${i}`, title: "💰 Precio" },
        },
        {
          type: "reply",
          reply: { id: `editar_cantidad_${i}`, title: "✏️ Cantidad" },
        },
        {
          type: "reply",
          reply: { id: `editar_descuento_${i}`, title: "🔻 Descuento" },
        },
      ]
    );

    // Segunda fase: navegación y eliminación
    const navBotones = [];

    if (productos.length > 1) {
      if (i > 0) {
        navBotones.push({
          type: "reply",
          reply: { id: "anterior_producto", title: "⏮️ Anterior" },
        });
      }
      if (i < productos.length - 1) {
        navBotones.push({
          type: "reply",
          reply: { id: "siguiente_producto", title: "⏭️ Siguiente" },
        });
      }
    }

    navBotones.push({
      type: "reply",
      reply: { id: `eliminar_producto_${i}`, title: "🗑️ Eliminar" },
    });

    if (navBotones.length > 0) {
      await whatsappService.sendInteractiveButtons(
        numero,
        "Opciones adicionales:",
        navBotones
      );
    }
  }

  async handleCrearCabeceraCotizacion(numero, mensaje) {
    if (!this.quotationState[numero] || !this.quotationState[numero].step) {
      if (!this.quotationState[numero]) this.quotationState[numero] = {};
      this.quotationState[numero].step = "esperando_ruc";
      await whatsappService.sendMessage(
        numero,
        "📄 Vamos a continuar con la creación de la cabecera de la cotización. Por favor, envíame el RUC del cliente."
      );
      return;
    }

    const state = this.quotationState[numero];
    const usuario = await buscarUsuarioPorNumero(
      numero.replace("@c.us", "").replace("+", "")
    );
    if (!usuario) return;

    switch (state.step) {
      case "esperando_ruc": {
        const ruc = (mensaje || "").trim();

        // normaliza exactamente igual a como guardas 'number' en tu BD (sin + y sin @c.us)
        const numeroSinPrefijo = numero
          .replace("@c.us", "")
          .replace("+", "")
          .trim();

        try {
          const check = await verificarOwnership(ruc, numeroSinPrefijo);
          // POSIBLES RESPUESTAS (status 200):
          // - { allowed:true,  exists:true,  cliente }  -> es tuyo
          // - { allowed:false, exists:true,  reason:"cliente_de_otro_asesor", cliente, asesor } -> de otro
          // - { allowed:false, exists:false, reason:"cliente_no_registrado" } -> no existe

          if (check.allowed && check.exists && check.cliente?.id) {
            // ✅ Es tuyo → continuar
            state.client_id = check.cliente.id;
            state.client_name = check.cliente.name;

            let msj = `✅ Cliente encontrado:\n*${check.cliente.name}*\nRUC: ${check.cliente.ruc}`;
            if (check.cliente.address) msj += `\n📍 ${check.cliente.address}`;
            await whatsappService.sendMessage(numero, msj);

            state.step = "esperando_condiciones";
            await whatsappService.sendMessage(
              numero,
              "✍️ Ingresa las *condiciones* de la cotización:"
            );
            return;
          }

          if (
            check.exists === true &&
            check.allowed === false &&
            check.reason === "cliente_de_otro_asesor"
          ) {
            // ⛔ Es de otro asesor → NO mostrar 'usuario no registrado'
            const a = check.asesor;
            await whatsappService.sendMessage(
              numero,
              `⛔ Este RUC pertenece al asesor *${a?.nombre || "-"} ${
                a?.apellido || ""
              }* 📞 ${a?.telefono || "-"}.`
            );
            await whatsappService.sendMessage(
              numero,
              "Por favor, ingresa **otro RUC**:"
            );
            state.step = "esperando_ruc";
            return;
          }

          if (
            check.exists === false &&
            check.reason === "cliente_no_registrado"
          ) {
            // 🆕 Registrar automáticamente usando solo el RUC (CI4 completa name/address con Decolecta)
            try {
              const numeroSinPrefijo = numero
                .replace("@c.us", "")
                .replace("+", "")
                .trim();
              const usuario = await buscarUsuarioPorNumero(numeroSinPrefijo);
              if (!usuario) {
                await whatsappService.sendMessage(
                  numero,
                  "❌ Tu número no está registrado como usuario autorizado."
                );
                return;
              }

              await whatsappService.sendMessage(
                numero,
                "🆕 Cliente no estaba registrado. Registrándolo automáticamente…"
              );

              const nuevo = await registrarCliente({
                ruc,
                assigned_user_id: usuario.id, // dueño actual
              });

              // Si el backend respondió OK, ya viene con nombre/dirección oficiales
              const c = nuevo.data;
              this.quotationState[numero].client_id = c.id;
              this.quotationState[numero].client_name = c.name;

              await whatsappService.sendMessage(
                numero,
                `✅ Cliente registrado automáticamente:\n*${c.name}*\nRUC: ${
                  c.ruc
                }${c.address ? `\n📍 ${c.address}` : ""}`
              );

              // Continúa el flujo normal
              state.step = "esperando_condiciones";
              await whatsappService.sendMessage(
                numero,
                "✍️ Ingresa las *condiciones* de la cotización:"
              );
              return;
            } catch (e) {
              // Errores típicos: 401 token Decolecta, 422 RUC inválido, etc.
              const msg =
                e?.response?.data?.messages?.ruc ||
                e?.response?.data?.message ||
                e?.message ||
                "No pude registrar el cliente.";
              await whatsappService.sendMessage(
                numero,
                `❌ ${msg} Por favor ingresa **otro RUC**:`
              );
              state.step = "esperando_ruc";
              return;
            }
          }

          // Fallback inesperado
          await whatsappService.sendMessage(
            numero,
            "⚠️ No pude validar el RUC. Intenta nuevamente con otro RUC."
          );
          state.step = "esperando_ruc";
        } catch (err) {
          // AQUÍ SOLO ENTRAN ERRORES HTTP (403/404/422/500)
          const status = err.response?.status;
          const data = err.response?.data;

          if (status === 403 && data?.reason === "cliente_de_otro_asesor") {
            // 🔒 Nuestro backend podría devolver 403 en este caso: usa el payload para mostrar el asesor
            const a = data?.asesor;
            await whatsappService.sendMessage(
              numero,
              `⛔ Este RUC pertenece al asesor *${a?.nombre || "-"} ${
                a?.apellido || ""
              }* 📞 ${a?.telefono || "-"}.`
            );
            await whatsappService.sendMessage(
              numero,
              "Por favor, ingresa **otro RUC**:"
            );
            state.step = "esperando_ruc";
            return;
          }

          if (status === 404) {
            // ⚠️ Solo 404 real de "Usuario no registrado"
            await whatsappService.sendMessage(
              numero,
              "❌ Tu número no está registrado como usuario autorizado."
            );
            // aquí probablemente cortas el flujo
            return;
          }

          if (status === 422) {
            await whatsappService.sendMessage(
              numero,
              "❌ Debes enviar un *RUC* y *número* válidos."
            );
            state.step = "esperando_ruc";
            return;
          }

          // Otros errores
          console.error(
            "Error verificarOwnership:",
            status,
            data || err.message
          );
          await whatsappService.sendMessage(
            numero,
            "❌ Error verificando el RUC. Intenta nuevamente."
          );
          state.step = "esperando_ruc";
        }
        break;
      }

      case "esperando_nombre_cliente": {
        const nombre = mensaje.trim();
        const nuevo = await registrarCliente({
          name: nombre, // el backend lo sobreescribe con SUNAT
          ruc: state.ruc,
          assigned_user_id: usuario.id,
        });

        if (!nuevo.success) {
          await whatsappService.sendMessage(
            numero,
            `❌ Error: ${nuevo.message}`
          );
          return;
        }

        state.client_id = nuevo.data.id;
        state.client_name = nuevo.data.name; // nombre oficial (SUNAT)

        await whatsappService.sendMessage(
          numero,
          `✅ Cliente registrado como:\n*${nuevo.data.name}*\nRUC: ${
            nuevo.data.ruc
          }${nuevo.data.address ? `\n📍 ${nuevo.data.address}` : ""}`
        );

        state.step = "esperando_condiciones";
        await whatsappService.sendMessage(
          numero,
          "✍️ Ingresa las *condiciones* de la cotización:"
        );
        break;
      }

      case "esperando_condiciones": {
        state.conditions = mensaje.trim();
        state.validation = "15 días"; // fijo

        const monedas = await axios.get(
          `${DOMAIN}/asistente_virtual/public/api/currencies`
        );
        state.monedas = monedas.data;

        let msj = "💱 Elige la moneda para la cotización:\n";
        monedas.data.forEach((m, i) => {
          msj += `${i + 1}. ${m.name} (${m.code})\n`;
        });

        state.step = "esperando_moneda";
        await whatsappService.sendMessage(numero, msj);
        break;
      }

      case "esperando_moneda": {
        const index = parseInt(mensaje) - 1;
        const moneda = state.monedas?.[index];
        if (!moneda) {
          await whatsappService.sendMessage(
            numero,
            "⚠️ Selección inválida. Intenta con el número de la moneda."
          );
          return;
        }
        state.currency_id = moneda.id;

        const metodos = await axios.get(
          `${DOMAIN}/asistente_virtual/public/api/payment-methods`
        );
        state.metodos_pago = metodos.data;

        let msj = "💳 Elige el método de pago:\n";
        metodos.data.forEach((m, i) => {
          msj += `${i + 1}. ${m.name}\n`;
        });

        state.step = "esperando_metodo_pago";
        await whatsappService.sendMessage(numero, msj);
        break;
      }

      case "esperando_metodo_pago": {
        const index = parseInt(mensaje) - 1;
        const metodo = state.metodos_pago?.[index];
        if (!metodo) {
          await whatsappService.sendMessage(
            numero,
            "⚠️ Selección inválida. Intenta con el número del método."
          );
          return;
        }
        state.payment_method_id = metodo.id;

        // Crear cotización (header)
        const payload = {
          client_id: state.client_id,
          user_id: usuario.id,
          conditions: state.conditions,
          validation: state.validation,
          currency_id: state.currency_id,
          payment_method_id: state.payment_method_id,
        };

        // Mensaje “generando…”
        await whatsappService.sendMessage(
          numero,
          `🧾 Generando cotización para *${
            this.quotationState[numero].client_name || "tu cliente"
          }*...`
        );

        // 1) Crear cabecera
        const resp = await axios.post(
          `${DOMAIN}/asistente_virtual/public/api/quotations`,
          payload
        );

        const quotationId = resp?.data?.id;
        if (!quotationId) {
          console.error(
            "❌ No llegó ID de cotización en la respuesta:",
            resp?.data
          );
          await whatsappService.sendMessage(
            numero,
            "❌ No pude generar la cabecera de la cotización."
          );
          return;
        }
        state.quotation_id = quotationId;

        // 2) Agregar productos a la cotización
        const productos = this.quotationState[numero]?.products || [];
        if (productos.length === 0) {
          await whatsappService.sendMessage(
            numero,
            "⚠️ No hay productos para agregar a la cotización."
          );
        } else {
          for (const p of productos) {
            const productoPayload = {
              quotation_id: quotationId,
              product_id: p.product_id,
              final_price: p.final_price,
              quantity: p.quantity,
              discount: p.discount,
            };

            try {
              await axios.post(
                `${DOMAIN}/asistente_virtual/public/api/quotations/products`,
                productoPayload
              );
            } catch (error) {
              console.error(
                `❌ Error al agregar producto ID ${p.product_id}:`,
                error?.response?.data || error.message
              );
              await whatsappService.sendMessage(
                numero,
                `⚠️ Error al agregar el producto *${
                  p.sku || p.product_id
                }* a la cotización.`
              );
            }
          }
        }

        // 3) Enviar PDF por WhatsApp
        const pdfUrl = `${DOMAIN}/asistente_virtual/public/api/pdf/quotation/${quotationId}`;
        await whatsappService.sendMediaMessage(
          numero,
          "document",
          pdfUrl,
          `🧾 Cotización #${quotationId} para *${
            this.quotationState[numero].client_name || "tu cliente"
          }*.`
        );

        // 4) Limpiar flujo
        delete this.quotationState[numero];

        break;
      }
    }
  }
}

export default new MessageHandler();
