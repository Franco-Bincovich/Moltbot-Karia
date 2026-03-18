const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const fileLabel = document.getElementById('fileLabel');
const fileLabelName = fileLabel.querySelector('.file-label-name');
const fileRemoveBtn = document.getElementById('fileRemoveBtn');

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

// === Welcome message on load ===
(function showWelcome() {
  const div = document.createElement('div');
  div.className = 'message bot welcome-message';
  div.innerHTML = `
    <div class="msg-avatar">${KARIA_AVATAR_SVG}</div>
    <div class="message-bubble">
      <div class="message-content">Hola! Soy <strong>Karia Agent</strong>, tu asistente inteligente. ¿En qué te puedo ayudar?</div>
      <div class="message-meta"><span class="msg-time">${getTimeStr()}</span></div>
    </div>`;
  messagesEl.appendChild(div);
})();

// === Attach file ===
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

// === Textarea auto-resize & Enter/Shift+Enter handling ===
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = userInput.scrollHeight + 'px';
  // Show scrollbar only when hitting max height
  const maxH = parseFloat(getComputedStyle(userInput).maxHeight);
  userInput.style.overflowY = userInput.scrollHeight > maxH ? 'auto' : 'hidden';
});

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

// === Send message ===
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const text = userInput.value.trim();
  if (!text && !pendingFile) return;

  // Show user message
  if (text) {
    appendMessage('user', escapeHtml(text));
  }

  // Show file attachment bubble if present
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

    if (pendingFile) {
      const formData = new FormData();
      formData.append('file', pendingFile);
      formData.append('message', text);
      formData.append('history', JSON.stringify(history));

      res = await fetch('/api/chat', {
        method: 'POST',
        body: formData,
      });
    } else {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
    }

    const data = await res.json();

    if (data.error) {
      appendMessage('bot', `Error: ${escapeHtml(data.error)}`);
    } else {
      const displayText = text || (pendingFile ? `[Excel adjunto: ${pendingFile.name}]` : '');
      history.push({ role: 'user', content: displayText });
      if (data.excelContext) {
        history.push({ role: 'assistant', content: `[EXCEL_DATA]\n${data.excelContext}` });
      }
      history.push({ role: 'assistant', content: data.reply });

      // Process reply — detect download links and render as file bubbles
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
  // Step 1: Extract download links BEFORE escaping.
  // Capture the ENTIRE surrounding line/context to avoid stray text leaking.
  const downloadLinks = [];
  const DOWNLOAD_PLACEHOLDER = '___DOWNLOAD_PLACEHOLDER___';

  // Pattern 1: Full line with optional leading text + markdown link to /download/
  // e.g. "📄 Descargar: [Análisis Completo](/download/file.docx)"
  // e.g. "Acá está tu archivo: [Descargar informe](/download/file.docx)"
  // Captures everything on the line that contains the download link
  let cleaned = text.replace(
    /[^\n]*\[([^\]]*)\]\((\/download\/[^\s)]+)\)[^\n]*/g,
    (match, linkText, url) => {
      downloadLinks.push({ url, linkText });
      return DOWNLOAD_PLACEHOLDER;
    }
  );

  // Pattern 2: Bare /download/ URL (no markdown link), consume the whole line
  // e.g. "Link de descarga: /download/file.docx"
  cleaned = cleaned.replace(
    /[^\n]*?(\/download\/[^\s<)]+)[^\n]*/g,
    (match, url) => {
      downloadLinks.push({ url, linkText: null });
      return DOWNLOAD_PLACEHOLDER;
    }
  );

  let html = escapeHtml(cleaned);

  // Bold **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Links [text](url) — non-download links only
  html = html.replace(
    /\[([^\]]+)\]\(([^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Bare URLs (not already inside href="...")
  html = html.replace(
    /(?<!")(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );

  // Tables
  html = convertTables(html);

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  // Replace download placeholders with a simple clickable link (same style as Gamma)
  let dlIndex = 0;
  html = html.replace(new RegExp(DOWNLOAD_PLACEHOLDER, 'g'), () => {
    const dl = downloadLinks[dlIndex++];
    if (!dl) return '';
    const filename = decodeURIComponent(dl.url.replace('/download/', ''));
    return `<a href="${dl.url}" download class="download-link">📄 Descargar ${escapeHtml(filename)}</a>`;
  });

  // Clean up stray <br> around download links
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
        continue; // skip separator
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
