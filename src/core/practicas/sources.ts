// Fuentes de oportunidades de prácticas. Cada conector devuelve datos reales o un estado honesto
// («sin configurar», «error»). No se usan métodos para saltarse controles de acceso: las fuentes sin
// API permitida (LinkedIn, InfoJobs, Indeed…) se ofrecen como enlaces de búsqueda para continuar a mano.

import { ExternalError, fetchWithTimeout } from "../http.js";
import type { GeoArea } from "../types.js";
import { foldText, getFamily, type Family } from "./families.js";
import type { DirCompany, JobOffer, ManualLink, Scope, StudentProfile } from "./types.js";

export interface KvCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

async function cachedJson<T>(cache: KvCache | null, key: string, ttl: number, produce: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  if (cache) {
    const raw = await cache.get(key).catch(() => null);
    if (raw) {
      try {
        return { value: JSON.parse(raw) as T, hit: true };
      } catch {}
    }
  }
  const value = await produce();
  if (cache) await cache.put(key, JSON.stringify(value), ttl).catch(() => {});
  return { value, hit: false };
}

/** Rectángulo de `km` alrededor de un punto: [sur, oeste, norte, este] */
export function bboxAround(center: [number, number], km: number): [number, number, number, number] {
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos((center[0] * Math.PI) / 180));
  return [center[0] - dLat, center[1] - dLon, center[0] + dLat, center[1] + dLon];
}

const INTERNSHIP_RE = /\b(practicas|becari[oa]s?|beca\b|internship|intern\b|trainee|fct\b|fp dual|formacion dual|en practicas)\b/;
export const isInternshipText = (s: string) => INTERNSHIP_RE.test(foldText(s));
const REMOTE_RE = /\b(remoto|teletrabajo|remote|en remoto|100% online|desde casa)\b/;

// ---------- Google Places: empresas del sector alrededor del estudiante ----------

/** Text Search Enterprise (web y teléfono) ≈ 35 US$ / 1.000 llamadas; 1.000 gratis al mes. */
export const GOOGLE_DISCOVERY_USD = 0.035;
const G_FIELDS = ["places.id", "places.displayName", "places.formattedAddress", "places.addressComponents", "places.location", "places.websiteUri", "places.nationalPhoneNumber", "places.googleMapsUri", "places.businessStatus", "places.rating", "places.userRatingCount", "nextPageToken"].join(",");

export async function googleDiscovery(
  apiKey: string,
  fam: Family,
  center: [number, number],
  km: number,
  maxCalls: number,
  f: typeof fetch,
): Promise<{ companies: DirCompany[]; calls: number }> {
  const [s, w, n, e] = bboxAround(center, Math.min(km, 60));
  const byId = new Map<string, DirCompany>();
  let calls = 0;
  for (const { q, category } of fam.googleQueries) {
    let pageToken: string | undefined;
    for (let page = 0; page < 2 && calls < maxCalls; page++) {
      calls++;
      const body: Record<string, unknown> = { textQuery: q, languageCode: "es", regionCode: "ES", pageSize: 20, locationRestriction: { rectangle: { low: { latitude: s, longitude: w }, high: { latitude: n, longitude: e } } } };
      if (pageToken) body.pageToken = pageToken;
      const res = await fetchWithTimeout("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": G_FIELDS }, body: JSON.stringify(body) }, 12000, f);
      if (!res.ok) throw new ExternalError(`Google Places respondió ${res.status}`, "google", res.status);
      const data = (await res.json()) as { places?: any[]; nextPageToken?: string };
      for (const p of data.places ?? []) {
        if (!p.id || !p.displayName?.text || !p.location || p.businessStatus === "CLOSED_PERMANENTLY" || byId.has(p.id)) continue;
        const city = p.addressComponents?.find((c: any) => c.types?.includes("locality"))?.longText;
        const web = p.websiteUri && !/(instagram|facebook|linktr\.ee|wa\.me|tiktok)\./i.test(p.websiteUri) ? p.websiteUri : undefined;
        byId.set(p.id, {
          id: `gp:${p.id}`,
          name: p.displayName.text,
          website: web,
          phone: p.nationalPhoneNumber,
          address: p.formattedAddress?.split(",").slice(0, 2).join(","),
          city,
          lat: p.location.latitude,
          lon: p.location.longitude,
          source: "Google Maps",
          sourceUrl: p.googleMapsUri,
          category,
          rating: p.rating,
          reviews: p.userRatingCount,
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    if (calls >= maxCalls) break;
  }
  return { companies: [...byId.values()], calls };
}

// ---------- OpenStreetMap: empresas etiquetadas por actividad ----------

export function osmDiscoveryQuery(fam: Family, bbox: [number, number, number, number]): string | null {
  if (!fam.osm.length) return null;
  const parts = fam.osm.map(([k, v]) => `  nwr["${k}"~"${v}"]["name"](${bbox.join(",")});`);
  return `[out:json][timeout:25];\n(\n${parts.join("\n")}\n);\nout center tags 300;`;
}

export function osmToCompanies(elements: Array<{ type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }>, fam: Family): DirCompany[] {
  const out: DirCompany[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!t.name || lat === undefined || lon === undefined || t.disused === "yes") continue;
    const w = (t.website ?? t["contact:website"] ?? t.url)?.trim().split(/[;\s]/)[0];
    out.push({
      id: `osm:${el.type}/${el.id}`,
      name: t.name,
      website: w ? (/^https?:\/\//i.test(w) ? w : `https://${w}`) : undefined,
      phone: t.phone ?? t["contact:phone"],
      address: [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ") || undefined,
      city: t["addr:city"],
      lat,
      lon,
      source: "OpenStreetMap",
      sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      category: fam.googleQueries[0]?.category ?? fam.label,
    });
  }
  return out;
}

// ---------- Portales de empleo con API ----------

export interface FeedQuery {
  keywords: string[];
  location?: string;
  distanceKm?: number;
  scope: Scope;
}

export function feedQuery(p: StudentProfile, scope: Scope): FeedQuery {
  const fam = getFamily(p.familyId);
  const kw = fam.jobKeywords.length ? fam.jobKeywords.slice(0, 4) : [p.specialty ?? p.studies].filter(Boolean);
  return { keywords: kw, location: scope === "local" ? p.location : undefined, distanceKm: scope === "local" ? p.maxDistanceKm : undefined, scope };
}

/** Adzuna (API oficial, clave gratuita: ADZUNA_APP_ID + ADZUNA_APP_KEY). Límite por defecto: 250 llamadas/día. */
export async function adzunaSearch(appId: string, appKey: string, q: FeedQuery, f: typeof fetch): Promise<{ offers: JobOffer[]; calls: number }> {
  const offers: JobOffer[] = [];
  let calls = 0;
  for (const what of ["prácticas", "becario"]) {
    const params = new URLSearchParams({ app_id: appId, app_key: appKey, results_per_page: "30", what, what_or: q.keywords.join(" "), max_days_old: "90", sort_by: "date", "content-type": "application/json" });
    if (q.location) params.set("where", q.location);
    if (q.distanceKm) params.set("distance", String(Math.min(q.distanceKm, 100)));
    calls++;
    const res = await fetchWithTimeout(`https://api.adzuna.com/v1/api/jobs/es/search/1?${params}`, { headers: { Accept: "application/json" } }, 12000, f);
    if (!res.ok) throw new ExternalError(res.status === 401 || res.status === 403 ? "Adzuna rechaza las claves (ADZUNA_APP_ID / ADZUNA_APP_KEY)." : `Adzuna respondió ${res.status}`, "adzuna", res.status);
    const data = (await res.json()) as { results?: any[] };
    for (const j of data.results ?? []) {
      const text = `${j.title ?? ""} ${j.description ?? ""}`;
      if (!j.redirect_url || !j.title) continue;
      if (offers.some((o) => o.id === `adzuna:${j.id}`)) continue;
      offers.push({
        id: `adzuna:${j.id}`,
        source: "Adzuna",
        title: String(j.title).replace(/<[^>]+>/g, "").slice(0, 200),
        company: j.company?.display_name?.slice(0, 120),
        location: j.location?.display_name?.slice(0, 120),
        snippet: String(j.description ?? "").replace(/<[^>]+>/g, "").slice(0, 600),
        url: j.redirect_url,
        created: j.created,
        remote: REMOTE_RE.test(foldText(text)),
        internship: isInternshipText(text),
        lat: typeof j.latitude === "number" ? j.latitude : undefined,
        lon: typeof j.longitude === "number" ? j.longitude : undefined,
        contract: [j.contract_time, j.contract_type].filter(Boolean).join(" · ") || undefined,
      });
    }
  }
  return { offers, calls };
}

/** Jooble (API oficial con clave gratuita bajo petición: JOOBLE_API_KEY). */
export async function joobleSearch(apiKey: string, q: FeedQuery, f: typeof fetch): Promise<{ offers: JobOffer[]; calls: number }> {
  const body: Record<string, string> = { keywords: `prácticas ${q.keywords.slice(0, 2).join(" ")}`, page: "1" };
  if (q.location) body.location = q.location;
  if (q.distanceKm) body.radius = String(Math.min(q.distanceKm, 80));
  const res = await fetchWithTimeout(`https://jooble.org/api/${encodeURIComponent(apiKey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 12000, f);
  if (!res.ok) throw new ExternalError(res.status === 403 ? "Jooble rechaza la clave (JOOBLE_API_KEY)." : `Jooble respondió ${res.status}`, "jooble", res.status);
  const data = (await res.json()) as { jobs?: any[] };
  const offers: JobOffer[] = [];
  for (const j of data.jobs ?? []) {
    if (!j.link || !j.title) continue;
    const snippet = String(j.snippet ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    const text = `${j.title} ${snippet}`;
    offers.push({
      id: `jooble:${j.id ?? j.link}`.slice(0, 200),
      source: "Jooble",
      title: String(j.title).replace(/<[^>]+>/g, "").slice(0, 200),
      company: j.company ? String(j.company).slice(0, 120) : undefined,
      location: j.location ? String(j.location).slice(0, 120) : undefined,
      snippet: snippet.slice(0, 600),
      url: j.link,
      created: j.updated,
      remote: REMOTE_RE.test(foldText(text)),
      internship: isInternshipText(text),
      contract: j.type || undefined,
    });
  }
  return { offers, calls: 1 };
}

export { cachedJson };

// ---------- Enlaces para continuar a mano (sin automatizar) ----------

export function manualLinks(p: StudentProfile, scope: Scope): ManualLink[] {
  const fam = getFamily(p.familyId);
  const kw = (fam.jobKeywords[0] ?? p.studies).toLowerCase();
  const loc = scope === "local" ? p.location : "España";
  const enc = encodeURIComponent;
  const g = (q: string) => `https://www.google.com/search?q=${enc(q)}`;
  const links: ManualLink[] = [
    { name: "LinkedIn Empleos · prácticas", url: `https://www.linkedin.com/jobs/search/?keywords=${enc(kw)}&location=${enc(loc)}&f_E=1${scope === "remota" ? "&f_WT=2" : ""}`, hint: "Filtro «Prácticas» activado. Requiere tu cuenta de LinkedIn." },
    { name: "InfoJobs", url: g(`site:infojobs.net prácticas ${kw} ${loc}`), hint: "InfoJobs no ofrece búsqueda abierta: abre los resultados en su web." },
    { name: "Indeed", url: `https://es.indeed.com/jobs?q=${enc(`prácticas ${kw}`)}&l=${enc(scope === "local" ? p.location : "")}${scope === "remota" ? "&sc=0kf%3Aattr(DSQF7)%3B" : ""}`, hint: "Búsqueda de prácticas en Indeed España." },
  ];
  if (fam.id === "informatica") links.push({ name: "Tecnoempleo", url: g(`site:tecnoempleo.com prácticas ${kw} ${loc}`), hint: "Portal especializado en empleo tecnológico." });
  links.push({ name: "Empresas que aceptan estudiantes", url: g(`"prácticas" "${kw}" empresa ${loc} estudiantes FCT OR "FP dual" OR becas`), hint: "Búsqueda abierta de empresas que mencionan prácticas." });
  if (p.centreBoardUrl) links.unshift({ name: "Bolsa de prácticas de tu centro", url: p.centreBoardUrl, hint: "Enlace que has guardado en tu perfil." });
  return links;
}

/** Enlaces para investigar la reputación de una empresa a mano (no se extraen opiniones de terceros). */
export function reputationLinks(name: string, city?: string): ManualLink[] {
  const enc = encodeURIComponent;
  const q = `${name}${city ? ` ${city}` : ""}`;
  return [
    { name: "Opiniones sobre prácticas", url: `https://www.google.com/search?q=${enc(`"${name}" prácticas opiniones OR experiencia OR becario`)}`, hint: "Testimonios de estudiantes en foros y redes." },
    { name: "Glassdoor / Indeed (opiniones de empleados)", url: `https://www.google.com/search?q=${enc(`${q} opiniones empleados site:glassdoor.es OR site:es.indeed.com`)}`, hint: "Opiniones de empleados: pueden ser antiguas o poco representativas." },
    { name: "Empresa en LinkedIn", url: `https://www.linkedin.com/search/results/companies/?keywords=${enc(name)}`, hint: "Tamaño, publicaciones y personas del equipo (tú decides a quién contactar)." },
  ];
}

export function areaCenter(area: GeoArea): [number, number] {
  return area.center;
}
