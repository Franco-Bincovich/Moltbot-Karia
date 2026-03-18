const { google } = require('googleapis');
const { getAuthClient, isConfigured } = require('./auth');

const NOT_CONFIGURED = 'Integración con Google no configurada. Configurá las credenciales de Google en el archivo .env.';

function getCalendar() {
  const auth = getAuthClient();
  if (!auth) return null;
  return google.calendar({ version: 'v3', auth });
}

/**
 * Obtiene eventos de los próximos X días.
 * @param {number} days - Cantidad de días a consultar (default 7)
 * @returns {string} Eventos formateados
 */
async function getEvents(days = 7) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const calendar = getCalendar();
  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  console.log(`[calendar] Buscando eventos de los próximos ${days} días...`);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    maxResults: 50,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = res.data.items || [];

  if (events.length === 0) {
    return `No hay eventos en los próximos ${days} días.`;
  }

  const formatted = events.map((ev) => {
    const start = ev.start.dateTime || ev.start.date;
    const end = ev.end.dateTime || ev.end.date;
    const date = new Date(start);
    const dateStr = date.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
    const timeStr = ev.start.dateTime
      ? date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      : 'Todo el día';
    const endTime = ev.end.dateTime
      ? new Date(end).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      : '';
    const timeRange = endTime ? `${timeStr} - ${endTime}` : timeStr;

    return `- **${ev.summary || '(Sin título)'}** | ${dateStr} | ${timeRange}${ev.description ? ` | ${ev.description}` : ''}`;
  });

  console.log(`[calendar] ${events.length} eventos encontrados.`);
  return `Eventos de los próximos ${days} días (${events.length}):\n\n${formatted.join('\n')}`;
}

/**
 * Crea un evento en Google Calendar.
 * @param {string} title - Título del evento
 * @param {string} date - Fecha en formato YYYY-MM-DD
 * @param {string} time - Hora en formato HH:MM (24h)
 * @param {number} duration - Duración en minutos (default 60)
 * @param {string} description - Descripción opcional
 * @returns {string} Confirmación con link al evento
 */
async function createEvent(title, date, time, duration = 60, description = '') {
  if (!isConfigured()) return NOT_CONFIGURED;

  const calendar = getCalendar();

  const startDateTime = new Date(`${date}T${time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + duration * 60 * 1000);

  console.log(`[calendar] Creando evento: "${title}" | ${date} ${time} | ${duration}min`);

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title,
      description: description || undefined,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: 'America/Argentina/Cordoba',
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: 'America/Argentina/Cordoba',
      },
    },
  });

  const event = res.data;
  console.log(`[calendar] Evento creado: ${event.id}`);

  return `Evento creado: **${event.summary}**\nFecha: ${date} a las ${time}\nDuración: ${duration} minutos\nLink: ${event.htmlLink}`;
}

/**
 * Obtiene los eventos de hoy.
 * @returns {string} Eventos de hoy formateados
 */
async function getTodayEvents() {
  if (!isConfigured()) return NOT_CONFIGURED;

  const calendar = getCalendar();

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  console.log(`[calendar] Buscando eventos de hoy...`);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    maxResults: 25,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = res.data.items || [];

  if (events.length === 0) {
    return 'No hay eventos para hoy.';
  }

  const formatted = events.map((ev) => {
    const start = ev.start.dateTime || ev.start.date;
    const timeStr = ev.start.dateTime
      ? new Date(start).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      : 'Todo el día';
    return `- **${ev.summary || '(Sin título)'}** | ${timeStr}${ev.description ? ` | ${ev.description}` : ''}`;
  });

  console.log(`[calendar] ${events.length} eventos hoy.`);
  return `Eventos de hoy (${events.length}):\n\n${formatted.join('\n')}`;
}

module.exports = { getEvents, createEvent, getTodayEvents };
