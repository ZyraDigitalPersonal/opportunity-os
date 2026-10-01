// Búsqueda de negocios con Google Places API (New) · Text Search.
// Es la fuente más completa: Google Maps tiene prácticamente todos los negocios abiertos.
//
// Cobertura: cada consulta devuelve como mucho 60 resultados (3 páginas de 20). Para zonas grandes
// («restaurantes en Tenerife») se divide el rectángulo de la zona en cuadrantes y se busca en cada uno,
// hasta un presupuesto máximo de llamadas por búsqueda (para controlar el coste).
//
// Términos de Google: el contenido no se guarda en servidor (sin caché); solo se muestra en vivo.

import type { Company, GeoArea } from "./types.js";
import type { SectorProfile } from "./sectors.js";
import { ExternalError, fetchWithTimeout } from "./http.js";
import { detectComplaints } from "./reviews.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
  "places.businessStatus",
  "places.regularOpeningHours.weekdayDescriptions",
  "places.reviews",
  "nextPageToken",
].join(",");

/** Precio orientativo por llamada (Text Search Enterprise + Atmosphere, por las reseñas ≈ 40 US$ / 1.000; 1.000 gratis al mes). */
export const GOOGLE_CALL_USD = 0.04;

export interface GoogleSearchOptions {
  apiKey: string;
  /** Máximo de llamadas a la API por búsqueda (cada una trae hasta 20 negocios). */
  maxCalls: number;
  fetchImpl?: typeof fetch;
}

export interface GoogleSearchResult {
  companies: Company[];
  calls: number;
  /** true si se agotó el presupuesto y podría haber más negocios */
  truncated: boolean;
}

interface GPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
  location?: { latitude: number; longitude: number };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  businessStatus?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  reviews?: Array<{ rating?: number; text?: { text?: string }; originalText?: { text?: string } }>;
}

type BBox = [number, number, number, number]; // [sur, oeste, norte, este]

/** Divide un rectángulo en 4 cuadrantes. */
export function quadrants(b: BBox): BBox[] {
  const [s, w, n, e] = b;
  const mLat = (s + n) / 2;
  const mLon = (w + e) / 2;
  return [
    [s, w, mLat, mLon],
    [s, mLon, mLat, e],
    [mLat, w, n, mLon],
    [mLat, mLon, n, e],
  ];
}

export class GooglePlacesSearch {
  private readonly f: typeof fetch;
  private calls = 0;

  constructor(private readonly opts: GoogleSearchOptions) {
    this.f = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  async searchCompanies(area: GeoArea, sectors: SectorProfile[], limit: number): Promise<GoogleSearchResult> {
    this.calls = 0;
    const byId = new Map<string, Company>();
    let truncated = false;
    // Reparte el presupuesto entre sectores (normalmente es uno solo)
    const perSector = Math.max(2, Math.floor(this.opts.maxCalls / Math.max(1, sectors.length)));
    for (const sector of sectors) {
      const budgetEnd = Math.min(this.opts.maxCalls, this.calls + perSector);
      const t = await this.searchTile(sector, area, area.bbox, byId, budgetEnd, limit, 0);
      truncated ||= t;
      if (byId.size >= limit) break;
    }
    return { companies: [...byId.values()].slice(0, limit), calls: this.calls, truncated };
  }

  /** Busca en un rectángulo; si sale lleno (60), lo subdivide. Devuelve true si se quedó sin presupuesto. */
  private async searchTile(sector: SectorProfile, area: GeoArea, box: BBox, out: Map<string, Company>, budgetEnd: number, limit: number, depth: number): Promise<boolean> {
    if (this.calls >= budgetEnd) return true;
    const query = `${sector.google}`;
    let pageToken: string | undefined;
    let got = 0;
    for (let page = 0; page < 3; page++) {
      if (this.calls >= budgetEnd) return true;
      const data = await this.call(query, box, pageToken);
      for (const p of data.places ?? []) {
        got++;
        if (p.businessStatus === "CLOSED_PERMANENTLY" || !p.location || !p.displayName?.text) continue;
        if (!out.has(p.id)) out.set(p.id, toCompany(p, sector, area));
      }
      pageToken = data.nextPageToken;
      if (!pageToken || out.size >= limit) break;
    }
    // Lleno → probablemente hay más: subdividir (máx. 3 niveles = 64 cuadrantes)
    if (got >= 60 && depth < 3 && out.size < limit) {
      let truncated = false;
      for (const q of quadrants(box)) {
        truncated = (await this.searchTile(sector, area, q, out, budgetEnd, limit, depth + 1)) || truncated;
        if (out.size >= limit) break;
      }
      return truncated;
    }
    return false;
  }

  private async call(textQuery: string, box: BBox, pageToken?: string): Promise<{ places?: GPlace[]; nextPageToken?: string }> {
    this.calls++;
    const [s, w, n, e] = box;
    const body: Record<string, unknown> = {
      textQuery,
      languageCode: "es",
      regionCode: "ES",
      pageSize: 20,
      locationRestriction: { rectangle: { low: { latitude: s, longitude: w }, high: { latitude: n, longitude: e } } },
    };
    if (pageToken) body.pageToken = pageToken;
    const res = await fetchWithTimeout(
      ENDPOINT,
      { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": this.opts.apiKey, "X-Goog-FieldMask": FIELD_MASK }, body: JSON.stringify(body) },
      15000,
      this.f,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let msg = `Google Places respondió ${res.status}`;
      if (/API_KEY_INVALID|API key not valid/i.test(detail)) msg = "La clave GOOGLE_PLACES_API_KEY no es válida.";
      else if (/SERVICE_DISABLED|has not been used|is disabled/i.test(detail)) msg = "La API «Places API (New)» no está activada en tu proyecto de Google Cloud.";
      else if (/BILLING/i.test(detail)) msg = "Google Places exige tener la facturación activada en el proyecto de Google Cloud.";
      else if (res.status === 429) msg = "Google Places: cuota superada por ahora. Reintenta en un minuto.";
      throw new ExternalError(msg, "google", res.status);
    }
    return (await res.json()) as { places?: GPlace[]; nextPageToken?: string };
  }
}

function component(p: GPlace, type: string): string | undefined {
  return p.addressComponents?.find((c) => c.types?.includes(type))?.longText;
}

export function toCompany(p: GPlace, sector: SectorProfile, area: GeoArea): Company {
  const street = [component(p, "route"), component(p, "street_number")].filter(Boolean).join(" ");
  const phone = p.nationalPhoneNumber ?? p.internationalPhoneNumber;
  return {
    id: `gp:${p.id}`,
    name: p.displayName!.text!,
    sectorId: sector.id,
    sectorLabel: sector.label,
    lat: p.location!.latitude,
    lon: p.location!.longitude,
    address: street || p.formattedAddress?.split(",")[0],
    city: component(p, "locality") ?? component(p, "administrative_area_level_3") ?? area.label.split(",")[0],
    postcode: component(p, "postal_code"),
    phone,
    website: cleanWebsite(p.websiteUri),
    openingHours: p.regularOpeningHours?.weekdayDescriptions?.join(" · "),
    instagram: p.websiteUri && /instagram\.com/i.test(p.websiteUri) ? p.websiteUri : undefined,
    facebook: p.websiteUri && /facebook\.com/i.test(p.websiteUri) ? p.websiteUri : undefined,
    whatsapp: p.websiteUri && /wa\.me|whatsapp/i.test(p.websiteUri) ? p.websiteUri : undefined,
    source: "Google",
    sourceUrl: p.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${p.id}`,
    googleMapsUri: p.googleMapsUri,
    rating: p.rating,
    reviews: p.userRatingCount ?? 0,
    complaints: p.reviews?.length ? detectComplaints(p.reviews.map((r) => ({ rating: r.rating, text: r.originalText?.text ?? r.text?.text }))) : undefined,
  };
}

/** Muchos negocios ponen su Instagram/Facebook como «web» en Google: eso no es una web propia. */
function cleanWebsite(u?: string): string | undefined {
  if (!u) return undefined;
  if (/(instagram|facebook|wa\.me|whatsapp|linktr\.ee|tiktok)\./i.test(u)) return undefined;
  return u;
}
