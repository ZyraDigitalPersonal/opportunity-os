// Worker de Cloudflare: API interna + protección de acceso + estáticos.
// Las claves viven solo aquí (variables de entorno); el navegador nunca las ve.

import { parseQuery } from "../core/query-parser.js";
import { OsmProvider, type DataProvider } from "../core/osm.js";
import { analyzeCompany, RULES_VERSION } from "../core/opportunity-engine.js";
import { auditWebsite } from "../core/web-audit.js";
import { fetchGooglePlace, GOOGLE_TEXT_SEARCH_USD } from "../core/google-places.js";
import { buildGenerationPrompt, createProvider, estimateCostUsd, type GenerationKind } from "../core/ai.js";
import { ExternalError } from "../core/http.js";
import { getSector } from "../core/sectors.js";
import type { Analysis, Company, WebAudit } from "../core/types.js";
import { clearSessionCookie, createSessionCookie, hasValidSession, passwordMatches, RateLimiter, withSecurityHeaders } from "./security.js";

export interface Env {
  ASSETS?: { fetch(req: Request): Promise<Response> };
  APP_PASSWORD?: string;
  SESSION_SECRET?: string;
  CONTACT_EMAIL?: string;
  SENDER_NAME?: string;
  GOOGLE_PLACES_API_KEY?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Solo para tests: permite inyectar proveedores */
  __deps?: Partial<Deps>;
}

export interface Deps {
  data: DataProvider;
  fetchImpl: typeof fetch;
  cache: { match(key: Request): Promise<Response | undefined>; put(key: Request, res: Response): Promise<void> } | null;
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

const apiLimiter = new RateLimiter(60, 60_000);
const loginLimiter = new RateLimiter(8, 15 * 60_000);
const aiLimiter = new RateLimiter(12, 60_000);

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

function userAgent(env: Env): string {
  return `OpportunityOSBot/0.1 (+contacto: ${env.CONTACT_EMAIL ?? "sin configurar"})`;
}

function deps(env: Env): Deps {
  const fetchImpl = env.__deps?.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const cfCaches = (globalThis as any).caches?.default;
  return {
    fetchImpl,
    data: env.__deps?.data ?? new OsmProvider({ userAgent: userAgent(env), contactEmail: env.CONTACT_EMAIL, fetchImpl }),
    cache: env.__deps?.cache !== undefined ? env.__deps.cache : cfCaches ?? null,
  };
}

async function cached<T>(d: Deps, ctx: Ctx, key: string, ttlSeconds: number, produce: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const req = new Request(`https://cache.opportunity-os.internal/${encodeURIComponent(key)}`);
  if (d.cache) {
    const hit = await d.cache.match(req);
    if (hit) return { value: (await hit.json()) as T, hit: true };
  }
  const value = await produce();
  if (d.cache) {
    const res = new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSeconds}` } });
    ctx.waitUntil(d.cache.put(req, res));
  }
  return { value, hit: false };
}

// ---------- Validación de entrada (sin dependencias) ----------

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function validateCompany(v: any): Company | null {
  if (!v || typeof v !== "object") return null;
  const name = str(v.name, 200);
  const id = str(v.id, 80);
  const sectorId = str(v.sectorId, 40);
  const lat = num(v.lat);
  const lon = num(v.lon);
  if (!name || !id || !sectorId || !getSector(sectorId) || lat === undefined || lon === undefined) return null;
  if (!/^osm:(node|way|relation)\/\d+$/.test(id)) return null;
  return {
    id,
    name,
    sectorId,
    sectorLabel: getSector(sectorId)!.label,
    lat,
    lon,
    address: str(v.address, 200),
    city: str(v.city, 100),
    postcode: str(v.postcode, 10),
    phone: str(v.phone, 60),
    website: str(v.website, 300),
    email: str(v.email, 120),
    openingHours: str(v.openingHours, 300),
    instagram: str(v.instagram, 300),
    facebook: str(v.facebook, 300),
    whatsapp: str(v.whatsapp, 60),
    reservation: str(v.reservation, 20),
    source: "OpenStreetMap",
    sourceUrl: `https://www.openstreetmap.org/${id.slice(4)}`,
  };
}

async function readJson(req: Request, maxBytes = 64_000): Promise<any> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new ExternalError("Petición demasiado grande", "api", 413);
  const text = await req.text();
  if (text.length > maxBytes) throw new ExternalError("Petición demasiado grande", "api", 413);
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new ExternalError("JSON no válido", "api", 400);
  }
}

// ---------- Handlers ----------

async function handleSearch(req: Request, env: Env, ctx: Ctx) {
  const body = await readJson(req);
  const q = str(body.q, 300);
  if (!q) return fail(400, "Escribe qué quieres encontrar, por ejemplo «Peluquerías en Lleida».");
  const limit = Math.min(Math.max(Number(body.limit) || 60, 5), 200);
  const parsed = parseQuery(q);
  if (!parsed.location && !parsed.postcode) return fail(400, "Indica una zona: por ejemplo «… en Lleida» o un código postal.", { parsed });
  if (!env.CONTACT_EMAIL) return fail(503, "Falta CONTACT_EMAIL: la política de uso de OpenStreetMap exige identificar la aplicación con un email de contacto.", { missing: "CONTACT_EMAIL" });

  const d = deps(env);
  const areaKey = `area:v1:${(parsed.location ?? "").toLowerCase()}|${parsed.postcode ?? ""}`;
  const { value: area } = await cached(d, ctx, areaKey, 7 * 86400, () => d.data.geocodeArea(parsed));
  const sKey = `companies:v1:${area.overpassAreaId ?? area.bbox.join(",")}:${[...parsed.sectorIds].sort().join(",")}:${limit}`;
  const { value: companies, hit } = await cached(d, ctx, sKey, 12 * 3600, () => d.data.searchCompanies(area, parsed.sectorIds, limit));

  let results = companies.map((c) => {
    const a = analyzeCompany(c);
    return { company: c, score: a.score, recommended: a.recommended, opportunities: a.opportunities.slice(0, 3) };
  });
  if (parsed.filters.withoutWebsite) results = results.filter((r) => !r.company.website);
  if (parsed.filters.withWebsite) results = results.filter((r) => !!r.company.website);
  results.sort((a, b) => b.score.score - a.score.score);

  return json({
    parsed,
    area,
    results,
    meta: { total: results.length, cacheHit: hit, rulesVersion: RULES_VERSION, source: "OpenStreetMap", attribution: "© colaboradores de OpenStreetMap (ODbL)", costEur: 0 },
  });
}

async function handleAnalyze(req: Request, env: Env, ctx: Ctx) {
  const body = await readJson(req);
  const company = validateCompany(body.company);
  if (!company) return fail(400, "Empresa no válida.");
  const d = deps(env);
  let audit: WebAudit | undefined;
  let cacheHit = false;
  if (company.website) {
    const r = await cached(d, ctx, `audit:v1:${company.website.toLowerCase()}`, 24 * 3600, () =>
      auditWebsite(company.website!, { userAgent: userAgent(env), botName: "OpportunityOSBot", fetchImpl: d.fetchImpl }),
    );
    audit = r.value;
    cacheHit = r.hit;
  }
  const analysis = analyzeCompany(company, audit);
  return json({ analysis, meta: { cacheHit, rulesVersion: RULES_VERSION, costEur: 0 } });
}

async function handleGoogle(req: Request, env: Env) {
  if (!env.GOOGLE_PLACES_API_KEY) return fail(503, "Google Places no está configurado. Añade la variable GOOGLE_PLACES_API_KEY para ver valoración y reseñas en vivo.", { missing: "GOOGLE_PLACES_API_KEY" });
  const body = await readJson(req);
  const name = str(body.name, 200);
  const lat = num(body.lat);
  const lon = num(body.lon);
  if (!name || lat === undefined || lon === undefined) return fail(400, "Datos incompletos.");
  const d = deps(env);
  // Sin caché a propósito: los términos de Google no permiten almacenar este contenido.
  const place = await fetchGooglePlace(env.GOOGLE_PLACES_API_KEY, { name, city: str(body.city, 100), lat, lon }, d.fetchImpl);
  return json({ place, meta: { estimatedCostUsd: GOOGLE_TEXT_SEARCH_USD, stored: false } });
}

const KINDS: GenerationKind[] = ["propuesta", "email", "whatsapp", "linkedin", "llamada"];

async function handleGenerate(req: Request, env: Env, ctx: Ctx) {
  const body = await readJson(req);
  const kind = body.kind as GenerationKind;
  if (!KINDS.includes(kind)) return fail(400, "Tipo de texto no válido.");
  const company = validateCompany(body.company);
  if (!company) return fail(400, "Empresa no válida.");
  const d = deps(env);
  const provider = createProvider(env, d.fetchImpl);
  if ("missing" in provider) return fail(503, `La IA no está configurada. Añade la variable ${provider.missing}.`, { missing: provider.missing });

  // Se recalcula el análisis en el servidor: la IA solo recibe señales que hemos obtenido nosotros.
  let audit: WebAudit | undefined;
  if (company.website) {
    audit = (await cached(d, ctx, `audit:v1:${company.website.toLowerCase()}`, 24 * 3600, () =>
      auditWebsite(company.website!, { userAgent: userAgent(env), botName: "OpportunityOSBot", fetchImpl: d.fetchImpl }),
    )).value;
  }
  const analysis: Analysis = analyzeCompany(company, audit);
  const request = buildGenerationPrompt(analysis, kind, env.SENDER_NAME ?? "[tu nombre]");
  const out = await provider.generate(request);
  const cost = estimateCostUsd(out.model, out.inputTokens, out.outputTokens);
  return json({ text: out.text, kind, meta: { provider: out.provider, model: out.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens, estimatedCostUsd: cost } });
}

function handleConfig(env: Env) {
  const ai = createProvider(env);
  return json({
    integrations: {
      openStreetMap: !!env.CONTACT_EMAIL,
      googlePlaces: !!env.GOOGLE_PLACES_API_KEY,
      ai: !("missing" in ai),
      aiProvider: "missing" in ai ? null : `${ai.name} · ${ai.model}`,
    },
    missing: [!env.CONTACT_EMAIL && "CONTACT_EMAIL", !env.GOOGLE_PLACES_API_KEY && "GOOGLE_PLACES_API_KEY", "missing" in ai && ai.missing].filter(Boolean),
    rulesVersion: RULES_VERSION,
  });
}

// ---------- Login ----------

function loginPage(error?: string): Response {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpportunityOS · Acceso</title><link rel="stylesheet" href="/styles.css"></head>
<body class="login-body"><form class="login-card" method="post" action="/login"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>OpportunityOS</span></div>
<h1>Encuentra oportunidades.</h1><p class="muted">Herramienta privada. Introduce la contraseña de acceso.</p>
<label for="pw">Contraseña</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
${error ? `<p class="form-error" role="alert">${error}</p>` : ""}<button class="btn btn-primary" type="submit">Entrar</button></form></body></html>`;
  return new Response(html, { status: error ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function sessionSecret(env: Env): string | undefined {
  return env.SESSION_SECRET ?? (env.APP_PASSWORD ? `derived:${env.APP_PASSWORD}` : undefined);
}

// ---------- Router ----------

export async function handle(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const secret = sessionSecret(env);

  if (!env.APP_PASSWORD || !secret) {
    return new Response("Configura la variable APP_PASSWORD (y SESSION_SECRET) antes de usar OpportunityOS.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (url.pathname === "/styles.css" && env.ASSETS) return env.ASSETS.fetch(req);

  if (url.pathname === "/login") {
    if (req.method === "GET") return loginPage();
    if (req.method === "POST") {
      if (!loginLimiter.allow(`login:${ip}`)) return loginPage("Demasiados intentos. Espera 15 minutos.");
      const form = await req.formData();
      const pw = String(form.get("password") ?? "");
      if (!(await passwordMatches(pw, env.APP_PASSWORD))) return loginPage("Contraseña incorrecta.");
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": await createSessionCookie(secret) } });
    }
  }
  if (url.pathname === "/logout") return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": clearSessionCookie() } });

  const authed = await hasValidSession(req, secret);
  if (url.pathname.startsWith("/api/")) {
    if (!authed) return fail(401, "Sesión caducada. Vuelve a entrar.");
    if (!apiLimiter.allow(`api:${ip}`)) return fail(429, "Demasiadas peticiones. Espera un minuto.");
    if (req.method === "GET" && url.pathname === "/api/config") return handleConfig(env);
    if (req.method !== "POST") return fail(405, "Método no permitido.");
    // Protección CSRF: las llamadas de la API deben venir de nuestro propio origen.
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) return fail(403, "Origen no permitido.");
    try {
      switch (url.pathname) {
        case "/api/search":
          return await handleSearch(req, env, ctx);
        case "/api/analyze":
          return await handleAnalyze(req, env, ctx);
        case "/api/google":
          return await handleGoogle(req, env);
        case "/api/generate":
          if (!aiLimiter.allow(`ai:${ip}`)) return fail(429, "Límite de generaciones por minuto alcanzado.");
          return await handleGenerate(req, env, ctx);
        default:
          return fail(404, "Ruta no encontrada.");
      }
    } catch (e) {
      if (e instanceof ExternalError) return fail(e.status && e.status >= 400 && e.status < 600 && e.service === "api" ? e.status : 502, e.message, { service: e.service });
      console.error(JSON.stringify({ level: "error", path: url.pathname, message: (e as Error).message }));
      return fail(500, "Error interno. Revisa los logs del Worker.");
    }
  }

  if (!authed) return new Response(null, { status: 303, headers: { location: "/login" } });
  if (env.ASSETS) return env.ASSETS.fetch(req);
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    return withSecurityHeaders(await handle(req, env, ctx));
  },
};
