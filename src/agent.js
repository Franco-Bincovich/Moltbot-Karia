const Anthropic = require('@anthropic-ai/sdk');
const { searchCompetitors } = require('./tools/perplexity');
const { generatePresentation } = require('./tools/gamma');

const client = new Anthropic();

const SYSTEM_PROMPT = `Sos Moltbot KarIA, un agente inteligente desarrollado por KarIA.

REGLAS:
- Siempre respondés en español.
- Tono profesional y directo.
- No inventás datos, solo reportás lo que encontrás.
- No realizás compras ni accedés a sitios con login.
- Si el usuario menciona un producto (aunque sea en términos generales como "lavarropas Samsung 9kg"), buscás directamente sin pedir más detalles.

CAPACIDADES:
1. **Presentaciones**: Podés generar presentaciones usando Gamma. Cuando el usuario pida una presentación, usá la herramienta "generate_presentation".
2. **Búsqueda de competencia**: Podés buscar precios, stock y promociones de electrodomésticos en fravega.com, oncity.com.ar y genecio.com.ar usando la herramienta "search_competitors". Devolvé siempre una tabla comparativa.

Cuando necesites usar una herramienta, invocala. No simules resultados.`;

const TOOLS = [
  {
    name: 'search_competitors',
    description:
      'Busca precios, stock y promociones de un electrodoméstico en fravega.com, oncity.com.ar y geneciohogar.com.ar. Devuelve una tabla comparativa. Usá esta herramienta siempre que el usuario mencione un electrodoméstico, aunque no especifique el modelo exacto.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Nombre del producto a buscar, puede ser genérico o con modelo. Ejemplos: "lavarropas Samsung 9kg", "heladera no frost 400 litros", "aire acondicionado Midea 3000 frigorías"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'generate_presentation',
    description:
      'Genera una presentación en Gamma sobre un tema dado y devuelve el link.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Tema o título de la presentación.',
        },
        details: {
          type: 'string',
          description:
            'Detalles adicionales o puntos a cubrir en la presentación.',
        },
      },
      required: ['topic'],
    },
  },
];

async function handleChat(userMessage, history) {
  const messages = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  messages.push({ role: 'user', content: userMessage });

  console.log(`[agent] Enviando a Claude. Turnos en contexto: ${messages.length}`);

  let response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  console.log(`[agent] Claude respondió. stop_reason: ${response.stop_reason}`);

  // Tool-use loop
  while (response.stop_reason === 'tool_use') {
    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];

    for (const block of assistantContent) {
      if (block.type !== 'tool_use') continue;

      console.log(`[agent] Tool invocada: ${block.name} | Input: ${JSON.stringify(block.input)}`);

      let result;
      try {
        if (block.name === 'search_competitors') {
          result = await searchCompetitors(block.input.query);
          console.log(`[agent] search_competitors completado. Resultado (primeros 300 chars): ${String(result).slice(0, 300)}`);
        } else if (block.name === 'generate_presentation') {
          result = await generatePresentation(
            block.input.topic,
            block.input.details
          );
          console.log(`[agent] generate_presentation completado.`);
        } else {
          result = `Herramienta desconocida: ${block.name}`;
          console.warn(`[agent] Tool desconocida: ${block.name}`);
        }
      } catch (err) {
        console.error(`[agent] Error ejecutando ${block.name}:`, err.message);
        console.error(err.stack);
        result = `Error al ejecutar ${block.name}: ${err.message}`;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: 'user', content: toolResults });

    console.log(`[agent] Enviando resultados de tools a Claude...`);
    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    console.log(`[agent] Claude respondió. stop_reason: ${response.stop_reason}`);
  }

  // Extraer texto de la respuesta final
  const textBlocks = response.content.filter((b) => b.type === 'text');
  return textBlocks.map((b) => b.text).join('\n');
}

module.exports = { handleChat };
