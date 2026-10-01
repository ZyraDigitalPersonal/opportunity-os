// AI Provider Layer: una interfaz, varios proveedores. Cambiar de modelo = cambiar AI_PROVIDER / AI_MODEL.

import type { Analysis } from "./types.js";
import { ExternalError, fetchWithTimeout } from "./http.js";

export interface AIRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}
export interface AIResponse {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generate(req: AIRequest): Promise<AIResponse>;
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  constructor(private readonly apiKey: string, readonly model: string, private readonly f: typeof fetch = (...a) => fetch(...a)) {}
  async generate(req: AIRequest): Promise<AIResponse> {
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: this.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: "user", content: req.prompt }] }),
      },
      60000,
      this.f,
    );
    if (!res.ok) throw new ExternalError(`Anthropic respondió ${res.status}: ${(await res.text()).slice(0, 200)}`, "anthropic", res.status);
    const data = (await res.json()) as { content: Array<{ type: string; text?: string }>; usage: { input_tokens: number; output_tokens: number } };
    return {
      text: data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(),
      provider: this.name,
      model: this.model,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    };
  }
}

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  constructor(private readonly apiKey: string, readonly model: string, private readonly f: typeof fetch = (...a) => fetch(...a)) {}
  async generate(req: AIRequest): Promise<AIResponse> {
    const res = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, max_completion_tokens: req.maxTokens, messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }] }),
      },
      60000,
      this.f,
    );
    if (!res.ok) throw new ExternalError(`OpenAI respondió ${res.status}: ${(await res.text()).slice(0, 200)}`, "openai", res.status);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number } };
    return { text: data.choices[0]?.message.content?.trim() ?? "", provider: this.name, model: this.model, inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens };
  }
}

/** Binding de Cloudflare Workers AI (gratis hasta 10.000 «neuronas» al día). */
export interface WorkersAIBinding {
  run(model: string, input: Record<string, unknown>): Promise<any>;
}

export const WORKERS_AI_DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class WorkersAIProvider implements AIProvider {
  readonly name = "cloudflare";
  constructor(private readonly ai: WorkersAIBinding, readonly model: string) {}
  async generate(req: AIRequest): Promise<AIResponse> {
    return this.chat(req.system, [{ role: "user", content: req.prompt }], req.maxTokens);
  }
  async chat(system: string, messages: ChatMessage[], maxTokens: number): Promise<AIResponse> {
    let out: any;
    try {
      out = await this.ai.run(this.model, { messages: [{ role: "system", content: system }, ...messages], max_tokens: maxTokens, temperature: 0.4 });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (/4006|daily free allocation|neurons/i.test(msg)) throw new ExternalError("Se ha agotado la IA gratuita de hoy (Cloudflare Workers AI). Vuelve a intentarlo mañana o añade ANTHROPIC_API_KEY.", "workers-ai", 429);
      throw new ExternalError(`La IA de Cloudflare no ha respondido: ${msg.slice(0, 160)}`, "workers-ai", 502);
    }
    const text = typeof out?.response === "string" ? out.response : typeof out?.result?.response === "string" ? out.result.response : "";
    return { text: text.trim(), provider: this.name, model: this.model, inputTokens: out?.usage?.prompt_tokens ?? 0, outputTokens: out?.usage?.completion_tokens ?? 0 };
  }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIEnv {
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Binding de Workers AI: se usa gratis cuando no hay clave de pago */
  AI?: WorkersAIBinding;
  WORKERS_AI_MODEL?: string;
}

/** IA gratuita de Cloudflare si el binding está disponible. */
export function freeProvider(env: AIEnv): WorkersAIProvider | null {
  return env.AI ? new WorkersAIProvider(env.AI, env.WORKERS_AI_MODEL ?? WORKERS_AI_DEFAULT_MODEL) : null;
}

/** Devuelve el proveedor configurado o un mensaje claro de qué variable falta. */
export function createProvider(env: AIEnv, f?: typeof fetch): AIProvider | { missing: string } {
  const provider = (env.AI_PROVIDER ?? "anthropic").toLowerCase();
  if (provider === "cloudflare") return freeProvider(env) ?? { missing: "AI (binding de Workers AI)" };
  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return freeProvider(env) ?? { missing: "ANTHROPIC_API_KEY" };
    return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.AI_MODEL ?? "claude-sonnet-5-5", f);
  }
  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) return freeProvider(env) ?? { missing: "OPENAI_API_KEY" };
    return new OpenAIProvider(env.OPENAI_API_KEY, env.AI_MODEL ?? "gpt-4.1-mini", f);
  }
  return { missing: `AI_PROVIDER (valor no soportado: ${provider})` };
}

export type GenerationKind = "propuesta" | "email" | "whatsapp" | "linkedin" | "llamada";

const KIND_INSTRUCTIONS: Record<GenerationKind, string> = {
  propuesta: "Escribe una propuesta comercial breve con estas secciones: Situación detectada, Problema, Solución propuesta (numerada), Beneficio esperado (sin cifras inventadas), Implementación (pasos), Próximos pasos. Máximo 350 palabras.",
  email: "Escribe un email de primer contacto: asunto en la primera línea (\"Asunto: ...\"), 90-130 palabras, un solo hallazgo concreto, una propuesta de valor y una pregunta final de bajo compromiso. Termina con una línea para que pueda pedir no recibir más mensajes.",
  whatsapp: "Escribe un mensaje de WhatsApp de 40-70 palabras, cercano y profesional, con un hallazgo concreto y una pregunta final. Sin emojis excesivos (máximo uno).",
  linkedin: "Escribe un mensaje de LinkedIn de 50-80 palabras, personal, con un hallazgo concreto y una pregunta final.",
  llamada: "Escribe un guion de llamada: apertura (15 s), motivo con el hallazgo concreto, 3 preguntas de descubrimiento, cómo presentar la solución y 2 objeciones típicas con respuesta. Formato en viñetas.",
};

export function buildGenerationPrompt(a: Analysis, kind: GenerationKind, senderName: string, agencyName = "Digital Zyra"): AIRequest {
  const verified = a.signals.filter((s) => s.confidence === "verificado").map((s) => `- [${s.key}] ${s.label}${s.evidence ? ` (${s.evidence})` : ""} — fuente: ${s.source}`);
  const inferred = a.signals.filter((s) => s.confidence === "inferido").map((s) => `- [${s.key}] ${s.label} — fuente: ${s.source}`);
  const ops = a.opportunities.slice(0, 4).map((o) => `- (${o.priority}) ${o.title}: ${o.problem} → ${o.solution}`);
  const system = [
    `Eres ${senderName}, de ${agencyName}, una agencia de digitalización de negocios (webs, sistemas de reservas, agentes de voz con IA que atienden llamadas, chatbots y automatizaciones). Escribes en español de España para pequeños negocios.`,
    "REGLAS ESTRICTAS:",
    `0. La agencia se llama exactamente «${agencyName}» y quien firma es «${senderName}». No uses otros nombres para la agencia ni uses direcciones de email o nombres de usuario como nombre.`,
    "1. Usa solo los hechos de la lista VERIFICADOS. No inventes datos, cifras, reseñas, nombres de personas ni resultados.",
    "2. Los hechos INFERIDOS son hipótesis del sector: si los usas, preséntalos como posibilidad (\"es habitual que…\", \"quizá…\"), nunca como algo que sabes de ese negocio.",
    "3. Nada de frases genéricas de agencia (\"somos una agencia digital que hace webs\"). Empieza por lo que has observado del negocio.",
    "4. Tono respetuoso, sin presión ni urgencia falsa. No prometas porcentajes ni resultados.",
    "5. Devuelve solo el texto final, sin comentarios.",
  ].join("\n");
  const prompt = [
    `NEGOCIO: ${a.company.name} — ${a.company.sectorLabel}${a.company.city ? ` en ${a.company.city}` : ""}`,
    `REMITENTE: ${senderName} (${agencyName})`,
    `OPPORTUNITY SCORE: ${a.score.score}/100`,
    "",
    "HECHOS VERIFICADOS:",
    ...(verified.length ? verified : ["- (ninguno)"]),
    "",
    "HECHOS INFERIDOS (perfil del sector):",
    ...(inferred.length ? inferred : ["- (ninguno)"]),
    "",
    "OPORTUNIDADES DETECTADAS:",
    ...(ops.length ? ops : ["- (ninguna)"]),
    `SOLUCIÓN RECOMENDADA: ${a.recommended}`,
    "",
    `TAREA: ${KIND_INSTRUCTIONS[kind]}`,
  ].join("\n");
  return { system, prompt, maxTokens: kind === "propuesta" || kind === "llamada" ? 1200 : 600 };
}

/** Precios aproximados por millón de tokens (entrada, salida) en US$. Editables sin tocar lógica. */
export const MODEL_PRICES_USD_PER_MTOK: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [3, 15],
  "claude-haiku-4-5-20251001": [1, 5],
  "gpt-4.1-mini": [0.4, 1.6],
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [0, 0],
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = MODEL_PRICES_USD_PER_MTOK[model];
  if (!p) return null;
  return (inputTokens * p[0] + outputTokens * p[1]) / 1_000_000;
}

// ---------- Asistente de ayuda ----------

export const ZYRA_CONTACT = {
  company: "ZYRA",
  web: "https://digitalzyra.com",
  contactPage: "https://digitalzyra.com/es-es/contacto/",
  email: "zyradigitalpersonal@gmail.com",
  phone: "+34 643 41 24 54",
  whatsapp: "https://wa.me/34643412454",
  instagram: "https://www.instagram.com/zyra_personal",
  linkedin: "https://www.linkedin.com/in/digital-zyra-730293439",
  tiktok: "https://www.tiktok.com/@digitalzyra",
};

export const ASSISTANT_SYSTEM = [
  "Eres el asistente de OpportunityOS, una herramienta de Digital Zyra (ZYRA), agencia de digitalización en España.",
  "Respondes en español de España, breve (máximo 120 palabras salvo que pidan detalle), claro y amable. Usa listas cortas cuando ayuden.",
  "Hablas de OpportunityOS, de cómo usarlo y de captar y atender clientes para servicios de digitalización: preparar llamadas, redactar emails, WhatsApp o propuestas, responder objeciones, decidir qué ofrecer a cada negocio y cómo priorizar. Si preguntan algo totalmente ajeno, redirige con amabilidad.",
  "Cuando te den el CONTEXTO DE LA PANTALLA, úsalo: si el usuario está viendo un negocio, responde sobre ese negocio con sus datos reales (no inventes datos que no estén en el contexto). Si te piden un mensaje o guion, escríbelo listo para copiar.",
  "Si no sabes algo, dilo y ofrece el contacto de ZYRA. No inventes funciones que no existen.",
  "",
  "QUÉ HACE OPPORTUNITYOS:",
  "- Buscador: se escribe el tipo de negocio y la zona (\"dentistas Lleida\", \"restaurantes de Tenerife\", \"peluquerías en La Laguna sin web\"). Busca en Google Maps y OpenStreetMap y une los resultados sin duplicados.",
  "- Cada negocio recibe un Opportunity Score (0-100): cuanto más alto, más le falta digitalizar. Cada punto tiene su motivo, marcado como verificado o inferido.",
  "- Por defecto salen primero los negocios SIN web. Filtros rápidos: sin web, sin reservas online, pocas reseñas, con teléfono. Orden por score, reseñas o nombre.",
  "- 'Analizar oportunidad' revisa la web pública del negocio: HTTPS, móvil, velocidad, reservas online, chat, WhatsApp, formularios, SEO básico.",
  "- Oportunidades que detecta: página web, rediseño, reservas online, recordatorios, agente de voz IA para llamadas, chatbot, automatización de WhatsApp, automatización de procesos, CRM, SEO local, reseñas y reputación.",
  "- Perfil de empresa: score explicado, oportunidades, datos de contacto y botón 'Generar con IA' para escribir propuesta, email, WhatsApp, LinkedIn o guion de llamada basados solo en datos reales.",
  "- Exportar CSV (abre en Excel) con todos los datos y el score.",
  "- Ajustes: servicios que ofrece tu agencia (resalta las oportunidades que vendes), orden por defecto, número de resultados por búsqueda y estado de las integraciones.",
  "- Legal: no enviar emails ni WhatsApp comerciales a quien no lo haya autorizado (LSSI art. 21). La app redacta, no envía.",
  "",
  "COSTES:",
  "- OpenStreetMap: gratis. IA del asistente y textos (Cloudflare Workers AI): gratis hasta el límite diario.",
  "- Google Places: cada consulta trae hasta 20 negocios; 1.000 consultas gratis al mes, luego unos 35 US$ por 1.000. Mapa de Google: 10.000 cargas gratis al mes. Recomendado poner límites de cuota en Google Cloud para no pagar nunca.",
  "",
  `CONTACTO DE ZYRA (para soporte, dudas o contratar servicios): email ${ZYRA_CONTACT.email}, teléfono y WhatsApp ${ZYRA_CONTACT.phone}, web ${ZYRA_CONTACT.web}.`,
].join("\n");

/** Convierte una conversación en una sola petición para proveedores sin chat multi-turno. */
/** System prompt del asistente con la agencia del usuario y lo que está viendo en pantalla. */
export function assistantSystem(agencyName: string, senderName: string, context?: string): string {
  return [
    ASSISTANT_SYSTEM,
    "",
    `El usuario trabaja en la agencia «${agencyName}» y se llama «${senderName}». Si redactas mensajes, fírmalos así.`,
    context ? `\nCONTEXTO DE LA PANTALLA (datos reales de la app):\n${context}` : "",
  ].join("\n");
}

export function flattenChat(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.content}`).join("\n\n") + "\n\nAsistente:";
}
