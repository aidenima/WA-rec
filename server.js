const express = require('express');
require('dotenv').config();

const { sendWhatsAppButtons } = require('./services/whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

const rateLimitMap = new Map();
const RATE_LIMIT_MS = 2000;

function isRateLimited(from) {
  if (!from) return false;
  const now = Date.now();
  const last = rateLimitMap.get(from) || 0;
  if (now - last < RATE_LIMIT_MS) {
    return true;
  }
  rateLimitMap.set(from, now);
  return false;
}

async function handleWebhookPayload(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const msg = value?.messages?.[0];
    const from = msg?.from;
    const text = msg?.text?.body;

    console.log('phoneNumberId:', phoneNumberId);
    console.log('from:', from);
    console.log('text:', text);

    if (!text) {
      return;
    }

    if (isRateLimited(from)) {
      console.log('rate_limited:', from);
      return;
    }

    if (phoneNumberId && from) {
      await sendWhatsAppButtons(phoneNumberId, from, {
        body: 'Dobar dan! Hvala sto ste se javili. Izaberite opciju ispod:',
        buttons: [
          { id: 'zakazi_termin', title: 'Zakazi termin' },
          { id: 'imam_pitanje', title: 'Imam pitanje' },
          { id: 'cena', title: 'Cena' }
        ]
      });
    }
  } catch (err) {
    console.error('Webhook handling error:', err && err.stack ? err.stack : err);
  }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  console.log('✅ POST /webhook HIT');
  console.log('content-type:', req.headers['content-type']);
  console.log('raw body:', JSON.stringify(req.body));

  res.sendStatus(200);

  setImmediate(() => {
    handleWebhookPayload(req.body);
  });
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
