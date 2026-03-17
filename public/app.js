const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const fileLabel = document.getElementById('fileLabel');

const history = [];
let pendingFile = null;

// Botón de adjuntar dispara el file input oculto
attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  pendingFile = file;
  fileLabel.textContent = `📄 ${file.name}`;
  fileLabel.style.display = 'inline';
  userInput.placeholder = 'Agregá una pregunta o enviá sin texto...';
});

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const text = userInput.value.trim();

  if (!text && !pendingFile) return;

  // Mostrar mensaje del usuario
  const displayText = text || `[Excel adjunto: ${pendingFile.name}]`;
  appendMessage('user', displayText);
  userInput.value = '';
  sendBtn.disabled = true;
  attachBtn.disabled = true;

  const typing = showTyping();

  try {
    let res;

    if (pendingFile) {
      // Enviar como multipart/form-data cuando hay archivo
      const formData = new FormData();
      formData.append('file', pendingFile);
      formData.append('message', text);
      formData.append('history', JSON.stringify(history));

      res = await fetch('/api/chat', {
        method: 'POST',
        body: formData,
      });
    } else {
      // Enviar como JSON para mensajes de texto puros
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
    }

    const data = await res.json();

    if (data.error) {
      appendMessage('bot', `Error: ${data.error}`);
    } else {
      history.push({ role: 'user', content: text || displayText });
      if (data.excelContext) {
        history.push({ role: 'assistant', content: `[EXCEL_DATA]\n${data.excelContext}` });
      }
      history.push({ role: 'assistant', content: data.reply });
      appendMessage('bot', formatMarkdown(data.reply));
    }
  } catch (err) {
    appendMessage('bot', 'Error de conexión con el servidor.');
  } finally {
    // Limpiar archivo adjunto
    pendingFile = null;
    fileInput.value = '';
    fileLabel.style.display = 'none';
    userInput.placeholder = 'Escribí tu mensaje...';

    typing.remove();
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    userInput.focus();
  }
});

function appendMessage(role, content) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const inner = document.createElement('div');
  inner.className = 'message-content';
  if (role === 'bot') {
    inner.innerHTML = content;
  } else {
    inner.textContent = content;
  }
  div.appendChild(inner);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.innerHTML = '<span></span><span></span><span></span>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function formatMarkdown(text) {
  let html = escapeHtml(text);

  // Bold **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener" style="color:#7c6fe0">$1</a>'
  );

  // Bare URLs
  html = html.replace(
    /(?<!")(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener" style="color:#7c6fe0">$1</a>'
  );

  // Download links (/download/filename)
  html = html.replace(
    /(?<!")(\/download\/[^\s<]+)/g,
    '<a href="$1" download style="color:#7c6fe0">$1</a>'
  );

  // Tables
  html = convertTables(html);

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
