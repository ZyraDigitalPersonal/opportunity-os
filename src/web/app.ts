// Frontend de OpportunityOS (sin framework). Todo dato externo pasa por esc() antes de pintarse.

import type { Analysis, Company, GeoArea, Opportunity, OpportunityScore, Signal } from "../core/types.js";


interface SearchResult {
  company: Company;
  score: OpportunityScore;
  recommended: string;
  opportunities: Opportunity[];
  /** Sistema que le falta (comunicación, reservas…) */
  system?: string | null;
}
interface SearchResponse {
  parsed: { raw: string; sectorIds: string[]; sectorsFromIntent: boolean; keyword?: string; location?: string; postcode?: string; intents: string[] };
  area: GeoArea;
  results: SearchResult[];
  warnings?: string[];
  meta: { total: number; cacheHit: boolean; attribution: string; costEur: number; costUsd?: number; sources?: string[]; source?: string; googleCalls?: number };
}
interface ApiError extends Error {
  status?: number;
  missing?: string;
}

interface Toggles {
  googleSearch: boolean;
  googleMap: boolean;
  osm: boolean;
  ai: boolean;
}
type MapStyle = "dark" | "light" | "auto" | "google";
type SortKey = "agency" | "score" | "reviews" | "name";
type QuickFilter = "all" | "noweb" | "system" | "nobooking" | "fewreviews" | "phone" | "mine";

interface AppConfig {
  integrations: { openStreetMap: boolean; contactEmail?: boolean; googlePlaces: boolean; googleMaxCalls?: number; googleMaps?: boolean; ai: boolean; aiFree?: boolean; aiProvider: string | null };
  mapsKey?: string | null;
  toggles?: Toggles;
  canToggle?: boolean;
  contact?: { company: string; web: string; contactPage: string; email: string; phone: string; whatsapp: string; instagram: string; linkedin: string; tiktok: string };
  missing: string[];
  rulesVersion: string;
}

/** Servicios que puede vender la agencia → ids de oportunidad del motor */
const SERVICES: Array<[string, string, string[]]> = [
  ["web", "Páginas web", ["new_web", "fix_web", "redesign"]],
  ["booking", "Reservas y recordatorios", ["booking", "reminders"]],
  ["voice", "Agentes de voz IA (llamadas)", ["voice_agent"]],
  ["chatbot", "Chatbots IA", ["chatbot"]],
  ["whatsapp", "Automatización de WhatsApp", ["whatsapp"]],
  ["automation", "Automatizaciones", ["automation", "leads"]],
  ["crm", "CRM y fidelización", ["crm"]],
  ["seo", "SEO local", ["seo"]],
  ["reviews", "Reseñas y reputación", ["reviews"]],
];

interface Settings {
  agencyName: string;
  senderName: string;
  mapStyle: MapStyle;
  services: string[];
  sort: SortKey;
  limit: number;
}
const DEFAULT_SETTINGS: Settings = { agencyName: "Digital Zyra", senderName: "Kilian", mapStyle: "dark", services: SERVICES.map(([id]) => id), sort: "agency", limit: 300 };

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("oos-settings");
    if (raw) {
      const v = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      if (v.agencyName === "ZYRA") v.agencyName = DEFAULT_SETTINGS.agencyName; // valor antiguo
      return v;
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}
function saveSettings(x: Settings) {
  try {
    localStorage.setItem("oos-settings", JSON.stringify(x));
  } catch {}
}
function myOppIds(): Set<string> {
  const sv = new Set(loadSettings().services);
  return new Set(SERVICES.filter(([id]) => sv.has(id)).flatMap(([, , ops]) => ops));
}

function recentSearches(): string[] {
  try {
    return JSON.parse(localStorage.getItem("oos-recent") ?? "[]").slice(0, 6);
  } catch {
    return [];
  }
}
function pushRecent(q: string) {
  try {
    const list = [q, ...recentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6);
    localStorage.setItem("oos-recent", JSON.stringify(list));
  } catch {}
}

const EXAMPLES = [
  "Clínicas dentales en Lleida",
  "Restaurantes en Santa Cruz de Tenerife sin web",
  "Peluquerías en La Laguna",
  "Talleres mecánicos en Las Palmas de Gran Canaria",
  "Negocios en Lleida que puedan necesitar agentes de IA",
  "Inmobiliarias en Adeje",
];

const OPP_FILTERS: Array<[string, string]> = [
  ["", "Todas las oportunidades"],
  ["voice_agent", "Agente de voz IA"],
  ["booking", "Reservas online"],
  ["whatsapp", "WhatsApp"],
  ["new_web", "Web nueva"],
  ["redesign", "Rediseño web"],
  ["chatbot", "Chatbot"],
  ["crm", "CRM"],
  ["leads", "Captación de leads"],
  ["automation", "Automatizaciones"],
  ["reviews", "Reseñas / reputación"],
  ["seo", "SEO local"],
  ["fix_web", "Web caída"],
];

const state = {
  data: null as SearchResponse | null,
  analyses: new Map<string, Analysis>(),
  activeId: null as string | null,
  loading: false,
  error: null as ApiError | null,
  filters: { minScore: 0, opp: "", sort: loadSettings().sort as SortKey },
  batch: null as null | { done: number; total: number },
  map: null as MapAdapter | null,
  config: null as null | AppConfig,
  quick: "all" as QuickFilter,
  shown: 60,
  chat: [] as Array<{ role: "user" | "assistant"; content: string }>,
  chatBusy: false,
};

// ---------- Utilidades ----------

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function safeHref(u?: string): string {
  if (!u) return "#";
  return /^https?:\/\//i.test(u) ? esc(u) : "#";
}
function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
function scoreColor(v: number): string {
  return v >= 70 ? "var(--high)" : v >= 45 ? "var(--mid)" : "var(--low)";
}
function scoreRing(v: number, lg = false): string {
  return `<div class="score${lg ? " lg" : ""}" style="--v:${v};--c:${scoreColor(v)}" role="img" aria-label="Opportunity Score ${v} de 100"><span>${v}</span></div>`;
}
function hostOf(u?: string): string {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "") : "";
  } catch {
    return u ?? "";
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Sesión caducada");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = new Error(data.error ?? `Error ${res.status}`);
    err.status = res.status;
    err.missing = data.missing;
    throw err;
  }
  return data as T;
}

function errorBox(e: ApiError): string {
  const cfg = e.missing ? `<p>Configura la variable <code>${esc(e.missing)}</code> en Cloudflare (Workers → tu worker → Settings → Variables and Secrets).</p>` : "";
  return `<div class="error-box" role="alert"><strong>${esc(e.message)}</strong>${cfg}</div>`;
}

// ---------- Tema ----------

function initTheme() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("oos-theme");
  } catch {}
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  $("#theme-toggle")?.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("oos-theme", next);
    } catch {}
    applyMapTheme();
  });
}
function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

// ---------- Router ----------

function route() {
  const h = location.hash || "#/";
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((a) => a.removeAttribute("aria-current"));
  if (h.startsWith("#/empresa/")) {
    renderProfile(decodeURIComponent(h.slice("#/empresa/".length)));
  } else if (h.startsWith("#/ajustes")) {
    $("[data-nav=settings]")?.setAttribute("aria-current", "page");
    renderSettings();
  } else if (h.startsWith("#/ayuda")) {
    $("[data-nav=help]")?.setAttribute("aria-current", "page");
    renderHelp();
  } else {
    $("[data-nav=explore]")?.setAttribute("aria-current", "page");
    renderExplore();
  }
}

// ---------- Explorar mercado ----------

function renderExplore() {
  destroyMap();
  const app = $("#app")!;
  const q = state.data?.parsed.raw ?? "";
  app.innerHTML = `<section class="view">
    <div class="eyebrow">Explorar mercado</div>
    <h1 class="hero">¿Qué oportunidad buscas?</h1>
    <form class="search" id="search-form" role="search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <label class="sr-only" for="q">Búsqueda</label>
      <input id="q" name="q" autocomplete="off" placeholder="Peluquerías en Lleida que necesitan automatización" value="${esc(q)}">
      <button class="btn btn-primary" type="submit" id="search-btn">Buscar</button>
    </form>
    <div class="chips">${EXAMPLES.map((e) => `<button type="button" class="chip" data-example="${esc(e)}">${esc(e)}</button>`).join("")}</div>
    <div id="results-area"></div>
  </section>`;

  $("#search-form")!.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = ($("#q") as HTMLInputElement).value.trim();
    if (v) search(v);
  });
  app.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((b) =>
    b.addEventListener("click", () => {
      ($("#q") as HTMLInputElement).value = b.dataset.example!;
      search(b.dataset.example!);
    }),
  );
  renderResultsArea();
}

async function search(q: string) {
  state.loading = true;
  state.error = null;
  state.activeId = null;
  renderResultsArea();
  const btn = $("#search-btn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    state.data = await api<SearchResponse>("/api/search", { q, limit: loadSettings().limit });
    state.analyses.clear();
    state.filters.minScore = 0;
    state.quick = "all";
    state.shown = 60;
    pushRecent(q);
    storage()?.setItem("oos-last", JSON.stringify(state.data));
  } catch (e) {
    state.error = e as ApiError;
    state.data = null;
  } finally {
    state.loading = false;
    if (btn) btn.disabled = false;
    renderResultsArea();
  }
}

function currentResult(r: SearchResult): { score: OpportunityScore; recommended: string; opportunities: Opportunity[]; analyzed: boolean } {
  const a = state.analyses.get(r.company.id);
  return a ? { score: a.score, recommended: a.recommended, opportunities: a.opportunities, analyzed: true } : { score: r.score, recommended: r.recommended, opportunities: r.opportunities, analyzed: false };
}

const systemOf = (r: SearchResult): string | null => {
  const a = state.analyses.get(r.company.id);
  return a ? (a.opportunities.find((o) => o.system)?.title ?? null) : (r.system ?? null);
};
const hasBookingGap = (r: SearchResult) => currentResult(r).opportunities.some((o) => o.id === "booking");
const fewReviews = (r: SearchResult) => r.company.reviews !== undefined && r.company.reviews < 25;
const matchesMine = (r: SearchResult, mine: Set<string>) => currentResult(r).opportunities.some((o) => mine.has(o.id));

function visibleResults(): SearchResult[] {
  if (!state.data) return [];
  const { minScore, opp, sort } = state.filters;
  const mine = myOppIds();
  const q = state.quick;
  const list = state.data.results.filter((r) => {
    const c = currentResult(r);
    if (c.score.score < minScore) return false;
    if (opp && !c.opportunities.some((o) => o.id === opp)) return false;
    if (q === "noweb" && r.company.website) return false;
    if (q === "system" && !systemOf(r)) return false;
    if (q === "nobooking" && !hasBookingGap(r)) return false;
    if (q === "fewreviews" && !fewReviews(r)) return false;
    if (q === "phone" && !r.company.phone) return false;
    if (q === "mine" && !matchesMine(r, mine)) return false;
    return true;
  });
  const byScore = (a: SearchResult, b: SearchResult) => currentResult(b).score.score - currentResult(a).score.score;
  return list.sort((a, b) => {
    if (sort === "name") return a.company.name.localeCompare(b.company.name, "es");
    if (sort === "reviews") return (b.company.reviews ?? -1) - (a.company.reviews ?? -1) || byScore(a, b);
    if (sort === "agency") {
      // Primero los que no tienen web (lo que más vende una agencia), luego los que tienen teléfono para llamar
      const w = Number(!!a.company.website) - Number(!!b.company.website);
      if (w) return w;
      const p = Number(!b.company.phone) - Number(!a.company.phone);
      if (p) return -p;
      return byScore(a, b);
    }
    return byScore(a, b);
  });
}

function renderResultsArea() {
  const area = $("#results-area");
  if (!area) return;
  if (state.loading) {
    area.innerHTML = `<div class="toolbar"><div class="summary">Buscando negocios en Google Maps y OpenStreetMap… (en zonas grandes puede tardar hasta 30 s)</div></div><div class="results">${'<div class="skeleton"></div>'.repeat(5)}</div>`;
    return;
  }
  if (state.error) {
    area.innerHTML = `<div style="margin-top:20px">${errorBox(state.error)}</div>`;
    return;
  }
  if (!state.data) {
    const recent = recentSearches();
    area.innerHTML = `
      ${recent.length ? `<div class="recent"><span class="muted">Búsquedas recientes:</span> ${recent.map((r) => `<button type="button" class="chip chip-soft" data-recent="${esc(r)}">${esc(r)}</button>`).join("")}</div>` : ""}
      <div class="features">
        <div class="feature"><span class="feature-n">1</span><h3>Encuentra</h3><p>Escribe tipo de negocio y zona: <b>«dentistas Lleida»</b>, <b>«restaurantes de Tenerife»</b>. Busca en Google Maps y OpenStreetMap a la vez.</p></div>
        <div class="feature"><span class="feature-n">2</span><h3>Prioriza</h3><p>Primero salen los negocios <b>sin web</b>. Cada uno tiene un score de 0 a 100 con los motivos: sin reservas, pocas reseñas, web lenta…</p></div>
        <div class="feature"><span class="feature-n">3</span><h3>Vende</h3><p>Abre el perfil y genera con IA la propuesta, el email, el WhatsApp o el guion de llamada con datos reales del negocio.</p></div>
      </div>`;
    area.querySelectorAll<HTMLButtonElement>("[data-recent]").forEach((b) =>
      b.addEventListener("click", () => {
        ($("#q") as HTMLInputElement).value = b.dataset.recent!;
        search(b.dataset.recent!);
      }),
    );
    return;
  }
  const d = state.data;
  const sectorsNote = d.parsed.sectorsFromIntent ? ` · sectores elegidos por la intención de la búsqueda` : "";
  const src = d.meta.source || d.meta.sources?.join(" + ") || "OpenStreetMap";
  const cost = d.meta.costUsd ? ` · ≈ ${d.meta.costUsd.toFixed(2)} US$ de Google (${d.meta.googleCalls} consultas)` : " · coste 0 €";
  const warn = (d.warnings ?? []).map((w) => `<div class="notice" style="margin-top:10px">${esc(w)}</div>`).join("");
  const all = d.results;
  const nNoWeb = all.filter((r) => !r.company.website).length;
  const nNoBooking = all.filter(hasBookingGap).length;
  const nSystem = all.filter((r) => !!systemOf(r)).length;
  const nFew = all.filter(fewReviews).length;
  const nPhone = all.filter((r) => !!r.company.phone).length;
  const mine = myOppIds();
  const nMine = all.filter((r) => matchesMine(r, mine)).length;
  const avg = all.length ? Math.round(all.reduce((x, r) => x + r.score.score, 0) / all.length) : 0;
  const stat = (key: QuickFilter, n: number, label: string, hint: string) =>
    `<button type="button" class="stat${state.quick === key ? " is-on" : ""}" data-quick="${key}" title="${esc(hint)}"><span class="stat-n">${n}</span><span class="stat-l">${label}</span></button>`;
  area.innerHTML = `
    <div class="stats" role="group" aria-label="Filtros rápidos">
      ${stat("all", all.length, "Negocios", "Ver todos")}
      ${stat("noweb", nNoWeb, "Sin web", "Negocios sin página web registrada")}
      ${stat("system", nSystem, "Falta un sistema", "Les falta un sistema de comunicación o de reservas: clientes que se quejan de que no cogen el teléfono, esperas, citas perdidas… El motivo de la llamada")}
      ${stat("nobooking", nNoBooking, "Sin reservas online", "Trabajan con citas y no tienen reserva online")}
      ${stat("fewreviews", nFew, "Pocas reseñas", "Menos de 25 reseñas en Google")}
      ${stat("phone", nPhone, "Con teléfono", "Se les puede llamar")}
      ${stat("mine", nMine, "Encajan contigo", "Tienen alguna oportunidad de los servicios que ofreces (Ajustes)")}
      <div class="stat stat-static"><span class="stat-n">${avg}</span><span class="stat-l">Score medio</span></div>
    </div>
    <div class="toolbar">
      <div class="summary"><strong>${d.results.length}</strong> empresas en <strong>${esc(d.area.label)}</strong>${sectorsNote} · fuente ${esc(src)}${cost}</div>
      <div class="filters">
        <label>Score mín. <input type="range" id="f-min" min="0" max="90" step="5" value="${state.filters.minScore}"> <span class="mono" id="f-min-v">${state.filters.minScore}</span></label>
        <label class="sr-only" for="f-opp">Oportunidad</label>
        <select id="f-opp">${OPP_FILTERS.map(([v, l]) => `<option value="${v}"${state.filters.opp === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <label class="sr-only" for="f-sort">Orden</label>
        <select id="f-sort">${(
          [
            ["agency", "Sin web primero"],
            ["score", "Mayor score"],
            ["reviews", "Más reseñas"],
            ["name", "Nombre"],
          ] as Array<[SortKey, string]>
        )
          .map(([v, l]) => `<option value="${v}"${state.filters.sort === v ? " selected" : ""}>${l}</option>`)
          .join("")}</select>
        <button class="btn btn-sm" id="batch-btn" type="button" title="Revisa la web de las 20 primeras con web registrada">Analizar top 20</button>
        <button class="btn btn-sm btn-ghost" id="csv-btn" type="button">Exportar CSV</button>
      </div>
    </div>
    ${warn}
    <div id="batch-progress"></div>
    <div class="split">
      <div class="results" id="results"></div>
      <div class="map-wrap"><div id="map"></div></div>
    </div>`;

  $("#f-min")!.addEventListener("input", (e) => {
    state.filters.minScore = Number((e.target as HTMLInputElement).value);
    $("#f-min-v")!.textContent = String(state.filters.minScore);
    renderCards();
  });
  $("#f-opp")!.addEventListener("change", (e) => {
    state.filters.opp = (e.target as HTMLSelectElement).value;
    renderCards();
  });
  $("#f-sort")!.addEventListener("change", (e) => {
    state.filters.sort = (e.target as HTMLSelectElement).value as SortKey;
    state.shown = 60;
    renderCards();
  });
  area.querySelectorAll<HTMLButtonElement>("[data-quick]").forEach((b) =>
    b.addEventListener("click", () => {
      state.quick = b.dataset.quick as QuickFilter;
      state.shown = 60;
      area.querySelectorAll(".stat").forEach((x) => x.classList.toggle("is-on", x === b));
      renderCards();
    }),
  );
  $("#batch-btn")!.addEventListener("click", batchAnalyze);
  $("#csv-btn")!.addEventListener("click", exportCsv);
  renderCards();
  initMap();
}

function presenceBadges(c: Company): string {
  const b = (on: boolean, label: string) => `<span class="badge ${on ? "on" : "off"}">${label}</span>`;
  const stars = c.rating !== undefined ? `<span class="badge on" title="Google Maps">${c.rating.toFixed(1)} ★ · ${c.reviews ?? 0}</span>` : "";
  return `<div class="presence">${b(!!c.website, "Web")}${b(!!c.phone, "Teléfono")}${b(!!(c.instagram || c.facebook), "Redes")}${b(!!c.openingHours, "Horario")}${c.whatsapp ? b(true, "WhatsApp") : ""}${stars}</div>`;
}

function cardHtml(r: SearchResult): string {
  const c = r.company;
  const cur = currentResult(r);
  const reasons = cur.score.items.filter((i) => i.dimension !== "Encaje del sector").slice(0, 2);
  const mine = myOppIds();
  const fit = cur.opportunities.find((o) => mine.has(o.id));
  const status = cur.analyzed
    ? `<span class="badge verified">Analizada</span>`
    : c.website
      ? `<span class="badge partial" title="El score mejora al revisar la web">Score provisional</span>`
      : "";
  return `<article class="card${state.activeId === c.id ? " is-active" : ""}" data-id="${esc(c.id)}">
    <div>
      <h3>${esc(c.name)}</h3>
      <div class="meta">${esc(c.sectorLabel)}${c.address ? ` · ${esc(c.address)}` : ""}${c.city ? ` · ${esc(c.city)}` : ""}${c.phone ? ` · <a href="tel:${esc(c.phone.replace(/\s/g, ""))}">${esc(c.phone)}</a>` : ""}</div>
      <div style="margin:6px 0">${presenceBadges(c)}</div>
      <div class="reco">Solución: <b>${esc(cur.recommended)}</b> ${status}</div>
      <div class="tags">${!c.website ? `<span class="tag tag-hot">Sin web · oportunidad directa</span>` : ""}${systemOf(r) ? `<span class="tag tag-sys">Falta: ${esc(systemOf(r)!)}</span>` : ""}${c.website && !systemOf(r) && fit ? `<span class="tag">Puedes ofrecer: ${esc(fit.title)}</span>` : ""}</div>
      ${c.complaints?.length ? `<div class="complaint">«${esc(c.complaints[0].quote.replace(/^…|…$/g, ""))}» <small>— reseña de Google</small></div>` : ""}
      <ul class="reasons">${reasons.map((i) => `<li>${esc(i.reason)}</li>`).join("")}</ul>
    </div>
    ${scoreRing(cur.score.score)}
    <div class="actions">
      ${c.website && !cur.analyzed ? `<button class="btn btn-sm btn-primary" data-analyze="${esc(c.id)}" type="button">Analizar oportunidad</button>` : ""}
      <a class="btn btn-sm" href="#/empresa/${encodeURIComponent(c.id)}">Ver perfil</a>
      ${c.website ? `<a class="btn btn-sm btn-ghost" href="${safeHref(c.website)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(c.website))} ↗</a>` : ""}
      ${c.googleMapsUri ? `<a class="btn btn-sm btn-ghost" href="${safeHref(c.googleMapsUri)}" target="_blank" rel="noopener noreferrer">Google Maps ↗</a>` : ""}
    </div>
  </article>`;
}

function renderCards() {
  const el = $("#results");
  if (!el) return;
  const list = visibleResults();
  const more = list.length > state.shown ? `<button class="btn more-btn" id="more-btn" type="button">Ver ${Math.min(60, list.length - state.shown)} más (${list.length - state.shown} restantes)</button>` : "";
  el.innerHTML = list.length ? list.slice(0, state.shown).map(cardHtml).join("") + more : `<div class="empty">Ninguna empresa cumple los filtros. ${state.data?.results.length ? "Baja el score mínimo o cambia la oportunidad." : "Prueba con otra zona o con otra forma de nombrar el sector."}</div>`;
  $("#more-btn")?.addEventListener("click", () => {
    state.shown += 60;
    renderCards();
  });
  el.querySelectorAll<HTMLButtonElement>("[data-analyze]").forEach((b) => b.addEventListener("click", () => analyzeOne(b.dataset.analyze!, b)));
  el.querySelectorAll<HTMLElement>(".card").forEach((card) =>
    card.addEventListener("mouseenter", () => {
      setActive(card.dataset.id!, false);
    }),
  );
  updateMarkers(list);
}

async function analyzeOne(id: string, btn?: HTMLButtonElement): Promise<void> {
  const r = state.data?.results.find((x) => x.company.id === id);
  if (!r) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Analizando…";
  }
  try {
    const { analysis } = await api<{ analysis: Analysis }>("/api/analyze", { company: r.company });
    state.analyses.set(id, analysis);
  } catch (e) {
    if (btn) {
      btn.textContent = "Reintentar";
      btn.disabled = false;
      btn.title = (e as Error).message;
    }
    throw e;
  }
  renderCards();
}

async function batchAnalyze() {
  if (!state.data || state.batch) return;
  const pending = visibleResults()
    .filter((r) => r.company.website && !state.analyses.has(r.company.id))
    .slice(0, 20);
  if (!pending.length) return;
  state.batch = { done: 0, total: pending.length };
  const prog = $("#batch-progress")!;
  const paint = () => (prog.innerHTML = state.batch ? `<div class="summary muted" style="font-size:13px">Revisando webs ${state.batch.done}/${state.batch.total}…</div><div class="progress"><div style="width:${(state.batch.done / state.batch.total) * 100}%"></div></div>` : "");
  paint();
  let failed = 0;
  const queue = [...pending];
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift()!;
      try {
        await analyzeOne(r.company.id);
      } catch {
        failed++;
      }
      state.batch!.done++;
      paint();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  state.batch = null;
  prog.innerHTML = failed ? `<div class="notice" style="margin-bottom:10px">${failed} webs no se pudieron revisar (sin respuesta o bloqueadas).</div>` : "";
}

function exportCsv() {
  const rows = visibleResults();
  const header = ["Nombre", "Sector", "Dirección", "Ciudad", "CP", "Teléfono", "Web", "Email", "Horario", "Instagram", "Facebook", "Valoración Google", "Reseñas", "Opportunity Score", "Analizada", "Solución recomendada", "Motivos", "Fuente"];
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // evita fórmulas al abrir en Excel
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = rows.map((r) => {
    const c = r.company;
    const cur = currentResult(r);
    return [c.name, c.sectorLabel, c.address, c.city, c.postcode, c.phone, c.website, c.email, c.openingHours, c.instagram, c.facebook, c.rating?.toFixed(1), c.reviews, cur.score.score, cur.analyzed ? "sí" : "no", cur.recommended, cur.score.items.map((i) => i.reason).join(" | "), c.sourceUrl].map(cell).join(";");
  });
  const blob = new Blob(["﻿" + [header.map(cell).join(";"), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `opportunityos-${(state.data?.area.label ?? "resultados").split(",")[0].toLowerCase().replace(/\s+/g, "-")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Mapa ----------
// Solo Google Maps. Estilos tipo iPhone (oscuro o claro) o Google clásico; pines con el score y agrupación.

declare const google: any;

let googleMapsPromise: Promise<boolean> | null = null;
let clustererPromise: Promise<boolean> | null = null;
let googleMapsFailed = false;

function loadScript(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve(true);
    el.onerror = () => resolve(false);
    document.head.appendChild(el);
  });
}

function loadGoogleMaps(key: string): Promise<boolean> {
  if (googleMapsPromise) return googleMapsPromise;
  googleMapsPromise = new Promise((resolve) => {
    (window as any).__oosMapsReady = () => resolve(true);
    // Google llama a esta función si la clave no vale o la API no está activada
    (window as any).gm_authFailure = () => {
      googleMapsFailed = true;
      state.map?.destroy();
      state.map = null;
      const el = $("#map");
      if (el) el.innerHTML = mapPlaceholder("Google no deja cargar el mapa con esta clave. Activa «Maps JavaScript API» en Google Cloud (misma clave) y recarga la página.");
    };
    loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=es&region=ES&loading=async&callback=__oosMapsReady`).then((ok) => {
      if (!ok) resolve(false);
    });
    setTimeout(() => resolve(false), 12000);
  });
  return googleMapsPromise;
}

function loadClusterer(): Promise<boolean> {
  clustererPromise ??= loadScript("https://unpkg.com/@googlemaps/markerclusterer@2.5.3/dist/index.min.js");
  return clustererPromise;
}

function mapPlaceholder(msg: string): string {
  return `<div class="map-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/></svg><p>${esc(msg)}</p><a class="btn btn-sm" href="#/ajustes">Ir a Ajustes</a></div>`;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#7c8594";
}
function scoreHex(v: number): string {
  return cssVar(v >= 70 ? "--high" : v >= 45 ? "--mid" : "--low");
}

/** Oscuro elegante, inspirado en el modo noche de Apple Maps */
const MAP_DARK = [
  { elementType: "geometry", stylers: [{ color: "#1c1c1e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#a1a1a6" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1c1c1e" }, { weight: 3 }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#3a3a3c" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#e5e5ea" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#202022" }] },
  { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: "#242426" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "poi.park", stylers: [{ visibility: "on" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1e2a22" }] },
  { featureType: "poi.park", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c2c2e" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8e8e93" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#3a3a3c" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#48484a" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#1c1c1e" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0b1e2e" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#4a6a85" }] },
];
/** Claro limpio, inspirado en Apple Maps de día */
const MAP_LIGHT = [
  { elementType: "geometry", stylers: [{ color: "#f5f3ef" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#5b5b60" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#ffffff" }, { weight: 3 }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "poi.park", stylers: [{ visibility: "on" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#dcecd5" }] },
  { featureType: "poi.park", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#fde7a6" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#f1cf6b" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#a9d3f2" }] },
];

function mapStyles(): any[] | null {
  const st = loadSettings().mapStyle;
  if (st === "google") return null;
  if (st === "dark") return MAP_DARK;
  if (st === "light") return MAP_LIGHT;
  return isDark() ? MAP_DARK : MAP_LIGHT; // "auto": sigue el tema de la app
}

/** Pin con el score dentro (SVG) */
function pinIcon(score: number, active: boolean, noWeb: boolean) {
  const color = scoreHex(score);
  const w = active ? 40 : 32;
  const h = Math.round(w * 1.25);
  const ring = noWeb ? `<circle cx="20" cy="18" r="16.5" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-dasharray="4 3"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 40 50"><path d="M20 49c-1.2 0-14-15.6-14-29a14 14 0 1 1 28 0c0 13.4-12.8 29-14 29Z" fill="rgba(0,0,0,.35)" transform="translate(0 1)"/><path d="M20 48C18.8 48 5 32.6 5 19a15 15 0 1 1 30 0c0 13.6-13.8 29-15 29Z" fill="${color}" stroke="#ffffff" stroke-width="2"/>${ring}<text x="20" y="23.5" text-anchor="middle" font-family="Inter Tight, Arial, sans-serif" font-size="13" font-weight="700" fill="#ffffff">${score}</text></svg>`;
  return { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, scaledSize: new google.maps.Size(w, h), anchor: new google.maps.Point(w / 2, h - 1) };
}

interface MapAdapter {
  setMarkers(list: SearchResult[]): void;
  highlight(id: string | null): void;
  applyTheme(): void;
  destroy(): void;
}

function destroyMap() {
  state.map?.destroy();
  state.map = null;
}

function applyMapTheme() {
  state.map?.applyTheme();
}

let mapToken = 0;
async function initMap() {
  const el = $("#map");
  if (!el || !state.data) return;
  const token = ++mapToken;
  destroyMap();
  await ensureConfig();
  if (token !== mapToken) return;
  const cfg = state.config;
  const key = cfg?.mapsKey;
  if (!key) {
    el.innerHTML = mapPlaceholder(
      cfg?.toggles && !cfg.toggles.googleMap
        ? "El mapa de Google está desconectado. Actívalo en Ajustes → Conexiones."
        : "Para ver el mapa de Google Maps añade GOOGLE_PLACES_API_KEY en Cloudflare (como Secreto) y activa «Maps JavaScript API» en Google Cloud.",
    );
    return;
  }
  if (googleMapsFailed) {
    el.innerHTML = mapPlaceholder("Google no deja cargar el mapa con esta clave. Activa «Maps JavaScript API» en Google Cloud (misma clave) y recarga la página.");
    return;
  }
  el.innerHTML = `<div class="map-loading">Cargando Google Maps…</div>`;
  const [ok] = await Promise.all([loadGoogleMaps(key), loadClusterer()]);
  if (token !== mapToken || !document.body.contains(el)) return;
  if (!ok || typeof google === "undefined" || !google.maps?.Map) {
    el.innerHTML = mapPlaceholder("No se ha podido cargar Google Maps. Revisa tu conexión y recarga la página.");
    return;
  }
  el.innerHTML = "";
  state.map = googleAdapter(el);
  state.map.setMarkers(visibleResults());
}

function googleAdapter(el: HTMLElement): MapAdapter {
  const [s, w, n, e] = state.data!.area.bbox;
  const map = new google.maps.Map(el, {
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true,
    clickableIcons: false,
    gestureHandling: "greedy",
    backgroundColor: isDark() ? "#1c1c1e" : "#f5f3ef",
    styles: mapStyles(),
  });
  map.fitBounds({ south: s, west: w, north: n, east: e }, 30);
  const info = new google.maps.InfoWindow();
  let markers = new Map<string, any>();
  const byId = new Map<string, SearchResult>();
  const MC = (window as any).markerClusterer?.MarkerClusterer;
  const clusterRenderer = {
    render({ count, position }: { count: number; position: any }) {
      const size = count < 10 ? 34 : count < 50 ? 40 : 48;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#0d1117" fill-opacity=".85" stroke="#2ee6a6" stroke-width="3"/><text x="24" y="29" text-anchor="middle" font-family="Inter Tight, Arial, sans-serif" font-size="15" font-weight="700" fill="#ffffff">${count}</text></svg>`;
      return new google.maps.Marker({ position, icon: { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, scaledSize: new google.maps.Size(size, size), anchor: new google.maps.Point(size / 2, size / 2) }, zIndex: 1000 + count });
    },
  };
  let clusterer: any = MC ? new MC({ map, markers: [], renderer: clusterRenderer }) : null;
  const iconFor = (r: SearchResult, active: boolean) => pinIcon(currentResult(r).score.score, active, !r.company.website);
  return {
    setMarkers(list) {
      clusterer?.clearMarkers();
      markers.forEach((m) => m.setMap(null));
      markers = new Map();
      byId.clear();
      const all: any[] = [];
      for (const r of list) {
        byId.set(r.company.id, r);
        const active = state.activeId === r.company.id;
        const m = new google.maps.Marker({ position: { lat: r.company.lat, lng: r.company.lon }, map: clusterer ? null : map, title: r.company.name, icon: iconFor(r, active), zIndex: active ? 999 : 1 });
        m.addListener("click", () => {
          setActive(r.company.id, true);
          const c = r.company;
          const cur = currentResult(r);
          info.setContent(`<div class="iw"><strong>${esc(c.name)}</strong><div>${esc(c.sectorLabel)} · score ${cur.score.score}</div>${c.rating !== undefined ? `<div>${c.rating.toFixed(1)} ★ · ${c.reviews ?? 0} reseñas</div>` : ""}<div>${c.website ? "Tiene web" : "<b>Sin web</b>"}${c.phone ? ` · ${esc(c.phone)}` : ""}</div>${r.system ? `<div class="iw-sys">Falta: ${esc(r.system)}</div>` : ""}<a href="#/empresa/${encodeURIComponent(c.id)}">Ver perfil →</a></div>`);
          info.open({ anchor: m, map });
        });
        markers.set(r.company.id, m);
        all.push(m);
      }
      clusterer?.addMarkers(all);
    },
    highlight(id) {
      markers.forEach((m, mid) => {
        const r = byId.get(mid);
        if (!r) return;
        m.setIcon(iconFor(r, mid === id));
        m.setZIndex(mid === id ? 999 : 1);
      });
      const m = id ? markers.get(id) : null;
      if (m && clusterer) {
        // Si el pin está dentro de un grupo, acerca el mapa para verlo
        const pos = m.getPosition();
        if (pos && !map.getBounds()?.contains(pos)) map.panTo(pos);
      }
    },
    applyTheme() {
      map.setOptions({ styles: mapStyles(), backgroundColor: isDark() ? "#1c1c1e" : "#f5f3ef" });
    },
    destroy() {
      clusterer?.clearMarkers();
      clusterer = null;
      markers.forEach((m) => m.setMap(null));
      markers.clear();
      info.close();
    },
  };
}

function updateMarkers(list: SearchResult[]) {
  state.map?.setMarkers(list);
}

function setActive(id: string, scrollCard: boolean) {
  if (state.activeId === id) return;
  state.activeId = id;
  document.querySelectorAll(".card.is-active").forEach((c) => c.classList.remove("is-active"));
  const card = document.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(id)}"]`);
  card?.classList.add("is-active");
  if (scrollCard) card?.scrollIntoView({ behavior: "smooth", block: "center" });
  state.map?.highlight(id);
}

// ---------- Perfil de empresa ----------

function findCompany(id: string): SearchResult | undefined {
  if (!state.data) {
    const raw = storage()?.getItem("oos-last");
    if (raw) {
      try {
        state.data = JSON.parse(raw);
      } catch {}
    }
  }
  return state.data?.results.find((r) => r.company.id === id);
}

async function renderProfile(id: string) {
  destroyMap();
  const app = $("#app")!;
  const r = findCompany(id);
  if (!r) {
    app.innerHTML = `<section class="view"><a class="back" href="#/">← Explorar mercado</a><div class="empty">Esta empresa no está en la búsqueda actual. Vuelve a buscar para abrir su perfil.</div></section>`;
    return;
  }
  const c = r.company;
  let analysis = state.analyses.get(id);
  app.innerHTML = `<section class="view"><a class="back" href="#/">← Volver a resultados</a><div id="profile">${profileHtml(c, analysis ?? null, r)}</div></section>`;
  bindProfile(c);
  if (!analysis) {
    try {
      analysis = (await api<{ analysis: Analysis }>("/api/analyze", { company: c })).analysis;
      state.analyses.set(id, analysis);
      if (location.hash === `#/empresa/${encodeURIComponent(id)}`) {
        $("#profile")!.innerHTML = profileHtml(c, analysis, r);
        bindProfile(c);
      }
    } catch (e) {
      $("#analysis-status")!.innerHTML = errorBox(e as ApiError);
    }
  }
}

function signalRow(s: Signal): string {
  return `<li><span>${esc(s.label)}${s.evidence ? ` <small>${esc(s.evidence)}</small>` : ""}</span><span class="badge ${s.confidence === "verificado" ? "verified" : "inferred"}" title="Fuente: ${esc(s.source)}">${s.confidence}</span></li>`;
}

function profileHtml(c: Company, a: Analysis | null, r: SearchResult): string {
  const score = a?.score ?? r.score;
  const recommended = a?.recommended ?? r.recommended;
  const audit = a?.audit;
  const loadingNote = !a ? `<div id="analysis-status" class="notice" style="margin-top:16px">${c.website ? "Revisando su web…" : "Calculando análisis…"}</div>` : `<div id="analysis-status"></div>`;

  const dims = Object.entries(score.byDimension)
    .map(([d, v]) => {
      const max = { "Presencia digital": 35, "Reservas y automatización": 30, "Atención al cliente": 15, "Potencial comercial": 10, "Encaje del sector": 10 }[d] ?? 10;
      return `<div class="dim"><span>${esc(d)}</span><div class="bar"><div style="width:${(v / max) * 100}%"></div></div><span class="val">${v}/${max}</span></div>`;
    })
    .join("");
  const reasons = score.items
    .map((i) => `<li><span class="pts">+${i.points}</span><span>${esc(i.reason)}</span><span class="badge ${i.confidence === "verificado" ? "verified" : "inferred"}">${i.confidence}</span></li>`)
    .join("");
  const opps = (a?.opportunities ?? r.opportunities)
    .map((o) => `<div class="opp ${o.priority}"><h3><span class="prio ${o.priority}">${o.priority}</span>${esc(o.title)}</h3><p><b>Problema:</b> ${esc(o.problem)}</p><p><b>Solución:</b> ${esc(o.solution)}</p></div>`)
    .join("");

  const auditHtml = !c.website
    ? `<p class="muted">No se ha encontrado web en ${c.source === "Google" ? "su ficha de Google Maps" : "OpenStreetMap"}. Puede tenerla igualmente.</p>`
    : !audit
      ? `<p class="muted">Pendiente de revisar.</p>`
      : audit.blockedByRobots
        ? `<p class="muted">La web pide no ser analizada automáticamente (robots.txt). Se respeta.</p>`
        : !audit.reachable
          ? `<p>${esc(audit.error ?? "La web no responde")}</p>`
          : `<dl class="kv">
            <dt>Web</dt><dd><a href="${safeHref(audit.finalUrl ?? audit.url)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(audit.finalUrl ?? audit.url))}</a>${audit.title ? ` · ${esc(audit.title)}` : ""}</dd>
            <dt>HTTPS</dt><dd>${audit.https ? "Sí" : "No"}</dd>
            <dt>Móvil</dt><dd>${audit.viewport ? "Adaptada (meta viewport)" : "No adaptada"}</dd>
            <dt>Respuesta</dt><dd class="mono">${((audit.responseMs ?? 0) / 1000).toFixed(1)} s · ${audit.htmlKb ?? "?"} KB</dd>
            <dt>Reservas online</dt><dd>${audit.bookingProviders.length ? esc(audit.bookingProviders.join(", ")) : "No detectadas"}</dd>
            <dt>Chat / asistente</dt><dd>${audit.chatWidgets.length ? esc(audit.chatWidgets.join(", ")) : "No detectado"}</dd>
            <dt>WhatsApp</dt><dd>${audit.whatsappLink ? "Enlace directo" : "No enlazado"}</dd>
            <dt>Llamadas a la acción</dt><dd>${audit.ctas.length ? esc(audit.ctas.join(", ")) : "Ninguna detectada"}</dd>
            <dt>Formularios</dt><dd>${audit.forms ?? 0}</dd>
            <dt>SEO básico</dt><dd>${[audit.metaDescription ? "meta descripción" : null, audit.h1 ? "H1" : null, audit.schemaLocalBusiness ? "datos estructurados" : null].filter(Boolean).join(", ") || "Faltan meta descripción, H1 y datos estructurados"}</dd>
            <dt>Redes enlazadas</dt><dd>${audit.socials.length ? esc(audit.socials.join(", ")) : "Ninguna"}</dd>
            ${audit.copyrightYear ? `<dt>Año en el pie</dt><dd>${audit.copyrightYear}</dd>` : ""}
            ${audit.generator ? `<dt>Tecnología</dt><dd>${esc(audit.generator)}</dd>` : ""}
            <dt>Revisada</dt><dd>${new Date(audit.auditedAt).toLocaleString("es-ES")}</dd>
          </dl>`;

  return `
  <div class="profile-head">
    <div>
      <div class="eyebrow">${esc(c.sectorLabel)}</div>
      <h1>${esc(c.name)}</h1>
      <div class="muted">${[c.address, c.postcode, c.city].filter(Boolean).map(esc).join(" · ") || "Dirección no disponible"}</div>
      <div class="recommend">Solución recomendada: <b>${esc(recommended)}</b></div>
    </div>
    <div style="display:flex;align-items:center;gap:14px">${score.partial ? `<span class="badge partial">Provisional</span>` : ""}${scoreRing(score.score, true)}</div>
  </div>
  ${loadingNote}
  <div class="grid-2">
    <div>
      <div class="panel"><h2>Por qué este score</h2><div class="dims">${dims}</div><ul class="reason-list">${reasons}</ul></div>
      <div class="panel"><h2>Oportunidades detectadas</h2><div class="opps">${opps || `<p class="muted">Sin oportunidades claras con los datos disponibles.</p>`}</div></div>
      <div class="panel" id="gen-panel"><h2>Acción comercial</h2>
        <p class="muted" style="margin:0 0 10px;font-size:13px">Elige qué quieres preparar y la IA lo escribe con los datos reales de este negocio, firmado por <b>${esc(loadSettings().senderName)}</b> de <b>${esc(loadSettings().agencyName)}</b>. Puedes editar el texto antes de copiarlo o enviarlo.</p>
        <div class="tabs" role="tablist">${(["propuesta", "email", "whatsapp", "linkedin", "llamada"] as const).map((k, i) => `<button class="tab" role="tab" data-kind="${k}" aria-selected="${i === 0}">${{ propuesta: "Propuesta", email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn", llamada: "Guion de llamada" }[k]}</button>`).join("")}</div>
        <div class="gen-bar"><button class="btn btn-primary btn-sm" id="gen-btn" type="button">Generar con IA</button><span class="muted" id="gen-meta" style="font-size:12px"></span></div>
        <textarea class="output" id="gen-out" rows="10" placeholder="Pulsa «Generar con IA». El texto se basa solo en lo que se ha detectado de este negocio." aria-label="Texto generado (editable)"></textarea>
        <div class="gen-actions" id="gen-actions" hidden>
          <button class="btn btn-sm" id="copy-btn" type="button">Copiar</button>
          <a class="btn btn-sm" id="send-wa" target="_blank" rel="noopener noreferrer" hidden>Abrir en WhatsApp</a>
          <a class="btn btn-sm" id="send-mail" hidden>Abrir en el correo</a>
          <a class="btn btn-sm" id="send-call" hidden>Llamar</a>
        </div>
        <p class="legal" id="gen-legal"></p>
      </div>
    </div>
    <div>
      <div class="panel"><h2>Información</h2><dl class="kv">
        <dt>Teléfono</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s/g, ""))}">${esc(c.phone)}</a>` : "No publicado"}</dd>
        <dt>Web</dt><dd>${c.website ? `<a href="${safeHref(c.website)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(c.website))}</a>` : "No encontrada"}</dd>
        <dt>Email</dt><dd>${esc(c.email ?? audit?.publicEmails.join(", ") ?? "") || "No publicado"}</dd>
        <dt>Horario</dt><dd>${esc(c.openingHours ?? "") || "No publicado"}</dd>
        <dt>Redes</dt><dd>${[c.instagram && `<a href="${safeHref(c.instagram)}" target="_blank" rel="noopener noreferrer">Instagram</a>`, c.facebook && `<a href="${safeHref(c.facebook)}" target="_blank" rel="noopener noreferrer">Facebook</a>`].filter(Boolean).join(" · ") || "No registradas"}</dd>
        <dt>Coordenadas</dt><dd class="mono">${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</dd>
        ${c.rating !== undefined ? `<dt>Google</dt><dd><span class="stars">${c.rating.toFixed(1)}</span> · ${c.reviews ?? 0} reseñas</dd>` : ""}
        <dt>Fuente</dt><dd><a href="${safeHref(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${c.source === "Google" ? "Google Maps" : "OpenStreetMap"}</a>${c.source === "Google" ? "" : " (ODbL)"}${c.alsoIn ? ` · también en ${esc(c.alsoIn)}` : ""}</dd>
      </dl></div>
      <div class="panel"><h2>Presencia digital</h2>${auditHtml}</div>
      <div class="panel" id="google-panel"><h2>Ficha de Google</h2>
        <p class="muted" style="margin:0 0 10px">Valoración, reseñas y horario en vivo. No se guarda (términos de Google). Coste aprox. 0,035 US$ por consulta; las primeras 1.000 al mes son gratis.</p>
        <button class="btn btn-sm" id="google-btn" type="button">${c.source === "Google" ? "Ver horario y estado en Google" : "Cargar ficha de Google"}</button><div id="google-out"></div>
      </div>
      <div class="panel"><h2>Señales</h2><ul class="signals">${(a?.signals ?? []).map(signalRow).join("") || `<li class="muted">Calculando…</li>`}</ul></div>
    </div>
  </div>`;
}

function waNumber(phone?: string): string | null {
  if (!phone) return null;
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (/^[6-9]\d{8}$/.test(d)) d = "34" + d;
  return /^\d{9,15}$/.test(d) ? d : null;
}

function bindProfile(c: Company) {
  let kind = "propuesta";
  const texts = new Map<string, string>();
  const out = () => $("#gen-out") as HTMLTextAreaElement;
  const email = c.email ?? state.analyses.get(c.id)?.audit?.publicEmails[0];
  const paintActions = () => {
    const text = out().value.trim();
    $("#gen-actions")!.hidden = !text;
    const wa = $("#send-wa") as HTMLAnchorElement;
    const mail = $("#send-mail") as HTMLAnchorElement;
    const call = $("#send-call") as HTMLAnchorElement;
    const num = waNumber(c.phone);
    wa.hidden = !(kind === "whatsapp" && num);
    if (num) wa.href = `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
    mail.hidden = kind !== "email";
    if (kind === "email") {
      const m = text.match(/^\s*asunto:\s*(.+)$/im);
      const subject = m ? m[1].trim() : `Propuesta para ${c.name}`;
      const body = m ? text.replace(m[0], "").trim() : text;
      mail.href = `mailto:${encodeURIComponent(email ?? "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      mail.textContent = email ? `Abrir en el correo (${email})` : "Abrir en el correo";
    }
    call.hidden = !(kind === "llamada" && c.phone);
    if (c.phone) call.href = `tel:${c.phone.replace(/\s/g, "")}`;
  };
  const legal = () => {
    $("#gen-legal")!.textContent =
      kind === "email" || kind === "whatsapp"
        ? "Aviso legal (LSSI art. 21): no envíes este mensaje por email o WhatsApp a quien no te lo haya pedido o autorizado. Úsalo tras un primer contacto por teléfono o en persona, o si ya existe relación."
        : "";
  };
  const generate = async () => {
    const btn = $("#gen-btn") as HTMLButtonElement;
    const k = kind;
    btn.disabled = true;
    btn.textContent = "Generando…";
    out().value = "";
    out().placeholder = "Escribiendo a partir de lo que se ha detectado de este negocio…";
    try {
      const st = loadSettings();
      const res = await api<{ text: string; meta: { model: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number | null } }>("/api/generate", { kind: k, company: c, agencyName: st.agencyName, senderName: st.senderName });
      texts.set(k, res.text);
      if (kind === k) {
        out().value = res.text;
        $("#gen-meta")!.textContent = res.meta.estimatedCostUsd ? `≈ ${res.meta.estimatedCostUsd.toFixed(4)} US$` : "IA gratuita";
      }
    } catch (e) {
      out().placeholder = (e as Error).message;
    } finally {
      btn.disabled = false;
      btn.textContent = texts.has(kind) ? "Regenerar" : "Generar con IA";
      paintActions();
    }
  };
  legal();
  document.querySelectorAll<HTMLButtonElement>("#gen-panel .tab").forEach((t) =>
    t.addEventListener("click", () => {
      texts.set(kind, out().value);
      kind = t.dataset.kind!;
      document.querySelectorAll("#gen-panel .tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
      legal();
      const prev = texts.get(kind);
      out().value = prev ?? "";
      ($("#gen-btn") as HTMLButtonElement).textContent = prev ? "Regenerar" : "Generar con IA";
      paintActions();
      // Al cambiar de pestaña, si aún no hay texto, se genera solo
      if (!prev && texts.size > 0) generate();
    }),
  );
  $("#gen-btn")?.addEventListener("click", generate);
  $("#gen-out")?.addEventListener("input", paintActions);
  $("#copy-btn")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(out().value);
      $("#copy-btn")!.textContent = "Copiado ✓";
      setTimeout(() => ($("#copy-btn")!.textContent = "Copiar"), 1500);
    } catch {}
  });
  $("#google-btn")?.addEventListener("click", async () => {
    const btn = $("#google-btn") as HTMLButtonElement;
    const out = $("#google-out")!;
    btn.disabled = true;
    try {
      const { place } = await api<{ place: null | { name?: string; rating?: number; userRatingCount?: number; googleMapsUri?: string; websiteUri?: string; phone?: string; businessStatus?: string; weekdayHours?: string[] } }>("/api/google", { name: c.name, city: c.city, lat: c.lat, lon: c.lon });
      if (!place) out.innerHTML = `<p class="muted">Google no devuelve una ficha para este negocio.</p>`;
      else
        out.innerHTML = `<dl class="kv" style="margin-top:12px">
          <dt>Nombre</dt><dd>${esc(place.name)}</dd>
          <dt>Valoración</dt><dd>${place.rating ? `<span class="stars">${place.rating.toFixed(1)}</span> · ${place.userRatingCount ?? 0} reseñas` : "Sin valoraciones"}</dd>
          ${place.websiteUri ? `<dt>Web (Google)</dt><dd><a href="${safeHref(place.websiteUri)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(place.websiteUri))}</a></dd>` : ""}
          ${place.phone ? `<dt>Teléfono</dt><dd>${esc(place.phone)}</dd>` : ""}
          ${place.businessStatus && place.businessStatus !== "OPERATIONAL" ? `<dt>Estado</dt><dd>${esc(place.businessStatus)}</dd>` : ""}
          ${place.weekdayHours?.length ? `<dt>Horario</dt><dd>${place.weekdayHours.map(esc).join("<br>")}</dd>` : ""}
        </dl>${place.googleMapsUri ? `<p><a href="${safeHref(place.googleMapsUri)}" target="_blank" rel="noopener noreferrer">Ver en Google Maps ↗</a></p>` : ""}<div class="google-attr">Datos de Google</div>`;
      btn.hidden = true;
    } catch (e) {
      out.innerHTML = `<div style="margin-top:10px">${errorBox(e as ApiError)}</div>`;
      btn.disabled = false;
    }
  });
}

// ---------- Ajustes ----------

let configPromise: Promise<AppConfig | null> | null = null;
function ensureConfig(): Promise<AppConfig | null> {
  if (state.config) return Promise.resolve(state.config);
  configPromise ??= api<AppConfig>("/api/config")
    .then((c) => (state.config = c))
    .catch(() => null)
    .finally(() => (configPromise = null));
  return configPromise;
}

async function renderSettings() {
  destroyMap();
  const app = $("#app")!;
  const st = loadSettings();
  app.innerHTML = `<section class="view narrow">
    <div class="eyebrow">Ajustes</div><h1 class="hero">Configura tu OpportunityOS</h1>
    <form class="panel" id="settings-form">
      <h2>Tu agencia</h2>
      <div class="field-row">
        <label class="field"><span>Nombre de tu agencia (firma de los textos)</span><input name="agencyName" value="${esc(st.agencyName)}" maxlength="60"></label>
        <label class="field"><span>Tu nombre</span><input name="senderName" value="${esc(st.senderName)}" maxlength="60"></label>
      </div>
      <p class="muted" style="margin:14px 0 8px">Servicios que ofreces: los negocios que los necesitan se marcan con «Puedes ofrecer» y aparecen en el filtro «Encajan contigo».</p>
      <div class="checks">${SERVICES.map(([id, label]) => `<label class="check"><input type="checkbox" name="svc" value="${id}"${st.services.includes(id) ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}</div>
      <h2 style="margin-top:22px">Búsqueda</h2>
      <div class="field-row">
        <label class="field"><span>Orden por defecto</span><select name="sort">${(
          [
            ["agency", "Sin web primero"],
            ["score", "Mayor score"],
            ["reviews", "Más reseñas"],
            ["name", "Nombre"],
          ] as Array<[SortKey, string]>
        )
          .map(([v, l]) => `<option value="${v}"${st.sort === v ? " selected" : ""}>${l}</option>`)
          .join("")}</select></label>
        <label class="field"><span>Resultados por búsqueda</span><select name="limit">${[100, 200, 300, 500].map((n) => `<option value="${n}"${st.limit === n ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      </div>
      <h2 style="margin-top:22px">Mapa</h2>
      <div class="map-styles">${(
        [
          ["dark", "Oscuro", "Estilo iPhone de noche"],
          ["light", "Claro", "Estilo iPhone de día"],
          ["auto", "Automático", "Sigue el tema de la app"],
          ["google", "Google clásico", "El de siempre"],
        ] as Array<[MapStyle, string, string]>
      )
        .map(([v, l, d]) => `<label class="map-style ms-${v}"><input type="radio" name="mapStyle" value="${v}"${st.mapStyle === v ? " checked" : ""}><span class="ms-swatch"></span><strong>${l}</strong><small>${d}</small></label>`)
        .join("")}</div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:16px"><button class="btn btn-primary" type="submit">Guardar ajustes</button><span class="muted" id="settings-saved" aria-live="polite"></span></div>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">Se guardan en este navegador.</p>
    </form>
    <div class="panel"><h2>Conexiones</h2><div id="cfg"><div class="skeleton"></div></div></div>
  </section>`;
  $("#settings-form")!.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    const next: Settings = {
      agencyName: String(f.get("agencyName") ?? "").trim() || DEFAULT_SETTINGS.agencyName,
      senderName: String(f.get("senderName") ?? "").trim() || DEFAULT_SETTINGS.senderName,
      mapStyle: (String(f.get("mapStyle") ?? "dark") as MapStyle) || "dark",
      services: f.getAll("svc").map(String),
      sort: String(f.get("sort")) as SortKey,
      limit: Number(f.get("limit")) || 300,
    };
    saveSettings(next);
    state.filters.sort = next.sort;
    $("#settings-saved")!.textContent = "Guardado ✓";
    setTimeout(() => ($("#settings-saved")!.textContent = ""), 2000);
  });
  try {
    state.config = null;
    const cfg = (await ensureConfig())!;
    if (!cfg) throw new Error("No se pudo leer la configuración");
    const i = cfg.integrations;
    const t: Toggles = cfg.toggles ?? { googleSearch: true, googleMap: true, osm: true, ai: true };
    const sw = (key: keyof Toggles | null, on: boolean, ready: boolean, name: string, desc: string, missing: string) => `<li>
        <div><span class="dot${on && ready ? " ok" : ""}"></span><strong>${name}</strong><div class="muted" style="font-size:13px;margin-left:16px">${desc}</div>${!ready && missing ? `<div class="warn-line">Falta <code class="mono">${missing}</code> en Cloudflare (como Secreto)</div>` : ""}</div>
        ${key ? `<label class="switch" title="${on ? "Desconectar" : "Conectar"}"><input type="checkbox" data-toggle="${key}"${on ? " checked" : ""}${cfg.canToggle ? "" : " disabled"}><span></span><em>${on ? "Conectado" : "Desconectado"}</em></label>` : `<span class="muted" style="font-size:12.5px">${ready ? "Conectado" : "—"}</span>`}
      </li>`;
    $("#cfg")!.innerHTML = `<ul class="status-list">
      ${sw("googleSearch", t.googleSearch, i.googlePlaces, "Google Maps · búsqueda", `Fuente principal: prácticamente todos los negocios, con teléfono, web, valoración y reseñas (también detecta quejas). Hasta ${i.googleMaxCalls ?? 12} consultas por búsqueda; 1.000 gratis al mes.`, "GOOGLE_PLACES_API_KEY")}
      ${sw("googleMap", t.googleMap, !!i.googleMaps && !googleMapsFailed, "Google Maps · mapa", googleMapsFailed ? "La clave no tiene activada «Maps JavaScript API». Actívala en Google Cloud (misma clave) y recarga." : "Mapa de los resultados (10.000 cargas gratis al mes).", "GOOGLE_PLACES_API_KEY")}
      ${sw("osm", t.osm, true, "OpenStreetMap · búsqueda", "Datos gratis que completan los de Google (email, redes) y añaden negocios que Google no devuelve.", "")}
      ${sw("ai", t.ai, i.ai, `IA${i.aiProvider ? ` · ${esc(i.aiProvider)}` : ""}`, i.aiFree ? "Asistente y textos comerciales. IA gratuita de Cloudflare con límite diario; con ANTHROPIC_API_KEY usa Claude." : "Asistente y textos comerciales.", "ANTHROPIC_API_KEY")}
      ${sw(null, !!i.contactEmail, !!i.contactEmail, "Email de contacto (opcional)", "Recomendado por la política de uso de OpenStreetMap. Sin él, la búsqueda funciona igual.", "CONTACT_EMAIL")}
    </ul>${cfg.canToggle ? "" : `<p class="warn-line">Los interruptores se activan al publicar esta versión (falta el almacén de ajustes).</p>`}<p class="muted" style="margin-top:14px;font-size:13px">Las claves se añaden en Cloudflare → Workers → opportunity-os → Settings → Variables and Secrets, siempre como <b>Secreto</b>. Reglas del Opportunity Engine: versión <span class="mono">${esc(cfg.rulesVersion)}</span>.</p>`;
    $("#cfg")!.querySelectorAll<HTMLInputElement>("[data-toggle]").forEach((inp) =>
      inp.addEventListener("change", async () => {
        inp.disabled = true;
        try {
          const res = await api<{ toggles: Toggles }>("/api/admin/toggles", { [inp.dataset.toggle!]: inp.checked });
          const cfg2 = await (async () => {
            state.config = null;
            return ensureConfig();
          })();
          if (cfg2) cfg2.toggles = res.toggles;
          googleMapsFailed = false;
          renderSettings();
        } catch (e) {
          inp.checked = !inp.checked;
          inp.disabled = false;
          alertBox(e as ApiError);
        }
      }),
    );
  } catch (e) {
    $("#cfg")!.innerHTML = errorBox(e as ApiError);
  }
}

function alertBox(e: ApiError) {
  const c = $("#cfg");
  if (c) c.insertAdjacentHTML("afterbegin", errorBox(e));
}

// ---------- Ayuda y contacto ----------

async function renderHelp() {
  destroyMap();
  const app = $("#app")!;
  const cfg = await ensureConfig();
  const c = cfg?.contact ?? { company: "ZYRA", web: "https://digitalzyra.com", contactPage: "https://digitalzyra.com/es-es/contacto/", email: "zyradigitalpersonal@gmail.com", phone: "+34 643 41 24 54", whatsapp: "https://wa.me/34643412454", instagram: "https://www.instagram.com/zyra_personal", linkedin: "https://www.linkedin.com/in/digital-zyra-730293439", tiktok: "https://www.tiktok.com/@digitalzyra" };
  const faq: Array<[string, string]> = [
    ["¿Cómo busco?", "Escribe el tipo de negocio y la zona como te salga: «dentistas Lleida», «restaurantes de Tenerife», «peluquerías en La Laguna sin web». Puedes añadir «sin web» o «sin reservas» para filtrar."],
    ["¿Qué es el Opportunity Score?", "Un número de 0 a 100: cuanto más alto, más le falta digitalizar a ese negocio. Cada punto tiene su motivo y se marca como verificado (dato real) o inferido (típico del sector)."],
    ["¿Por qué salen primero los que no tienen web?", "Es la venta más directa para una agencia. Puedes cambiar el orden en la barra de resultados o en Ajustes."],
    ["¿Cuánto cuesta cada búsqueda?", "OpenStreetMap y la IA gratuita no cuestan nada. Google: 1.000 consultas gratis al mes (cada una trae hasta 20 negocios); la app te enseña el coste de cada búsqueda."],
    ["¿Puedo enviar los emails que genera?", "La app redacta, no envía. Por ley (LSSI art. 21) no se deben enviar emails o WhatsApp comerciales sin permiso: úsalos después de un primer contacto por teléfono o en persona."],
  ];
  app.innerHTML = `<section class="view narrow">
    <div class="eyebrow">Ayuda y contacto</div><h1 class="hero">¿En qué te ayudamos?</h1>
    <div class="help-hero panel">
      <div><h2>Asistente de OpportunityOS</h2><p class="muted" style="margin:0">Pregúntale cómo usar el programa, qué significa cada dato o cómo preparar una llamada.</p></div>
      <button class="btn btn-primary" type="button" data-open-assistant>Abrir asistente</button>
    </div>
    <div class="panel"><h2>Contacta con ${esc(c.company)}</h2>
      <div class="contact-grid">
        <a class="contact" href="mailto:${esc(c.email)}"><span class="contact-l">Email</span><strong>${esc(c.email)}</strong></a>
        <a class="contact" href="${safeHref(c.whatsapp)}" target="_blank" rel="noopener noreferrer"><span class="contact-l">WhatsApp</span><strong>${esc(c.phone)}</strong></a>
        <a class="contact" href="tel:${esc(c.phone.replace(/\s/g, ""))}"><span class="contact-l">Teléfono</span><strong>${esc(c.phone)}</strong></a>
        <a class="contact" href="${safeHref(c.contactPage)}" target="_blank" rel="noopener noreferrer"><span class="contact-l">Web</span><strong>${esc(hostOf(c.web))}</strong></a>
      </div>
      <p class="socials"><a href="${safeHref(c.instagram)}" target="_blank" rel="noopener noreferrer">Instagram</a> · <a href="${safeHref(c.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a> · <a href="${safeHref(c.tiktok)}" target="_blank" rel="noopener noreferrer">TikTok</a></p>
    </div>
    <div class="panel"><h2>Preguntas frecuentes</h2>${faq.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>
  </section>`;
  bindAssistantOpeners(app);
}

// ---------- Asistente ----------

function assistantSuggestions(): string[] {
  if (location.hash.startsWith("#/empresa/")) return ["¿Qué le ofrezco a este negocio?", "Escríbeme un guion de llamada", "¿Qué objeciones puede poner?", "Resúmeme sus puntos débiles"];
  if (state.data) return ["¿A cuáles llamo primero?", "¿Qué les vendo a los que no tienen web?", "¿Qué significa «Falta un sistema»?", "Escribe un WhatsApp para el primero"];
  return ["¿Cómo encuentro negocios sin web?", "¿Qué significa el score?", "¿Cuánto me cuesta Google?", "¿Cómo preparo una llamada de venta?"];
}

function renderAssistantLog() {
  const log = $("#assistant-log");
  if (!log) return;
  const fmt = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
  log.innerHTML =
    (state.chat.length ? "" : `<div class="msg msg-a">¡Hola! Soy el asistente de OpportunityOS. Pregúntame cómo buscar negocios, qué significa cada dato o cómo preparar una propuesta.</div>`) +
    state.chat.map((m) => `<div class="msg ${m.role === "user" ? "msg-u" : "msg-a"}">${fmt(m.content)}</div>`).join("") +
    (state.chatBusy ? `<div class="msg msg-a msg-typing"><span></span><span></span><span></span></div>` : "");
  log.scrollTop = log.scrollHeight;
  const sug = $("#assistant-suggest");
  if (sug) sug.innerHTML = state.chat.length ? "" : assistantSuggestions().map((q) => `<button type="button" class="chip chip-soft" data-ask="${esc(q)}">${esc(q)}</button>`).join("");
  sug?.querySelectorAll<HTMLButtonElement>("[data-ask]").forEach((b) => b.addEventListener("click", () => askAssistant(b.dataset.ask!)));
}

/** Lo que el usuario está viendo, para que el asistente responda sobre ello */
function screenContext(): string {
  const h = location.hash;
  const mine = SERVICES.filter(([id]) => loadSettings().services.includes(id)).map(([, l]) => l).join(", ");
  const lines: string[] = [`Servicios que ofrece la agencia: ${mine || "(sin indicar)"}.`];
  if (h.startsWith("#/empresa/")) {
    const id = decodeURIComponent(h.slice("#/empresa/".length));
    const r = findCompany(id);
    if (r) {
      const c = r.company;
      const a = state.analyses.get(id);
      const cur = currentResult(r);
      lines.push(`Pantalla: perfil del negocio «${c.name}» (${c.sectorLabel}${c.city ? `, ${c.city}` : ""}).`);
      lines.push(`Datos: teléfono ${c.phone ?? "no publicado"}; web ${c.website ?? "no tiene"}; email ${c.email ?? "no publicado"}; ${c.rating !== undefined ? `Google ${c.rating.toFixed(1)} ★ con ${c.reviews ?? 0} reseñas` : "sin datos de Google"}; horario ${c.openingHours ?? "no publicado"}.`);
      lines.push(`Opportunity Score: ${cur.score.score}/100. Solución recomendada: ${cur.recommended}.`);
      lines.push(`Oportunidades: ${cur.opportunities.map((o) => `${o.title} (${o.priority}): ${o.problem}`).join(" | ") || "ninguna"}.`);
      if (c.complaints?.length) lines.push(`Quejas en reseñas: ${c.complaints.map((k) => `«${k.quote}»`).join(" ")}`);
      if (a) lines.push(`Señales verificadas: ${a.signals.filter((x) => x.confidence === "verificado").map((x) => x.label).join("; ")}.`);
    }
  } else if (state.data && (h === "" || h === "#/" || h.startsWith("#/?"))) {
    const d = state.data;
    const list = visibleResults();
    lines.push(`Pantalla: resultados de «${d.parsed.raw}» en ${d.area.label}: ${d.results.length} negocios (${d.results.filter((r) => !r.company.website).length} sin web, ${d.results.filter((r) => !!systemOf(r)).length} con falta de un sistema).`);
    lines.push(
      "Primeros de la lista: " +
        list
          .slice(0, 12)
          .map((r) => `${r.company.name} (score ${currentResult(r).score.score}${r.company.website ? "" : ", sin web"}${systemOf(r) ? `, falta ${systemOf(r)}` : ""}${r.company.phone ? `, tel ${r.company.phone}` : ""})`)
          .join("; "),
    );
  } else {
    lines.push(`Pantalla: ${h.startsWith("#/ajustes") ? "Ajustes" : h.startsWith("#/ayuda") ? "Ayuda y contacto" : "buscador sin resultados"}.`);
  }
  return lines.join("\n").slice(0, 3800);
}

async function askAssistant(text: string) {
  const q = text.trim();
  if (!q || state.chatBusy) return;
  state.chat.push({ role: "user", content: q });
  state.chatBusy = true;
  renderAssistantLog();
  try {
    const st = loadSettings();
    const res = await api<{ text: string; meta: { model: string } }>("/api/assistant", { messages: state.chat.slice(-10), context: screenContext(), agencyName: st.agencyName, senderName: st.senderName });
    state.chat.push({ role: "assistant", content: res.text });
  } catch (e) {
    state.chat.push({ role: "assistant", content: `No he podido responder: ${(e as Error).message}` });
  } finally {
    state.chatBusy = false;
    renderAssistantLog();
  }
}

function openAssistant() {
  const panel = $("#assistant");
  if (!panel) return;
  panel.hidden = false;
  document.body.classList.add("assistant-open");
  renderAssistantLog();
  ($("#assistant-input") as HTMLInputElement | null)?.focus();
}

function bindAssistantOpeners(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-open-assistant]").forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", openAssistant);
  });
}

function initAssistant() {
  bindAssistantOpeners();
  $("#assistant-close")?.addEventListener("click", () => {
    $("#assistant")!.hidden = true;
    document.body.classList.remove("assistant-open");
  });
  $("#assistant-form")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = $("#assistant-input") as HTMLInputElement;
    const v = input.value;
    input.value = "";
    askAssistant(v);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#assistant")!.hidden) {
      $("#assistant")!.hidden = true;
      document.body.classList.remove("assistant-open");
    }
  });
}

// ---------- Arranque ----------

initTheme();
initAssistant();
window.addEventListener("hashchange", route);
// La configuración (clave del mapa, contacto) se pide en paralelo: la interfaz no espera por ella
ensureConfig();
route();
