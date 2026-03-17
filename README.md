# Moltbot KarIA

Agente inteligente desarrollado por KarIA. Interfaz tipo chat con capacidades de:

- **Presentaciones**: Genera presentaciones con Gamma y devuelve el link.
- **Búsqueda de competencia**: Busca precios, stock y promociones en fravega.com, oncity.com.ar y genecio.com.ar.

## Requisitos

- Docker y Docker Compose instalados
- API Keys:
  - `ANTHROPIC_API_KEY` — [console.anthropic.com](https://console.anthropic.com)
  - `PERPLEXITY_API_KEY` — [perplexity.ai](https://www.perplexity.ai)
  - `GAMMA_API_KEY` — [gamma.app](https://gamma.app)

## Instalación

1. Cloná el repo y entrá al directorio:

```bash
cd MoltbotKariaV1
```

2. Copiá el archivo de entorno y completá tus API keys:

```bash
cp .env.example .env
```

Editá `.env` y pegá tus keys.

3. Levantá con Docker Compose:

```bash
docker-compose up --build
```

4. Abrí el navegador en:

```
http://localhost:3000
```

## Desarrollo local (sin Docker)

```bash
npm install
npm run dev
```

## Estructura del proyecto

```
├── docker-compose.yml
├── Dockerfile
├── package.json
├── .env.example
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── src/
    ├── server.js
    ├── agent.js
    └── tools/
        ├── gamma.js
        └── perplexity.js
```
