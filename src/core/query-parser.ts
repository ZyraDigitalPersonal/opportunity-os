// Convierte una búsqueda en lenguaje natural en filtros estructurados.
// Solo reglas: rápido, gratis y predecible. Lo que no entiende lo devuelve en `unparsed`.

import { SECTORS, INTENT_DEFAULT_SECTORS } from "./sectors.js";

export type Intent = "ia" | "reservas" | "automatizacion" | "web" | "crm" | "marketing" | "software";

export interface ParsedQuery {
  raw: string;
  sectorIds: string[];
  sectorsFromIntent: boolean;
  location?: string;
  postcode?: string;
  intents: Intent[];
  filters: { withoutWebsite?: boolean; withWebsite?: boolean; withoutBooking?: boolean };
}

export function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

const INTENT_PATTERNS: Array<[Intent, RegExp]> = [
  ["ia", /\b(ia|inteligencia artificial|agentes? de (ia|voz)|chatbots?|agente de voz|bots?)\b/],
  ["reservas", /\b(reservas?|citas?|agenda)\b/],
  ["automatizacion", /\b(automatiza\w*|procesos)\b/],
  ["web", /\b(web|pagina web|paginas web|sitio web|webs)\b/],
  ["crm", /\bcrm\b/],
  ["marketing", /\b(marketing|redes sociales|seo|publicidad)\b/],
  ["software", /\b(software|erp|panel de gestion|inventario)\b/],
];

// Palabras que cortan la parte de ubicación: "en Lleida que necesitan..."
const LOCATION_STOP = /\s(que|con|sin|y que|cerca|para|donde|las cuales|los cuales|mas de|menos de)\s.*$/;

export function parseQuery(raw: string): ParsedQuery {
  const q = normalize(raw);
  const result: ParsedQuery = { raw, sectorIds: [], sectorsFromIntent: false, intents: [], filters: {} };

  const aliasList = SECTORS.flatMap((s) => s.aliases.map((a) => ({ alias: a, id: s.id }))).sort((a, b) => b.alias.length - a.alias.length);
  let rest = ` ${q} `;
  for (const { alias, id } of aliasList) {
    const re = new RegExp(`\\s${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s`);
    if (re.test(rest)) {
      if (!result.sectorIds.includes(id)) result.sectorIds.push(id);
      rest = rest.replace(re, " ");
    }
  }

  for (const [intent, re] of INTENT_PATTERNS) if (re.test(q)) result.intents.push(intent);

  if (/\bsin (pagina )?web\b/.test(q)) result.filters.withoutWebsite = true;
  else if (/\bcon (pagina )?web\b/.test(q)) result.filters.withWebsite = true;
  if (/\bsin (sistema de )?reservas?( online)?\b/.test(q)) result.filters.withoutBooking = true;

  const pc = q.match(/\b(0[1-9]|[1-4]\d|5[0-2])\d{3}\b/);
  if (pc) result.postcode = pc[0];

  // Ubicación: lo que va detrás del último " en " (o "de"), cortado en la primera palabra de condición.
  const m = raw.match(/\s(?:en|de la zona de|zona)\s+(.+)$/i);
  if (m) {
    let loc = m[1];
    // fold conserva la longitud del texto (a diferencia de normalize), así el índice sirve para cortar el original
    const fold = loc.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const cut = fold.match(LOCATION_STOP);
    if (cut && cut.index !== undefined) loc = loc.slice(0, cut.index);
    loc = loc.replace(/[.,;!?¿¡"]+$/g, "").trim();
    // "negocios en Lleida" dentro de frases como "... en Lleida que puedan necesitar"
    if (loc && !/^\d{5}$/.test(loc)) result.location = loc;
  }

  if (result.sectorIds.length === 0) {
    const key = result.intents[0] ?? "default";
    result.sectorIds = INTENT_DEFAULT_SECTORS[key] ?? INTENT_DEFAULT_SECTORS.default;
    result.sectorsFromIntent = true;
  }
  return result;
}
