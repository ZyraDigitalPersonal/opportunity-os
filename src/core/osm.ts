// Proveedor de datos: OpenStreetMap (Nominatim/Photon para zonas, Overpass para negocios).
// Datos © colaboradores de OpenStreetMap, licencia ODbL. Se muestran con atribución.
//
// Robustez:
//  - Geocodificación: Nominatim y, si falla o está bloqueado, Photon (komoot), también sobre OSM.
//  - Overpass: varios servidores públicos; si uno está saturado (429/504) o tarda, se prueba el siguiente.
//  - Las consultas usan igualdad exacta de etiquetas siempre que se puede (10x más rápido que regex).

import type { Company, GeoArea } from "./types.js";
import { resolveSector, type SectorProfile } from "./sectors.js";
import { ExternalError, fetchWithTimeout } from "./http.js";

export interface DataProvider {
  geocodeArea(query: { location?: string; postcode?: string }): Promise<GeoArea>;
  searchCompanies(area: GeoArea, sectorIds: string[], limit: number): Promise<Company[]>;
}

export interface OsmOptions {
  userAgent: string;
  contactEmail?: string;
  nominatimUrl?: string;
  photonUrl?: string;
  overpassUrls?: string[];
  fetchImpl?: typeof fetch;
}

interface NominatimResult {
  osm_type: "node" | "way" | "relation";
  osm_id: number;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string]; // sur, norte, oeste, este
  display_name: string;
  addresstype?: string;
  class?: string;
  type?: string;
}

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const ADMIN_TYPES = new Set(["city", "town", "village", "municipality", "county", "state", "state_district", "province", "region", "island", "archipelago", "suburb", "city_district", "borough", "quarter", "neighbourhood", "hamlet", "political", "administrative", "postcode"]);

export class OsmProvider implements DataProvider {
  private readonly nominatim: string;
  private readonly photon: string;
  private readonly overpass: string[];
  private readonly f: typeof fetch;

  constructor(private readonly opts: OsmOptions) {
    this.nominatim = opts.nominatimUrl ?? "https://nominatim.openstreetmap.org";
    this.photon = opts.photonUrl ?? "https://photon.komoot.io";
    this.overpass = opts.overpassUrls ?? OVERPASS_ENDPOINTS;
    this.f = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  async geocodeArea(query: { location?: string; postcode?: string }): Promise<GeoArea> {
    if (!query.location && !query.postcode) throw new ExternalError("Indica una zona: ciudad, isla, provincia, comunidad o código postal.", "nominatim", 400);
    const label = query.location ?? query.postcode!;
    let nominatimError: unknown;
    try {
      const r = await this.nominatimSearch(query);
      if (r) return r;
    } catch (e) {
      nominatimError = e;
    }
    // Respaldo: Photon (no exige email y tolera mejor las IPs compartidas de Cloudflare)
    try {
      const r = await this.photonSearch(query.location ? `${query.location}${query.postcode ? " " + query.postcode : ""}` : query.postcode!);
      if (r) return r;
    } catch (e) {
      if (nominatimError) throw new ExternalError("No se ha podido localizar la zona ahora mismo (los geocodificadores no responden). Reintenta en unos segundos.", "nominatim", 502);
    }
    throw new ExternalError(`No se ha encontrado la zona «${label}». Prueba con el nombre del municipio, la isla o la provincia.`, "nominatim", 404);
  }

  private async nominatimSearch(query: { location?: string; postcode?: string }): Promise<GeoArea | null> {
    const params = new URLSearchParams({ format: "jsonv2", countrycodes: "es", limit: "6", "accept-language": "es" });
    if (query.postcode && !query.location) params.set("postalcode", query.postcode);
    else params.set("q", query.postcode ? `${query.location} ${query.postcode}` : query.location!);
    if (this.opts.contactEmail) params.set("email", this.opts.contactEmail);
    const res = await fetchWithTimeout(`${this.nominatim}/search?${params}`, { headers: { "User-Agent": this.opts.userAgent, Accept: "application/json", "Accept-Language": "es" } }, 8000, this.f);
    if (!res.ok) throw new ExternalError(`Nominatim respondió ${res.status}`, "nominatim", res.status);
    const data = (await res.json()) as NominatimResult[];
    if (!data.length) return null;
    return toGeoArea(pickBest(data));
  }

  private async photonSearch(q: string): Promise<GeoArea | null> {
    const params = new URLSearchParams({ q, limit: "8", lang: "es" });
    const res = await fetchWithTimeout(`${this.photon}/api/?${params}`, { headers: { "User-Agent": this.opts.userAgent, Accept: "application/json" } }, 8000, this.f);
    if (!res.ok) throw new ExternalError(`Photon respondió ${res.status}`, "nominatim", res.status);
    const data = (await res.json()) as { features?: PhotonFeature[] };
    const feats = (data.features ?? []).filter((f) => (f.properties.countrycode ?? "").toUpperCase() === "ES");
    if (!feats.length) return null;
    const best = feats.find((f) => f.properties.osm_type === "R" && f.properties.extent) ?? feats.find((f) => f.properties.extent) ?? feats[0];
    return photonToGeoArea(best);
  }

  async searchCompanies(area: GeoArea, sectorIds: string[], limit: number): Promise<Company[]> {
    const sectors = sectorIds.map(resolveSector).filter((s): s is SectorProfile => !!s);
    if (!sectors.length) return [];
    const query = buildOverpassQuery(area, sectors, limit);
    const elements = await this.runOverpass(query);
    return elementsToCompanies(elements, sectors, limit, area);
  }

  /** Ejecuta la consulta probando servidores hasta que uno responda bien. */
  private async runOverpass(query: string): Promise<OverpassElement[]> {
    const errors: string[] = [];
    for (const [i, url] of this.overpass.entries()) {
      try {
        const res = await fetchWithTimeout(
          url,
          { method: "POST", headers: { "User-Agent": this.opts.userAgent, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ data: query }) },
          i === 0 ? 28000 : 35000,
          this.f,
        );
        const text = await res.text();
        if (!res.ok || !text.trimStart().startsWith("{")) {
          errors.push(`${new URL(url).hostname}: ${res.status}`);
          continue;
        }
        const data = JSON.parse(text) as { elements?: OverpassElement[]; remark?: string };
        if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark) && !(data.elements ?? []).length) {
          errors.push(`${new URL(url).hostname}: ${data.remark.slice(0, 80)}`);
          continue;
        }
        return data.elements ?? [];
      } catch (e) {
        errors.push(`${new URL(url).hostname}: ${(e as Error).name === "AbortError" ? "sin respuesta" : (e as Error).message}`);
      }
    }
    console.error(JSON.stringify({ level: "error", where: "overpass", errors }));
    throw new ExternalError("Los servidores de OpenStreetMap están saturados ahora mismo. Reintenta en unos segundos o prueba con una zona más pequeña.", "overpass", 503);
  }
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: { osm_type?: "N" | "W" | "R"; osm_id?: number; name?: string; extent?: [number, number, number, number]; countrycode?: string; state?: string; county?: string; type?: string; city?: string };
}

function pickBest(results: NominatimResult[]): NominatimResult {
  const isArea = (r: NominatimResult) => r.osm_type === "relation" && (ADMIN_TYPES.has(r.addresstype ?? "") || r.class === "boundary" || r.class === "place");
  return results.find(isArea) ?? results.find((r) => r.osm_type === "relation") ?? results[0];
}

export function toGeoArea(r: NominatimResult): GeoArea {
  const [s, n, w, e] = r.boundingbox.map(Number);
  return {
    label: r.display_name.split(",").slice(0, 3).join(",").trim(),
    overpassAreaId: r.osm_type === "relation" ? 3600000000 + r.osm_id : r.osm_type === "way" ? 2400000000 + r.osm_id : undefined,
    bbox: pad([s, w, n, e], r.osm_type === "node" ? 0.03 : 0),
    center: [Number(r.lat), Number(r.lon)],
  };
}

function photonToGeoArea(f: PhotonFeature): GeoArea {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  // extent: [oeste, norte, este, sur]
  const bbox: [number, number, number, number] = p.extent ? [p.extent[3], p.extent[0], p.extent[1], p.extent[2]] : pad([lat, lon, lat, lon], 0.03);
  return {
    label: [p.name, p.county ?? p.city, p.state].filter(Boolean).join(", "),
    overpassAreaId: p.osm_type === "R" && p.osm_id ? 3600000000 + p.osm_id : p.osm_type === "W" && p.osm_id ? 2400000000 + p.osm_id : undefined,
    bbox,
    center: [lat, lon],
  };
}

function pad(b: [number, number, number, number], d: number): [number, number, number, number] {
  return [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
}

/** «^(a|b|c)$» → ["a","b","c"]; null si la regex no es una lista simple de valores. */
export function exactValues(re: string): string[] | null {
  const m = re.match(/^\^\(?([a-z0-9_:|-]+)\)?\$$/i);
  return m ? m[1].split("|") : null;
}

/** Patrón tolerante a acentos para buscar por nombre: «floristeri» → «fl[oóò]r[iíì]st[eéè]r[iíì]» */
export function accentInsensitive(word: string): string {
  const map: Record<string, string> = { a: "[aáàä]", e: "[eéèë]", i: "[iíìï]", o: "[oóòö]", u: "[uúùü]", n: "[nñ]" };
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .split("")
    .map((c) => map[c] ?? c)
    .join("");
}

function customNamePattern(sector: SectorProfile): string {
  const kw = sector.id.slice(7);
  const main = kw.split(/\s+/).sort((a, b) => b.length - a.length)[0] ?? kw;
  // raíz: quita la última letra para cubrir género/número (floristeria → floristeri)
  const stem = main.length > 5 ? main.slice(0, -1) : main;
  return accentInsensitive(stem);
}

export function buildOverpassQuery(area: GeoArea, sectors: SectorProfile[], limit: number): string {
  const scope = area.overpassAreaId ? "(area.a)" : `(${area.bbox.join(",")})`;
  const header = area.overpassAreaId ? `area(${area.overpassAreaId})->.a;\n` : "";
  const parts: string[] = [];
  for (const s of sectors) {
    if (s.id.startsWith("custom:") && !s.osm.length) {
      parts.push(`  nwr["name"~"${customNamePattern(s)}",i]${scope};`);
      continue;
    }
    for (const [k, v] of s.osm) {
      const exact = exactValues(v);
      if (exact) for (const val of exact) parts.push(`  nwr["${k}"="${val}"]["name"]${scope};`);
      else parts.push(`  nwr["${k}"~"${v}"]["name"]${scope};`);
    }
  }
  const max = Math.max(1, Math.min(Math.ceil(limit * 1.3), 3000));
  return `[out:json][timeout:45];\n${header}(\n${parts.join("\n")}\n);\nout center tags ${max};`;
}

function matchSector(tags: Record<string, string>, sectors: SectorProfile[]): SectorProfile | undefined {
  for (const s of sectors) {
    if (s.id.startsWith("custom:") && !s.osm.length) {
      if (tags.name && new RegExp(customNamePattern(s), "i").test(tags.name)) return s;
      continue;
    }
    if (s.osm.some(([k, v]) => tags[k] !== undefined && new RegExp(v).test(tags[k]))) return s;
  }
  return undefined;
}

function cleanUrl(u?: string): string | undefined {
  if (!u) return undefined;
  const t = u.trim().split(/[;\s]/)[0];
  if (!t || !/\./.test(t)) return undefined;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

function socialHandle(v: string | undefined, base: string): string | undefined {
  if (!v) return undefined;
  const t = v.trim().split(/[;\s]/)[0];
  if (!t) return undefined;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(www\.)?(instagram|facebook)\.com\//i.test(t)) return `https://${t}`;
  return `${base}${t.replace(/^@/, "")}`;
}

/** Clave de deduplicación por nombre normalizado */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(s\.?l\.?u?|s\.?a\.?|sl|sa|slu|cb|c\.b\.)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function elementsToCompanies(elements: OverpassElement[], sectors: SectorProfile[], limit: number, area?: GeoArea): Company[] {
  const seen = new Map<string, { lat: number; lon: number }[]>();
  const out: Company[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    if (!t.name) continue;
    if (t.disused === "yes" || t["disused:shop"] || t["abandoned"] === "yes") continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const sector = matchSector(t, sectors);
    if (!sector) continue;
    // Deduplicación: mismo nombre a menos de ~150 m (nodo + edificio del mismo negocio)
    const key = nameKey(t.name);
    const near = seen.get(key);
    if (near?.some((p) => Math.abs(p.lat - lat) < 0.0015 && Math.abs(p.lon - lon) < 0.0015)) continue;
    seen.set(key, [...(near ?? []), { lat, lon }]);

    const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
    out.push({
      id: `osm:${el.type}/${el.id}`,
      name: t.name,
      sectorId: sector.id,
      sectorLabel: sector.label,
      lat,
      lon,
      address: street || undefined,
      city: t["addr:city"] ?? t["addr:municipality"] ?? t["addr:place"] ?? (area ? area.label.split(",")[0] : undefined),
      postcode: t["addr:postcode"],
      phone: t.phone ?? t["contact:phone"] ?? t["contact:mobile"] ?? t.mobile,
      website: cleanUrl(t.website ?? t["contact:website"] ?? t.url),
      email: t.email ?? t["contact:email"],
      openingHours: t.opening_hours,
      instagram: socialHandle(t["contact:instagram"] ?? t.instagram, "https://instagram.com/"),
      facebook: socialHandle(t["contact:facebook"] ?? t.facebook, "https://facebook.com/"),
      whatsapp: t["contact:whatsapp"] ?? t.whatsapp,
      reservation: t.reservation,
      source: "OpenStreetMap",
      sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    });
    if (out.length >= limit) break;
  }
  return out;
}
