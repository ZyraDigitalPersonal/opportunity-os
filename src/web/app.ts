// Frontend de OpportunityOS (sin framework). Todo dato externo pasa por esc() antes de pintarse.

import type { Analysis, Company, GeoArea, Opportunity, OpportunityScore, Signal } from "../core/types.js";

declare const maplibregl: any;

interface SearchResult {
  company: Company;
  score: OpportunityScore;
  recommended: string;
  opportunities: Opportunity[];
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
  filters: { minScore: 0, opp: "", sort: "score" as "score" | "name" },
  batch: null as null | { done: number; total: number },
  map: null as any,
  markers: new Map<string, any>(),
  config: null as null | { integrations: { openStreetMap: boolean; contactEmail?: boolean; googlePlaces: boolean; googleMaxCalls?: number; ai: boolean; aiProvider: string | null }; missing: string[]; rulesVersion: string },
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
    state.data = await api<SearchResponse>("/api/search", { q, limit: 300 });
    state.analyses.clear();
    state.filters.minScore = 0;
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

function visibleResults(): SearchResult[] {
  if (!state.data) return [];
  const { minScore, opp, sort } = state.filters;
  const list = state.data.results.filter((r) => {
    const c = currentResult(r);
    return c.score.score >= minScore && (!opp || c.opportunities.some((o) => o.id === opp));
  });
  return list.sort((a, b) => (sort === "name" ? a.company.name.localeCompare(b.company.name, "es") : currentResult(b).score.score - currentResult(a).score.score));
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
    area.innerHTML = `<div class="notice" style="margin-top:24px">Escribe qué tipo de negocio buscas y dónde: <b>«dentistas Lleida»</b>, <b>«restaurantes de Tenerife»</b>, <b>«peluquerías en La Laguna sin web»</b>. Los negocios salen de Google Maps y OpenStreetMap; al pulsar <b>Analizar oportunidad</b> se revisa la web de cada uno para confirmar qué le falta (web, reservas, chatbot, agente de voz, automatizaciones…).</div>`;
    return;
  }
  const d = state.data;
  const sectorsNote = d.parsed.sectorsFromIntent ? ` · sectores elegidos por la intención de la búsqueda` : "";
  const src = d.meta.source || d.meta.sources?.join(" + ") || "OpenStreetMap";
  const cost = d.meta.costUsd ? ` · ≈ ${d.meta.costUsd.toFixed(2)} US$ de Google (${d.meta.googleCalls} consultas)` : " · coste 0 €";
  const warn = (d.warnings ?? []).map((w) => `<div class="notice" style="margin-top:10px">${esc(w)}</div>`).join("");
  area.innerHTML = `
    <div class="toolbar">
      <div class="summary"><strong>${d.results.length}</strong> empresas en <strong>${esc(d.area.label)}</strong>${sectorsNote} · fuente ${esc(src)}${cost}</div>
      <div class="filters">
        <label>Score mín. <input type="range" id="f-min" min="0" max="90" step="5" value="${state.filters.minScore}"> <span class="mono" id="f-min-v">${state.filters.minScore}</span></label>
        <label class="sr-only" for="f-opp">Oportunidad</label>
        <select id="f-opp">${OPP_FILTERS.map(([v, l]) => `<option value="${v}"${state.filters.opp === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <label class="sr-only" for="f-sort">Orden</label>
        <select id="f-sort"><option value="score"${state.filters.sort === "score" ? " selected" : ""}>Mayor score</option><option value="name"${state.filters.sort === "name" ? " selected" : ""}>Nombre</option></select>
        <button class="btn btn-sm" id="batch-btn" type="button" title="Revisa la web de las 20 primeras con web registrada">Analizar top 20</button>
        <button class="btn btn-sm btn-ghost" id="csv-btn" type="button">Exportar CSV</button>
      </div>
    </div>
    ${warn}
    <div id="batch-progress"></div>
    <div class="split">
      <div class="results" id="results"></div>
      <div class="map-wrap"><div id="map"></div><div class="map-note">Mapa © OpenStreetMap · OpenFreeMap</div></div>
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
    state.filters.sort = (e.target as HTMLSelectElement).value as "score" | "name";
    renderCards();
  });
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
      <ul class="reasons">${reasons.map((i) => `<li>${esc(i.reason)}</li>`).join("")}</ul>
    </div>
    ${scoreRing(cur.score.score)}
    <div class="actions">
      ${c.website && !cur.analyzed ? `<button class="btn btn-sm btn-primary" data-analyze="${esc(c.id)}" type="button">Analizar oportunidad</button>` : ""}
      <a class="btn btn-sm" href="#/empresa/${encodeURIComponent(c.id)}">Ver perfil</a>
      ${c.website ? `<a class="btn btn-sm btn-ghost" href="${safeHref(c.website)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(c.website))} ↗</a>` : ""}
    </div>
  </article>`;
}

function renderCards() {
  const el = $("#results");
  if (!el) return;
  const list = visibleResults();
  el.innerHTML = list.length ? list.map(cardHtml).join("") : `<div class="empty">Ninguna empresa cumple los filtros. ${state.data?.results.length ? "Baja el score mínimo o cambia la oportunidad." : "Prueba con otra zona o con otra forma de nombrar el sector."}</div>`;
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

function destroyMap() {
  state.markers.forEach((m) => m.remove());
  state.markers.clear();
  state.map?.remove();
  state.map = null;
}

function applyMapTheme() {
  const canvas = document.querySelector<HTMLElement>("#map .maplibregl-canvas");
  if (canvas) canvas.style.filter = isDark() ? "invert(0.92) hue-rotate(180deg) saturate(0.6)" : "";
}

function initMap(retries = 20) {
  const el = $("#map");
  if (!el || !state.data) return;
  if (typeof maplibregl === "undefined") {
    if (retries > 0) setTimeout(() => initMap(retries - 1), 150);
    else el.innerHTML = `<div class="map-fallback">No se pudo cargar el mapa. Los resultados siguen disponibles en la lista.</div>`;
    return;
  }
  destroyMap();
  const [s, w, n, e] = state.data.area.bbox;
  state.map = new maplibregl.Map({ container: el, style: "https://tiles.openfreemap.org/styles/positron", bounds: [[w, s], [e, n]], fitBoundsOptions: { padding: 30 }, attributionControl: { compact: true } });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  state.map.on("load", applyMapTheme);
  state.map.on("error", () => {});
  updateMarkers(visibleResults());
}

function updateMarkers(list: SearchResult[]) {
  if (!state.map) return;
  state.markers.forEach((m) => m.remove());
  state.markers.clear();
  for (const r of list) {
    const div = document.createElement("div");
    div.className = `marker${state.activeId === r.company.id ? " is-active" : ""}`;
    div.style.background = scoreColor(currentResult(r).score.score);
    div.title = `${r.company.name} · ${currentResult(r).score.score}`;
    div.addEventListener("click", () => setActive(r.company.id, true));
    const m = new maplibregl.Marker({ element: div }).setLngLat([r.company.lon, r.company.lat]).addTo(state.map);
    state.markers.set(r.company.id, m);
  }
}

function setActive(id: string, scrollCard: boolean) {
  if (state.activeId === id) return;
  state.activeId = id;
  document.querySelectorAll(".card.is-active").forEach((c) => c.classList.remove("is-active"));
  const card = document.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(id)}"]`);
  card?.classList.add("is-active");
  if (scrollCard) card?.scrollIntoView({ behavior: "smooth", block: "center" });
  state.markers.forEach((m, mid) => m.getElement().classList.toggle("is-active", mid === id));
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
        <div class="tabs" role="tablist">${(["propuesta", "email", "whatsapp", "linkedin", "llamada"] as const).map((k, i) => `<button class="tab" role="tab" data-kind="${k}" aria-selected="${i === 0}">${{ propuesta: "Propuesta", email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn", llamada: "Guion de llamada" }[k]}</button>`).join("")}</div>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn btn-primary btn-sm" id="gen-btn" type="button">Generar con IA</button><button class="btn btn-sm" id="copy-btn" type="button" hidden>Copiar</button><span class="muted" id="gen-meta" style="font-size:12px"></span></div>
        <div class="output" id="gen-out" aria-live="polite"><span class="muted">El texto se basa solo en las señales de esta página.</span></div>
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

function bindProfile(c: Company) {
  let kind = "propuesta";
  let lastText = "";
  const legal = () => {
    $("#gen-legal")!.textContent =
      kind === "email" || kind === "whatsapp"
        ? "Aviso legal (LSSI art. 21): no envíes este mensaje por email o WhatsApp a quien no te lo haya pedido o autorizado. Úsalo tras un primer contacto por teléfono o en persona, o si ya existe relación."
        : "";
  };
  legal();
  document.querySelectorAll<HTMLButtonElement>("#gen-panel .tab").forEach((t) =>
    t.addEventListener("click", () => {
      kind = t.dataset.kind!;
      document.querySelectorAll("#gen-panel .tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
      legal();
    }),
  );
  $("#gen-btn")?.addEventListener("click", async () => {
    const btn = $("#gen-btn") as HTMLButtonElement;
    const out = $("#gen-out")!;
    btn.disabled = true;
    btn.textContent = "Generando…";
    out.innerHTML = `<span class="muted">Escribiendo a partir de las señales detectadas…</span>`;
    try {
      const res = await api<{ text: string; meta: { model: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number | null } }>("/api/generate", { kind, company: c });
      lastText = res.text;
      out.textContent = res.text;
      ($("#copy-btn") as HTMLButtonElement).hidden = false;
      $("#gen-meta")!.textContent = `${res.meta.model} · ${res.meta.inputTokens + res.meta.outputTokens} tokens${res.meta.estimatedCostUsd != null ? ` · ≈ ${res.meta.estimatedCostUsd.toFixed(4)} US$` : ""}`;
    } catch (e) {
      out.innerHTML = errorBox(e as ApiError);
    } finally {
      btn.disabled = false;
      btn.textContent = "Generar con IA";
    }
  });
  $("#copy-btn")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(lastText);
      $("#copy-btn")!.textContent = "Copiado";
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

// ---------- Integraciones ----------

async function renderSettings() {
  destroyMap();
  const app = $("#app")!;
  app.innerHTML = `<section class="view"><div class="eyebrow">Integraciones</div><h1 class="hero">Estado de las conexiones</h1><div id="cfg"><div class="skeleton"></div></div></section>`;
  try {
    state.config = await api("/api/config");
    const i = state.config!.integrations;
    const row = (ok: boolean, name: string, desc: string, variable: string) =>
      `<li><div><span class="dot${ok ? " ok" : ""}"></span><strong>${name}</strong><div class="muted" style="font-size:13px;margin-left:16px">${desc}</div></div><div class="muted" style="font-size:12.5px;text-align:right">${ok ? "Configurado" : `Falta <code class="mono">${variable}</code>`}</div></li>`;
    $("#cfg")!.innerHTML = `<ul class="status-list">
      ${row(i.googlePlaces, "Google Maps (Places API)", `Fuente principal: encuentra prácticamente todos los negocios de la zona, con teléfono, web, valoración y reseñas. Hasta ${i.googleMaxCalls ?? 12} consultas por búsqueda (≈ 0,035 US$ cada una; 1.000 gratis al mes).`, "GOOGLE_PLACES_API_KEY")}
      ${row(true, "OpenStreetMap", "Zonas y negocios gratis. Completa los datos de Google (email, redes). Siempre activo.", "")}
      ${row(!!i.contactEmail, "Email de contacto (opcional)", "Recomendado por la política de uso de OpenStreetMap. Sin él, la búsqueda funciona igual.", "CONTACT_EMAIL")}
      ${row(i.ai, `IA${i.aiProvider ? ` · ${esc(i.aiProvider)}` : ""}`, "Propuestas, emails, WhatsApp, LinkedIn y guiones de llamada.", "ANTHROPIC_API_KEY")}
    </ul><p class="muted" style="margin-top:14px;font-size:13px">Reglas del Opportunity Engine: versión <span class="mono">${esc(state.config!.rulesVersion)}</span>.</p>`;
  } catch (e) {
    $("#cfg")!.innerHTML = errorBox(e as ApiError);
  }
}

// ---------- Arranque ----------

initTheme();
window.addEventListener("hashchange", route);
route();
