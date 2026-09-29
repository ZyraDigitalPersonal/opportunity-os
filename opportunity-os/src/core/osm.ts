// Proveedor de datos: OpenStreetMap (Nominatim para zonas, Overpass para negocios).
// Datos © colaboradores de OpenStreetMap, licencia ODbL. Se muestran con atribución.

import type { Company, GeoArea } from "./types.js";
import { getSector, type SectorProfile } from "./sectors.js";
import { ExternalError, fetchWithTimeout } from "./http.js";

export interface DataProvider {
  geocodeArea(query: { location?: string; postcode?: string }): Promise<GeoArea>;
  searchCompanies(area: GeoArea, sectorIds: string[], limit: number): Promise<Company[]>;
}

export interface OsmOptions {
  userAgent: string;
  contactEmail?: string;
  nominatimUrl?: string;
  overpassUrl?: string;
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
}

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export class OsmProvider implements DataProvider {
  private readonly nominatim: string;
  private readonly overpass: string;
  private readonly f: typeof fetch;

  constructor(private readonly opts: OsmOptions) {
    this.nominatim = opts.nominatimUrl ?? "https://nominatim.openstreetmap.org";
    this.overpass = opts.overpassUrl ?? "https://overpass-api.de/api/interpreter";
    this.f = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  async geocodeArea(query: { location?: string; postcode?: string }): Promise<GeoArea> {
    const params = new URLSearchParams({ format: "jsonv2", countrycodes: "es", limit: "1", "accept-language": "es" });
    if (query.postcode && !query.location) params.set("postalcode", query.postcode);
    else if (query.location) params.set("q", query.postcode ? `${query.location} ${query.postcode}` : query.location);
    else throw new ExternalError("Indica una zona: ciudad, provincia, comunidad o código postal.", "nominatim");
    if (this.opts.contactEmail) params.set("email", this.opts.contactEmail);

    const res = await fetchWithTimeout(`${this.nominatim}/search?${params}`, { headers: { "User-Agent": this.opts.userAgent, Accept: "application/json" } }, 10000, this.f);
    if (!res.ok) throw new ExternalError(`Nominatim respondió ${res.status}`, "nominatim", res.status);
    const data = (await res.json()) as NominatimResult[];
    if (!data.length) throw new ExternalError(`No se ha encontrado la zona «${query.location ?? query.postcode}» en España.`, "nominatim", 404);
    return toGeoArea(data[0]);
  }

  async searchCompanies(area: GeoArea, sectorIds: string[], limit: number): Promise<Company[]> {
    const sectors = sectorIds.map(getSector).filter((s): s is SectorProfile => !!s);
    const query = buildOverpassQuery(area, sectors, limit);
    const res = await fetchWithTimeout(
      this.overpass,
      { method: "POST", headers: { "User-Agent": this.opts.userAgent, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: query }) },
      30000,
      this.f,
    );
    if (res.status === 429 || res.status === 504) throw new ExternalError("Overpass está saturado ahora mismo. Reintenta en unos segundos o usa una zona más pequeña.", "overpass", res.status);
    if (!res.ok) throw new ExternalError(`Overpass respondió ${res.status}`, "overpass", res.status);
    const data = (await res.json()) as { elements: OverpassElement[] };
    return elementsToCompanies(data.elements, sectors, limit);
  }
}

export function toGeoArea(r: NominatimResult): GeoArea {
  const [s, n, w, e] = r.boundingbox.map(Number);
  return {
    label: r.display_name.split(",").slice(0, 3).join(",").trim(),
    overpassAreaId: r.osm_type === "relation" ? 3600000000 + r.osm_id : r.osm_type === "way" ? 2400000000 + r.osm_id : undefined,
    bbox: [s, w, n, e],
    center: [Number(r.lat), Number(r.lon)],
  };
}

export function buildOverpassQuery(area: GeoArea, sectors: SectorProfile[], limit: number): string {
  const scope = area.overpassAreaId ? "(area.a)" : `(${area.bbox.join(",")})`;
  const header = area.overpassAreaId ? `area(${area.overpassAreaId})->.a;\n` : "";
  const parts = sectors.flatMap((s) => s.osm.map(([k, v]) => `  nwr["${k}"~"${v}"]["name"]${scope};`));
  return `[out:json][timeout:25];\n${header}(\n${parts.join("\n")}\n);\nout center tags ${Math.max(1, Math.min(limit * 2, 1000))};`;
}

function matchSector(tags: Record<string, string>, sectors: SectorProfile[]): SectorProfile | undefined {
  return sectors.find((s) => s.osm.some(([k, v]) => tags[k] !== undefined && new RegExp(v).test(tags[k])));
}

function cleanUrl(u?: string): string | undefined {
  if (!u) return undefined;
  const t = u.trim().split(/[;\s]/)[0];
  if (!t) return undefined;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

function socialHandle(v: string | undefined, base: string): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^https?:\/\//i.test(t)) return t;
  return `${base}${t.replace(/^@/, "")}`;
}

export function elementsToCompanies(elements: OverpassElement[], sectors: SectorProfile[], limit: number): Company[] {
  const seen = new Set<string>();
  const out: Company[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    if (!t.name) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const sector = matchSector(t, sectors);
    if (!sector) continue;
    // Deduplicación simple: mismo nombre a menos de ~50 m
    const key = `${t.name.toLowerCase()}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
    out.push({
      id: `osm:${el.type}/${el.id}`,
      name: t.name,
      sectorId: sector.id,
      sectorLabel: sector.label,
      lat,
      lon,
      address: street || undefined,
      city: t["addr:city"],
      postcode: t["addr:postcode"],
      phone: t.phone ?? t["contact:phone"] ?? t["contact:mobile"],
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
