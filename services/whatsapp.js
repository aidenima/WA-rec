const axios = require('axios');

async function sendWhatsAppText(phoneNumberId, to, text) {
  try {
    const token = process.env.WA_ACCESS_TOKEN;
    if (!token) {
      console.warn('WA_ACCESS_TOKEN is not set; cannot send message.');
      return;
    }

    const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    };

    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    const status = err.response ? err.response.status : 'unknown';
    const data = err.response ? err.response.data : err.message;
    console.error('Failed to send WhatsApp text:', status, data);
  }
}

module.exports = { sendWhatsAppText };
