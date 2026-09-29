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
  id: string; // "osm:node/123"
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
  source: "OpenStreetMap";
  sourceUrl: string;
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

export interface OpportunityScore {
  score: number;
  items: ScoreItem[];
  byDimension: Record<string, number>;
  /** true si solo se usaron datos de OSM (sin auditar la web) */
  partial: boolean;
}

export type Priority = "alta" | "media" | "baja";

export interface Opportunity {
  id: string;
  title: string;
  priority: Priority;
  problem: string;
  solution: string;
  basedOn: string[]; // signal keys
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
