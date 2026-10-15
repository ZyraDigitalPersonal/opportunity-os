// API del módulo «Prácticas y empleo formativo» sobre Cloudflare D1.
// Todos los datos personales (perfil, candidaturas, notas) se filtran por owner_id; la investigación pública
// de empresas (hechos sacados de su propia web) se comparte como caché. Nada de Google se guarda en servidor.

import { ExternalError, fetchWithTimeout } from "../core/http.js";
import { nameKey, OsmProvider } from "../core/osm.js";
import { createProvider, estimateCostUsd, type AIEnv } from "../core/ai.js";
import { mentionsInternship } from "../core/reviews.js";
import { toReviewItems } from "../core/google-places.js";
import type { GeoArea } from "../core/types.js";
import { currentUser, USAGE_LIMIT_KEY, type CurrentUser, type UsageKind } from "../core/plans.js";
import { exampleProfile, FAMILIES, getFamily, sanitizeProfile } from "../core/practicas/families.js";
import { researchCompany } from "../core/practicas/research.js";
import { FIT_WEIGHTS, haversineKm, headlineOf, scoreOpportunity, VIABILITY_BASE } from "../core/practicas/scoring.js";
import {
  adzunaSearch,
  cachedJson,
  feedQuery,
  googleDiscovery,
  GOOGLE_DISCOVERY_USD,
  joobleSearch,
  manualLinks,
  osmDiscoveryQuery,
  osmToCompanies,
  bboxAround,
  reputationLinks,
  type KvCache,
} from "../core/practicas/sources.js";
import { APP_STATUSES, APP_STATUS_IDS, OPEN_APP_STATUSES, STATUS_FOLLOWUP, appStatusLabel, type AppActivity, type Application } from "../core/practicas/tracker.js";
import { buildInternPrompt, INTERN_KINDS, type InternKind } from "../core/practicas/prompts.js";
import { NATURE_LABEL, type CompanyResearch, type DirCompany, type InternOpportunity, type JobOffer, type Scope, type SourceStatus, type StudentProfile } from "../core/practicas/types.js";
import type { D1Like } from "./crm.js";

export interface PracticasEnv extends AIEnv {
  DB?: D1Like;
  GOOGLE_PLACES_API_KEY?: string;
  ADZUNA_APP_ID?: string;
  ADZUNA_APP_KEY?: string;
  JOOBLE_API_KEY?: string;
  PLAN?: string;
  PRACTICAS_GOOGLE_MAX_CALLS?: string;
  CONTACT_EMAIL?: string;
}

export interface PracticasDeps {
  fetchImpl: typeof fetch;
  geocode: (location: string) => Promise<GeoArea>;
  osm: Pick<OsmProvider, "runOverpass"> | null;
  userAgent: string;
  googleEnabled: boolean;
  aiEnabled: boolean;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS intern_profiles (owner_id TEXT NOT NULL, id TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, id))`,
  `CREATE TABLE IF NOT EXISTS intern_research (domain TEXT PRIMARY KEY, website TEXT, research_json TEXT NOT NULL, checked_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS intern_apps (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, org_id TEXT, opp_key TEXT NOT NULL, company_name TEXT NOT NULL, company_json TEXT NOT NULL, offer_json TEXT, nature TEXT NOT NULL, status TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, fit INTEGER, viability INTEGER, confidence INTEGER, notes TEXT, next_step TEXT, next_date TEXT, contact_date TEXT, interview_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (owner_id, opp_key))`,
  `CREATE INDEX IF NOT EXISTS intern_apps_owner ON intern_apps (owner_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS intern_activities (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, application_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, to_status TEXT)`,
  `CREATE INDEX IF NOT EXISTS intern_activities_app ON intern_activities (owner_id, application_id, at)`,
  `CREATE TABLE IF NOT EXISTS usage (owner_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (owner_id, day, kind))`,
  `CREATE TABLE IF NOT EXISTS kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
];
const schemaReady = new WeakSet<object>();
export async function ensurePracticasSchema(db: D1Like) {
  if (schemaReady.has(db)) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  schemaReady.add(db);
}

const RESEARCH_TTL_DAYS = 14;
const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const s = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const httpsUrl = (v: unknown, max = 600) => (typeof v === "string" && /^https?:\/\/[^\s]+$/i.test(v) ? v.slice(0, max) : undefined);
const numOr = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function d1Cache(db: D1Like): KvCache {
  return {
    async get(key) {
      const row = await db.prepare("SELECT value, expires_at FROM kv_cache WHERE key = ?").bind(key).first<{ value: string; expires_at: number }>();
      return row && row.expires_at > Date.now() ? row.value : null;
    },
    async put(key, value, ttl) {
      await db.prepare("INSERT INTO kv_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at").bind(key, value, Date.now() + ttl * 1000).run();
    },
  };
}

// ---------- Uso y límites (coste medible por usuario) ----------

async function usageToday(db: D1Like, user: CurrentUser): Promise<Record<string, { n: number; cost: number }>> {
  const { results } = await db.prepare("SELECT kind, n, cost_usd FROM usage WHERE owner_id = ? AND day = ?").bind(user.id, today()).all<{ kind: string; n: number; cost_usd: number }>();
  const out: Record<string, { n: number; cost: number }> = {};
  for (const r of results) out[r.kind] = { n: r.n, cost: r.cost_usd };
  return out;
}

async function checkLimit(db: D1Like, user: CurrentUser, kind: UsageKind, amount = 1): Promise<string | null> {
  const u = await usageToday(db, user);
  const limit = user.plan.limits[USAGE_LIMIT_KEY[kind]];
  return (u[kind]?.n ?? 0) + amount > limit ? `Has llegado al límite diario de tu plan (${user.plan.label}: ${limit}). Vuelve mañana.` : null;
}

async function addUsage(db: D1Like, user: CurrentUser, kind: UsageKind, n: number, costUsd = 0) {
  if (!n && !costUsd) return;
  await db
    .prepare("INSERT INTO usage (owner_id, day, kind, n, cost_usd) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id, day, kind) DO UPDATE SET n = n + excluded.n, cost_usd = cost_usd + excluded.cost_usd")
    .bind(user.id, today(), kind, n, costUsd)
    .run();
}

// ---------- Validación de datos que vuelven del navegador ----------

export function validateDirCompany(v: any): DirCompany | null {
  if (!v || typeof v !== "object") return null;
  const id = s(v.id, 260);
  const name = s(v.name, 200);
  if (!id || !name || !/^(gp:[A-Za-z0-9_-]{10,250}|osm:(node|way|relation)\/\d+|web:[a-z0-9.-]{3,200}|job:[\w:.\/-]{3,250})$/.test(id)) return null;
  const lat = numOr(v.lat);
  const lon = numOr(v.lon);
  return {
    id,
    name,
    website: httpsUrl(v.website, 300),
    phone: s(v.phone, 40) ?? undefined,
    address: s(v.address, 200) ?? undefined,
    city: s(v.city, 100) ?? undefined,
    lat: lat !== undefined && Math.abs(lat) <= 90 ? lat : undefined,
    lon: lon !== undefined && Math.abs(lon) <= 180 ? lon : undefined,
    source: s(v.source, 60) ?? "Desconocida",
    sourceUrl: httpsUrl(v.sourceUrl, 400),
    category: s(v.category, 80) ?? undefined,
    rating: numOr(v.rating),
    reviews: numOr(v.reviews),
  };
}

export function validateOffer(v: any): JobOffer | undefined {
  if (!v || typeof v !== "object") return undefined;
  const id = s(v.id, 220);
  const title = s(v.title, 200);
  const url = httpsUrl(v.url);
  if (!id || !title || !url || !/^(adzuna|jooble):/.test(id)) return undefined;
  return {
    id,
    source: id.startsWith("adzuna:") ? "Adzuna" : "Jooble",
    title,
    company: s(v.company, 120) ?? undefined,
    location: s(v.location, 120) ?? undefined,
    snippet: s(v.snippet, 600) ?? undefined,
    url,
    created: s(v.created, 40) ?? undefined,
    remote: !!v.remote,
    internship: !!v.internship,
    lat: numOr(v.lat),
    lon: numOr(v.lon),
    contract: s(v.contract, 80) ?? undefined,
  };
}

function domainOf(u?: string): string | null {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "").toLowerCase() : null;
  } catch {
    return null;
  }
}

async function loadProfile(db: D1Like, user: CurrentUser): Promise<StudentProfile | null> {
  const row = await db.prepare("SELECT data_json FROM intern_profiles WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 1").bind(user.id).first<{ data_json: string }>();
  if (!row) return null;
  try {
    return sanitizeProfile(JSON.parse(row.data_json));
  } catch {
    return null;
  }
}

async function cachedResearch(db: D1Like, domains: string[]): Promise<Map<string, CompanyResearch>> {
  const out = new Map<string, CompanyResearch>();
  const uniq = [...new Set(domains)].slice(0, 400);
  for (let i = 0; i < uniq.length; i += 80) {
    const chunk = uniq.slice(i, i + 80);
    const { results } = await db.prepare(`SELECT domain, research_json FROM intern_research WHERE domain IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ domain: string; research_json: string }>();
    for (const r of results) {
      try {
        out.set(r.domain, JSON.parse(r.research_json));
      } catch {}
    }
  }
  return out;
}

function buildOpportunity(profile: StudentProfile, company: DirCompany, center: [number, number] | null, research: CompanyResearch | null | undefined, offer?: JobOffer): InternOpportunity {
  const lat = company.lat ?? offer?.lat;
  const lon = company.lon ?? offer?.lon;
  const distanceKm = center && lat !== undefined && lon !== undefined && !offer?.remote ? Math.round(haversineKm(center, [lat, lon]) * 10) / 10 : undefined;
  const sc = scoreOpportunity({ profile, company, offer, research, distanceKm });
  const { techs, nature, modality, ...score } = sc;
  const warnings: string[] = [];
  if (nature === "potencial") warnings.push("Sin confirmar que acepte estudiantes");
  if (offer && !offer.internship) warnings.push("Oferta de empleo, no de prácticas");
  if (research?.blockedByRobots) warnings.push("Su web no permite análisis automático");
  if (distanceKm !== undefined && distanceKm > profile.maxDistanceKm) warnings.push(`A ${Math.round(distanceKm)} km`);
  const checkedAt = research?.checkedAt ?? offer?.created ?? nowIso();
  return {
    key: offer ? `${company.id}|${offer.id}` : company.id,
    nature,
    company,
    offer,
    research: research ?? null,
    distanceKm,
    modality,
    techs,
    headline: headlineOf(score, nature),
    warnings,
    checkedAt,
    score,
  };
}

// ---------- Búsqueda ----------

async function handleSearch(db: D1Like, env: PracticasEnv, deps: PracticasDeps, user: CurrentUser, body: any): Promise<Response> {
  const profile = sanitizeProfile(body.profile) ?? (await loadProfile(db, user));
  if (!profile) return fail(400, "Completa tu perfil (estudios y localidad) antes de buscar.");
  const scope: Scope = ["local", "nacional", "remota"].includes(body.scope) ? body.scope : "local";
  const limitMsg = await checkLimit(db, user, "practicas_search");
  if (limitMsg) return fail(429, limitMsg);
  const fam = getFamily(profile.familyId);
  const cache = d1Cache(db);
  const sources: SourceStatus[] = [];
  const warnings: string[] = [];
  let costUsd = 0;
  let googleCalls = 0;

  let area: GeoArea | null = null;
  try {
    area = (await cachedJson(cache, `geo:v1:${profile.location.toLowerCase()}`, 30 * 86400, () => deps.geocode(profile.location))).value;
  } catch (e) {
    if (scope === "local") return fail(e instanceof ExternalError && e.status === 404 ? 404 : 502, (e as Error).message);
    warnings.push(`No se ha podido localizar «${profile.location}»: no se calculan distancias.`);
  }
  const center = area?.center ?? null;

  const companies: DirCompany[] = [];
  // Directorios de empresas (solo búsqueda local: tiene sentido alrededor del estudiante)
  if (scope === "local" && center) {
    const km = Math.min(profile.maxDistanceKm, 60);
    if (!env.GOOGLE_PLACES_API_KEY) sources.push({ id: "google", name: "Google Maps (empresas)", status: "sin_configurar", detail: "Falta GOOGLE_PLACES_API_KEY" });
    else if (!deps.googleEnabled) sources.push({ id: "google", name: "Google Maps (empresas)", status: "omitida", detail: "Desconectado en Ajustes → Conexiones" });
    else if (!fam.googleQueries.length) sources.push({ id: "google", name: "Google Maps (empresas)", status: "omitida", detail: "Tu familia profesional no tiene búsquedas de empresas predefinidas" });
    else {
      const maxCalls = Math.min(Math.max(Number(env.PRACTICAS_GOOGLE_MAX_CALLS) || 6, 1), 12);
      const lim = await checkLimit(db, user, "google_calls", maxCalls);
      if (lim) sources.push({ id: "google", name: "Google Maps (empresas)", status: "omitida", detail: lim });
      else
        try {
          // Sin caché a propósito: los términos de Google no permiten almacenar este contenido.
          const g = await googleDiscovery(env.GOOGLE_PLACES_API_KEY, fam, center, km, maxCalls, deps.fetchImpl);
          googleCalls = g.calls;
          costUsd += g.calls * GOOGLE_DISCOVERY_USD;
          companies.push(...g.companies);
          sources.push({ id: "google", name: "Google Maps (empresas)", status: "ok", detail: `${g.companies.length} empresas · ${g.calls} consultas`, count: g.companies.length, costUsd: +(g.calls * GOOGLE_DISCOVERY_USD).toFixed(3) });
        } catch (e) {
          sources.push({ id: "google", name: "Google Maps (empresas)", status: "error", detail: (e as Error).message });
        }
    }
    const q = deps.osm ? osmDiscoveryQuery(fam, bboxAround(center, km)) : null;
    if (q && deps.osm) {
      try {
        const els = (await cachedJson(cache, `osm:prac:v1:${fam.id}:${center.map((x) => x.toFixed(3)).join(",")}:${km}`, 86400, () => deps.osm!.runOverpass(q))).value;
        const found = osmToCompanies(els as any, fam);
        let added = 0;
        for (const o of found) {
          const dup = companies.find((c) => c.lat !== undefined && c.lon !== undefined && o.lat !== undefined && Math.abs(c.lat - o.lat) < 0.003 && Math.abs(c.lon - o.lon!) < 0.003 && nameKey(c.name) === nameKey(o.name));
          if (dup) {
            dup.website ??= o.website;
            dup.alsoIn = "OpenStreetMap";
          } else {
            companies.push(o);
            added++;
          }
        }
        sources.push({ id: "osm", name: "OpenStreetMap (empresas)", status: "ok", detail: `${found.length} empresas (${added} nuevas)`, count: added });
      } catch (e) {
        sources.push({ id: "osm", name: "OpenStreetMap (empresas)", status: "error", detail: (e as Error).message });
      }
    }
  } else if (scope !== "local") {
    sources.push({ id: "google", name: "Directorio de empresas", status: "omitida", detail: "En búsqueda nacional o remota se usan portales de empleo. Para descubrir empresas sin oferta, busca en local por ciudad." });
  }

  // Portales de empleo con API oficial
  const fq = feedQuery(profile, scope);
  const offers: JobOffer[] = [];
  const feedKey = `${scope}:${fq.location ?? "es"}:${fq.distanceKm ?? ""}:${fq.keywords.join(",")}`.toLowerCase();
  if (env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) {
    try {
      const r = await cachedJson(cache, `adzuna:v1:${feedKey}`, 6 * 3600, () => adzunaSearch(env.ADZUNA_APP_ID!, env.ADZUNA_APP_KEY!, fq, deps.fetchImpl));
      offers.push(...r.value.offers);
      sources.push({ id: "adzuna", name: "Adzuna (ofertas)", status: "ok", detail: `${r.value.offers.length} ofertas${r.hit ? " · caché" : ""}`, count: r.value.offers.length });
    } catch (e) {
      sources.push({ id: "adzuna", name: "Adzuna (ofertas)", status: "error", detail: (e as Error).message });
    }
  } else sources.push({ id: "adzuna", name: "Adzuna (ofertas)", status: "sin_configurar", detail: "Clave gratuita en developer.adzuna.com: ADZUNA_APP_ID y ADZUNA_APP_KEY" });
  if (env.JOOBLE_API_KEY) {
    try {
      const r = await cachedJson(cache, `jooble:v1:${feedKey}`, 6 * 3600, () => joobleSearch(env.JOOBLE_API_KEY!, fq, deps.fetchImpl));
      for (const o of r.value.offers) if (!offers.some((x) => x.url === o.url || (x.title === o.title && x.company === o.company))) offers.push(o);
      sources.push({ id: "jooble", name: "Jooble (ofertas)", status: "ok", detail: `${r.value.offers.length} ofertas${r.hit ? " · caché" : ""}`, count: r.value.offers.length });
    } catch (e) {
      sources.push({ id: "jooble", name: "Jooble (ofertas)", status: "error", detail: (e as Error).message });
    }
  } else sources.push({ id: "jooble", name: "Jooble (ofertas)", status: "sin_configurar", detail: "Clave gratuita en jooble.org/api/about: JOOBLE_API_KEY" });

  // Investigación ya hecha (caché compartida de hechos públicos)
  const research = await cachedResearch(db, companies.map((c) => domainOf(c.website)).filter((d): d is string => !!d));

  const opps: InternOpportunity[] = [];
  const usedCompanies = new Set<string>();
  for (const o of offers) {
    const match = o.company ? companies.find((c) => nameKey(c.name) === nameKey(o.company!) || (nameKey(o.company!).length >= 5 && nameKey(c.name).includes(nameKey(o.company!)))) : undefined;
    const company: DirCompany = match ?? { id: `job:${o.id}`.slice(0, 250), name: o.company ?? "Empresa no indicada en la oferta", source: o.source, sourceUrl: o.url, lat: o.lat, lon: o.lon, city: o.location };
    if (match) usedCompanies.add(match.id);
    opps.push(buildOpportunity(profile, company, center, match ? research.get(domainOf(match.website) ?? "") : null, o));
  }
  for (const c of companies) {
    if (usedCompanies.has(c.id)) continue;
    opps.push(buildOpportunity(profile, c, center, research.get(domainOf(c.website) ?? "") ?? null));
  }
  const excluded = profile.exclude.map((x) => x.toLowerCase()).filter(Boolean);
  const visible = opps.filter((o) => !excluded.some((x) => o.company.name.toLowerCase().includes(x)));
  visible.sort((a, b) => b.score.fit - a.score.fit || b.score.viability - a.score.viability);

  await addUsage(db, user, "practicas_search", 1);
  if (googleCalls) await addUsage(db, user, "google_calls", googleCalls, costUsd);
  if (!opps.length) warnings.push(scope === "local" ? "No se han encontrado empresas ni ofertas. Amplía la distancia, prueba la búsqueda nacional o conecta un portal de empleo." : "Ningún portal de empleo ha devuelto ofertas. Configura Adzuna o Jooble, o usa los enlaces de búsqueda manual.");
  return json({
    profile,
    scope,
    area,
    results: visible.slice(0, 300),
    sources,
    manualLinks: manualLinks(profile, scope),
    warnings,
    meta: { total: visible.length, googleCalls, costUsd: +costUsd.toFixed(3), offers: offers.length, companies: companies.length, researched: research.size, generatedAt: nowIso() },
  });
}

// ---------- Investigación de una empresa ----------

async function placeReviews(apiKey: string, placeId: string, f: typeof fetch) {
  const res = await fetchWithTimeout(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=es`, { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "id,rating,userRatingCount,reviews,googleMapsUri" } }, 10000, f);
  if (!res.ok) throw new ExternalError(`Google Places respondió ${res.status}`, "google", res.status);
  const p = (await res.json()) as any;
  const reviews = toReviewItems(p.reviews);
  return { rating: p.rating as number | undefined, count: p.userRatingCount as number | undefined, mapsUri: p.googleMapsUri as string | undefined, internship: reviews.filter((r) => mentionsInternship(r.text)), general: reviews.filter((r) => !mentionsInternship(r.text)) };
}

/** Coste aproximado de Place Details con reseñas (Enterprise + Atmosphere). */
const PLACE_DETAILS_USD = 0.025;

async function handleResearch(db: D1Like, env: PracticasEnv, deps: PracticasDeps, user: CurrentUser, body: any): Promise<Response> {
  const company = validateDirCompany(body.company);
  if (!company) return fail(400, "Empresa no válida.");
  const offer = validateOffer(body.offer);
  const manualWeb = httpsUrl(body.website, 300);
  if (manualWeb) company.website = manualWeb;
  const profile = sanitizeProfile(body.profile) ?? (await loadProfile(db, user)) ?? exampleProfile();
  const domain = domainOf(company.website);
  let research: CompanyResearch | null = null;
  let fromCache = false;
  if (domain) {
    const row = await db.prepare("SELECT research_json, checked_at FROM intern_research WHERE domain = ?").bind(domain).first<{ research_json: string; checked_at: string }>();
    const fresh = row && Date.now() - Date.parse(row.checked_at) < RESEARCH_TTL_DAYS * 86400000;
    if (row && fresh && !body.force) {
      research = JSON.parse(row.research_json);
      fromCache = true;
    } else {
      const lim = await checkLimit(db, user, "research");
      if (lim) return fail(429, lim);
      research = await researchCompany(company.website!, { userAgent: deps.userAgent, botName: "OpportunityOSBot", familyId: profile.familyId, fetchImpl: deps.fetchImpl });
      if (!research.error) {
        await db
          .prepare("INSERT INTO intern_research (domain, website, research_json, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(domain) DO UPDATE SET website = excluded.website, research_json = excluded.research_json, checked_at = excluded.checked_at")
          .bind(domain, research.website, JSON.stringify(research), research.checkedAt)
          .run();
      }
      await addUsage(db, user, "research", 1);
    }
  }
  // Reseñas de Google en vivo (no se guardan): separa las que hablan de prácticas de las generales
  let reviews: Awaited<ReturnType<typeof placeReviews>> | null = null;
  let reviewsError: string | null = null;
  if (company.id.startsWith("gp:") && env.GOOGLE_PLACES_API_KEY && deps.googleEnabled && body.reviews !== false) {
    const lim = await checkLimit(db, user, "google_calls");
    if (!lim)
      try {
        reviews = await placeReviews(env.GOOGLE_PLACES_API_KEY, company.id.slice(3), deps.fetchImpl);
        await addUsage(db, user, "google_calls", 1, PLACE_DETAILS_USD);
      } catch (e) {
        reviewsError = (e as Error).message;
      }
    else reviewsError = lim;
  }
  const area = await cachedJson(d1Cache(db), `geo:v1:${profile.location.toLowerCase()}`, 30 * 86400, () => deps.geocode(profile.location)).then((r) => r.value).catch(() => null);
  const opportunity = buildOpportunity(profile, company, area?.center ?? null, research, offer);
  return json({
    opportunity,
    fromCache,
    noWebsite: !domain,
    reviews,
    reviewsError,
    reputationLinks: reputationLinks(company.name, company.city),
    meta: { researchTtlDays: RESEARCH_TTL_DAYS },
  });
}

// ---------- Candidaturas ----------

async function logAct(db: D1Like, user: CurrentUser, appId: string, kind: AppActivity["kind"], text: string | null, to: string | null = null) {
  await db.prepare("INSERT INTO intern_activities (owner_id, application_id, at, kind, text, to_status) VALUES (?, ?, ?, ?, ?, ?)").bind(user.id, appId, nowIso(), kind, text, to).run();
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function handleAppSave(db: D1Like, user: CurrentUser, body: any): Promise<Response> {
  const company = validateDirCompany(body.company);
  if (!company) return fail(400, "Empresa no válida.");
  // Términos de Google: no se guarda valoración ni número de reseñas
  delete company.rating;
  delete company.reviews;
  const offer = validateOffer(body.offer);
  const key = s(body.key, 520) ?? company.id;
  const status = APP_STATUS_IDS.includes(body.status) ? body.status : "por_investigar";
  const existing = await db.prepare("SELECT id, status, favorite FROM intern_apps WHERE owner_id = ? AND opp_key = ?").bind(user.id, key).first<{ id: string; status: string; favorite: number }>();
  const t = nowIso();
  const fit = numOr(body.fit);
  const viability = numOr(body.viability);
  const confidence = numOr(body.confidence);
  const nature = ["oferta_publicada", "programa", "interes_estudiantes", "potencial"].includes(body.nature) ? body.nature : "potencial";
  if (existing) {
    await db
      .prepare("UPDATE intern_apps SET company_json = ?, offer_json = COALESCE(?, offer_json), nature = ?, fit = COALESCE(?, fit), viability = COALESCE(?, viability), confidence = COALESCE(?, confidence), favorite = CASE WHEN ? IS NULL THEN favorite ELSE ? END, updated_at = ? WHERE id = ? AND owner_id = ?")
      .bind(JSON.stringify(company), offer ? JSON.stringify(offer) : null, nature, fit ?? null, viability ?? null, confidence ?? null, body.favorite === undefined ? null : 1, body.favorite ? 1 : 0, t, existing.id, user.id)
      .run();
    return json({ ok: true, created: false, id: existing.id });
  }
  const id = crypto.randomUUID();
  const fu = STATUS_FOLLOWUP[status as keyof typeof STATUS_FOLLOWUP];
  await db
    .prepare("INSERT INTO intern_apps (id, owner_id, org_id, opp_key, company_name, company_json, offer_json, nature, status, favorite, fit, viability, confidence, next_step, next_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, user.id, user.orgId, key, company.name, JSON.stringify(company), offer ? JSON.stringify(offer) : null, nature, status, body.favorite ? 1 : 0, fit ?? null, viability ?? null, confidence ?? null, fu?.step ?? null, fu ? addDaysIso(fu.days) : null, t, t)
    .run();
  await logAct(db, user, id, "sistema", `Guardada (${NATURE_LABEL[nature as keyof typeof NATURE_LABEL]})`, status);
  return json({ ok: true, created: true, id });
}

async function handleAppUpdate(db: D1Like, user: CurrentUser, body: any): Promise<Response> {
  const id = s(body.id, 60);
  if (!id) return fail(400, "Falta el id.");
  const app = await db.prepare("SELECT * FROM intern_apps WHERE id = ? AND owner_id = ?").bind(id, user.id).first<Application>();
  if (!app) return fail(404, "Esa candidatura no existe.");
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  let newStatus: string | null = null;
  if (typeof body.status === "string" && APP_STATUS_IDS.includes(body.status) && body.status !== app.status) {
    newStatus = body.status;
    set("status", body.status);
    const fu = STATUS_FOLLOWUP[body.status as keyof typeof STATUS_FOLLOWUP];
    if (fu && body.nextDate === undefined) {
      set("next_date", addDaysIso(fu.days));
      set("next_step", fu.step);
    }
    if (!OPEN_APP_STATUSES.includes(body.status) && body.nextDate === undefined) {
      set("next_date", null);
      set("next_step", null);
    }
    if (body.status === "contactada" && !app.contact_date && body.contactDate === undefined) set("contact_date", today());
  }
  if (body.favorite !== undefined) set("favorite", body.favorite ? 1 : 0);
  if (body.nextDate === null || isDate(body.nextDate)) set("next_date", body.nextDate);
  if (body.nextStep === null || typeof body.nextStep === "string") set("next_step", body.nextStep === null ? null : s(body.nextStep, 200));
  if (body.contactDate === null || isDate(body.contactDate)) set("contact_date", body.contactDate);
  if (body.interviewDate === null || isDate(body.interviewDate)) set("interview_date", body.interviewDate);
  if (body.notes === null || typeof body.notes === "string") set("notes", body.notes === null ? null : s(body.notes, 4000));
  set("updated_at", nowIso());
  await db.prepare(`UPDATE intern_apps SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`).bind(...vals, id, user.id).run();
  const note = s(body.note, 2000);
  const kind: AppActivity["kind"] = ["nota", "contacto", "entrevista", "seguimiento"].includes(body.kind) ? body.kind : newStatus ? "estado" : "nota";
  if (newStatus || note) await logAct(db, user, id, kind, note ?? `Estado: ${appStatusLabel(newStatus!)}`, newStatus);
  const updated = await db.prepare("SELECT * FROM intern_apps WHERE id = ? AND owner_id = ?").bind(id, user.id).first<Application>();
  return json({ ok: true, app: updated });
}

async function handleSummary(db: D1Like, user: CurrentUser, day: string): Promise<Response> {
  const open = OPEN_APP_STATUSES.map(() => "?").join(",");
  const [counts, due, interviews, waiting, acts] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) AS n FROM intern_apps WHERE owner_id = ? GROUP BY status").bind(user.id).all<{ status: string; n: number }>(),
    db.prepare(`SELECT id, opp_key, company_name, status, next_step, next_date, fit FROM intern_apps WHERE owner_id = ? AND status IN (${open}) AND next_date IS NOT NULL AND next_date <= ? ORDER BY next_date ASC LIMIT 50`).bind(user.id, ...OPEN_APP_STATUSES, addDaysIso(7)).all<Application>(),
    db.prepare("SELECT id, opp_key, company_name, interview_date FROM intern_apps WHERE owner_id = ? AND interview_date IS NOT NULL AND interview_date >= ? ORDER BY interview_date ASC LIMIT 20").bind(user.id, day).all<Application>(),
    db.prepare("SELECT id, opp_key, company_name, contact_date, status FROM intern_apps WHERE owner_id = ? AND status IN ('contactada','pendiente_respuesta','seguimiento') ORDER BY contact_date ASC LIMIT 50").bind(user.id).all<Application>(),
    db.prepare("SELECT a.at, a.kind, a.text, a.to_status, p.company_name, p.id AS application_id FROM intern_activities a JOIN intern_apps p ON p.id = a.application_id AND p.owner_id = a.owner_id WHERE a.owner_id = ? ORDER BY a.at DESC LIMIT 15").bind(user.id).all<any>(),
  ]);
  const by: Record<string, number> = {};
  for (const r of counts.results) by[r.status] = r.n;
  const active = counts.results.filter((r) => OPEN_APP_STATUSES.includes(r.status)).reduce((a, r) => a + r.n, 0);
  return json({ today: day, byStatus: by, active, total: counts.results.reduce((a, r) => a + r.n, 0), due: due.results, overdue: due.results.filter((x) => (x.next_date ?? "") < day).length, interviews: interviews.results, waiting: waiting.results, activity: acts.results });
}

// ---------- Asistente ----------

async function handleGenerate(db: D1Like, env: PracticasEnv, deps: PracticasDeps, user: CurrentUser, body: any): Promise<Response> {
  const kind = body.kind as InternKind;
  if (!INTERN_KINDS.includes(kind)) return fail(400, "Tipo de texto no válido.");
  if (!deps.aiEnabled) return fail(503, "La IA está desconectada en Ajustes → Conexiones.");
  const company = validateDirCompany(body.company);
  if (!company) return fail(400, "Empresa no válida.");
  const offer = validateOffer(body.offer);
  const profile = sanitizeProfile(body.profile) ?? (await loadProfile(db, user));
  if (!profile) return fail(400, "Completa tu perfil antes de generar textos.");
  const lim = await checkLimit(db, user, "ai");
  if (lim) return fail(429, lim);
  // La investigación se vuelve a leer del servidor: la IA solo recibe hechos que hemos comprobado nosotros
  const domain = domainOf(company.website);
  const row = domain ? await db.prepare("SELECT research_json FROM intern_research WHERE domain = ?").bind(domain).first<{ research_json: string }>() : null;
  const research: CompanyResearch | null = row ? JSON.parse(row.research_json) : null;
  const opp = buildOpportunity(profile, company, null, research, offer);
  const provider = createProvider(env, deps.fetchImpl);
  if ("missing" in provider) return fail(503, `La IA no está configurada. Añade la variable ${provider.missing}.`, { missing: provider.missing });
  const out = await provider.generate(buildInternPrompt(kind, profile, company, opp.nature, research, offer));
  const cost = estimateCostUsd(out.model, out.inputTokens, out.outputTokens);
  await addUsage(db, user, "ai", 1, cost ?? 0);
  return json({ text: out.text, kind, nature: opp.nature, researched: !!research, meta: { provider: out.provider, model: out.model, estimatedCostUsd: cost } });
}

// ---------- Router ----------

export async function handlePracticas(req: Request, env: PracticasEnv, deps: PracticasDeps, path: string, body: any): Promise<Response> {
  const db = env.DB;
  if (!db) return fail(503, "Falta la base de datos (D1). Vuelve a publicar la app.");
  await ensurePracticasSchema(db);
  const user = currentUser(env);
  const url = new URL(req.url);

  if (req.method === "GET") {
    switch (path) {
      case "/api/practicas/meta": {
        const usage = await usageToday(db, user);
        return json({
          families: FAMILIES.map((f) => ({ id: f.id, label: f.label, studiesHint: f.studiesHint, suggestedSkills: f.suggestedSkills })),
          statuses: APP_STATUSES,
          natures: NATURE_LABEL,
          weights: FIT_WEIGHTS,
          viabilityBase: VIABILITY_BASE,
          sources: {
            google: !!env.GOOGLE_PLACES_API_KEY && deps.googleEnabled,
            adzuna: !!(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY),
            jooble: !!env.JOOBLE_API_KEY,
            ai: deps.aiEnabled && !("missing" in createProvider(env)),
          },
          user: { role: user.role, orgId: user.orgId },
          plan: user.plan,
          usage,
          example: exampleProfile(),
        });
      }
      case "/api/practicas/profile":
        return json({ profile: await loadProfile(db, user) });
      case "/api/practicas/apps": {
        const { results } = await db.prepare("SELECT id, opp_key, company_name, company_json, offer_json, nature, status, favorite, fit, viability, confidence, notes, next_step, next_date, contact_date, interview_date, created_at, updated_at FROM intern_apps WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 1000").bind(user.id).all<Application>();
        return json({ apps: results });
      }
      case "/api/practicas/app": {
        const id = url.searchParams.get("id") ?? "";
        const app = await db.prepare("SELECT * FROM intern_apps WHERE id = ? AND owner_id = ?").bind(id, user.id).first<Application>();
        if (!app) return fail(404, "Esa candidatura no existe.");
        const { results } = await db.prepare("SELECT * FROM intern_activities WHERE application_id = ? AND owner_id = ? ORDER BY at DESC LIMIT 200").bind(id, user.id).all<AppActivity>();
        return json({ app, activities: results });
      }
      case "/api/practicas/summary":
        return handleSummary(db, user, isDate(url.searchParams.get("today")) ? url.searchParams.get("today")! : today());
      default:
        return fail(404, "Ruta no encontrada.");
    }
  }
  if (req.method !== "POST") return fail(405, "Método no permitido.");
  switch (path) {
    case "/api/practicas/profile": {
      const p = sanitizeProfile(body.profile);
      if (!p) return fail(400, "Faltan los estudios o la localidad.");
      p.updatedAt = nowIso();
      await db.prepare("INSERT INTO intern_profiles (owner_id, id, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at").bind(user.id, p.id, JSON.stringify(p), p.updatedAt).run();
      return json({ ok: true, profile: p });
    }
    case "/api/practicas/search":
      return handleSearch(db, env, deps, user, body);
    case "/api/practicas/research":
      return handleResearch(db, env, deps, user, body);
    case "/api/practicas/app/save":
      return handleAppSave(db, user, body);
    case "/api/practicas/app/update":
      return handleAppUpdate(db, user, body);
    case "/api/practicas/app/delete": {
      const id = s(body.id, 60);
      if (!id) return fail(400, "Falta el id.");
      await db.prepare("DELETE FROM intern_activities WHERE application_id = ? AND owner_id = ?").bind(id, user.id).run();
      await db.prepare("DELETE FROM intern_apps WHERE id = ? AND owner_id = ?").bind(id, user.id).run();
      return json({ ok: true });
    }
    case "/api/practicas/generate":
      return handleGenerate(db, env, deps, user, body);
    default:
      return fail(404, "Ruta no encontrada.");
  }
}
