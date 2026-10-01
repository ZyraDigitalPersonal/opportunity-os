// Convierte una búsqueda en lenguaje natural en filtros estructurados.
// Solo reglas: rápido, gratis y predecible.
//
// Entiende, entre otras:
//   «Clínicas dentales en Lleida», «clinica dental lleida», «Lleida dentistas»,
//   «restaurantes de Tenerife», «Restaurantes en Santa Cruz de Tenerife sin web»,
//   «Negocios en Lleida que puedan necesitar agentes de IA» (sectores según la intención),
//   «tiendas de drones en Madrid» (sector libre que no está en el catálogo).

import { SECTORS, INTENT_DEFAULT_SECTORS } from "./sectors.js";

export type Intent = "ia" | "reservas" | "automatizacion" | "web" | "crm" | "marketing" | "software";

export interface LocationCandidate {
  location: string;
  /** Sector libre si la frase se parte de otra forma */
  keyword?: string;
}

export interface ParsedQuery {
  raw: string;
  sectorIds: string[];
  sectorsFromIntent: boolean;
  /** Sector libre («tienda de drones») cuando no encaja en el catálogo */
  keyword?: string;
  location?: string;
  postcode?: string;
  /** Otras interpretaciones de la zona, por si la primera no se encuentra */
  alternatives: LocationCandidate[];
  intents: Intent[];
  filters: { withoutWebsite?: boolean; withWebsite?: boolean; withoutBooking?: boolean };
}

export function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

const INTENT_PATTERNS: Array<[Intent, RegExp]> = [
  ["ia", /\b(ia|inteligencia artificial|agentes? (de )?(ia|voz)|chatbots?|agente de voz|bots?|asistente virtual)\b/],
  ["reservas", /\b(reservas?|citas?|agenda)\b/],
  ["automatizacion", /\b(automatiza\w*|procesos)\b/],
  ["web", /\b(web|pagina web|paginas web|sitio web|webs)\b/],
  ["crm", /\b(crm|seguimiento de clientes|fidelizacion)\b/],
  ["marketing", /\b(marketing|redes sociales|publicidad|resenas|seo)\b/],
  ["software", /\b(software|erp|panel de gestion|inventario)\b/],
];

/** Palabras que inician una condición: lo que va detrás no es ni zona ni sector. */
const CUT_WORDS = new Set(["que", "con", "sin", "cuyo", "cuyos", "cuya", "cuyas", "donde", "para", "necesitan", "necesiten", "puedan", "interesados", "interesadas", "mas", "menos"]);

/** Relleno: nunca es zona ni sector. */
const FILLER = new Set([
  "negocio", "negocios", "empresa", "empresas", "pyme", "pymes", "local", "locales", "autonomo", "autonomos", "comercios",
  "todos", "todas", "todo", "toda", "los", "las", "el", "la", "lo", "un", "una", "unos", "unas", "mis", "sus",
  "busca", "buscar", "buscame", "busco", "encuentra", "encontrar", "encuentrame", "dame", "quiero", "necesito", "lista", "listado", "listame", "muestrame", "mostrar", "ver", "hay",
  "y", "e", "o", "mejores", "nuevos", "nuevas", "pequenos", "pequenas", "cualquier", "tipo", "tipos", "sector", "sectores", "potenciales", "clientes",
  "ia", "inteligencia", "artificial", "chatbot", "chatbots", "automatizacion", "automatizaciones", "crm", "marketing", "seo", "digitalizacion", "agente", "agentes", "voz", "bot", "bots",
]);

/** Palabras que introducen la zona. */
const PLACE_INTRO = new Set(["en", "zona", "cerca", "alrededor", "provincia", "isla", "municipio", "ciudad", "comarca"]);
const PREPS = new Set(["de", "del", "en", "a", "al", "la", "el", "los", "las", "y", "por", "desde"]);

interface Tok {
  raw: string;
  norm: string;
  kind: "free" | "sector" | "filler" | "cut" | "postcode";
}

function tokenize(raw: string): Tok[] {
  return raw
    .replace(/[¿?¡!.,;:"«»()\[\]]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ({ raw: t, norm: normalize(t), kind: "free" as const }));
}

/** Singular aproximado para sectores libres: floristerías → floristería, talleres → taller, drones → dron. */
export function singularize(phrase: string): string {
  return phrase
    .split(/\s+/)
    .map((w) => {
      if (w.length <= 3 || PREPS.has(w)) return w;
      if (/ces$/.test(w)) return w.slice(0, -3) + "z";
      if (/[^aeiou]es$/.test(w) && !/(ies)$/.test(w)) return w.slice(0, -2);
      if (/s$/.test(w)) return w.slice(0, -1);
      return w;
    })
    .join(" ");
}

function stripEdges(words: Tok[]): Tok[] {
  let a = 0;
  let b = words.length;
  const properArticle = (t: Tok) => ["la", "el", "los", "las"].includes(t.norm) && /^[A-ZÁÉÍÓÚÑ]/.test(t.raw);
  while (a < b && !properArticle(words[a]) && (PREPS.has(words[a].norm) || PLACE_INTRO.has(words[a].norm) || FILLER.has(words[a].norm))) a++;
  while (b > a && (PREPS.has(words[b - 1].norm) || FILLER.has(words[b - 1].norm))) b--;
  return words.slice(a, b);
}

const text = (ts: Tok[]) => ts.map((t) => t.raw).join(" ");

export function parseQuery(raw: string): ParsedQuery {
  const q = normalize(raw);
  const result: ParsedQuery = { raw, sectorIds: [], sectorsFromIntent: false, intents: [], filters: {}, alternatives: [] };

  for (const [intent, re] of INTENT_PATTERNS) if (re.test(q)) result.intents.push(intent);
  if (/\b(sin|que no (tienen|tengan)|no tienen|no tengan) (una )?(pagina |sitio )?(web|webs)( propia)?\b/.test(q)) result.filters.withoutWebsite = true;
  else if (/\b(con|que (tienen|tengan)) (pagina |sitio )?(web|webs)( propia)?\b/.test(q)) result.filters.withWebsite = true;
  if (/\bsin (sistema de )?(reservas?|citas?)( online)?\b/.test(q)) result.filters.withoutBooking = true;

  const toks = tokenize(raw);

  // 1) Código postal
  for (const t of toks) {
    if (/^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/.test(t.norm)) {
      t.kind = "postcode";
      result.postcode ??= t.norm;
    }
  }

  // 2) Cortar en la primera palabra de condición («… que necesitan web», «… con más de 100 reseñas»)
  for (let i = 1; i < toks.length; i++) {
    if (CUT_WORDS.has(toks[i].norm)) {
      for (let j = i; j < toks.length; j++) toks[j].kind = "cut";
      break;
    }
  }

  // 3) Sectores del catálogo (alias más largos primero)
  const aliasList = SECTORS.flatMap((s) => s.aliases.map((a) => ({ words: a.split(" "), id: s.id }))).sort((a, b) => b.words.length - a.words.length);
  for (const { words, id } of aliasList) {
    for (let i = 0; i + words.length <= toks.length; i++) {
      if (words.every((w, k) => toks[i + k].kind === "free" && toks[i + k].norm === w)) {
        for (let k = 0; k < words.length; k++) toks[i + k].kind = "sector";
        if (!result.sectorIds.includes(id)) result.sectorIds.push(id);
      }
    }
  }

  // 4) Relleno
  for (const t of toks) if (t.kind === "free" && FILLER.has(t.norm)) t.kind = "filler";

  // 5) Zona: lo que va detrás de la última palabra de lugar («en», «zona»…) que tenga texto libre detrás
  const live = toks.filter((t) => t.kind !== "cut");
  let introIdx = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    if (PLACE_INTRO.has(live[i].norm) && live[i].kind !== "sector" && live.slice(i + 1).some((t) => t.kind === "free")) {
      introIdx = i;
      break;
    }
  }
  // Sin «en»: «restaurantes de Tenerife» → lo que va detrás de «de» que sigue al sector
  if (introIdx === -1) {
    const lastSector = live.map((t) => t.kind).lastIndexOf("sector");
    if (lastSector >= 0 && ["de", "del"].includes(live[lastSector + 1]?.norm ?? "") && live.slice(lastSector + 2).some((t) => t.kind === "free")) introIdx = lastSector + 1;
  }

  let locToks: Tok[] = [];
  let keywordToks: Tok[] = [];
  if (introIdx >= 0) {
    // La zona conserva preposiciones y artículos internos («Santa Cruz de Tenerife», «El Puerto de la Cruz»)
    locToks = stripEdges(live.slice(introIdx + 1).filter((t) => t.kind === "free" || (t.kind === "filler" && PREPS.has(t.norm))));
    keywordToks = stripEdges(live.slice(0, introIdx).filter((t) => t.kind === "free"));
  } else {
    // «clinica dental lleida», «Lleida dentistas»: lo libre que no es sector es la zona
    const free = stripEdges(live.filter((t) => t.kind === "free" || (t.kind === "filler" && PREPS.has(t.norm))));
    if (result.sectorIds.length) locToks = free;
    else if (free.length === 1) locToks = free;
    else if (free.length > 1) {
      // Sin sector ni preposición («floristerias girona»): zona al final y, si no existe, al principio
      locToks = free.slice(-1);
      keywordToks = free.slice(0, -1);
      for (let k = free.length - 2; k >= 1; k--) result.alternatives.push({ location: text(free.slice(k)), keyword: singularize(normalize(text(free.slice(0, k)))) });
      for (let k = free.length - 1; k >= 1; k--) result.alternatives.push({ location: text(free.slice(0, k)), keyword: singularize(normalize(text(free.slice(k)))) });
    }
  }

  const location = text(locToks).trim();
  if (location && !/^\d{5}$/.test(location)) result.location = location;

  // Zonas largas que no existan tal cual («el sur de Tenerife»): probar quitando palabras por delante
  if (locToks.length > 1) {
    for (let k = 1; k < locToks.length; k++) {
      const rest = stripEdges(locToks.slice(k));
      if (rest.length) {
        const loc = text(rest);
        if (!result.alternatives.some((a) => a.location === loc)) result.alternatives.push({ location: loc });
      }
    }
  }

  if (!result.sectorIds.length && keywordToks.length) {
    const kw = singularize(normalize(text(keywordToks)));
    if (kw.length >= 3 && kw.length <= 40) result.keyword = kw;
  } else if (result.sectorIds.length === 1 && introIdx >= 0) {
    // Sector del catálogo con matiz («tiendas de drones», «academias de inglés»): se busca la frase completa
    const before = live.slice(0, introIdx);
    const first = before.findIndex((t) => t.kind === "sector");
    const phrase = stripEdges(before.slice(first).filter((t) => t.kind === "sector" || t.kind === "free" || (t.kind === "filler" && PREPS.has(t.norm))));
    if (first >= 0 && phrase.some((t) => t.kind === "free")) {
      const words = normalize(text(phrase)).split(" ");
      words[0] = singularize(words[0]);
      const kw = words.join(" ");
      if (kw.length <= 40) result.keyword = kw;
    }
  }

  if (result.keyword) result.sectorIds = [`custom:${result.keyword}`];
  else if (!result.sectorIds.length) {
    const key = result.intents[0] ?? "default";
    result.sectorIds = INTENT_DEFAULT_SECTORS[key] ?? INTENT_DEFAULT_SECTORS.default;
    result.sectorsFromIntent = true;
  }
  return result;
}

/** Aplica una alternativa (zona y, si hay, sector libre) a una búsqueda ya interpretada. */
export function withAlternative(p: ParsedQuery, alt: LocationCandidate): ParsedQuery {
  const next: ParsedQuery = { ...p, location: alt.location, alternatives: [] };
  if (alt.keyword && (p.keyword || p.sectorsFromIntent)) {
    next.keyword = alt.keyword;
    next.sectorIds = [`custom:${alt.keyword}`];
    next.sectorsFromIntent = false;
  }
  return next;
}
