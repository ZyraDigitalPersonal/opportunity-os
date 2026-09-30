// Auditoría de la web pública de una empresa.
// Lee solo la página principal, respeta robots.txt y no guarda el HTML:
// devuelve hechos concretos (señales) con su evidencia.

import type { WebAudit } from "./types.js";
import { assertPublicHttpUrl, fetchWithTimeout, readTextLimited } from "./http.js";

const MAX_HTML_BYTES = 1_500_000;

export const BOOKING_PROVIDERS: Array<[string, RegExp]> = [
  ["Booksy", /booksy\.com/i],
  ["Treatwell", /treatwell\./i],
  ["Fresha", /fresha\.com/i],
  ["CoverManager", /covermanager\.com/i],
  ["TheFork", /thefork\.|eltenedor\./i],
  ["Calendly", /calendly\.com/i],
  ["Doctoralia", /doctoralia\./i],
  ["Timp", /timp\.pro/i],
  ["Reservio", /reservio\.com/i],
  ["SimplyBook", /simplybook\./i],
  ["Bookitit", /bookitit\.com/i],
  ["Setmore", /setmore\.com/i],
  ["Acuity", /acuityscheduling\.com/i],
  ["Square Appointments", /squareup\.com\/appointments/i],
  ["Booking.com", /booking\.com\/hotel/i],
  ["Motor de reservas (widget)", /(bookingengine|motor-?de-?reservas|reservas\.online|widget\.bookeo|bookeo\.com)/i],
  ["Glofox / Mindbody", /glofox\.com|mindbodyonline\.com|mindbody\.io/i],
  ["WooCommerce Bookings / Amelia", /(wc-bookings|ameliabooking|amelia-booking)/i],
  ["Google Calendar citas", /calendar\.app\.google|calendar\.google\.com\/calendar\/appointments/i],
];

export const CHAT_WIDGETS: Array<[string, RegExp]> = [
  ["Tawk.to", /tawk\.to/i],
  ["Intercom", /intercom(cdn)?\.(io|com)/i],
  ["Crisp", /crisp\.chat/i],
  ["Tidio", /tidio(chat)?\.co/i],
  ["Zendesk", /zdassets\.com|zopim/i],
  ["HubSpot chat", /js\.hs-scripts\.com|hubspot.*conversations/i],
  ["LiveChat", /livechatinc\.com/i],
  ["Botón WhatsApp flotante", /(joinchat|wa-?button|whatsapp-?(button|widget|chat)|click-to-chat)/i],
  ["Chatbot IA", /(chatbase\.co|voiceflow\.com|botpress\.cloud|landbot\.io|manychat\.com)/i],
];

const SOCIALS: Array<[string, RegExp]> = [
  ["Instagram", /instagram\.com\/[a-z0-9_.]+/i],
  ["Facebook", /facebook\.com\/[a-z0-9_.-]+/i],
  ["TikTok", /tiktok\.com\/@/i],
  ["LinkedIn", /linkedin\.com\/(company|in)\//i],
  ["YouTube", /youtube\.com\/(@|channel|c\/)/i],
  ["X / Twitter", /(twitter|x)\.com\/[a-z0-9_]+/i],
];

const CTA_WORDS = /\b(reserv(a|ar)(\s+(ahora|mesa|cita|online))?|pide\s+(tu\s+)?cita|pedir\s+cita|solicita(r)?\s+(cita|presupuesto|informaci[oó]n)|presupuesto|cont[aá]cta(nos)?|ll[aá]ma(nos)?|comprar|compra\s+ahora|pide\s+online|hacer\s+pedido|ap[uú]ntate|inscr[ií]bete|prueba\s+gratis)\b/gi;

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/** Analiza el HTML. Separado del fetch para poder probarlo con HTML de ejemplo. */
export function analyzeHtml(html: string, finalUrl: string, now = new Date()): Omit<WebAudit, "url" | "reachable" | "auditedAt" | "responseMs" | "status" | "htmlKb"> {
  const head = html.slice(0, 200_000);
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const anchors = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => m[0]);
  const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => m[1]);
  const ctaText = [...anchors.map((a) => stripTags(a)), ...buttons.map(stripTags), ...[...html.matchAll(/<input[^>]+type=["']?submit[^>]*value=["']([^"']+)/gi)].map((m) => m[1])].join(" | ");
  const ctas = [...new Set([...ctaText.matchAll(CTA_WORDS)].map((m) => m[0].toLowerCase().replace(/\s+/g, " ")))].slice(0, 6);

  const years = [...html.matchAll(/(?:©|&copy;|copyright)[^<]{0,40}?((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)].map((m) => Number(m[2] ?? m[1]));
  const currentYear = now.getUTCFullYear();
  const copyrightYear = years.filter((y) => y <= currentYear).sort((a, b) => b - a)[0];

  const emails = [...new Set([...html.matchAll(/mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))];
  // Minimización (RGPD): solo buzones genéricos de empresa, no nombres de personas.
  const genericEmails = emails.filter((e) => /^(info|hola|hello|contact[oa]?|reservas?|citas?|admin|administracion|recepcion|comercial|ventas|clinica|oficina|atencion)[._-]?[a-z0-9]*@/i.test(e));

  return {
    finalUrl,
    https: finalUrl.startsWith("https://"),
    title: title ? stripTags(title).slice(0, 160) : undefined,
    metaDescription: /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(head) || /<meta[^>]+content=["'][^"']{20,}["'][^>]+name=["']description["']/i.test(head),
    viewport: /<meta[^>]+name=["']viewport["']/i.test(head),
    h1: /<h1\b/i.test(html),
    forms: (html.match(/<form\b/gi) ?? []).length,
    telLinks: /href=["']tel:/i.test(html),
    whatsappLink: /(wa\.me\/|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send|whatsapp:\/\/send)/i.test(html),
    bookingProviders: BOOKING_PROVIDERS.filter(([, re]) => re.test(html)).map(([n]) => n),
    chatWidgets: CHAT_WIDGETS.filter(([, re]) => re.test(html)).map(([n]) => n),
    socials: SOCIALS.filter(([, re]) => re.test(html)).map(([n]) => n),
    ctas,
    copyrightYear,
    generator: head.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i)?.[1]?.slice(0, 60),
    schemaLocalBusiness: /"@type"\s*:\s*"(LocalBusiness|Restaurant|Dentist|HairSalon|BeautySalon|MedicalClinic|Hotel|HealthAndBeautyBusiness|AutoRepair|LegalService|RealEstateAgent|ExerciseGym|Store|ProfessionalService)"/i.test(html),
    publicEmails: genericEmails.slice(0, 3),
  };
}

/** Interpreta robots.txt para nuestro bot (o *). Devuelve true si la raíz "/" está permitida. */
export function robotsAllowsRoot(robots: string, botName: string): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "disallow" || field === "allow") && current) {
      current.rules.push({ allow: field === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const bot = botName.toLowerCase();
  const group = groups.find((g) => g.agents.some((a) => a !== "*" && bot.includes(a))) ?? groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; len: number } = { allow: true, len: -1 };
  for (const r of group.rules) {
    if (r.path === "") continue; // "Disallow:" vacío = todo permitido
    const p = r.path.replace(/\*$/, "");
    if ("/".startsWith(p) || p === "/" || p === "/*") {
      if (p.length > best.len || (p.length === best.len && r.allow)) best = { allow: r.allow, len: p.length };
    }
  }
  return best.allow;
}

export interface AuditOptions {
  userAgent: string;
  botName: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function auditWebsite(rawUrl: string, opts: AuditOptions): Promise<WebAudit> {
  const f = opts.fetchImpl ?? ((...a) => fetch(...a));
  const now = opts.now ?? Date.now;
  const auditedAt = new Date(now()).toISOString();
  let url: URL;
  try {
    url = assertPublicHttpUrl(rawUrl);
  } catch (e) {
    return { url: rawUrl, reachable: false, error: (e as Error).message, bookingProviders: [], chatWidgets: [], socials: [], ctas: [], publicEmails: [], auditedAt };
  }
  const headers = { "User-Agent": opts.userAgent, Accept: "text/html,application/xhtml+xml", "Accept-Language": "es-ES,es;q=0.9" };

  // robots.txt: si no existe o falla, se asume permitido (comportamiento estándar).
  try {
    const r = await fetchWithTimeout(`${url.origin}/robots.txt`, { headers, redirect: "follow" }, 5000, f);
    if (r.ok) {
      const { text } = await readTextLimited(r, 100_000);
      if (!robotsAllowsRoot(text, opts.botName)) {
        return { url: url.href, reachable: true, blockedByRobots: true, bookingProviders: [], chatWidgets: [], socials: [], ctas: [], publicEmails: [], auditedAt };
      }
    }
  } catch {
    /* sin robots.txt accesible */
  }

  const start = now();
  let res: Response;
  try {
    res = await fetchWithTimeout(url.href, { headers, redirect: "follow" }, 10000, f);
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    return { url: url.href, reachable: false, error: aborted ? "La web no respondió en 10 s" : "No se pudo conectar con la web", bookingProviders: [], chatWidgets: [], socials: [], ctas: [], publicEmails: [], auditedAt };
  }
  const { text, bytes } = await readTextLimited(res, MAX_HTML_BYTES);
  const responseMs = now() - start;
  const finalUrl = res.url || url.href;
  if (!res.ok) {
    return { url: url.href, finalUrl, reachable: false, status: res.status, error: `La web responde con error ${res.status}`, responseMs, bookingProviders: [], chatWidgets: [], socials: [], ctas: [], publicEmails: [], auditedAt };
  }
  return { url: url.href, reachable: true, status: res.status, responseMs, htmlKb: Math.round(bytes / 1024), auditedAt, ...analyzeHtml(text, finalUrl, new Date(now())) };
}
