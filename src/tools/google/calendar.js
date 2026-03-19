const { google } = require('googleapis');
const { getAuthClient, isConfigured } = require('./auth');
const { conReintentos } = require('../../utils/reintentos');

const NOT_CONFIGURED = 'Integración con Google no configurada. Configurá las credenciales de Google en el archivo .env.';
const TZ = 'America/Argentina/Buenos_Aires';

// === Timeouts ===

// 15 segundos para todas las operaciones de Calendar (lectura, creación, eliminación)
const TIMEOUT_MS = 15_000;

/** Crea y retorna el cliente de Google Calendar autenticado con timeout configurado. */
function getCalendar() {
  const auth = getAuthClient();
  if (!auth) return null;
  return google.calendar({ version: 'v3', auth, timeout: TIMEOUT_MS });
}

// === Helpers ===

/**
 * Retorna la fecha actual en Argentina en formato YYYY-MM-DD.
 */
function getTodayAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

/**
 * Formatea un evento de Calendar como línea de texto.
 * @param {object} ev - Evento de Google Calendar
 * @param {boolean} incluirFecha - Si true, incluye día y fecha además de la hora
 * @returns {string} Línea formateada con título, fecha/hora e ID
 */
function formatearEvento(ev, incluirFecha) {
  const startRaw = ev.start.dateTime || ev.start.date;
  const startDate = new Date(startRaw);

  const horaStr = ev.start.dateTime
    ? startDate.toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
    : 'Todo el día';

  const descripcion = ev.description ? ` | ${ev.description}` : '';
  const titulo = ev.summary || '(Sin título)';

  if (incluirFecha) {
    const fechaStr = startDate.toLocaleDateString('es-AR', {
      timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short',
    });
    const endRaw = ev.end.dateTime || ev.end.date;
    const horaFin = ev.end.dateTime
      ? new Date(endRaw).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
      : '';
    const rangoHorario = horaFin ? `${horaStr} - ${horaFin}` : horaStr;
    return `- **${titulo}** | ${fechaStr} | ${rangoHorario}${descripcion} | ID: ${ev.id}`;
  }

  return `- **${titulo}** | ${horaStr}${descripcion} | ID: ${ev.id}`;
}

// === Funciones públicas ===

/**
 * Obtiene eventos de los próximos X días.
 * @param {number} days - Cantidad de días a consultar (default 7)
 * @returns {string} Eventos formateados
 */
async function getEvents(days = 7) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const calendar = getCalendar();
  const hoy = getTodayAR();
  const fechaFin = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: TZ });

  const timeMin = `${hoy}T00:00:00-03:00`;
  const timeMax = `${fechaFin}T23:59:59-03:00`;

  console.log(`[calendar] Buscando eventos de los próximos ${days} días (${timeMin} → ${timeMax})...`);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    timeZone: TZ,
    maxResults: 50,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = res.data.items || [];
  if (events.length === 0) return `No hay eventos en los próximos ${days} días.`;

  const lineas = events.map((ev) => formatearEvento(ev, true));
  console.log(`[calendar] ${events.length} eventos encontrados.`);
  return `Eventos de los próximos ${days} días (${events.length}):\n\n${lineas.join('\n')}`;
}

/**
 * Obtiene los eventos de hoy.
 * @returns {string} Eventos de hoy formateados
 */
async function getTodayEvents() {
  if (!isConfigured()) return NOT_CONFIGURED;

  const calendar = getCalendar();
  const hoy = getTodayAR();
  const timeMin = `${hoy}T00:00:00-03:00`;
  const timeMax = `${hoy}T23:59:59-03:00`;

  console.log(`[calendar] Buscando eventos de hoy (${hoy})...`);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    timeZone: TZ,
    maxResults: 50,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = res.data.items || [];
  if (events.length === 0) return 'No hay eventos para hoy.';

  const lineas = events.map((ev) => formatearEvento(ev, false));
  console.log(`[calendar] ${events.length} eventos hoy.`);
  return `Eventos de hoy (${events.length}):\n\n${lineas.join('\n')}`;
}

/**
 * Crea un evento en Google Calendar.
 * Verifica conflictos de horario antes de crear.
 * @param {string} title - Título del evento
 * @param {string} date - Fecha en formato YYYY-MM-DD
 * @param {string} time - Hora en formato HH:MM (24h)
 * @param {number} duration - Duración en minutos (default 60)
 * @param {string} description - Descripción opcional
 * @param {string[]} attendees - Lista de emails de invitados
 * @param {boolean} withMeet - Si true, crea link de Google Meet
 * @returns {string} Confirmación con datos del evento creado
 */
async function createEvent(title, date, time, duration = 60, description = '', attendees = [], withMeet = false) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const calendar = getCalendar();
  console.log(`[calendar] Creando evento: "${title}" | ${date} ${time} | ${duration}min | Invitados: ${attendees.length} | Meet: ${withMeet}`);

  // Calcular hora de fin sumando duración en minutos
  const startLocal = `${date}T${time}:00`;
  const [startH, startM] = time.split(':').map(Number);
  const totalMinutes = startH * 60 + startM + duration;
  const endH = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
  const endM = String(totalMinutes % 60).padStart(2, '0');
  const endLocal = `${date}T${endH}:${endM}:00`;

  // Verificar conflictos en el mismo día usando minutos desde medianoche
  // (evita problemas de conversión de timezone)
  const conflictos = await detectarConflictos(calendar, date, startH * 60 + startM, startH * 60 + startM + duration);
  if (conflictos.length > 0) {
    const lista = conflictos.map((ev) => {
      const s = new Date(ev.start.dateTime).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
      const e = new Date(ev.end.dateTime).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
      return `- **${ev.summary}** (${s} - ${e})`;
    }).join('\n');
    return `⚠️ Hay conflicto de horario con eventos existentes:\n${lista}\n\nEl evento "${title}" NO fue creado. ¿Querés que lo cree de todas formas o preferís otro horario?`;
  }

  // Construir cuerpo del evento
  const eventBody = {
    summary: title,
    description: description || undefined,
    start: { dateTime: startLocal, timeZone: TZ },
    end: { dateTime: endLocal, timeZone: TZ },
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

  // Reintentos en la creación porque puede fallar por errores de red o rate limits de Calendar API.
  // No se reintenta en errores de autenticación o datos inválidos (esos se propagan directo).
  const res = await conReintentos(
    () => calendar.events.insert({
      calendarId: 'primary',
      requestBody: eventBody,
      sendUpdates: attendees.length > 0 ? 'all' : 'none',
      ...(withMeet && { conferenceDataVersion: 1 }),
    }),
    {
      intentos: 3,
      esperaMs: 1000,
      onReintento: (err, intento, espera) => {
        console.warn(`[calendar] Reintento ${intento} de creación de evento "${title}" (espera ${espera}ms): ${err.message}`);
      },
    }
  );

  const evento = res.data;
  console.log(`[calendar] Evento creado: ${evento.id}`);

  let respuesta = `Evento creado: **${evento.summary}**\nFecha: ${date} a las ${time}\nDuración: ${duration} minutos\nID: ${evento.id}`;
  if (attendees.length > 0) respuesta += `\nInvitados: ${attendees.join(', ')}`;

  const meetLink = evento.hangoutLink || evento.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  if (meetLink) respuesta += `\nGoogle Meet: ${meetLink}`;

  respuesta += `\nLink: ${evento.htmlLink}`;
  return respuesta;
}

/**
 * Elimina un evento de Google Calendar por su ID.
 * Primero obtiene el nombre del evento para mostrarlo en la confirmación.
 * @param {string} eventId - ID del evento a eliminar
 * @returns {string} Confirmación de eliminación
 */
async function deleteEvent(eventId) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const calendar = getCalendar();
  console.log(`[calendar] Eliminando evento: ${eventId}`);

  let nombreEvento = eventId;
  try {
    const ev = await calendar.events.get({ calendarId: 'primary', eventId });
    nombreEvento = ev.data.summary || eventId;
  } catch {
    // Si no se puede obtener el nombre, continuar con la eliminación igual
  }

  await calendar.events.delete({ calendarId: 'primary', eventId });
  console.log(`[calendar] Evento eliminado: ${eventId}`);
  return `Evento eliminado: **${nombreEvento}**`;
}

// === Helper privado ===

/**
 * Detecta eventos existentes que se superponen con el rango horario dado.
 * Usa minutos desde medianoche para evitar problemas de timezone.
 * @param {object} calendar - Cliente de Calendar
 * @param {string} date - Fecha en YYYY-MM-DD
 * @param {number} inicioMin - Minuto de inicio (desde medianoche)
 * @param {number} finMin - Minuto de fin (desde medianoche)
 * @returns {Promise<Array>} Eventos con conflicto
 */
async function detectarConflictos(calendar, date, inicioMin, finMin) {
  const existing = await calendar.events.list({
    calendarId: 'primary',
    timeMin: `${date}T00:00:00-03:00`,
    timeMax: `${date}T23:59:59-03:00`,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (existing.data.items || []).filter((ev) => {
    if (!ev.start.dateTime) return false; // ignorar eventos de día completo

    const evStartStr = new Date(ev.start.dateTime).toLocaleTimeString('es-AR', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const evEndStr = new Date(ev.end.dateTime).toLocaleTimeString('es-AR', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const [evSH, evSM] = evStartStr.split(':').map(Number);
    const [evEH, evEM] = evEndStr.split(':').map(Number);
    const evInicioMin = evSH * 60 + evSM;
    const evFinMin = evEH * 60 + evEM;

    // Dos rangos se superponen si: A.inicio < B.fin && A.fin > B.inicio
    return inicioMin < evFinMin && finMin > evInicioMin;
  });
}

module.exports = { getEvents, createEvent, getTodayEvents, deleteEvent };
