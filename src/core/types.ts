// Tipos de dominio compartidos por el worker, el frontend y los tests.

export type Confidence = "verificado" | "inferido";

export interface GeoArea {
  label: string;
  /** id de área de Overpass (relaciones OSM) si existe */
  overpassAreaId?: number;
  /** [sur, oeste, norte, este] */
  bbox: [number, number, number, number];
  center: [number, number]; // [lat, lon]
}

export interface Company {
  id: string; // "osm:node/123" o "gp:<place_id>"
  name: string;
  sectorId: string;
  sectorLabel: string;
  lat: number;
  lon: number;
  address?: string;
  city?: string;
  postcode?: string;
  phone?: string;
  website?: string;
  email?: string;
  openingHours?: string;
  instagram?: string;
  facebook?: string;
  whatsapp?: string;
  /** Etiqueta OSM reservation=* (yes, required, no, recommended) */
  reservation?: string;
  source: "OpenStreetMap" | "Google";
  sourceUrl: string;
  /** Solo resultados de Google (se muestran en vivo, no se guardan en servidor) */
  rating?: number;
  reviews?: number;
  googleMapsUri?: string;
  /** El negocio aparece también en otra fuente (OSM + Google) */
  alsoIn?: string;
  /** Quejas detectadas en las reseñas de Google (se calculan en vivo, no se guardan) */
  complaints?: Complaint[];
}

export interface Complaint {
  type: "telefono" | "esperas" | "atencion";
  /** Fragmento donde aparece la queja (puede estar recortado, con «…») */
  quote: string;
  /** Texto completo de la reseña (solo en vivo; nunca se guarda en servidor) */
  text?: string;
  rating?: number;
  author?: string;
  /** «hace 3 meses» (texto de Google) */
  when?: string;
  /** Enlace a la reseña o a su autor en Google Maps */
  uri?: string;
}

/** Reseña de Google mostrada en vivo, completa y con atribución (no se guarda). */
export interface ReviewItem {
  text: string;
  rating?: number;
  author?: string;
  authorUri?: string;
  when?: string;
  publishTime?: string;
  uri?: string;
}

export interface Signal {
  key: string;
  label: string;
  confidence: Confidence;
  source: string; // "OpenStreetMap", "Web de la empresa", "Perfil del sector"
  evidence?: string;
}

export interface ScoreItem {
  dimension: "Presencia digital" | "Reservas y automatización" | "Atención al cliente" | "Potencial comercial" | "Encaje del sector";
  points: number;
  reason: string;
  confidence: Confidence;
  signalKey: string;
}

export type ConfidenceLevel = "alta" | "media" | "baja";

export interface OpportunityScore {
  score: number;
  items: ScoreItem[];
  byDimension: Record<string, number>;
  /** true si el negocio tiene web y todavía no se ha revisado: el score es provisional */
  partial: boolean;
  /** Cuánto respaldo tienen los datos usados (no cambia el score) */
  confidence: ConfidenceLevel;
  confidenceReasons: string[];
  /** Puntos que salen de hechos verificados frente al total */
  verifiedShare: number;
}

export type Priority = "alta" | "media" | "baja";

export interface Opportunity {
  id: string;
  title: string;
  priority: Priority;
  problem: string;
  solution: string;
  basedOn: string[]; // signal keys
  /** Le falta un sistema (comunicación, reservas, atención): el motivo de la llamada */
  system?: boolean;
}

export interface WebAudit {
  url: string;
  finalUrl?: string;
  reachable: boolean;
  blockedByRobots?: boolean;
  error?: string;
  status?: number;
  https?: boolean;
  responseMs?: number;
  htmlKb?: number;
  title?: string;
  metaDescription?: boolean;
  viewport?: boolean;
  h1?: boolean;
  forms?: number;
  telLinks?: boolean;
  whatsappLink?: boolean;
  bookingProviders: string[];
  chatWidgets: string[];
  socials: string[];
  ctas: string[];
  copyrightYear?: number;
  generator?: string;
  schemaLocalBusiness?: boolean;
  publicEmails: string[];
  auditedAt: string;
}

export interface Analysis {
  company: Company;
  signals: Signal[];
  score: OpportunityScore;
  opportunities: Opportunity[];
  recommended: string;
  audit?: WebAudit;
}
