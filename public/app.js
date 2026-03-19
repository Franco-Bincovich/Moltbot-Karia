// === DOM refs ===
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const fileLabel = document.getElementById('fileLabel');
const fileLabelName = fileLabel.querySelector('.file-label-name');
const fileRemoveBtn = document.getElementById('fileRemoveBtn');
const resetBtn = document.getElementById('resetBtn');
const sidebarList = document.getElementById('sidebarList');
const sidebarNewBtn = document.getElementById('sidebarNewBtn');

// === State ===
const history = [];
let pendingFile = null;
let currentSesionId = null;  // tracks current session in Supabase
let activeSidebarItem = null;

// === KarIA avatar ===
const KARIA_AVATAR_SVG = `<svg viewBox="0 0 28 28" width="28" height="28">
  <circle cx="14" cy="14" r="14" fill="#fff"/>
  <circle cx="10" cy="7" r="1.8" fill="#43D1C9"/>
  <circle cx="18" cy="7" r="1.8" fill="#43D1C9"/>
  <path d="M7 10 Q14 16 21 10" stroke="#43D1C9" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <text x="5" y="22" font-family="Baloo 2, sans-serif" font-size="9.5" font-weight="600" fill="#081C54">kar</text>
  <text x="17.5" y="22" font-family="Baloo 2, sans-serif" font-size="9.5" font-weight="600" fill="#43D1C9">ia</text>
</svg>`;

// === Sidebar ===

async function loadSidebar(selectId = null) {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();

    if (!Array.isArray(sessions) || sessions.length === 0) {
      sidebarList.innerHTML = '<div class="sidebar-empty">Sin conversaciones</div>';
      return;
    }

    sidebarList.innerHTML = '';
    activeSidebarItem = null;

    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'sidebar-item';
      item.dataset.id = s.id;

      const date = new Date(s.iniciada_at).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
      item.innerHTML = `
        <span class="sidebar-item-name">${escapeHtml(s.nombre || 'Conversación')}</span>
        <span class="sidebar-item-date">${date}</span>`;

      item.addEventListener('click', () => selectSession(s.id, item));
      sidebarList.appendChild(item);

      if (selectId && s.id === selectId) {
        item.classList.add('active');
        activeSidebarItem = item;
      }
    }
  } catch (err) {
    console.error('[sidebar] Error cargando sesiones:', err);
    sidebarList.innerHTML = '<div class="sidebar-empty">Error al cargar</div>';
  }
}

async function selectSession(sesionId, itemEl) {
  // Update active state in sidebar
  if (activeSidebarItem) activeSidebarItem.classList.remove('active');
  itemEl.classList.add('active');
  activeSidebarItem = itemEl;

  // Reset chat state
  currentSesionId = sesionId;
  history.length = 0;
  pendingFile = null;
  fileInput.value = '';
  fileLabel.style.display = 'none';
  userInput.placeholder = 'Escribi tu mensaje...';
  messagesEl.innerHTML = '';

  // Load messages from server
  try {
    const res = await fetch(`/api/sessions/${sesionId}/messages`);
    const messages = await res.json();

    console.log(`[app] Mensajes recibidos para sesión ${sesionId}:`, messages);

    if (!Array.isArray(messages) || messages.length === 0) {
      showWelcome();
      return;
    }

    for (const m of messages) {
      if (m.rol === 'user') {
        appendMessage('user', escapeHtml(m.contenido));
        history.push({ role: 'user', content: m.contenido });
      } else if (m.rol === 'assistant') {
        appendMessage('bot', formatMarkdown(m.contenido));
        history.push({ role: 'assistant', content: m.contenido });
      }
    }
  } catch (err) {
    console.error('[sidebar] Error cargando mensajes:', err);
    appendMessage('bot', 'Error al cargar la conversación.');
  }
}

// === New conversation ===
function startNewConversation() {
  currentSesionId = null;
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

  showWelcome();
  userInput.focus();
}

function showWelcome() {
  const div = document.createElement('div');
  div.className = 'message bot welcome-message';
  div.innerHTML = `
    <div class="msg-avatar">${KARIA_AVATAR_SVG}</div>
    <div class="message-bubble">
      <div class="message-content">Hola! Soy <strong>Karia Agent</strong>, tu asistente inteligente. ¿En qué te puedo ayudar?</div>
      <div class="message-meta"><span class="msg-time">${getTimeStr()}</span></div>
    </div>`;
  messagesEl.appendChild(div);
}

// Init
showWelcome();
loadSidebar();

resetBtn.addEventListener('click', startNewConversation);
sidebarNewBtn.addEventListener('click', startNewConversation);

// === Drag & drop ===
const dropOverlay = document.getElementById('dropOverlay');
const chatContainerEl = document.getElementById('chatContainer');
const ALLOWED_EXTENSIONS = /\.(xlsx|xls|doc|docx)$/i;
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
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!ALLOWED_EXTENSIONS.test(file.name)) {
    appendMessage('bot', 'Solo se permiten archivos Excel (.xlsx, .xls) o Word (.doc, .docx).');
    return;
  }
  pendingFile = file;
  fileLabelName.textContent = file.name;
  fileLabel.style.display = 'flex';
  userInput.placeholder = 'Agrega una pregunta o envia sin texto...';
  userInput.focus();
});

// === File attach ===
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  pendingFile = file;
  fileLabelName.textContent = file.name;
  fileLabel.style.display = 'flex';
  userInput.placeholder = 'Agrega una pregunta o envia sin texto...';
});
fileRemoveBtn.addEventListener('click', () => {
  pendingFile = null;
  fileInput.value = '';
  fileLabel.style.display = 'none';
  userInput.placeholder = 'Escribi tu mensaje...';
});

// === Textarea resize & Enter ===
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = userInput.scrollHeight + 'px';
  const maxH = parseFloat(getComputedStyle(userInput).maxHeight);
  userInput.style.overflowY = userInput.scrollHeight > maxH ? 'auto' : 'hidden';
});
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatForm.requestSubmit(); }
});

// === Send message ===
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const text = userInput.value.trim();
  if (!text && !pendingFile) return;

  if (text) appendMessage('user', escapeHtml(text));
  if (pendingFile) appendFileBubble('user', pendingFile.name, formatFileSize(pendingFile.size));

  userInput.value = '';
  userInput.style.height = 'auto';
  sendBtn.disabled = true;
  attachBtn.disabled = true;

  const typing = showTyping();

  try {
    // Create session on first message of a new conversation
    if (!currentSesionId && text) {
      try {
        const sessionRes = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ firstMessage: text }),
        });
        if (sessionRes.ok) {
          const session = await sessionRes.json();
          currentSesionId = session.id;
          console.log(`[app] Sesión creada: ${currentSesionId} "${session.nombre}"`);
          // Refresh sidebar and mark new session as active
          await loadSidebar(currentSesionId);
        }
      } catch (err) {
        console.warn('[app] No se pudo crear sesión:', err.message);
      }
    }

    let res;
    if (pendingFile) {
      const formData = new FormData();
      formData.append('file', pendingFile);
      formData.append('message', text);
      formData.append('history', JSON.stringify(history));
      if (currentSesionId) formData.append('sesion_id', currentSesionId);
      res = await fetch('/api/chat', { method: 'POST', body: formData });
    } else {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, sesion_id: currentSesionId }),
      });
    }

    const data = await res.json();

    if (data.error) {
      appendMessage('bot', `Error: ${escapeHtml(data.error)}`);
    } else {
      const displayText = text || (pendingFile ? `[Archivo: ${pendingFile.name}]` : '');
      history.push({ role: 'user', content: displayText });
      if (data.excelContext) history.push({ role: 'assistant', content: `[EXCEL_DATA]\n${data.excelContext}` });
      if (data.wordContext) history.push({ role: 'assistant', content: `[WORD_DATA]\n${data.wordContext}` });
      history.push({ role: 'assistant', content: data.reply });
      appendMessage('bot', formatMarkdown(data.reply));
    }
  } catch (err) {
    appendMessage('bot', 'Error de conexion con el servidor.');
  } finally {
    pendingFile = null;
    fileInput.value = '';
    fileLabel.style.display = 'none';
    userInput.placeholder = 'Escribi tu mensaje...';
    typing.remove();
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    userInput.focus();
  }
});

// === Append messages ===
function appendMessage(role, contentHtml) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const time = getTimeStr();
  if (role === 'bot') {
    div.innerHTML = `
      <div class="msg-avatar">${KARIA_AVATAR_SVG}</div>
      <div class="message-bubble">
        <div class="message-content">${contentHtml}</div>
        <div class="message-meta"><span class="msg-time">${time}</span></div>
      </div>`;
  } else {
    div.innerHTML = `
      <div class="message-bubble">
        <div class="message-content">${contentHtml}</div>
        <div class="message-meta">
          <span class="msg-time">${time}</span>
          <span class="msg-ticks">&#10003;&#10003;</span>
        </div>
      </div>`;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendFileBubble(role, fileName, fileSize, downloadUrl) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const time = getTimeStr();
  const ext = fileName.split('.').pop().toLowerCase();
  const { iconClass, iconText } = getFileIconInfo(ext);
  const downloadBtn = downloadUrl
    ? `<a href="${downloadUrl}" download class="file-download-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>`
    : '';
  const statusText = downloadUrl ? 'Listo para descargar' : '';

  if (role === 'bot') {
    div.innerHTML = `
      <div class="msg-avatar">${KARIA_AVATAR_SVG}</div>
      <div class="message-bubble">
        <div class="file-bubble">
          <div class="file-icon ${iconClass}">${iconText}</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(fileName)}</div>
            <div class="file-size">${fileSize}</div>
            ${statusText ? `<div class="file-status">${statusText}</div>` : ''}
          </div>${downloadBtn}
        </div>
        <div class="message-meta"><span class="msg-time">${time}</span></div>
      </div>`;
  } else {
    div.innerHTML = `
      <div class="message-bubble">
        <div class="file-bubble">
          <div class="file-icon ${iconClass}">${iconText}</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(fileName)}</div>
            <div class="file-size">${fileSize}</div>
          </div>
        </div>
        <div class="message-meta">
          <span class="msg-time">${time}</span>
          <span class="msg-ticks">&#10003;&#10003;</span>
        </div>
      </div>`;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.innerHTML = `<div class="typing-avatar">${KARIA_AVATAR_SVG}</div><div class="typing-dots"><span></span><span></span><span></span></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// === Markdown ===
function formatMarkdown(text) {
  const downloadLinks = [];
  const PLACEHOLDER = '___DL___';

  let cleaned = text
    .replace(/[^\n]*\[([^\]]*)\]\((\/download\/[^\s)]+)\)[^\n]*/g, (_, lt, url) => { downloadLinks.push({ url, linkText: lt }); return PLACEHOLDER; })
    .replace(/[^\n]*?(\/download\/[^\s<)]+)[^\n]*/g, (_, url) => { downloadLinks.push({ url, linkText: null }); return PLACEHOLDER; });

  let html = escapeHtml(cleaned);
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/(?<!")(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  html = convertTables(html);
  html = html.replace(/\n/g, '<br>');

  let dlIdx = 0;
  html = html.replace(new RegExp(PLACEHOLDER, 'g'), () => {
    const dl = downloadLinks[dlIdx++];
    if (!dl) return '';
    const fname = decodeURIComponent(dl.url.replace('/download/', ''));
    return `<a href="${dl.url}" download class="download-link">📄 Descargar ${escapeHtml(fname)}</a>`;
  });
  html = html.replace(/(<br>\s*)+(<a [^>]*class="download-link")/g, '$2');
  html = html.replace(/(class="download-link">[^<]*<\/a>)\s*(<br>\s*)+/g, '$1');
  return html;
}

// === Helpers ===
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
function getTimeStr() {
  return new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function getFileIconInfo(ext) {
  switch (ext) {
    case 'xlsx': case 'xls': case 'csv': return { iconClass: 'excel', iconText: 'XLS' };
    case 'docx': case 'doc': return { iconClass: 'word', iconText: 'DOC' };
    case 'pdf': return { iconClass: 'pdf', iconText: 'PDF' };
    default: return { iconClass: 'other', iconText: ext.toUpperCase().slice(0, 3) };
  }
}
function convertTables(text) {
  const lines = text.split('\n');
  let inTable = false, tableHtml = '';
  const result = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('|') && t.endsWith('|')) {
      if (/^\|[\s-:|]+\|$/.test(t)) continue;
      if (!inTable) { inTable = true; tableHtml = '<table>'; }
      const cells = t.slice(1, -1).split('|').map((c) => c.trim());
      const tag = tableHtml === '<table>' ? 'th' : 'td';
      tableHtml += '<tr>' + cells.map((c) => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    } else {
      if (inTable) { tableHtml += '</table>'; result.push(tableHtml); tableHtml = ''; inTable = false; }
      result.push(line);
    }
  }
  if (inTable) { tableHtml += '</table>'; result.push(tableHtml); }
  return result.join('\n');
}
