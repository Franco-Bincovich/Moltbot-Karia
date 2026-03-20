FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

EXPOSE 3000

# === Health Check ===
#
# Docker ejecuta este comando periódicamente para verificar que el servidor
# esté respondiendo. Si falla 3 veces seguidas, Docker marca el container
# como "unhealthy" y el restart policy (unless-stopped) lo reinicia.
#
# Parámetros:
#   --interval=30s     → Ejecutar el chequeo cada 30 segundos
#   --timeout=10s      → Si el request no responde en 10 segundos, contar como fallo
#   --retries=3        → Marcar unhealthy después de 3 fallos consecutivos (no al primero)
#   --start-period=15s → Esperar 15 segundos después del arranque antes del primer chequeo,
#                        dando tiempo a que el servidor inicie y conecte a Supabase
#
# Usa wget en vez de curl porque node:20-alpine no incluye curl por defecto.
# Apunta a GET /health (público, sin auth) que solo devuelve { status: "ok" }.
# Las métricas detalladas están en GET /api/status (requiere JWT).
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
