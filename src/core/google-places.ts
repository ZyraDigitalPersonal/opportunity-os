// Ficha de Google en vivo (Places API New). Se consulta al abrir una empresa y NO se guarda:
// los términos de Google Maps Platform solo permiten conservar el place_id.
// Con facturación en el EEE, este contenido no se muestra junto al mapa.

import { ExternalError, fetchWithTimeout } from "./http.js";
import type { ReviewItem } from "./types.js";

/** Reseña tal como la devuelve Places API (New). */
export interface GReview {
  rating?: number;
  text?: { text?: string };
  originalText?: { text?: string };
  authorAttribution?: { displayName?: string; uri?: string };
  relativePublishTimeDescription?: string;
  publishTime?: string;
  googleMapsUri?: string;
}

const httpsOnly = (u?: string) => (u && /^https:\/\//i.test(u) ? u : undefined);

/** Reseñas completas con atribución (Google exige mostrar autor y enlace). */
export function toReviewItems(reviews?: GReview[]): ReviewItem[] {
  return (reviews ?? [])
    .map((r) => ({
      text: (r.originalText?.text ?? r.text?.text ?? "").trim(),
      rating: r.rating,
      author: r.authorAttribution?.displayName,
      authorUri: httpsOnly(r.authorAttribution?.uri),
      when: r.relativePublishTimeDescription,
      publishTime: r.publishTime,
      uri: httpsOnly(r.googleMapsUri),
    }))
    .filter((r) => r.text);
}

export interface GooglePlaceLive {
  placeId: string;
  name?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  websiteUri?: string;
  phone?: string;
  businessStatus?: string;
  weekdayHours?: string[];
  /** Hasta 5 reseñas completas (las que Google elige como más relevantes) */
  reviews: ReviewItem[];
  fetchedAt: string;
}

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.businessStatus",
  "places.regularOpeningHours.weekdayDescriptions",
  "places.reviews",
].join(",");

/** Precio de referencia: Text Search Enterprise + Atmosphere (reseñas) ≈ 40 US$ / 1.000 (1.000 gratis al mes). */
export const GOOGLE_TEXT_SEARCH_USD = 0.04;

export async function fetchGooglePlace(
  apiKey: string,
  q: { name: string; city?: string; lat: number; lon: number },
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<GooglePlaceLive | null> {
  const res = await fetchWithTimeout(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify({
        textQuery: [q.name, q.city].filter(Boolean).join(", "),
        languageCode: "es",
        regionCode: "ES",
        maxResultCount: 1,
        locationBias: { circle: { center: { latitude: q.lat, longitude: q.lon }, radius: 250 } },
      }),
    },
    10000,
    fetchImpl,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ExternalError(`Google Places respondió ${res.status}${detail.includes("API_KEY") ? " (clave no válida o API no activada)" : ""}`, "google", res.status);
  }
  const data = (await res.json()) as { places?: Array<Record<string, any>> };
  const p = data.places?.[0];
  if (!p) return null;
  return {
    placeId: p.id,
    name: p.displayName?.text,
    rating: p.rating,
    userRatingCount: p.userRatingCount,
    googleMapsUri: p.googleMapsUri,
    websiteUri: p.websiteUri,
    phone: p.nationalPhoneNumber,
    businessStatus: p.businessStatus,
    weekdayHours: p.regularOpeningHours?.weekdayDescriptions,
    reviews: toReviewItems(p.reviews),
    fetchedAt: new Date().toISOString(),
  };
}
