import config from '../config/env.js';
import messageHandler from '../services/messageHandler.js';

class WebhookController {
  async handleIncoming(req, res) {
    const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];
    const senderInfo = req.body.entry?.[0]?.changes[0]?.value?.contacts?.[0];

    if (message) {

       const fromNumber = message.from;
        const senderName = senderInfo?.profile?.name || '(Nombre no disponible)';
        const messageText = message.text?.body || '(Mensaje sin texto)';

        /*
        console.log(`📲 Mensaje recibido de: ${fromNumber}`);
        console.log(`🙋 Nombre del contacto: ${senderName}`);
        console.log(`💬 Contenido: ${messageText}`);
        */
        
        await messageHandler.handleIncomingMessage(message, senderInfo);
    }
    res.sendStatus(200);
  }

  verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.WEBHOOK_VERIFY_TOKEN) {
      res.status(200).send(challenge);
      console.log('Webhook verified successfully!');
    } else {
      res.sendStatus(403);
    }
  }

  
}

export default new WebhookController();