# Karia Agent

Agente inteligente conversacional con interfaz web de chat. Integra Claude (Anthropic) como motor de razonamiento con herramientas de productividad: búsqueda de precios, análisis de archivos, generación de documentos, email, calendario y drive.

Desarrollado por KarIA.

---

## Capacidades del agente

### Búsqueda de precios
- Busca precios de electrodomésticos en comercios de Córdoba Argentina
- Usa Claude Haiku con web_search nativa para obtener datos actualizados
- Genera tabla comparativa con tienda, precio y link exacto del producto
- Soporta búsqueda libre o en tiendas específicas ("buscá en Frávega")

### Análisis de archivos
- **Excel (.xlsx, .xls):** parsea el contenido y lo pasa a Claude para análisis (horas, costos, rankings, comparativas)
- **Word (.doc, .docx):** extrae el texto con mammoth y lo incluye como contexto de la conversación
- Soporta adjuntar archivos por botón o drag & drop

### Generación de documentos
- **Word (.docx):** genera documentos con títulos, bold, bullets a partir de markdown
- **Excel (.xlsx):** genera planillas con headers estilizados y auto-ajuste de columnas
- Los archivos se suben a Supabase Storage y se comparten via URL firmada (2h)

### Presentaciones con Gamma
- Genera presentaciones profesionales via Gamma API
- El agente pregunta tema y estilo (Formal, Moderno, Minimalista) antes de generar
- Descarga el PDF y lo sube a Storage para enviar por email si el usuario lo pide

### Gmail
- Leer emails no leídos con detección de adjuntos
- Buscar emails con operadores de Gmail (from:, subject:, etc.)
- Enviar emails con soporte para adjuntos (PDFs, Word, Excel desde Storage)
- Búsqueda automática de contactos antes de enviar (Google People API)

### Google Calendar
- Ver eventos de hoy o de los próximos N días
- Crear eventos con invitados y Google Meet
- Detección de conflictos de horario antes de crear (incluye eventos nocturnos)
- Eliminar eventos por ID
- Zona horaria Argentina (America/Argentina/Buenos_Aires)

### Google Drive
- Listar archivos con búsqueda por nombre
- Leer contenido de Google Docs, Sheets y archivos de texto
- Subir archivos al Drive del usuario

### Contactos
- Búsqueda de contactos en Google People API por nombre
- Resolución automática de email al enviar ("mandále a Hernán")

### Interfaz web
- Login con JWT y roles (admin, document_analyst)
- Sidebar con historial de conversaciones persistentes en Supabase
- Drag & drop de archivos Excel y Word
- Textarea multilínea (Shift+Enter para salto, Enter para enviar)
- Botón de nueva conversación

---

## Arquitectura

```
├── public/                     Frontend (SPA estática)
│   ├── index.html              Login + sidebar + chat + pantalla aprendizaje
│   ├── style.css               Design system KarIA
│   └── app.js                  Auth, sesiones, chat, drag & drop, markdown
│
├── src/
│   ├── server.js               Servidor Express: rutas, auth JWT, middlewares, Supabase
│   ├── agent.js                Agente Claude: system prompt, 13 tools, tool-use loop
│   │
│   ├── config/
│   │   ├── supabase.js         Cliente Supabase singleton con timeout y pooling
│   │   └── cola.js             Cola de requests con concurrencia limitada
│   │
│   ├── utils/
│   │   ├── logger.js           Logger centralizado [timestamp] [NIVEL] [módulo]
│   │   ├── reintentos.js       Retry con backoff exponencial para errores transitorios
│   │   ├── circuitBreaker.js   Circuit breaker (CERRADO → ABIERTO → SEMI_ABIERTO)
│   │   ├── storage.js          Upload a Supabase Storage con URLs firmadas
│   │   └── limpiarTmp.js       Limpieza periódica de archivos en /tmp
│   │
│   ├── tools/
│   │   ├── search.js           Búsqueda de precios (Claude Haiku + web_search)
│   │   ├── gamma.js            Presentaciones (Gamma API + descarga PDF)
│   │   ├── excel.js            Parsing y análisis de Excel (Claude Sonnet)
│   │   ├── export.js           Generación de Word y Excel
│   │   └── google/
│   │       ├── auth.js         OAuth2 client singleton (5 scopes)
│   │       ├── gmail.js        Email: leer, buscar, enviar con adjuntos MIME
│   │       ├── calendar.js     Eventos: CRUD, conflictos, Meet, timezone AR
│   │       ├── drive.js        Archivos: listar, leer, subir
│   │       └── contactos_gmail.js  Búsqueda en Google People API
│   │
│   └── middlewares/
│       ├── validaciones.js     Reglas express-validator por endpoint
│       └── manejarErroresValidacion.js  Respuestas 400 uniformes
│
├── scripts/
│   ├── generarHash.js          Genera hash bcrypt para testing
│   ├── hashPasswords.js        Migración MD5 → bcrypt(md5) (legacy)
│   ├── migrarBcryptPuro.js     Migración bcrypt(md5) → bcrypt puro
│   ├── setupRLS.sql            Políticas Row Level Security en Supabase
│   └── setupStorage.sql        Creación de buckets en Supabase Storage
│
├── Dockerfile                  Container con health check
├── docker-compose.yml          Orquestación con restart policy
├── .env.example                Template de variables de entorno
└── package.json                Dependencias y scripts npm
```

---

## Requisitos

- **Node.js** 20 o superior
- **npm** 9 o superior
- **Docker** (opcional, para deploy containerizado)
- Cuenta en **Anthropic** (API key para Claude)
- Cuenta en **Supabase** (base de datos + Storage)
- Cuenta en **Google Cloud** (OAuth2 para Gmail, Calendar, Drive, People)
- Cuenta en **Gamma** (API key para presentaciones, opcional)

---

## Variables de entorno

Copiar `.env.example` a `.env` y completar:

| Variable | Descripción |
|---|---|
| `ANTHROPIC_API_KEY` | API key de Anthropic para Claude Sonnet y Haiku |
| `GAMMA_API_KEY` | API key de Gamma para generar presentaciones (opcional) |
| `PORT` | Puerto del servidor (default 3000) |
| `JWT_SECRET` | Secret para firmar tokens JWT. Mínimo 32 caracteres. Generar con: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `GOOGLE_CLIENT_ID` | Client ID de OAuth2 de Google Cloud |
| `GOOGLE_CLIENT_SECRET` | Client Secret de OAuth2 de Google Cloud |
| `GOOGLE_REDIRECT_URI` | Redirect URI configurada en Google Cloud (default `http://localhost:3000/auth/google/callback`) |
| `GOOGLE_REFRESH_TOKEN` | Refresh token obtenido via el flujo OAuth2. Ejecutar `node get_google_token.js` para generarlo |
| `SUPABASE_URL` | URL del proyecto Supabase (ej: `https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Service role key de Supabase (bypasea RLS). Obtener en Dashboard > Settings > API |

---

## Instalación y arranque

### Desarrollo local

```bash
# 1. Clonar el repositorio
git clone <url-del-repo>
cd MoltbotKariaV1

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Editar .env con las API keys reales

# 4. Configurar Supabase (una sola vez)
# Ejecutar en el SQL Editor de Supabase:
#   - scripts/setupRLS.sql (políticas de seguridad)
#   - scripts/setupStorage.sql (buckets para archivos)

# 5. Obtener refresh token de Google (una sola vez)
node get_google_token.js

# 6. Arrancar el servidor
npm run dev
# El servidor arranca en http://localhost:3000
```

### Docker

```bash
# Arrancar con docker-compose
docker-compose up -d

# Ver logs
docker-compose logs -f

# El health check verifica /health cada 30 segundos
```

---

## Seguridad implementada

### Autenticación y autorización
- JWT con HS256 explícito, 8h de expiración, secret validado al arrancar (min 32 chars)
- Roles: `admin` (acceso completo) y `document_analyst` (solo análisis de archivos)
- Passwords con bcrypt 12 rounds puro
- Endpoint de reset-password con respuesta anti-enumeración de emails

### Protección de endpoints
- Helmet con CSP (Content Security Policy) configurado por directive
- 4 rate limiters: login (10/15min), API (100/15min), chat (30/15min), download (20/15min)
- Cola de requests: 10 concurrentes, 100 en espera, 5 per-usuario, timeout 30s
- express-validator en login, sesiones, chat y reset-password
- Body JSON limitado a 100KB, uploads a 10MB

### Prevención de inyecciones
- SQL injection: queries parametrizadas en Supabase
- XSS: escapado HTML en frontend + validación de protocolos en links + CSP
- Header injection: validación de `\r\n` en campos `to` y `subject` de emails
- SSRF: validación de URLs (HTTPS, no IPv6, no IPs privadas/decimales)
- ReDoS: truncamiento a 10K chars antes de regex
- Prompt injection: delimitadores explícitos entre datos de archivos y mensaje del usuario

### Filesystem
- Path traversal: `path.basename()` + validación + auth
- Filenames con 128 bits de entropía
- Storage externo: Supabase Storage con URLs firmadas (2h)
- Limpieza de /tmp: post-descarga + periódica cada 30 min

### Resiliencia
- Circuit breaker en Anthropic, Gmail, Calendar y Drive
- Reintentos con backoff exponencial para errores transitorios
- Timeouts en todas las APIs (15-60s)
- Process handlers: unhandledRejection, uncaughtException, SIGTERM, SIGINT
- Docker health check con restart unless-stopped

### Logging
- Logger centralizado en 100% del proyecto
- 4 niveles: INFO, WARN, ERROR, FATAL
- Secrets nunca logueados

---

## Scripts disponibles

| Script | Uso | Descripción |
|---|---|---|
| `scripts/generarHash.js` | `node scripts/generarHash.js` | Genera y verifica un hash bcrypt para testing |
| `scripts/hashPasswords.js` | `node scripts/hashPasswords.js` | Migra passwords de MD5 a bcrypt(md5). Legacy, usar migrarBcryptPuro.js en su lugar |
| `scripts/migrarBcryptPuro.js` | `node scripts/migrarBcryptPuro.js` | Marca usuarios para reset de password (migración a bcrypt puro) |
| `scripts/setupRLS.sql` | SQL Editor de Supabase | Crea políticas Row Level Security en sesiones, conversaciones, listas_contactos y contactos |
| `scripts/setupStorage.sql` | SQL Editor de Supabase | Crea buckets privados "documentos" y "presentaciones" en Supabase Storage |

---

## Tablas en Supabase

| Tabla | Descripción |
|---|---|
| `usuarios` | Usuarios del sistema: email, nombre, rol, password_hash, needs_password_reset |
| `sesiones` | Conversaciones: nombre generado por IA, usuario_id, timestamps |
| `conversaciones` | Mensajes: rol (user/assistant/system), contenido, sesion_id |
| `listas_contactos` | Listas de contactos por usuario |
| `contactos` | Contactos: nombre, email, lista_id |

---

## Tecnologías

| Componente | Tecnología |
|---|---|
| Backend | Node.js + Express |
| Agente IA | Claude Sonnet 4 (Anthropic) |
| Búsqueda web | Claude Haiku + web_search nativa |
| Base de datos | Supabase (PostgreSQL) |
| Storage | Supabase Storage |
| Google APIs | Gmail, Calendar, Drive, People (OAuth2) |
| Presentaciones | Gamma API |
| Auth | JWT (jsonwebtoken) + bcrypt |
| Seguridad | helmet, express-rate-limit, express-validator |
| Parsing | xlsx, mammoth, docx, exceljs |
| Deploy | Docker + docker-compose |
