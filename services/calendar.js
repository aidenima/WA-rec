const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  return google.calendar({ version: 'v3', auth });
}

async function findAvailableCalendar(calendarIds, startIso, endIso) {
  const calendar = getCalendarClient();
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: startIso,
      timeMax: endIso,
      items: calendarIds.map((id) => ({ id }))
    }
  });

  const calendars = response.data.calendars || {};
  for (const id of calendarIds) {
    const busy = calendars[id]?.busy || [];
    if (busy.length === 0) {
      return id;
    }
  }

  return null;
}

async function createEvent(calendarId, startIso, endIso, summary, description, timeZone) {
  const calendar = getCalendarClient();
  const response = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      start: { dateTime: startIso, timeZone },
      end: { dateTime: endIso, timeZone }
    }
  });

  return response.data;
}

module.exports = {
  findAvailableCalendar,
  createEvent
};
