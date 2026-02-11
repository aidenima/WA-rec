const express = require('express');
require('dotenv').config();
const { DateTime } = require('luxon');

const { sendWhatsAppButtons, sendWhatsAppText } = require('./services/whatsapp');
const { findAvailableCalendar, createEvent } = require('./services/calendar');
const clientsConfig = require('./config/clients.json').clients || [];

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

const rateLimitMap = new Map();
const RATE_LIMIT_MS = 2000;
const conversationState = new Map();

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

function getClientConfig(phoneNumberId) {
  return clientsConfig.find((c) => c.phone_number_id === phoneNumberId) || null;
}

function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[čć]/g, 'c')
    .replace(/đ/g, 'dj')
    .replace(/[š]/g, 's')
    .replace(/[ž]/g, 'z')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTime(text) {
  const match = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*h?\b/);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { hour, minute };
}

const WEEKDAYS = {
  ponedeljak: 1,
  pon: 1,
  utorak: 2,
  uto: 2,
  sreda: 3,
  sre: 3,
  cetvrtak: 4,
  cet: 4,
  petak: 5,
  pet: 5,
  subota: 6,
  sub: 6,
  nedelja: 7,
  ned: 7
};

function extractWeekday(text) {
  for (const key of Object.keys(WEEKDAYS)) {
    if (text.includes(key)) {
      return WEEKDAYS[key];
    }
  }
  return null;
}

function nextWeekday(base, weekday) {
  const delta = (weekday - base.weekday + 7) % 7;
  return base.plus({ days: delta });
}

function parseRequestedDateTime(text, tz) {
  const normalized = normalizeText(text);
  const time = parseTime(normalized);
  if (!time) return null;

  let date = null;
  const now = DateTime.now().setZone(tz);

  if (normalized.includes('danas')) {
    date = now;
  } else if (normalized.includes('prekosutra')) {
    date = now.plus({ days: 2 });
  } else if (normalized.includes('sutra')) {
    date = now.plus({ days: 1 });
  } else {
    const weekday = extractWeekday(normalized);
    if (!weekday) return null;
    const base = now;
    const next = nextWeekday(base, weekday);
    if (normalized.includes('sledece') || normalized.includes('sledeci')) {
      date = next.plus({ days: 7 });
    } else {
      date = next;
    }
  }

  const dt = date.set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
  if (dt < now) return null;
  return dt;
}

function parseWorkingHours(workingHours, weekday) {
  const range = workingHours[String(weekday)];
  if (!range || range.length !== 2) return null;
  return { start: range[0], end: range[1] };
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map((v) => parseInt(v, 10));
  return h * 60 + m;
}

function isWithinWorkingHours(dt, durationMinutes, workingHours) {
  const range = parseWorkingHours(workingHours, dt.weekday);
  if (!range) return false;
  const startMinutes = timeToMinutes(range.start);
  const endMinutes = timeToMinutes(range.end);
  const currentMinutes = dt.hour * 60 + dt.minute;
  const endSlotMinutes = currentMinutes + durationMinutes;
  return currentMinutes >= startMinutes && endSlotMinutes <= endMinutes;
}

function nextWorkingStart(dt, workingHours, tz) {
  let cursor = dt.plus({ days: 1 }).startOf('day').setZone(tz);
  for (let i = 0; i < 14; i += 1) {
    const range = parseWorkingHours(workingHours, cursor.weekday);
    if (range) {
      const [h, m] = range.start.split(':').map((v) => parseInt(v, 10));
      return cursor.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    }
    cursor = cursor.plus({ days: 1 });
  }
  return null;
}

async function checkAvailability(client, startDt) {
  const duration = client.slot_minutes;
  if (!isWithinWorkingHours(startDt, duration, client.working_hours)) {
    return { available: false };
  }

  const endDt = startDt.plus({ minutes: duration });
  const calendarId = await findAvailableCalendar(client.calendars, startDt.toISO(), endDt.toISO());
  if (!calendarId) {
    return { available: false };
  }

  return { available: true, calendarId, startDt, endDt };
}

async function findAlternativeSlots(client, startDt, count) {
  const slots = [];
  const duration = client.slot_minutes;
  let cursor = startDt;
  let attempts = 0;

  while (slots.length < count && attempts < 60) {
    cursor = cursor.plus({ minutes: duration });

    if (!isWithinWorkingHours(cursor, duration, client.working_hours)) {
      const nextStart = nextWorkingStart(cursor, client.working_hours, client.timezone);
      if (!nextStart) break;
      cursor = nextStart;
    }

    const endDt = cursor.plus({ minutes: duration });
    const calendarId = await findAvailableCalendar(client.calendars, cursor.toISO(), endDt.toISO());
    if (calendarId) {
      slots.push({ startDt: cursor, endDt, calendarId });
    }

    attempts += 1;
  }

  return slots;
}

function formatSlot(dt) {
  return dt.toFormat('dd.MM.yyyy HH:mm');
}

async function handleBookingFlow(client, phoneNumberId, from, text, buttonId) {
  const key = `${phoneNumberId}:${from}`;
  const state = conversationState.get(key);
  const normalized = normalizeText(text);

  if (buttonId === 'zakazi_termin' || normalized === 'zakazi termin') {
    conversationState.set(key, { stage: 'awaiting_datetime' });
    await sendWhatsAppText(phoneNumberId, from, 'Kada zelite da zakazete? (npr. "sledece srede u 12")');
    return;
  }

  if (buttonId === 'otkazi_termin' || normalized === 'otkazi termin') {
    await sendWhatsAppText(phoneNumberId, from, 'Opcija otkazivanja jos nije dostupna.');
    return;
  }

  if (buttonId === 'provera_termina' || normalized === 'provera termina') {
    await sendWhatsAppText(phoneNumberId, from, 'Opcija provere termina jos nije dostupna.');
    return;
  }

  if (!state) {
    await sendWhatsAppButtons(phoneNumberId, from, {
      body: 'Dobar dan! Hvala sto ste se javili. Izaberite opciju ispod:',
      buttons: [
        { id: 'zakazi_termin', title: 'Zakazi termin' },
        { id: 'otkazi_termin', title: 'Otkazi termin' },
        { id: 'provera_termina', title: 'Provera termina' }
      ]
    });
    return;
  }

  if (state.stage === 'awaiting_datetime') {
    const requested = parseRequestedDateTime(text, client.timezone);
    if (!requested) {
      await sendWhatsAppText(phoneNumberId, from, 'Nisam razumeo datum. Napisite npr. "sledece srede u 12".');
      return;
    }

    const availability = await checkAvailability(client, requested);
    if (!availability.available) {
      const alternatives = await findAlternativeSlots(client, requested, 3);
      if (alternatives.length === 0) {
        await sendWhatsAppText(phoneNumberId, from, 'Nema slobodnih termina u blizini. Molim predlozite drugi termin.');
        return;
      }

      const list = alternatives.map((s) => `- ${formatSlot(s.startDt)}`).join('\n');
      await sendWhatsAppText(phoneNumberId, from, `Taj termin nije slobodan. Predlozi:\n${list}`);
      return;
    }

    conversationState.set(key, {
      stage: 'awaiting_name',
      calendarId: availability.calendarId,
      startIso: availability.startDt.toISO(),
      endIso: availability.endDt.toISO()
    });

    await sendWhatsAppText(phoneNumberId, from, 'Super! Molim vase ime i prezime.');
    return;
  }

  if (state.stage === 'awaiting_name') {
    if (!text || text.length < 2) {
      await sendWhatsAppText(phoneNumberId, from, 'Molim napisite vase ime i prezime.');
      return;
    }

    conversationState.set(key, { ...state, stage: 'awaiting_service', name: text.trim() });
    const services = client.services.map((s) => `- ${s}`).join('\n');
    await sendWhatsAppText(phoneNumberId, from, `Koju uslugu zelite?\n${services}`);
    return;
  }

  if (state.stage === 'awaiting_service') {
    const selected = client.services.find((s) => normalizeText(s) === normalized);
    if (!selected) {
      const services = client.services.map((s) => `- ${s}`).join('\n');
      await sendWhatsAppText(phoneNumberId, from, `Molim izaberite jednu od usluga:\n${services}`);
      return;
    }

    const startDt = DateTime.fromISO(state.startIso).setZone(client.timezone);
    const endDt = DateTime.fromISO(state.endIso).setZone(client.timezone);
    const summary = `${selected} - ${state.name}`;
    const description = `Klijent: ${state.name}\nUsluga: ${selected}\nTelefon: ${from}`;

    await createEvent(state.calendarId, startDt.toISO(), endDt.toISO(), summary, description, client.timezone);

    conversationState.delete(key);
    await sendWhatsAppText(
      phoneNumberId,
      from,
      `Termin je zakazan za ${formatSlot(startDt)}. Vidimo se!`
    );
    return;
  }
}

async function handleWebhookPayload(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const msg = value?.messages?.[0];
    const from = msg?.from;
    const text = msg?.text?.body;
    const buttonId = msg?.interactive?.button_reply?.id;

    console.log('phoneNumberId:', phoneNumberId);
    console.log('from:', from);
    console.log('text:', text);
    console.log('buttonId:', buttonId);

    if (!phoneNumberId || !from) {
      return;
    }

    if (!text && !buttonId) {
      return;
    }

    if (isRateLimited(from)) {
      console.log('rate_limited:', from);
      return;
    }

    const client = getClientConfig(phoneNumberId);
    if (!client) {
      console.log('No client config for phone_number_id:', phoneNumberId);
      return;
    }

    await handleBookingFlow(client, phoneNumberId, from, text || '', buttonId || '');
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
