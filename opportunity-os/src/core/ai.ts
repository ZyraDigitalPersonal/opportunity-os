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

export interface AIEnv {
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

/** Devuelve el proveedor configurado o un mensaje claro de qué variable falta. */
export function createProvider(env: AIEnv, f?: typeof fetch): AIProvider | { missing: string } {
  const provider = (env.AI_PROVIDER ?? "anthropic").toLowerCase();
  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return { missing: "ANTHROPIC_API_KEY" };
    return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.AI_MODEL ?? "claude-sonnet-5-5", f);
  }
  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) return { missing: "OPENAI_API_KEY" };
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

export function buildGenerationPrompt(a: Analysis, kind: GenerationKind, senderName: string): AIRequest {
  const verified = a.signals.filter((s) => s.confidence === "verificado").map((s) => `- [${s.key}] ${s.label}${s.evidence ? ` (${s.evidence})` : ""} — fuente: ${s.source}`);
  const inferred = a.signals.filter((s) => s.confidence === "inferido").map((s) => `- [${s.key}] ${s.label} — fuente: ${s.source}`);
  const ops = a.opportunities.slice(0, 4).map((o) => `- (${o.priority}) ${o.title}: ${o.problem} → ${o.solution}`);
  const system = [
    "Eres un consultor de digitalización que escribe en español de España para pequeños negocios.",
    "REGLAS ESTRICTAS:",
    "1. Usa solo los hechos de la lista VERIFICADOS. No inventes datos, cifras, reseñas, nombres de personas ni resultados.",
    "2. Los hechos INFERIDOS son hipótesis del sector: si los usas, preséntalos como posibilidad (\"es habitual que…\", \"quizá…\"), nunca como algo que sabes de ese negocio.",
    "3. Nada de frases genéricas de agencia (\"somos una agencia digital que hace webs\"). Empieza por lo que has observado del negocio.",
    "4. Tono respetuoso, sin presión ni urgencia falsa. No prometas porcentajes ni resultados.",
    "5. Devuelve solo el texto final, sin comentarios.",
  ].join("\n");
  const prompt = [
    `NEGOCIO: ${a.company.name} — ${a.company.sectorLabel}${a.company.city ? ` en ${a.company.city}` : ""}`,
    `REMITENTE: ${senderName}`,
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
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = MODEL_PRICES_USD_PER_MTOK[model];
  if (!p) return null;
  return (inputTokens * p[0] + outputTokens * p[1]) / 1_000_000;
}
