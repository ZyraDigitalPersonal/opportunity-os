// Worker de Cloudflare: API interna + protección de acceso + estáticos.
// Las claves viven solo aquí (variables de entorno); el navegador nunca las ve.

import { parseQuery, withAlternative, type ParsedQuery } from "../core/query-parser.js";
import { GooglePlacesSearch, GOOGLE_CALL_USD } from "../core/google-search.js";
import { mergeCompanies } from "../core/merge.js";
import { OsmProvider, type DataProvider } from "../core/osm.js";
import { analyzeCompany, RULES_VERSION, systemGap } from "../core/opportunity-engine.js";
import { auditWebsite } from "../core/web-audit.js";
import { fetchGooglePlace, GOOGLE_TEXT_SEARCH_USD } from "../core/google-places.js";
import { assistantSystem, buildGenerationPrompt, createProvider, estimateCostUsd, flattenChat, freeProvider, ZYRA_CONTACT, type ChatMessage, type GenerationKind, type WorkersAIBinding } from "../core/ai.js";
import { ExternalError } from "../core/http.js";
import { resolveSector } from "../core/sectors.js";
import type { Analysis, Company, GeoArea, WebAudit } from "../core/types.js";
import { handleCrm, type D1Like } from "./crm.js";
import { clearSessionCookie, createSessionCookie, hasValidSession, passwordMatches, RateLimiter, withSecurityHeaders } from "./security.js";

export interface Env {
  ASSETS?: { fetch(req: Request): Promise<Response> };
  APP_PASSWORD?: string;
  SESSION_SECRET?: string;
  CONTACT_EMAIL?: string;
  SENDER_NAME?: string;
  GOOGLE_PLACES_API_KEY?: string;
  /** Máximo de llamadas a Google por búsqueda (cada una ≈ 20 negocios). Por defecto 12. */
  GOOGLE_MAX_CALLS?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Workers AI (binding «AI» en wrangler.jsonc): IA gratuita */
  AI?: WorkersAIBinding;
  WORKERS_AI_MODEL?: string;
  /** Clave de navegador para el mapa de Google (restringida por dominio). Si falta, se usa GOOGLE_PLACES_API_KEY. */
  GOOGLE_MAPS_BROWSER_KEY?: string;
  /** Firma por defecto de los textos */
  AGENCY_NAME?: string;
  /** Base de datos D1 del pipeline (CRM) */
  DB?: D1Like;
  /** KV con los interruptores de administrador */
  SETTINGS?: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
  /** Solo para tests: permite inyectar proveedores */
  __deps?: Partial<Deps>;
}

export interface Deps {
  data: DataProvider;
  google: { searchCompanies: GooglePlacesSearch["searchCompanies"] } | null;
  fetchImpl: typeof fetch;
  cache: { match(key: Request): Promise<Response | undefined>; put(key: Request, res: Response): Promise<void> } | null;
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

// ---------- Interruptores de administrador ----------

export interface Toggles {
  googleSearch: boolean;
  googleMap: boolean;
  osm: boolean;
  ai: boolean;
}
export const DEFAULT_TOGGLES: Toggles = { googleSearch: true, googleMap: true, osm: true, ai: true };
let togglesCache: { at: number; value: Toggles } | null = null;

export async function getToggles(env: Env): Promise<Toggles> {
  if (!env.SETTINGS) return { ...DEFAULT_TOGGLES };
  if (togglesCache && Date.now() - togglesCache.at < 10_000) return togglesCache.value;
  let value = { ...DEFAULT_TOGGLES };
  try {
    const raw = await env.SETTINGS.get("toggles");
    if (raw) value = { ...DEFAULT_TOGGLES, ...JSON.parse(raw) };
  } catch {}
  togglesCache = { at: Date.now(), value };
  return value;
}

async function handleAdminToggles(req: Request, env: Env) {
  if (!env.SETTINGS) return fail(503, "Falta el almacén de ajustes (KV SETTINGS). Vuelve a publicar la app.");
  const body = await readJson(req);
  const cur = await getToggles(env);
  const next: Toggles = { ...cur };
  for (const k of Object.keys(DEFAULT_TOGGLES) as Array<keyof Toggles>) if (typeof body[k] === "boolean") next[k] = body[k];
  await env.SETTINGS.put("toggles", JSON.stringify(next));
  togglesCache = { at: Date.now(), value: next };
  return json({ toggles: next });
}

const apiLimiter = new RateLimiter(60, 60_000);
const loginLimiter = new RateLimiter(8, 15 * 60_000);
const aiLimiter = new RateLimiter(12, 60_000);

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

function userAgent(env: Env, req?: Request): string {
  const site = req ? new URL(req.url).origin : "https://opportunity-os.workers.dev";
  return `OpportunityOSBot/0.2 (+${site}${env.CONTACT_EMAIL ? `; ${env.CONTACT_EMAIL}` : ""})`;
}

function deps(env: Env, req?: Request, toggles: Toggles = DEFAULT_TOGGLES): Deps {
  const fetchImpl = env.__deps?.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const cfCaches = (globalThis as any).caches?.default;
  return {
    fetchImpl,
    data: env.__deps?.data ?? new OsmProvider({ userAgent: userAgent(env, req), contactEmail: env.CONTACT_EMAIL, fetchImpl }),
    google:
      env.__deps?.google !== undefined
        ? env.__deps.google
        : env.GOOGLE_PLACES_API_KEY && toggles.googleSearch
          ? new GooglePlacesSearch({ apiKey: env.GOOGLE_PLACES_API_KEY, maxCalls: Math.min(Math.max(Number(env.GOOGLE_MAX_CALLS) || 12, 1), 60), fetchImpl })
          : null,
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
  const id = str(v.id, 300);
  const sectorId = str(v.sectorId, 60);
  const lat = num(v.lat);
  const lon = num(v.lon);
  const sector = sectorId ? resolveSector(sectorId) : undefined;
  if (!name || !id || !sectorId || !sector || lat === undefined || lon === undefined) return null;
  const isOsm = /^osm:(node|way|relation)\/\d+$/.test(id);
  const isGoogle = /^gp:[A-Za-z0-9_-]{10,250}$/.test(id);
  if (!isOsm && !isGoogle) return null;
  const mapsUri = str(v.googleMapsUri, 300);
  const rating = num(v.rating);
  const reviews = num(v.reviews);
  return {
    id,
    name,
    sectorId,
    sectorLabel: sector.label,
    lat,
    lon,
    address: str(v.address, 200),
    city: str(v.city, 100),
    postcode: str(v.postcode, 10),
    phone: str(v.phone, 60),
    website: str(v.website, 300),
    email: str(v.email, 120),
    openingHours: str(v.openingHours, 600),
    instagram: str(v.instagram, 300),
    facebook: str(v.facebook, 300),
    whatsapp: str(v.whatsapp, 300),
    reservation: str(v.reservation, 20),
    source: isGoogle ? "Google" : "OpenStreetMap",
    sourceUrl: isGoogle ? (mapsUri && /^https:\/\/(maps\.google\.com|www\.google\.com|google\.com|maps\.app\.goo\.gl)\//.test(mapsUri) ? mapsUri : `https://www.google.com/maps/place/?q=place_id:${id.slice(3)}`) : `https://www.openstreetmap.org/${id.slice(4)}`,
    googleMapsUri: isGoogle ? mapsUri : undefined,
    rating: rating !== undefined && rating >= 0 && rating <= 5 ? rating : undefined,
    reviews: reviews !== undefined && reviews >= 0 ? Math.round(reviews) : undefined,
    alsoIn: str(v.alsoIn, 30),
    complaints: Array.isArray(v.complaints)
      ? v.complaints
          .filter((k: any) => k && ["telefono", "esperas", "atencion"].includes(k.type) && typeof k.quote === "string")
          .slice(0, 3)
          .map((k: any) => ({ type: k.type, quote: k.quote.slice(0, 200) }))
      : undefined,
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

async function geocodeWithAlternatives(d: Deps, ctx: Ctx, parsed: ParsedQuery): Promise<{ area: GeoArea; parsed: ParsedQuery }> {
  const candidates: ParsedQuery[] = [parsed, ...parsed.alternatives.slice(0, 4).map((a) => withAlternative(parsed, a))];
  let lastError: unknown;
  for (const p of candidates) {
    if (!p.location && !p.postcode) continue;
    try {
      const areaKey = `area:v2:${(p.location ?? "").toLowerCase()}|${p.postcode ?? ""}`;
      const { value } = await cached(d, ctx, areaKey, 7 * 86400, () => d.data.geocodeArea(p));
      return { area: value, parsed: p };
    } catch (e) {
      lastError = e;
      // Solo se prueba la siguiente interpretación si la zona no existe; si el servicio falla, se corta
      if (!(e instanceof ExternalError) || e.status !== 404) throw e;
    }
  }
  throw lastError ?? new ExternalError("No se ha encontrado la zona.", "nominatim", 404);
}

async function handleSearch(req: Request, env: Env, ctx: Ctx) {
  const body = await readJson(req);
  const q = str(body.q, 300);
  if (!q) return fail(400, "Escribe qué quieres encontrar, por ejemplo «Peluquerías en Lleida».");
  const limit = Math.min(Math.max(Number(body.limit) || 200, 5), 500);
  const first = parseQuery(q);
  if (!first.location && !first.postcode) return fail(400, "Indica una zona: por ejemplo «… en Lleida», «… de Tenerife» o un código postal.", { parsed: first });

  const toggles = await getToggles(env);
  const d = deps(env, req, toggles);
  if (!toggles.osm && !d.google) return fail(503, "Todas las fuentes de búsqueda están desconectadas. Activa Google Maps u OpenStreetMap en Ajustes → Conexiones.");
  const { area, parsed } = await geocodeWithAlternatives(d, ctx, first);
  const sectors = parsed.sectorIds.map(resolveSector).filter((s): s is NonNullable<typeof s> => !!s);
  if (!sectors.length) return fail(400, "No he entendido el sector. Prueba con «dentistas», «restaurantes», «peluquerías»…", { parsed });

  const warnings: string[] = [];
  const sKey = `companies:v2:${area.overpassAreaId ?? area.bbox.join(",")}:${[...parsed.sectorIds].sort().join(",")}:${limit}`;
  const osmTask = toggles.osm ? cached(d, ctx, sKey, 12 * 3600, () => d.data.searchCompanies(area, parsed.sectorIds, limit)) : Promise.resolve({ value: [] as Company[], hit: false });
  const googleTask = d.google ? d.google.searchCompanies(area, sectors, limit) : null;
  // Si Google ya ha respondido, OSM solo complementa: no se le espera más de 15 s
  const osmBounded = googleTask
    ? Promise.allSettled([googleTask]).then(([g]) =>
        g.status === "fulfilled" ? Promise.race([osmTask, new Promise<never>((_, rej) => setTimeout(() => rej(new ExternalError("OpenStreetMap tarda demasiado", "overpass", 504)), 15000))]) : osmTask,
      )
    : osmTask;
  const [osmR, googleR] = await Promise.allSettled([osmBounded, googleTask ?? Promise.resolve(null)]);

  const osm = osmR.status === "fulfilled" ? osmR.value.value : [];
  const google = googleR.status === "fulfilled" ? googleR.value : null;
  if (osmR.status === "rejected") {
    if (!google) throw osmR.reason;
    warnings.push("OpenStreetMap no ha respondido; se muestran solo los resultados de Google.");
  }
  if (googleR.status === "rejected") {
    if (osmR.status === "rejected") throw googleR.reason;
    warnings.push(`Google Places: ${(googleR.reason as Error).message} Se muestran solo los resultados de OpenStreetMap.`);
  }
  if (!d.google) warnings.push(env.GOOGLE_PLACES_API_KEY ? "Google Maps está desconectado en Ajustes → Conexiones: solo se busca en OpenStreetMap y faltan negocios." : "Solo OpenStreetMap: faltan negocios. La app no encuentra la variable GOOGLE_PLACES_API_KEY: añádela en Cloudflare como Secreto.");
  if (google?.truncated) warnings.push(`Zona muy grande: se ha parado en ${google.companies.length} negocios de Google para controlar el coste. Busca por municipio para verlos todos.`);

  const companies = google ? mergeCompanies(google.companies, osm) : osm;

  let results = companies.map((c) => {
    const a = analyzeCompany(c);
    return { company: c, score: a.score, recommended: a.recommended, opportunities: a.opportunities.slice(0, 6), system: systemGap(a.opportunities) };
  });
  if (parsed.filters.withoutWebsite) results = results.filter((r) => !r.company.website);
  if (parsed.filters.withWebsite) results = results.filter((r) => !!r.company.website);
  if (parsed.filters.withoutBooking) results = results.filter((r) => r.opportunities.some((o) => o.id === "booking"));
  results.sort((a, b) => b.score.score - a.score.score);
  results = results.slice(0, limit);

  const sources = [google && "Google Maps", toggles.osm && osmR.status === "fulfilled" && "OpenStreetMap"].filter(Boolean) as string[];
  const costUsd = google ? +(google.calls * GOOGLE_CALL_USD).toFixed(3) : 0;
  return json({
    parsed,
    area,
    results,
    warnings,
    meta: {
      total: results.length,
      cacheHit: osmR.status === "fulfilled" ? osmR.value.hit : false,
      rulesVersion: RULES_VERSION,
      sources,
      source: sources.join(" + "),
      googleCalls: google?.calls ?? 0,
      attribution: sources.includes("OpenStreetMap") ? "© colaboradores de OpenStreetMap (ODbL)" : "",
      costUsd,
      costEur: costUsd,
    },
  });
}

async function handleAnalyze(req: Request, env: Env, ctx: Ctx) {
  const body = await readJson(req);
  const company = validateCompany(body.company);
  if (!company) return fail(400, "Empresa no válida.");
  const d = deps(env, req);
  let audit: WebAudit | undefined;
  let cacheHit = false;
  if (company.website) {
    const r = await cached(d, ctx, `audit:v1:${company.website.toLowerCase()}`, 24 * 3600, () =>
      auditWebsite(company.website!, { userAgent: userAgent(env, req), botName: "OpportunityOSBot", fetchImpl: d.fetchImpl }),
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
  const d = deps(env, req);
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
  if (!(await getToggles(env)).ai) return fail(503, "La IA está desconectada en Ajustes → Conexiones.");
  const d = deps(env, req);
  const provider = createProvider(env, d.fetchImpl);
  if ("missing" in provider) return fail(503, `La IA no está configurada. Añade la variable ${provider.missing}.`, { missing: provider.missing });

  // Se recalcula el análisis en el servidor: la IA solo recibe señales que hemos obtenido nosotros.
  let audit: WebAudit | undefined;
  if (company.website) {
    audit = (await cached(d, ctx, `audit:v1:${company.website.toLowerCase()}`, 24 * 3600, () =>
      auditWebsite(company.website!, { userAgent: userAgent(env, req), botName: "OpportunityOSBot", fetchImpl: d.fetchImpl }),
    )).value;
  }
  const analysis: Analysis = analyzeCompany(company, audit);
  const request = buildGenerationPrompt(analysis, kind, str(body.senderName, 60) ?? env.SENDER_NAME ?? "[tu nombre]", str(body.agencyName, 60) ?? env.AGENCY_NAME ?? "Digital Zyra");
  const out = await provider.generate(request);
  const cost = estimateCostUsd(out.model, out.inputTokens, out.outputTokens);
  return json({ text: out.text, kind, meta: { provider: out.provider, model: out.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens, estimatedCostUsd: cost } });
}

async function handleConfig(env: Env) {
  const ai = createProvider(env);
  const toggles = await getToggles(env);
  return json({
    integrations: {
      openStreetMap: true,
      contactEmail: !!env.CONTACT_EMAIL,
      googlePlaces: !!env.GOOGLE_PLACES_API_KEY,
      googleMaxCalls: Math.min(Math.max(Number(env.GOOGLE_MAX_CALLS) || 12, 1), 60),
      googleMaps: !!(env.GOOGLE_MAPS_BROWSER_KEY ?? env.GOOGLE_PLACES_API_KEY),
      ai: !("missing" in ai),
      aiFree: !!env.AI,
      aiProvider: "missing" in ai ? null : `${ai.name} · ${ai.model}`,
    },
    // Solo para usuarios con sesión: carga el mapa de Google en el navegador
    mapsKey: toggles.googleMap ? (env.GOOGLE_MAPS_BROWSER_KEY ?? env.GOOGLE_PLACES_API_KEY ?? null) : null,
    toggles,
    canToggle: !!env.SETTINGS,
    contact: ZYRA_CONTACT,
    missing: [!env.GOOGLE_PLACES_API_KEY && "GOOGLE_PLACES_API_KEY", "missing" in ai && ai.missing, !env.CONTACT_EMAIL && "CONTACT_EMAIL"].filter(Boolean),
    rulesVersion: RULES_VERSION,
  });
}

async function handleAssistant(req: Request, env: Env) {
  const body = await readJson(req, 32_000);
  const raw = Array.isArray(body.messages) ? body.messages.slice(-10) : [];
  const messages: ChatMessage[] = raw
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m: any) => ({ role: m.role, content: m.content.trim().slice(0, 1500) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return fail(400, "Escribe tu pregunta.");
  if (!(await getToggles(env)).ai) return fail(503, "La IA está desconectada en Ajustes → Conexiones.");
  const system = assistantSystem(str(body.agencyName, 60) ?? env.AGENCY_NAME ?? "Digital Zyra", str(body.senderName, 60) ?? env.SENDER_NAME ?? "", str(body.context, 4000));
  // El asistente usa la IA gratuita si existe; si no, la de pago configurada
  const free = freeProvider(env);
  let text: string;
  let model: string;
  if (free) {
    const r = await free.chat(system, messages, 700);
    text = r.text;
    model = r.model;
  } else {
    const provider = createProvider(env, deps(env, req).fetchImpl);
    if ("missing" in provider) return fail(503, "El asistente no está disponible: falta configurar la IA.", { missing: provider.missing });
    const r = await provider.generate({ system, prompt: flattenChat(messages), maxTokens: 700 });
    text = r.text;
    model = r.model;
  }
  return json({ text: text || "Ahora mismo no tengo respuesta. Prueba a reformular la pregunta o escribe a ZYRA.", meta: { model } });
}

// ---------- Login ----------

function loginPage(error?: string): Response {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpportunityOS · Acceso</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&display=swap"><link rel="stylesheet" href="/styles.css"></head>
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

  if ((url.pathname === "/styles.css" || url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") && env.ASSETS) {
    return env.ASSETS.fetch(url.pathname === "/favicon.ico" ? new Request(new URL("/favicon.svg", url), req) : req);
  }

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
    if (req.method === "GET" && url.pathname === "/api/config") return await handleConfig(env);
    if (url.pathname.startsWith("/api/crm/")) {
      const origin = req.headers.get("origin");
      if (req.method === "POST" && origin && origin !== url.origin) return fail(403, "Origen no permitido.");
      try {
        const body = req.method === "POST" ? await readJson(req) : {};
        return await handleCrm(req, env.DB, url.pathname, body, validateCompany);
      } catch (e) {
        if (e instanceof ExternalError) return fail(e.status ?? 400, e.message);
        console.error(JSON.stringify({ level: "error", path: url.pathname, message: (e as Error).message }));
        return fail(500, "Error en el pipeline. Revisa los logs del Worker.");
      }
    }
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
        case "/api/admin/toggles":
          return await handleAdminToggles(req, env);
        case "/api/assistant":
          if (!aiLimiter.allow(`ai:${ip}`)) return fail(429, "Demasiadas preguntas seguidas. Espera un minuto.");
          return await handleAssistant(req, env);
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
