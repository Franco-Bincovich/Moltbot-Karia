// === REFERENCIAS AL DOM ===

const messagesEl    = document.getElementById('messages');
const chatForm      = document.getElementById('chatForm');
const userInput     = document.getElementById('userInput');
const sendBtn       = document.getElementById('sendBtn');
const attachBtn     = document.getElementById('attachBtn');
const fileInput     = document.getElementById('fileInput');
const fileLabel     = document.getElementById('fileLabel');
const fileLabelName = fileLabel.querySelector('.file-label-name');
const fileRemoveBtn = document.getElementById('fileRemoveBtn');
const resetBtn      = document.getElementById('resetBtn');
const sidebarList   = document.getElementById('sidebarList');
const sidebarNewBtn = document.getElementById('sidebarNewBtn');
const learningScreen   = document.getElementById('learningScreen');
const learningBackBtn  = document.getElementById('learningBackBtn');
const learningTitleBtn = document.getElementById('learningTitleBtn');
const learningNewBtn   = document.getElementById('learningNewBtn');

// === ESTADO GLOBAL ===

const history = [];               // Historial de mensajes del turno actual
let pendingFile     = null;       // Archivo adjunto pendiente de envío
let currentSessionId = null;      // UUID de la sesión activa en Supabase
let activeSidebarItem = null;     // Elemento DOM activo en la sidebar

// SVG del avatar de KarIA reutilizado en cada mensaje del bot
const KARIA_AVATAR_SVG = `<svg viewBox="0 0 28 28" width="28" height="28">
  <circle cx="14" cy="14" r="14" fill="#fff"/>
  <circle cx="10" cy="7" r="1.8" fill="#43D1C9"/>
  <circle cx="18" cy="7" r="1.8" fill="#43D1C9"/>
  <path d="M7 10 Q14 16 21 10" stroke="#43D1C9" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <text x="5" y="22" font-family="Baloo 2, sans-serif" font-size="9.5" font-weight="600" fill="#081C54">kar</text>
  <text x="17.5" y="22" font-family="Baloo 2, sans-serif" font-size="9.5" font-weight="600" fill="#43D1C9">ia</text>
</svg>`;

// Extensiones de archivo permitidas para adjuntar
const ALLOWED_EXTENSIONS = /\.(xlsx|xls|doc|docx)$/i;

// ============================================================
// === AUTENTICACIÓN ==========================================
// ============================================================

/** Retorna el JWT guardado en sessionStorage, o null si no existe. */
function obtenerToken() {
  return sessionStorage.getItem('karia_token');
}

/**
 * Retorna el header Authorization listo para incluir en cada request al servidor.
 * Si no hay token, retorna un objeto vacío (el servidor responderá 401).
 */
function obtenerHeadersAuth() {
  const token = obtenerToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Verifica si hay una sesión activa al cargar la página.
 * Si hay token válido en sessionStorage, muestra la app directamente.
 * Si no, redirige al login.
 */
function inicializarAuth() {
  const token    = obtenerToken();
  const userData = sessionStorage.getItem('karia_user');
  if (token && userData) {
    try {
      const user = JSON.parse(userData);
      mostrarApp(user.nombre);
      mostrarBienvenida();
      cargarSidebar();
    } catch {
      cerrarSesion();
    }
  } else {
    mostrarPantallaLogin();
  }
}

/**
 * Envía las credenciales al servidor y, si son válidas,
 * guarda el token en sessionStorage y muestra la app.
 * @param {string} email
 * @param {string} password
 */
async function iniciarSesion(email, password) {
  const res  = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();

  if (!res.ok) throw new Error(data.error || 'Error al ingresar.');

  sessionStorage.setItem('karia_token', data.token);
  sessionStorage.setItem('karia_user', JSON.stringify(data.usuario));

  mostrarApp(data.usuario.nombre);
  mostrarBienvenida();
  cargarSidebar();
}

/** Cierra la sesión: limpia todo el estado de la app y redirige al login. */
function cerrarSesion() {
  // Conversación
  history.length = 0;
  currentSessionId = null;
  messagesEl.innerHTML = '';

  // Archivo adjunto pendiente
  pendingFile = null;
  fileInput.value = '';
  fileLabel.style.display = 'none';
  userInput.value = '';
  userInput.style.height = 'auto';
  userInput.placeholder = 'Escribi tu mensaje...';

  // Sidebar
  sidebarList.innerHTML = '';
  if (activeSidebarItem) {
    activeSidebarItem.classList.remove('active');
    activeSidebarItem = null;
  }

  // Pantalla de aprendizaje (por si estaba abierta)
  ocultarPantallaAprendizaje();

  // Credenciales
  sessionStorage.removeItem('karia_token');
  sessionStorage.removeItem('karia_user');
  mostrarPantallaLogin();
}

// Listener del formulario de login
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const loginBtn = document.getElementById('loginBtn');
  const loginError = document.getElementById('loginError');

  loginBtn.disabled = true;
  loginBtn.textContent = 'Ingresando...';
  loginError.classList.remove('visible');

  try {
    await iniciarSesion(email, password);
  } catch (err) {
    loginError.textContent = err.message || 'Error de conexión con el servidor.';
    loginError.classList.add('visible');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Ingresar';
  }
});

document.getElementById('logoutBtn').addEventListener('click', cerrarSesion);

// Arranque
inicializarAuth();

// ============================================================
// === SESIONES ===============================================
// ============================================================

/**
 * Crea una sesión nueva en Supabase usando el primer mensaje del usuario.
 * El servidor genera un nombre de 2-4 palabras con Claude Haiku.
 * @param {string} primerMensaje - Texto del primer mensaje de la conversación
 * @returns {string|null} UUID de la sesión creada, o null si falla
 */
async function crearSesion(primerMensaje) {
  try {
    const res     = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...obtenerHeadersAuth() },
      body: JSON.stringify({ firstMessage: primerMensaje }),
    });
    const session = await res.json();
    if (res.ok && session.id) return session.id;
    console.warn('[sesiones] Respuesta sin id válido:', session);
    return null;
  } catch (err) {
    console.warn('[sesiones] No se pudo crear sesión:', err.message);
    return null;
  }
}

/**
 * Carga las sesiones del usuario desde Supabase y las renderiza en la sidebar.
 * Si se pasa un selectId, resalta ese ítem como activo.
 * @param {string|null} selectId - UUID de la sesión a resaltar tras cargar
 */
async function cargarSidebar(selectId = null) {
  try {
    const res      = await fetch('/api/sessions', { headers: obtenerHeadersAuth() });
    const sesiones = await res.json();

    if (!Array.isArray(sesiones) || sesiones.length === 0) {
      sidebarList.innerHTML = '<div class="sidebar-empty">Sin conversaciones</div>';
      return;
    }

    sidebarList.innerHTML = '';
    activeSidebarItem = null;

    for (const s of sesiones) {
      const item  = document.createElement('div');
      item.className   = 'sidebar-item';
      item.dataset.id  = s.id;
      const fecha = new Date(s.iniciada_at).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });

      item.innerHTML = `
        <span class="sidebar-item-name">${escaparHtml(s.nombre || 'Conversación')}</span>
        <span class="sidebar-item-date">${fecha}</span>`;

      item.addEventListener('click', () => abrirSesion(s.id, item));
      sidebarList.appendChild(item);

      if (selectId && s.id === selectId) {
        item.classList.add('active');
        activeSidebarItem = item;
      }
    }
  } catch (err) {
    console.error('[sesiones] Error cargando sesiones:', err);
    sidebarList.innerHTML = '<div class="sidebar-empty">Error al cargar</div>';
  }
}

/**
 * Abre una sesión existente: resetea el chat y carga sus mensajes desde Supabase.
 * @param {string} sesionId - UUID de la sesión a abrir
 * @param {HTMLElement} itemEl - Elemento DOM de la sidebar a marcar como activo
 */
async function abrirSesion(sesionId, itemEl) {
  ocultarPantallaAprendizaje();

  // Actualizar estado activo en la sidebar
  if (activeSidebarItem) activeSidebarItem.classList.remove('active');
  itemEl.classList.add('active');
  activeSidebarItem = itemEl;

  // Resetear estado del chat
  currentSessionId = sesionId;
  history.length = 0;
  pendingFile = null;
  fileInput.value = '';
  fileLabel.style.display = 'none';
  userInput.placeholder = 'Escribi tu mensaje...';
  messagesEl.innerHTML = '';

  // Cargar mensajes desde el servidor
  try {
    const res      = await fetch(`/api/sessions/${sesionId}/messages`, { headers: obtenerHeadersAuth() });
    const mensajes = await res.json();

    if (!Array.isArray(mensajes) || mensajes.length === 0) {
      mostrarBienvenida();
      return;
    }

    for (const m of mensajes) {
      if (m.rol === 'user') {
        agregarMensaje('user', escaparHtml(m.contenido));
        history.push({ role: 'user', content: m.contenido });
      } else if (m.rol === 'assistant') {
        agregarMensaje('bot', formatearMarkdown(m.contenido));
        history.push({ role: 'assistant', content: m.contenido });
      }
    }
  } catch (err) {
    console.error('[sesiones] Error cargando mensajes:', err);
    agregarMensaje('bot', 'Error al cargar la conversación.');
  }
}

// ============================================================
// === CHAT ===================================================
// ============================================================

/** Muestra el mensaje de bienvenida del agente al iniciar una conversación nueva. */
function mostrarBienvenida() {
  const div = document.createElement('div');
  div.className = 'message bot welcome-message';
  div.innerHTML = `
    <div class="msg-avatar">${KARIA_AVATAR_SVG}</div>
    <div class="message-bubble">
      <div class="message-content">Hola! Soy <strong>Karia Agent</strong>, tu asistente inteligente. ¿En qué te puedo ayudar?</div>
      <div class="message-meta"><span class="msg-time">${obtenerHora()}</span></div>
    </div>`;
  messagesEl.appendChild(div);
}

/**
 * Inicia una conversación nueva: resetea todo el estado y muestra la bienvenida.
 * También cierra la pantalla de aprendizaje si estaba abierta.
 */
function nuevaConversacion() {
  ocultarPantallaAprendizaje();
  currentSessionId = null;
  history.length = 0;
  pendingFile = null;
  fileInput.value = '';
  fileLabel.style.display = 'none';
  userInput.placeholder = 'Escribi tu mensaje...';
  messagesEl.innerHTML = '';

  if (activeSidebarItem) {
    activeSidebarItem.classList.remove('active');
    activeSidebarItem = null;
  }

  mostrarBienvenida();
  userInput.focus();
}

// Listener del formulario de envío de mensajes
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const texto = userInput.value.trim();
  if (!texto && !pendingFile) return;

  if (texto)       agregarMensaje('user', escaparHtml(texto));
  if (pendingFile) agregarBurbujArchivo('user', pendingFile.name, formatearTamañoArchivo(pendingFile.size));

  userInput.value = '';
  userInput.style.height = 'auto';
  sendBtn.disabled   = true;
  attachBtn.disabled = true;

  const indicadorEscribiendo = mostrarEscribiendo();

  try {
    // Crear sesión en el primer mensaje de una conversación nueva
    if (!currentSessionId && texto) {
      const sessionId = await crearSesion(texto);
      if (sessionId) {
        currentSessionId = sessionId;
        await cargarSidebar(currentSessionId);
      }
    }

    // Enviar mensaje al agente
    let res;
    if (pendingFile) {
      const formData = new FormData();
      formData.append('file', pendingFile);
      formData.append('message', texto);
      formData.append('history', JSON.stringify(history));
      if (currentSessionId) formData.append('sesion_id', currentSessionId);
      res = await fetch('/api/chat', { method: 'POST', headers: obtenerHeadersAuth(), body: formData });
    } else {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...obtenerHeadersAuth() },
        body: JSON.stringify({ message: texto, history, sesion_id: currentSessionId }),
      });
    }

    const data = await res.json();

    if (data.error) {
      agregarMensaje('bot', `Error: ${escaparHtml(data.error)}`);
    } else {
      const contenidoUsuario = texto || (pendingFile ? `[Archivo: ${pendingFile.name}]` : '');
      history.push({ role: 'user', content: contenidoUsuario });
      if (data.excelContext) history.push({ role: 'assistant', content: `[EXCEL_DATA]\n${data.excelContext}` });
      if (data.wordContext)  history.push({ role: 'assistant', content: `[WORD_DATA]\n${data.wordContext}` });
      history.push({ role: 'assistant', content: data.reply });
      agregarMensaje('bot', formatearMarkdown(data.reply));
    }
  } catch {
    agregarMensaje('bot', 'Error de conexion con el servidor.');
  } finally {
    pendingFile = null;
    fileInput.value = '';
    fileLabel.style.display = 'none';
    userInput.placeholder = 'Escribi tu mensaje...';
    indicadorEscribiendo.remove();
    sendBtn.disabled   = false;
    attachBtn.disabled = false;
    userInput.focus();
  }
});

/**
 * Agrega un mensaje de texto al área de chat.
 * @param {'user'|'bot'} rol - Rol del mensaje
 * @param {string} contenidoHtml - HTML ya sanitizado o formateado
 */
function agregarMensaje(rol, contenidoHtml) {
  const div  = document.createElement('div');
  div.className = `message ${rol}`;
  const hora = obtenerHora();

  if (rol === 'bot') {
    div.innerHTML = `
      <div class="msg-avatar">${KARIA_AVATAR_SVG}</div>
      <div class="message-bubble">
        <div class="message-content">${contenidoHtml}</div>
        <div class="message-meta"><span class="msg-time">${hora}</span></div>
      </div>`;
  } else {
    div.innerHTML = `
      <div class="message-bubble">
        <div class="message-content">${contenidoHtml}</div>
        <div class="message-meta">
          <span class="msg-time">${hora}</span>
          <span class="msg-ticks">&#10003;&#10003;</span>
        </div>
      </div>`;
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Agrega una burbuja de archivo al área de chat.
 * Si se proporciona downloadUrl, muestra un botón de descarga.
 * @param {'user'|'bot'} rol
 * @param {string} nombreArchivo
 * @param {string} tamañoFormateado
 * @param {string|undefined} downloadUrl - URL de descarga opcional
 */
function agregarBurbujArchivo(rol, nombreArchivo, tamañoFormateado, downloadUrl) {
  const div  = document.createElement('div');
  div.className = `message ${rol}`;
  const hora = obtenerHora();
  const ext  = nombreArchivo.split('.').pop().toLowerCase();
  const { iconClass, iconText } = obtenerIconoArchivo(ext);

  const botonDescarga = downloadUrl
    ? `<a href="${downloadUrl}" download class="file-download-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>`
    : '';
  const estadoTexto = downloadUrl ? 'Listo para descargar' : '';

  if (rol === 'bot') {
    div.innerHTML = `
      <div class="msg-avatar">${KARIA_AVATAR_SVG}</div>
      <div class="message-bubble">
        <div class="file-bubble">
          <div class="file-icon ${iconClass}">${iconText}</div>
          <div class="file-info">
            <div class="file-name">${escaparHtml(nombreArchivo)}</div>
            <div class="file-size">${tamañoFormateado}</div>
            ${estadoTexto ? `<div class="file-status">${estadoTexto}</div>` : ''}
          </div>${botonDescarga}
        </div>
        <div class="message-meta"><span class="msg-time">${hora}</span></div>
      </div>`;
  } else {
    div.innerHTML = `
      <div class="message-bubble">
        <div class="file-bubble">
          <div class="file-icon ${iconClass}">${iconText}</div>
          <div class="file-info">
            <div class="file-name">${escaparHtml(nombreArchivo)}</div>
            <div class="file-size">${tamañoFormateado}</div>
          </div>
        </div>
        <div class="message-meta">
          <span class="msg-time">${hora}</span>
          <span class="msg-ticks">&#10003;&#10003;</span>
        </div>
      </div>`;
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Muestra el indicador de "escribiendo..." del bot mientras espera respuesta.
 * @returns {HTMLElement} El elemento para poder removerlo cuando llegue la respuesta
 */
function mostrarEscribiendo() {
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.innerHTML = `<div class="typing-avatar">${KARIA_AVATAR_SVG}</div><div class="typing-dots"><span></span><span></span><span></span></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// Listeners del chat
resetBtn.addEventListener('click', nuevaConversacion);
sidebarNewBtn.addEventListener('click', nuevaConversacion);

// Auto-resize del textarea y envío con Enter
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = userInput.scrollHeight + 'px';
  const maxH = parseFloat(getComputedStyle(userInput).maxHeight);
  userInput.style.overflowY = userInput.scrollHeight > maxH ? 'auto' : 'hidden';
});
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatForm.requestSubmit(); }
});

// ============================================================
// === ARCHIVOS ===============================================
// ============================================================

/**
 * Registra un archivo como pendiente de envío y actualiza la UI
 * para indicar que hay un adjunto seleccionado.
 * @param {File} archivo
 */
function adjuntarArchivo(archivo) {
  pendingFile = archivo;
  fileLabelName.textContent = archivo.name;
  fileLabel.style.display = 'flex';
  userInput.placeholder = 'Agrega una pregunta o envia sin texto...';
}

/** Elimina el archivo adjunto pendiente y restaura el placeholder del input. */
function quitarArchivo() {
  pendingFile = null;
  fileInput.value = '';
  fileLabel.style.display = 'none';
  userInput.placeholder = 'Escribi tu mensaje...';
}

// Listeners de adjunto por botón
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const archivo = fileInput.files[0];
  if (archivo) adjuntarArchivo(archivo);
});
fileRemoveBtn.addEventListener('click', quitarArchivo);

// Drag & drop sobre el área del chat
const dropOverlay    = document.getElementById('dropOverlay');
const chatContainerEl = document.getElementById('chatContainer');
let dragCounter = 0;

chatContainerEl.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.add('active');
});
chatContainerEl.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); }
});
chatContainerEl.addEventListener('dragover', (e) => e.preventDefault());
chatContainerEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('active');
  const archivo = e.dataTransfer.files[0];
  if (!archivo) return;
  if (!ALLOWED_EXTENSIONS.test(archivo.name)) {
    agregarMensaje('bot', 'Solo se permiten archivos Excel (.xlsx, .xls) o Word (.doc, .docx).');
    return;
  }
  adjuntarArchivo(archivo);
  userInput.focus();
});

// ============================================================
// === UI =====================================================
// ============================================================

/** Muestra la pantalla de login y oculta el shell de la app. */
function mostrarPantallaLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('appShell').style.display = 'none';
}

/**
 * Oculta el login, muestra el shell de la app y pone el nombre
 * del usuario en el header.
 * @param {string} nombreUsuario
 */
function mostrarApp(nombreUsuario) {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appShell').style.display = 'flex';
  document.getElementById('headerUserName').textContent = nombreUsuario || '';
}

/**
 * Muestra la pantalla de Aprendizaje y oculta el header, mensajes e input del chat.
 * Quita el resaltado del ítem activo en la sidebar.
 */
function mostrarPantallaAprendizaje() {
  learningScreen.classList.add('active');
  document.getElementById('messages').style.display = 'none';
  document.querySelector('.chat-input-area').style.display = 'none';
  document.querySelector('.chat-header').style.display = 'none';
  if (activeSidebarItem) activeSidebarItem.classList.remove('active');
  activeSidebarItem = null;
}

/** Cierra la pantalla de Aprendizaje y restaura el chat. */
function ocultarPantallaAprendizaje() {
  learningScreen.classList.remove('active');
  document.getElementById('messages').style.display = '';
  document.querySelector('.chat-input-area').style.display = '';
  document.querySelector('.chat-header').style.display = '';
}

// Listeners de la pantalla de aprendizaje
learningTitleBtn.addEventListener('click', mostrarPantallaAprendizaje);
learningNewBtn.addEventListener('click', mostrarPantallaAprendizaje);
learningBackBtn.addEventListener('click', ocultarPantallaAprendizaje);

// ============================================================
// === HELPERS ================================================
// ============================================================

/** Escapa caracteres especiales de HTML para evitar inyección de contenido. */
function escaparHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/** Retorna la hora actual en formato HH:MM (zona horaria de Argentina). */
function obtenerHora() {
  return new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Formatea un tamaño en bytes a una representación legible (B, KB, MB).
 * @param {number} bytes
 * @returns {string}
 */
function formatearTamañoArchivo(bytes) {
  if (bytes < 1024)          return bytes + ' B';
  if (bytes < 1024 * 1024)   return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Retorna la clase CSS y el texto del ícono según la extensión del archivo.
 * @param {string} ext - Extensión en minúsculas
 * @returns {{ iconClass: string, iconText: string }}
 */
function obtenerIconoArchivo(ext) {
  switch (ext) {
    case 'xlsx': case 'xls': case 'csv': return { iconClass: 'excel', iconText: 'XLS' };
    case 'docx': case 'doc':             return { iconClass: 'word',  iconText: 'DOC' };
    case 'pdf':                          return { iconClass: 'pdf',   iconText: 'PDF' };
    default: return { iconClass: 'other', iconText: ext.toUpperCase().slice(0, 3) };
  }
}

/**
 * Convierte texto con formato markdown simplificado a HTML.
 * Soporta: bold (**), links, tablas y links de descarga (/download/).
 * @param {string} texto
 * @returns {string} HTML sanitizado
 */
function formatearMarkdown(texto) {
  const linksDescarga = [];
  const PLACEHOLDER   = '___DL___';

  // Extraer links de descarga antes de escapar el HTML
  let limpio = texto
    .replace(/[^\n]*\[([^\]]*)\]\((\/download\/[^\s)]+)\)[^\n]*/g, (_, lt, url) => { linksDescarga.push({ url, linkText: lt }); return PLACEHOLDER; })
    .replace(/[^\n]*?(\/download\/[^\s<)]+)[^\n]*/g, (_, url) => { linksDescarga.push({ url, linkText: null }); return PLACEHOLDER; });

  let html = escaparHtml(limpio);
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/(?<!")(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  html = convertirTablas(html);
  html = html.replace(/\n/g, '<br>');

  // Reinsertar links de descarga con botón
  let dlIdx = 0;
  html = html.replace(new RegExp(PLACEHOLDER, 'g'), () => {
    const dl = linksDescarga[dlIdx++];
    if (!dl) return '';
    const fname = decodeURIComponent(dl.url.replace('/download/', ''));
    return `<a href="${dl.url}" download class="download-link">📄 Descargar ${escaparHtml(fname)}</a>`;
  });
  html = html.replace(/(<br>\s*)+(<a [^>]*class="download-link")/g, '$2');
  html = html.replace(/(class="download-link">[^<]*<\/a>)\s*(<br>\s*)+/g, '$1');
  return html;
}

/**
 * Convierte líneas de tabla Markdown (|col|col|) a HTML <table>.
 * Las líneas separadoras (|---|---| ) se ignoran.
 * @param {string} texto - Texto ya pasado por escaparHtml
 * @returns {string}
 */
function convertirTablas(texto) {
  const lineas   = texto.split('\n');
  let enTabla    = false;
  let htmlTabla  = '';
  const resultado = [];

  for (const linea of lineas) {
    const t = linea.trim();
    if (t.startsWith('|') && t.endsWith('|')) {
      if (/^\|[\s-:|]+\|$/.test(t)) continue; // saltar separador
      if (!enTabla) { enTabla = true; htmlTabla = '<table>'; }
      const celdas = t.slice(1, -1).split('|').map((c) => c.trim());
      const etiqueta = htmlTabla === '<table>' ? 'th' : 'td';
      htmlTabla += '<tr>' + celdas.map((c) => `<${etiqueta}>${c}</${etiqueta}>`).join('') + '</tr>';
    } else {
      if (enTabla) { htmlTabla += '</table>'; resultado.push(htmlTabla); htmlTabla = ''; enTabla = false; }
      resultado.push(linea);
    }
  }
  if (enTabla) { htmlTabla += '</table>'; resultado.push(htmlTabla); }
  return resultado.join('\n');
}
