// Investigación de una empresa a partir de su web pública.
// Lee la portada y como mucho 5 páginas internas relevantes (empleo, prácticas, nosotros, servicios),
// respeta robots.txt y no guarda HTML: solo hechos con su cita y su URL.
// Datos personales: solo buzones genéricos (info@, rrhh@, empleo@…); nunca nombres ni emails de personas.

import { assertPublicHttpUrl, fetchWithTimeout, readTextLimited } from "../http.js";
import { robotsAllowsPath } from "../web-audit.js";
import { foldText, getFamily, vocabIn } from "./families.js";
import type { CompanyResearch, Evidence, TechHit } from "./types.js";

const MAX_PAGES = 6;
const MAX_HTML = 900_000;

export interface ResearchOptions {
  userAgent: string;
  botName: string;
  familyId: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const LINK_KEYWORDS: Array<[RegExp, number, string]> = [
  [/practicas|becas?\b|becari|estudiantes|internship|intern\b|trainee|fct|fp-?dual|dual\b|graduate|talento|talent/, 6, "prácticas o talento"],
  [/empleo|trabaja|trabajo|careers?|jobs?|unete|join|vacantes|ofertas|seleccion|recruit|work-with-us|treballa/, 5, "empleo"],
  [/nosotros|quienes|about|empresa|equipo|team|sobre|qui-som/, 2, "sobre la empresa"],
  [/servicios|services|soluciones|solutions|tecnolog|technolog|proyectos|projects|productos|products|casos|clientes/, 2, "actividad"],
];

const ATS: Array<[string, RegExp]> = [
  ["Workable", /apply\.workable\.com\/[a-z0-9-]+/i],
  ["Lever", /jobs\.lever\.co\/[a-z0-9-]+/i],
  ["Greenhouse", /boards\.greenhouse\.io\/[a-z0-9-]+/i],
  ["Teamtailor", /[a-z0-9-]+\.teamtailor\.com/i],
  ["Personio", /[a-z0-9-]+\.jobs\.personio\.(de|com|es)/i],
  ["Factorial", /[a-z0-9-]+\.factorialhr\.(com|es)\/(job|careers|ofertas)?/i],
  ["BambooHR", /[a-z0-9-]+\.bamboohr\.com\/careers/i],
  ["SmartRecruiters", /(jobs|careers)\.smartrecruiters\.com\/[a-z0-9-]+/i],
  ["Recruitee", /[a-z0-9-]+\.recruitee\.com/i],
  ["InfoJobs", /infojobs\.net\/[a-z0-9-]+\/(em|co)-/i],
  ["LinkedIn empleos", /linkedin\.com\/company\/[a-z0-9_-]+\/jobs/i],
];

const SITE_TECH: Array<[string, string, RegExp]> = [
  ["wordpress", "WordPress", /wp-content|wp-includes|<meta[^>]+generator[^>]+wordpress/i],
  ["react", "React", /data-reactroot|react(-dom)?(\.production)?(\.min)?\.js|__next|_next\/static/i],
  ["next", "Next.js", /_next\/static|__NEXT_DATA__/],
  ["vue", "Vue", /data-v-[0-9a-f]{6,}|vue(\.runtime)?(\.global)?(\.prod)?(\.min)?\.js|__NUXT__/i],
  ["angular", "Angular", /ng-version=|angular(\.min)?\.js/i],
  ["ecommerce", "Shopify", /cdn\.shopify\.com/i],
  ["laravel", "Laravel", /laravel_session|XSRF-TOKEN.+laravel/i],
];

// Frases que son evidencia (sobre texto en minúsculas y sin acentos)
const RX = {
  programa: /\b(programa (de )?(practicas|becas|talento|graduados|trainee)|talent (program|programme)|graduate (program|programme)|plan de becas|becas? (para|de) (estudiantes|recien titulados|talento)|programa de jovenes talentos)\b/,
  practicas: /\b(practicas (curriculares|extracurriculares|profesionales|en empresa)|estudiantes en practicas|alumnos en practicas|en practicas|convenios? de (practicas|cooperacion educativa)|fct\b|formacion en centros de trabajo|fp dual|formacion dual|becari[oa]s?|internships?|interns?\b|trainee)/,
  interes: /\b(colaboramos con (universidades|centros|institutos|escuelas)|centros educativos|acogemos (a )?(estudiantes|alumnos)|incorporamos (a )?(estudiantes|alumnos)|(alumnos|estudiantes) de (fp|formacion profesional|grado|universidad)|apostamos por el talento joven|talento joven)\b/,
  contratando: /\b(ofertas? de (empleo|trabajo)|vacantes|estamos (contratando|buscando)|buscamos (un|una|a)? ?(desarrollador|programador|tecnico|perfil|persona|talento)|unete (a nuestro|al) equipo|trabaja con nosotros|posiciones abiertas|join (our|the) team|we are hiring|open positions)\b/,
  junior: /\b(junior|sin experiencia|recien titulad[oa]s?|primer empleo|entry level)\b/,
  tutoria: /\b(mentor(ing|ia|es)?|tutor(ia|es)?|plan de (formacion|carrera)|formacion (continua|interna)|aprendizaje continuo|crecimiento profesional|academy|onboarding)\b/,
  proyectos: /\b(casos de exito|nuestros proyectos|proyectos (realizados|para)|nuestros clientes|clientes como|portfolio|nuestros productos|plataforma propia|producto propio)\b/,
  size: /\b(mas de |equipo de |somos |contamos con )?(\d{1,5})\s+(profesionales|personas|empleados|trabajadores|expertos|ingenieros|desarrolladores|consultores)\b/,
};

const GENERIC_EMAIL = /^(info|hola|hello|contact[oa]?|admin|administracion|oficina|comercial|ventas|rrhh|hr|empleo|jobs|careers|talento|talent|seleccion|recruiting|practicas|becas|people|treball|feina|cv|curriculum|recepcion|atencion)[._-]?[a-z0-9]*@/i;

function strip(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(br|p|div|li|h[1-6]|section|article|tr|footer|header)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Frases (o líneas) del texto visible, para poder citar exactamente. */
export function sentences(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 12 && x.length <= 600);
}

/** Recorta una cita alrededor de la coincidencia sin pasar de ~220 caracteres. */
function quoteAround(sentence: string, re: RegExp): string {
  const f = foldText(sentence);
  const m = f.match(re);
  if (!m || m.index === undefined || sentence.length <= 220) return sentence.slice(0, 220);
  const start = Math.max(0, m.index - 90);
  const end = Math.min(sentence.length, m.index + m[0].length + 110);
  return (start > 0 ? "…" : "") + sentence.slice(start, end).trim() + (end < sentence.length ? "…" : "");
}

interface Page {
  url: string;
  html: string;
  text: string;
  title?: string;
}

export interface PageFacts {
  evidence: Evidence[];
  techs: TechHit[];
  size?: CompanyResearch["size"];
  emails: string[];
  phones: string[];
  socials: Array<{ name: string; url: string }>;
  atsLinks: Array<{ name: string; url: string }>;
  hasContactForm: boolean;
}

/** Extrae hechos de una página ya descargada. Separado del fetch para poder probarlo. */
export function extractFacts(page: Page, familyId: string, checkedAt: string): PageFacts {
  const fam = getFamily(familyId);
  const ev: Evidence[] = [];
  const seen = new Set<string>();
  const push = (e: Evidence) => {
    const k = `${e.kind}|${e.quote ?? e.label}`;
    if (seen.has(k)) return;
    seen.add(k);
    ev.push(e);
  };
  const src = "Web de la empresa";
  for (const s of sentences(page.text)) {
    const f = foldText(s);
    if (RX.programa.test(f)) push({ kind: "programa", label: "Menciona un programa de prácticas, becas o talento", quote: quoteAround(s, RX.programa), url: page.url, source: src, certainty: "confirmado", date: checkedAt });
    else if (RX.practicas.test(f)) push({ kind: "practicas", label: "Menciona prácticas, FCT, FP dual o becarios", quote: quoteAround(s, RX.practicas), url: page.url, source: src, certainty: "confirmado", date: checkedAt });
    if (RX.interes.test(f)) push({ kind: "interes", label: "Habla de colaborar con centros o incorporar estudiantes", quote: quoteAround(s, RX.interes), url: page.url, source: src, certainty: "confirmado", date: checkedAt });
    if (RX.contratando.test(f)) push({ kind: "contratando", label: "Indica que contrata o tiene vacantes", quote: quoteAround(s, RX.contratando), url: page.url, source: src, certainty: "confirmado", date: checkedAt });
    if (RX.junior.test(f) && /\b(puesto|perfil|buscamos|oferta|posicion|vacante|incorpora)/.test(f)) push({ kind: "junior", label: "Busca o acepta perfiles junior", quote: quoteAround(s, RX.junior), url: page.url, source: src, certainty: "confirmado", date: checkedAt });
    if (RX.tutoria.test(f)) push({ kind: "tutoria", label: "Habla de mentoría, formación o plan de carrera", quote: quoteAround(s, RX.tutoria), url: page.url, source: src, certainty: "confirmado", date: checkedAt });
    if (RX.proyectos.test(f)) push({ kind: "proyectos", label: "Muestra proyectos, productos o clientes", quote: quoteAround(s, RX.proyectos), url: page.url, source: src, certainty: "confirmado", date: checkedAt });
  }

  const techs: TechHit[] = [];
  for (const s of sentences(page.text)) {
    for (const v of vocabIn(s, fam.vocabulary)) {
      if (techs.some((x) => x.id === v.id)) continue;
      techs.push({ id: v.id, name: v.name, from: "texto", quote: quoteAround(s, v.re), url: page.url });
    }
  }
  if (fam.id === "informatica") {
    for (const [id, name, re] of SITE_TECH) {
      if (re.test(page.html) && !techs.some((x) => x.id === id)) techs.push({ id, name, from: "web", url: page.url });
    }
  }

  let size: PageFacts["size"];
  for (const s of sentences(page.text)) {
    const m = foldText(s).match(RX.size);
    if (m && Number(m[2]) >= 2 && Number(m[2]) <= 100000) {
      size = { text: `${m[1]?.trim() === "mas de" ? "Más de " : ""}${m[2]} ${m[3]} (según su web)`, quote: quoteAround(s, RX.size), url: page.url };
      break;
    }
  }

  const emails = [...new Set([...page.html.matchAll(/mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))].filter((e) => GENERIC_EMAIL.test(e));
  const phones = [...new Set([...page.html.matchAll(/href=["']tel:([+\d\s().-]{6,20})["']/gi)].map((m) => m[1].replace(/\s+/g, " ").trim()))];
  const socials: Array<{ name: string; url: string }> = [];
  for (const [name, re] of [
    ["LinkedIn", /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/company\/[a-z0-9_%-]+\/?/i],
    ["GitHub", /https?:\/\/github\.com\/[a-z0-9_-]+\/?(?=["'\s])/i],
    ["Instagram", /https?:\/\/(www\.)?instagram\.com\/[a-z0-9_.]+\/?/i],
    ["X / Twitter", /https?:\/\/(www\.)?(twitter|x)\.com\/[a-z0-9_]+\/?/i],
    ["YouTube", /https?:\/\/(www\.)?youtube\.com\/(@|channel\/|c\/)[a-z0-9_-]+/i],
  ] as Array<[string, RegExp]>) {
    const m = page.html.match(re);
    if (m) socials.push({ name, url: m[0] });
  }
  const atsLinks: Array<{ name: string; url: string }> = [];
  for (const [name, re] of ATS) {
    const m = page.html.match(new RegExp(`https?://[^"'\\s<>]*${re.source}[^"'\\s<>]*`, "i"));
    if (m) atsLinks.push({ name, url: m[0] });
  }
  return { evidence: ev, techs, size, emails, phones, socials, atsLinks, hasContactForm: /<form\b/i.test(page.html) };
}

/** Enlaces internos de la portada puntuados por lo útiles que son para investigar prácticas. */
export function candidateLinks(html: string, base: URL): Array<{ url: string; score: number; why: string }> {
  const out = new Map<string, { url: string; score: number; why: string }>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u: URL;
    try {
      u = new URL(m[1], base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    const sameSite = u.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "") || u.hostname.endsWith("." + base.hostname.replace(/^www\./, ""));
    if (!sameSite) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4)$/i.test(u.pathname)) continue;
    u.hash = "";
    const key = foldText(`${u.pathname} ${m[2].replace(/<[^>]+>/g, " ")}`);
    let best = { score: 0, why: "" };
    for (const [re, w, why] of LINK_KEYWORDS) if (re.test(key) && w > best.score) best = { score: w, why };
    if (best.score === 0 || u.pathname === base.pathname) continue;
    const prev = out.get(u.href);
    if (!prev || prev.score < best.score) out.set(u.href, { url: u.href, ...best });
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

async function fetchPage(url: string, headers: Record<string, string>, f: typeof fetch): Promise<Page | null> {
  try {
    const res = await fetchWithTimeout(url, { headers, redirect: "follow" }, 9000, f);
    if (!res.ok || !/html|text\/plain|^$/.test(res.headers.get("content-type") ?? "")) return null;
    const { text: html } = await readTextLimited(res, MAX_HTML);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim().slice(0, 160);
    return { url: res.url || url, html, text: strip(html), title };
  } catch {
    return null;
  }
}

function metaContent(html: string, name: string): string | undefined {
  const a = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']{10,400})`, "i"))?.[1];
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']{10,400})["'][^>]+(?:name|property)=["']${name}["']`, "i"))?.[1];
  return (a ?? b)?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
}

export async function researchCompany(rawUrl: string, opts: ResearchOptions): Promise<CompanyResearch> {
  const f = opts.fetchImpl ?? ((...a) => fetch(...a));
  const checkedAt = (opts.now?.() ?? new Date()).toISOString();
  const empty = (website: string, extra: Partial<CompanyResearch>): CompanyResearch => ({
    domain: "",
    website,
    checkedAt,
    pages: [],
    activity: { headings: [] },
    atsLinks: [],
    evidence: [],
    techs: [],
    emails: [],
    phones: [],
    socials: [],
    hasContactForm: false,
    ...extra,
  });
  let base: URL;
  try {
    base = assertPublicHttpUrl(rawUrl);
  } catch (e) {
    return empty(rawUrl, { error: (e as Error).message });
  }
  const headers = { "User-Agent": opts.userAgent, Accept: "text/html,application/xhtml+xml", "Accept-Language": "es-ES,es;q=0.9,ca;q=0.7" };
  let robots = "";
  try {
    const r = await fetchWithTimeout(`${base.origin}/robots.txt`, { headers, redirect: "follow" }, 5000, f);
    if (r.ok) robots = (await readTextLimited(r, 100_000)).text;
  } catch {}
  const allowed = (u: string) => !robots || robotsAllowsPath(robots, opts.botName, new URL(u).pathname + new URL(u).search);
  const domain = base.hostname.replace(/^www\./, "");
  if (!allowed(base.href)) return empty(base.href, { domain, blockedByRobots: true });

  const home = await fetchPage(base.href, headers, f);
  if (!home) return empty(base.href, { domain, error: "La web no responde o no devuelve HTML", pages: [{ url: base.href, ok: false, why: "portada" }] });
  const pages: CompanyResearch["pages"] = [{ url: home.url, title: home.title, ok: true, why: "portada" }];
  const fetched: Page[] = [home];
  const candidates = candidateLinks(home.html, new URL(home.url))
    .filter((c) => allowed(c.url))
    .slice(0, MAX_PAGES - 1);
  // Como mucho 3 descargas a la vez para no cargar el servidor de la empresa
  for (let i = 0; i < candidates.length; i += 3) {
    const batch = candidates.slice(i, i + 3);
    const res = await Promise.all(batch.map((c) => fetchPage(c.url, headers, f)));
    res.forEach((p, j) => {
      pages.push({ url: batch[j].url, title: p?.title, ok: !!p, why: batch[j].why });
      if (p) fetched.push(p);
    });
  }

  const merged: PageFacts = { evidence: [], techs: [], emails: [], phones: [], socials: [], atsLinks: [], hasContactForm: false };
  for (const p of fetched) {
    const x = extractFacts(p, opts.familyId, checkedAt);
    for (const e of x.evidence) if (!merged.evidence.some((y) => y.kind === e.kind && y.quote === e.quote)) merged.evidence.push(e);
    for (const t of x.techs) if (!merged.techs.some((y) => y.id === t.id)) merged.techs.push(t);
    else if (t.from === "texto") merged.techs = merged.techs.map((y) => (y.id === t.id && y.from === "web" ? t : y));
    merged.size ??= x.size;
    merged.emails = [...new Set([...merged.emails, ...x.emails])].slice(0, 4);
    merged.phones = [...new Set([...merged.phones, ...x.phones])].slice(0, 3);
    for (const s of x.socials) if (!merged.socials.some((y) => y.name === s.name)) merged.socials.push(s);
    for (const a of x.atsLinks) if (!merged.atsLinks.some((y) => y.url === a.url)) merged.atsLinks.push(a);
    merged.hasContactForm ||= x.hasContactForm;
  }
  // Limita el volumen por tipo para que la ficha sea legible
  const perKind = new Map<string, number>();
  merged.evidence = merged.evidence.filter((e) => {
    const n = (perKind.get(e.kind) ?? 0) + 1;
    perKind.set(e.kind, n);
    return n <= (e.kind === "practicas" || e.kind === "programa" ? 4 : 3);
  });

  const careers = pages.find((p) => p.ok && (p.why === "empleo" || p.why === "prácticas o talento"))?.url ?? merged.atsLinks[0]?.url;
  if (merged.atsLinks.length) {
    merged.evidence.push({ kind: "contratando", label: `Usa una plataforma de selección (${merged.atsLinks.map((a) => a.name).join(", ")})`, url: merged.atsLinks[0].url, source: src(), certainty: "confirmado", date: checkedAt });
  }
  if (merged.size) merged.evidence.push({ kind: "tamano", label: merged.size.text, quote: merged.size.quote, url: merged.size.url, source: src(), certainty: "estimado", date: checkedAt });

  const headings = [...home.html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((h) => h.length >= 4 && h.length <= 140)
    .slice(0, 6);
  return {
    domain,
    website: home.url,
    checkedAt,
    pages,
    activity: { title: home.title, description: metaContent(home.html, "description") ?? metaContent(home.html, "og:description"), headings },
    careersUrl: careers,
    atsLinks: merged.atsLinks,
    evidence: merged.evidence,
    techs: merged.techs.slice(0, 20),
    size: merged.size,
    emails: merged.emails,
    phones: merged.phones,
    socials: merged.socials,
    hasContactForm: merged.hasContactForm,
  };
}

const src = () => "Web de la empresa";
