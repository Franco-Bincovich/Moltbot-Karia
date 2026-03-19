// === Auth Gate ===
const loginScreen = document.getElementById('loginScreen');
const chatContainer = document.getElementById('chatContainer');
const loginForm = document.getElementById('loginForm');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const headerUserName = document.getElementById('headerUserName');

// Check existing session
const session = JSON.parse(sessionStorage.getItem('karia_session') || 'null');
if (session) {
  showChat(session);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  loginBtn.disabled = true;
  loginBtn.textContent = 'Ingresando...';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: loginEmail.value.trim(),
        password: loginPassword.value,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      loginError.textContent = data.error || 'Error al iniciar sesion.';
      return;
    }

    // Save session
    sessionStorage.setItem('karia_session', JSON.stringify(data));
    showChat(data);
  } catch (err) {
    loginError.textContent = 'Error de conexion con el servidor.';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Iniciar sesion';
  }
});

logoutBtn.addEventListener('click', async () => {
  const currentSession = JSON.parse(sessionStorage.getItem('karia_session') || 'null');
  if (currentSession?.sesion_id) {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sesion_id: currentSession.sesion_id }),
      });
    } catch (e) { /* ignore */ }
  }
  sessionStorage.removeItem('karia_session');
  loginScreen.style.display = 'flex';
  chatContainer.style.display = 'none';
  loginEmail.value = '';
  loginPassword.value = '';
  loginError.textContent = '';
  // Clear chat state
  messagesEl.innerHTML = '';
  history.length = 0;
});

function showChat(userData) {
  loginScreen.style.display = 'none';
  chatContainer.style.display = 'flex';
  headerUserName.textContent = userData.nombre;
  initChat();
}

// === Chat App (only runs after login) ===
let chatInitialized = false;
let messagesEl, chatForm, userInput, sendBtn, attachBtn, fileInput, fileLabel, fileLabelName, fileRemoveBtn;
const history = [];
let pendingFile = null;

// === KarIA mini avatar SVG (for bot messages) ===
const KARIA_AVATAR_SVG = `<svg viewBox="0 0 28 28" width="28" height="28">
  <circle cx="14" cy="14" r="14" fill="#fff"/>
  <circle cx="10" cy="7" r="1.8" fill="#43D1C9"/>
  <circle cx="18" cy="7" r="1.8" fill="#43D1C9"/>
  <path d="M7 10 Q14 16 21 10" stroke="#43D1C9" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <text x="5" y="22" font-family="Baloo 2, sans-serif" font-size="9.5" font-weight="600" fill="#081C54">kar</text>
  <text x="17.5" y="22" font-family="Baloo 2, sans-serif" font-size="9.5" font-weight="600" fill="#43D1C9">ia</text>
</svg>`;

function initChat() {
  if (chatInitialized) return;
  chatInitialized = true;

  messagesEl = document.getElementById('messages');
  chatForm = document.getElementById('chatForm');
  userInput = document.getElementById('userInput');
  sendBtn = document.getElementById('sendBtn');
  attachBtn = document.getElementById('attachBtn');
  fileInput = document.getElementById('fileInput');
  fileLabel = document.getElementById('fileLabel');
  fileLabelName = fileLabel.querySelector('.file-label-name');
  fileRemoveBtn = document.getElementById('fileRemoveBtn');
  const resetBtn = document.getElementById('resetBtn');

  // Reset conversation
  resetBtn.addEventListener('click', async () => {
    // Log reset to Supabase
    const sess = JSON.parse(sessionStorage.getItem('karia_session') || 'null');
    if (sess?.usuario_id && sess?.sesion_id) {
      try {
        await fetch('/api/chat-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sesion_id: sess.sesion_id,
            usuario_id: sess.usuario_id,
            rol: 'system',
            contenido: '--- Conversación reiniciada ---',
          }),
        });
      } catch (e) { /* ignore */ }
    }

    // Clear chat
    messagesEl.innerHTML = '';
    history.length = 0;
    pendingFile = null;
    fileInput.value = '';
    fileLabel.style.display = 'none';
    userInput.placeholder = 'Escribi tu mensaje...';

    // Show reset indicator + welcome
    const resetDiv = document.createElement('div');
    resetDiv.className = 'chat-reset-indicator';
    resetDiv.textContent = 'Conversacion reiniciada';
    messagesEl.appendChild(resetDiv);

    const div = document.createElement('div');
    div.className = 'message bot welcome-message';
    div.innerHTML = `
      <div class="msg-avatar">${KARIA_AVATAR_SVG}</div>
      <div class="message-bubble">
        <div class="message-content">Hola! Soy <strong>Karia Agent</strong>, tu asistente inteligente. ¿En qué te puedo ayudar?</div>
        <div class="message-meta"><span class="msg-time">${getTimeStr()}</span></div>
      </div>`;
    messagesEl.appendChild(div);
    userInput.focus();
  });

  // Welcome message
  const div = document.createElement('div');
  div.className = 'message bot welcome-message';
  div.innerHTML = `
    <div class="msg-avatar">${KARIA_AVATAR_SVG}</div>
    <div class="message-bubble">
      <div class="message-content">Hola! Soy <strong>Karia Agent</strong>, tu asistente inteligente. ¿En qué te puedo ayudar?</div>
      <div class="message-meta"><span class="msg-time">${getTimeStr()}</span></div>
    </div>`;
  messagesEl.appendChild(div);

  // Drag & drop
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
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.classList.remove('active');
    }
  });

  chatContainerEl.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

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

  // Attach file
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

  // Textarea auto-resize & Enter/Shift+Enter handling
  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = userInput.scrollHeight + 'px';
    const maxH = parseFloat(getComputedStyle(userInput).maxHeight);
    userInput.style.overflowY = userInput.scrollHeight > maxH ? 'auto' : 'hidden';
  });

  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  // Send message
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const text = userInput.value.trim();
    if (!text && !pendingFile) return;

    if (text) {
      appendMessage('user', escapeHtml(text));
    }

    if (pendingFile) {
      appendFileBubble('user', pendingFile.name, formatFileSize(pendingFile.size));
    }

    userInput.value = '';
    userInput.style.height = 'auto';
    sendBtn.disabled = true;
    attachBtn.disabled = true;

    const typing = showTyping();

    try {
      let res;

      const currentSession = JSON.parse(sessionStorage.getItem('karia_session') || 'null');
      const usuarioId = currentSession?.usuario_id || null;
      const sesionId = currentSession?.sesion_id || null;

      if (pendingFile) {
        const formData = new FormData();
        formData.append('file', pendingFile);
        formData.append('message', text);
        formData.append('history', JSON.stringify(history));
        if (usuarioId) formData.append('usuario_id', usuarioId);
        if (sesionId) formData.append('sesion_id', sesionId);

        res = await fetch('/api/chat', {
          method: 'POST',
          body: formData,
        });
      } else {
        res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, history, usuario_id: usuarioId, sesion_id: sesionId }),
        });
      }

      const data = await res.json();

      if (data.error) {
        appendMessage('bot', `Error: ${escapeHtml(data.error)}`);
      } else {
        const displayText = text || (pendingFile ? `[Archivo adjunto: ${pendingFile.name}]` : '');
        history.push({ role: 'user', content: displayText });
        if (data.excelContext) {
          history.push({ role: 'assistant', content: `[EXCEL_DATA]\n${data.excelContext}` });
        }
        if (data.wordContext) {
          history.push({ role: 'assistant', content: `[WORD_DATA]\n${data.wordContext}` });
        }
        history.push({ role: 'assistant', content: data.reply });

        const replyHtml = formatMarkdown(data.reply);
        appendMessage('bot', replyHtml);
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
}

// === Append text message ===
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

// === Append file attachment bubble ===
function appendFileBubble(role, fileName, fileSize, downloadUrl) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const time = getTimeStr();
  const ext = fileName.split('.').pop().toLowerCase();
  const { iconClass, iconText } = getFileIconInfo(ext);

  const downloadBtn = downloadUrl
    ? `<a href="${downloadUrl}" download class="file-download-btn" title="Descargar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </a>`
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
          </div>
          ${downloadBtn}
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

// === Typing indicator ===
function showTyping() {
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.innerHTML = `
    <div class="typing-avatar">${KARIA_AVATAR_SVG}</div>
    <div class="typing-dots"><span></span><span></span><span></span></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// === Markdown formatting ===
function formatMarkdown(text) {
  const downloadLinks = [];
  const DOWNLOAD_PLACEHOLDER = '___DOWNLOAD_PLACEHOLDER___';

  let cleaned = text.replace(
    /[^\n]*\[([^\]]*)\]\((\/download\/[^\s)]+)\)[^\n]*/g,
    (match, linkText, url) => {
      downloadLinks.push({ url, linkText });
      return DOWNLOAD_PLACEHOLDER;
    }
  );

  cleaned = cleaned.replace(
    /[^\n]*?(\/download\/[^\s<)]+)[^\n]*/g,
    (match, url) => {
      downloadLinks.push({ url, linkText: null });
      return DOWNLOAD_PLACEHOLDER;
    }
  );

  let html = escapeHtml(cleaned);

  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  html = html.replace(
    /\[([^\]]+)\]\(([^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  html = html.replace(
    /(?<!")(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );

  html = convertTables(html);

  html = html.replace(/\n/g, '<br>');

  let dlIndex = 0;
  html = html.replace(new RegExp(DOWNLOAD_PLACEHOLDER, 'g'), () => {
    const dl = downloadLinks[dlIndex++];
    if (!dl) return '';
    const filename = decodeURIComponent(dl.url.replace('/download/', ''));
    return `<a href="${dl.url}" download class="download-link">📄 Descargar ${escapeHtml(filename)}</a>`;
  });

  html = html.replace(/(<br>\s*)+(<a [^>]*class="download-link")/g, '$2');
  html = html.replace(/(class="download-link">[^<]*<\/a>)\s*(<br>\s*)+/g, '$1');

  return html;
}

// === Helpers ===

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getTimeStr() {
  const now = new Date();
  return now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileIconInfo(ext) {
  switch (ext) {
    case 'xlsx': case 'xls': case 'csv':
      return { iconClass: 'excel', iconText: 'XLS' };
    case 'docx': case 'doc':
      return { iconClass: 'word', iconText: 'DOC' };
    case 'pdf':
      return { iconClass: 'pdf', iconText: 'PDF' };
    default:
      return { iconClass: 'other', iconText: ext.toUpperCase().slice(0, 3) };
  }
}

function convertTables(text) {
  const lines = text.split('\n');
  let inTable = false;
  let tableHtml = '';
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (/^\|[\s-:|]+\|$/.test(trimmed)) {
        continue;
      }
      if (!inTable) {
        inTable = true;
        tableHtml = '<table>';
      }
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      const tag = tableHtml === '<table>' ? 'th' : 'td';
      tableHtml += '<tr>' + cells.map((c) => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    } else {
      if (inTable) {
        tableHtml += '</table>';
        result.push(tableHtml);
        tableHtml = '';
        inTable = false;
      }
      result.push(line);
    }
  }

  if (inTable) {
    tableHtml += '</table>';
    result.push(tableHtml);
  }

  return result.join('\n');
}
