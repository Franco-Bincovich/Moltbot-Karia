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

  const TZ = 'America/Argentina/Buenos_Aires';
  const formatted = events.map((ev) => {
    const start = ev.start.dateTime || ev.start.date;
    const end = ev.end.dateTime || ev.end.date;
    const date = new Date(start);
    const dateStr = date.toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
    const timeStr = ev.start.dateTime
      ? date.toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
      : 'Todo el día';
    const endTime = ev.end.dateTime
      ? new Date(end).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
      : '';
    const timeRange = endTime ? `${timeStr} - ${endTime}` : timeStr;

    return `- **${ev.summary || '(Sin título)'}** | ${dateStr} | ${timeRange}${ev.description ? ` | ${ev.description}` : ''} | ID: ${ev.id}`;
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
 * @param {string[]} attendees - Lista de emails de invitados
 * @param {boolean} withMeet - Si true, crea link de Google Meet
 * @returns {string} Confirmación con link al evento
 */
async function createEvent(title, date, time, duration = 60, description = '', attendees = [], withMeet = false) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const calendar = getCalendar();

  console.log(`[calendar] Creando evento: "${title}" | ${date} ${time} | ${duration}min | Invitados: ${attendees.length} | Meet: ${withMeet}`);

  // Build local datetime strings WITHOUT timezone suffix — Google interprets them
  // using the timeZone field, so we avoid the UTC conversion bug (was 3 hours off).
  const startLocal = `${date}T${time}:00`;
  // Calculate end time by parsing hours/minutes and adding duration
  const [startH, startM] = time.split(':').map(Number);
  const totalMinutes = startH * 60 + startM + duration;
  const endH = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
  const endM = String(totalMinutes % 60).padStart(2, '0');
  const endLocal = `${date}T${endH}:${endM}:00`;

  // Check for conflicts on that day using minute-of-day comparison
  // to avoid timezone/Date parsing issues
  const dayStart = `${date}T00:00:00-03:00`;
  const dayEnd = `${date}T23:59:59-03:00`;
  const existing = await calendar.events.list({
    calendarId: 'primary',
    timeMin: dayStart,
    timeMax: dayEnd,
    singleEvents: true,
    orderBy: 'startTime',
  });

  // Convert HH:MM to minutes since midnight for safe comparison
  const newStartMin = startH * 60 + startM;
  const newEndMin = newStartMin + duration;

  const conflicts = (existing.data.items || []).filter((ev) => {
    if (!ev.start.dateTime) return false; // skip all-day events
    // Extract HH:MM from the event's dateTime (works regardless of offset format)
    const evStartDate = new Date(ev.start.dateTime);
    const evEndDate = new Date(ev.end.dateTime);
    // Get hours/minutes in Argentina timezone
    const evStartStr = evStartDate.toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false });
    const evEndStr = evEndDate.toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false });
    const [evSH, evSM] = evStartStr.split(':').map(Number);
    const [evEH, evEM] = evEndStr.split(':').map(Number);
    const evStartMin = evSH * 60 + evSM;
    const evEndMin = evEH * 60 + evEM;
    // Two ranges overlap if: rangeA.start < rangeB.end AND rangeA.end > rangeB.start
    return newStartMin < evEndMin && newEndMin > evStartMin;
  });

  if (conflicts.length > 0) {
    const conflictList = conflicts.map((ev) => {
      const s = new Date(ev.start.dateTime).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' });
      const e = new Date(ev.end.dateTime).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' });
      return `- **${ev.summary}** (${s} - ${e})`;
    }).join('\n');
    return `⚠️ Hay conflicto de horario con eventos existentes:\n${conflictList}\n\nEl evento "${title}" NO fue creado. ¿Querés que lo cree de todas formas o preferís otro horario?`;
  }

  const eventBody = {
    summary: title,
    description: description || undefined,
    start: {
      dateTime: startLocal,
      timeZone: 'America/Argentina/Buenos_Aires',
    },
    end: {
      dateTime: endLocal,
      timeZone: 'America/Argentina/Buenos_Aires',
    },
  };

  if (attendees.length > 0) {
    eventBody.attendees = attendees.map((email) => ({ email: email.trim() }));
  }

  if (withMeet) {
    const requestId = `meet-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    eventBody.conferenceData = {
      createRequest: {
        requestId,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const insertParams = {
    calendarId: 'primary',
    requestBody: eventBody,
    sendUpdates: attendees.length > 0 ? 'all' : 'none',
  };

  if (withMeet) {
    insertParams.conferenceDataVersion = 1;
  }

  const res = await calendar.events.insert(insertParams);

  const event = res.data;
  console.log(`[calendar] Evento creado: ${event.id}`);

  let response = `Evento creado: **${event.summary}**\nFecha: ${date} a las ${time}\nDuración: ${duration} minutos\nID: ${event.id}`;

  if (attendees.length > 0) {
    response += `\nInvitados: ${attendees.join(', ')}`;
  }

  const meetLink = event.hangoutLink || event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  if (meetLink) {
    response += `\nGoogle Meet: ${meetLink}`;
  }

  response += `\nLink: ${event.htmlLink}`;
  return response;
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

  const TZ_TODAY = 'America/Argentina/Buenos_Aires';
  const formatted = events.map((ev) => {
    const start = ev.start.dateTime || ev.start.date;
    const timeStr = ev.start.dateTime
      ? new Date(start).toLocaleTimeString('es-AR', { timeZone: TZ_TODAY, hour: '2-digit', minute: '2-digit', hour12: false })
      : 'Todo el día';
    return `- **${ev.summary || '(Sin título)'}** | ${timeStr}${ev.description ? ` | ${ev.description}` : ''} | ID: ${ev.id}`;
  });

  console.log(`[calendar] ${events.length} eventos hoy.`);
  return `Eventos de hoy (${events.length}):\n\n${formatted.join('\n')}`;
}

/**
 * Elimina un evento de Google Calendar por su ID.
 * @param {string} eventId - ID del evento a eliminar
 * @returns {string} Confirmación de eliminación
 */
async function deleteEvent(eventId) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const calendar = getCalendar();

  console.log(`[calendar] Eliminando evento: ${eventId}`);

  // First get the event to show its name in the confirmation
  let eventName = eventId;
  try {
    const ev = await calendar.events.get({ calendarId: 'primary', eventId });
    eventName = ev.data.summary || eventId;
  } catch (e) {
    // If we can't get the name, proceed with deletion anyway
  }

  await calendar.events.delete({ calendarId: 'primary', eventId });

  console.log(`[calendar] Evento eliminado: ${eventId}`);
  return `Evento eliminado: **${eventName}**`;
}

module.exports = { getEvents, createEvent, getTodayEvents, deleteEvent };
