// Tipos del módulo «Prácticas y empleo formativo». Independiente del buscador comercial.

export type Modality = "presencial" | "hibrida" | "remota";
export type Scope = "local" | "nacional" | "remota";
/** Naturaleza real de la oportunidad: nunca se presenta una empresa como si buscara estudiantes sin evidencia. */
export type Nature = "oferta_publicada" | "programa" | "interes_estudiantes" | "potencial";
/** Grado de certeza de cada dato */
export type Certainty = "confirmado" | "estimado" | "hipotesis";
export type Level = "alta" | "media" | "baja";

export const NATURE_LABEL: Record<Nature, string> = {
  oferta_publicada: "Oferta de prácticas publicada",
  programa: "Programa de prácticas o talento",
  interes_estudiantes: "Ha mostrado interés en estudiantes",
  potencial: "Empresa potencial · sin confirmar",
};
export const NATURE_HINT: Record<Nature, string> = {
  oferta_publicada: "Hay una oferta publicada con enlace directo y fecha. Verifica que sigue abierta.",
  programa: "Su web habla de un programa de prácticas, becas o talento joven.",
  interes_estudiantes: "Su web menciona prácticas, FCT, FP dual o convenios con centros, pero no hay una oferta concreta.",
  potencial: "No hay evidencia de que acepte estudiantes. Puede encajar por su actividad: contacto para preguntar.",
};

export interface StudentProfile {
  id: string;
  /** Nombre para firmar los mensajes (opcional) */
  name?: string;
  familyId: string;
  studies: string;
  specialty?: string;
  /** Tecnologías o habilidades que ya conoce */
  skills: string[];
  /** Lo que quiere aprender */
  interests: string[];
  experience?: string;
  projects?: string;
  portfolioUrl?: string;
  internshipType?: string;
  location: string;
  maxDistanceKm: number;
  modalities: Modality[];
  startDate?: string;
  durationMonths?: number;
  availability?: string;
  languages: string[];
  wants: { tutoring: boolean; hiring: boolean; learning: boolean };
  /** Multiplicadores 0–2 de los pesos del encaje (modo avanzado) */
  priorities: { tech: number; activity: number; location: number; learning: number };
  /** Bolsa de prácticas de tu centro (enlace) */
  centreBoardUrl?: string;
  /** Empresas o sectores a excluir (texto) */
  exclude: string[];
  advanced: boolean;
  updatedAt?: string;
}

export interface Evidence {
  kind: "practicas" | "programa" | "interes" | "contratando" | "junior" | "tutoria" | "proyectos" | "tecnologia" | "tamano" | "actividad" | "testimonio";
  label: string;
  /** Cita corta tal cual aparece en la fuente */
  quote?: string;
  url?: string;
  source: string;
  certainty: Certainty;
  /** Fecha de publicación si se conoce; si no, fecha de comprobación */
  date?: string;
}

export interface TechHit {
  id: string;
  name: string;
  /** "texto": la empresa lo menciona; "web": lo usa su propia web (evidencia débil) */
  from: "texto" | "web" | "oferta";
  quote?: string;
  url?: string;
}

export interface CompanyResearch {
  domain: string;
  website: string;
  checkedAt: string;
  blockedByRobots?: boolean;
  error?: string;
  pages: Array<{ url: string; title?: string; ok: boolean; why: string }>;
  activity: { title?: string; description?: string; headings: string[] };
  careersUrl?: string;
  atsLinks: Array<{ name: string; url: string }>;
  evidence: Evidence[];
  techs: TechHit[];
  size?: { text: string; quote: string; url: string };
  emails: string[];
  phones: string[];
  socials: Array<{ name: string; url: string }>;
  hasContactForm: boolean;
}

export interface JobOffer {
  id: string;
  source: "Adzuna" | "Jooble";
  title: string;
  company?: string;
  location?: string;
  snippet?: string;
  url: string;
  created?: string;
  remote: boolean;
  internship: boolean;
  lat?: number;
  lon?: number;
  contract?: string;
}

/** Empresa encontrada en un directorio (Google Places / OpenStreetMap). */
export interface DirCompany {
  id: string; // gp:… | osm:… | web:dominio | job:…
  name: string;
  website?: string;
  phone?: string;
  address?: string;
  city?: string;
  lat?: number;
  lon?: number;
  source: string;
  sourceUrl?: string;
  /** Categoría de la consulta con la que se encontró («desarrollo de software») */
  category?: string;
  rating?: number;
  reviews?: number;
  alsoIn?: string;
}

export interface ScorePart {
  key: "tech" | "activity" | "location" | "learning";
  label: string;
  weight: number;
  /** 0–1; null = sin datos (no penaliza, reduce la confianza) */
  value: number | null;
  reason: string;
}

export interface InternScore {
  fit: number;
  fitProvisional: boolean;
  viability: number;
  confidence: number;
  confidenceLevel: Level;
  parts: ScorePart[];
  viabilityReasons: string[];
  confidenceReasons: string[];
  strengths: string[];
  drawbacks: string[];
  missing: string[];
}

export interface InternOpportunity {
  key: string;
  nature: Nature;
  company: DirCompany;
  offer?: JobOffer;
  research?: CompanyResearch | null;
  distanceKm?: number;
  modality: Modality | "desconocida";
  techs: string[];
  headline: string;
  warnings: string[];
  checkedAt: string;
  score: InternScore;
}

export interface SourceStatus {
  id: string;
  name: string;
  status: "ok" | "sin_configurar" | "error" | "omitida";
  detail: string;
  count?: number;
  costUsd?: number;
}

export interface ManualLink {
  name: string;
  url: string;
  hint: string;
}
