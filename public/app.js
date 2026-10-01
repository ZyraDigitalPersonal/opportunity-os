// Frontend de OpportunityOS (sin framework). Todo dato externo pasa por esc() antes de pintarse.
/** Servicios que puede vender la agencia → ids de oportunidad del motor */
const SERVICES = [
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
const DEFAULT_SETTINGS = { agencyName: "ZYRA", services: SERVICES.map(([id]) => id), sort: "agency", limit: 300 };
function loadSettings() {
    try {
        const raw = localStorage.getItem("oos-settings");
        if (raw)
            return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
    catch { }
    return { ...DEFAULT_SETTINGS };
}
function saveSettings(x) {
    try {
        localStorage.setItem("oos-settings", JSON.stringify(x));
    }
    catch { }
}
function myOppIds() {
    const sv = new Set(loadSettings().services);
    return new Set(SERVICES.filter(([id]) => sv.has(id)).flatMap(([, , ops]) => ops));
}
function recentSearches() {
    try {
        return JSON.parse(localStorage.getItem("oos-recent") ?? "[]").slice(0, 6);
    }
    catch {
        return [];
    }
}
function pushRecent(q) {
    try {
        const list = [q, ...recentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6);
        localStorage.setItem("oos-recent", JSON.stringify(list));
    }
    catch { }
}
const EXAMPLES = [
    "Clínicas dentales en Lleida",
    "Restaurantes en Santa Cruz de Tenerife sin web",
    "Peluquerías en La Laguna",
    "Talleres mecánicos en Las Palmas de Gran Canaria",
    "Negocios en Lleida que puedan necesitar agentes de IA",
    "Inmobiliarias en Adeje",
];
const OPP_FILTERS = [
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
    data: null,
    analyses: new Map(),
    activeId: null,
    loading: false,
    error: null,
    filters: { minScore: 0, opp: "", sort: loadSettings().sort },
    batch: null,
    map: null,
    mapNote: "",
    config: null,
    quick: "all",
    shown: 60,
    chat: [],
    chatBusy: false,
};
// ---------- Utilidades ----------
const $ = (sel, root = document) => root.querySelector(sel);
function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function safeHref(u) {
    if (!u)
        return "#";
    return /^https?:\/\//i.test(u) ? esc(u) : "#";
}
function storage() {
    try {
        return window.sessionStorage;
    }
    catch {
        return null;
    }
}
function scoreColor(v) {
    return v >= 70 ? "var(--high)" : v >= 45 ? "var(--mid)" : "var(--low)";
}
function scoreRing(v, lg = false) {
    return `<div class="score${lg ? " lg" : ""}" style="--v:${v};--c:${scoreColor(v)}" role="img" aria-label="Opportunity Score ${v} de 100"><span>${v}</span></div>`;
}
function hostOf(u) {
    try {
        return u ? new URL(u).hostname.replace(/^www\./, "") : "";
    }
    catch {
        return u ?? "";
    }
}
async function api(path, body) {
    const res = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 401) {
        location.href = "/login";
        throw new Error("Sesión caducada");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error ?? `Error ${res.status}`);
        err.status = res.status;
        err.missing = data.missing;
        throw err;
    }
    return data;
}
function errorBox(e) {
    const cfg = e.missing ? `<p>Configura la variable <code>${esc(e.missing)}</code> en Cloudflare (Workers → tu worker → Settings → Variables and Secrets).</p>` : "";
    return `<div class="error-box" role="alert"><strong>${esc(e.message)}</strong>${cfg}</div>`;
}
// ---------- Tema ----------
function initTheme() {
    let saved = null;
    try {
        saved = localStorage.getItem("oos-theme");
    }
    catch { }
    if (saved === "light" || saved === "dark")
        document.documentElement.dataset.theme = saved;
    $("#theme-toggle")?.addEventListener("click", () => {
        const cur = document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        const next = cur === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try {
            localStorage.setItem("oos-theme", next);
        }
        catch { }
        applyMapTheme();
    });
}
function isDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}
// ---------- Router ----------
function route() {
    const h = location.hash || "#/";
    document.querySelectorAll("[data-nav]").forEach((a) => a.removeAttribute("aria-current"));
    if (h.startsWith("#/empresa/")) {
        renderProfile(decodeURIComponent(h.slice("#/empresa/".length)));
    }
    else if (h.startsWith("#/ajustes")) {
        $("[data-nav=settings]")?.setAttribute("aria-current", "page");
        renderSettings();
    }
    else if (h.startsWith("#/ayuda")) {
        $("[data-nav=help]")?.setAttribute("aria-current", "page");
        renderHelp();
    }
    else {
        $("[data-nav=explore]")?.setAttribute("aria-current", "page");
        renderExplore();
    }
}
// ---------- Explorar mercado ----------
function renderExplore() {
    destroyMap();
    const app = $("#app");
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
    $("#search-form").addEventListener("submit", (ev) => {
        ev.preventDefault();
        const v = $("#q").value.trim();
        if (v)
            search(v);
    });
    app.querySelectorAll("[data-example]").forEach((b) => b.addEventListener("click", () => {
        $("#q").value = b.dataset.example;
        search(b.dataset.example);
    }));
    renderResultsArea();
}
async function search(q) {
    state.loading = true;
    state.error = null;
    state.activeId = null;
    renderResultsArea();
    const btn = $("#search-btn");
    if (btn)
        btn.disabled = true;
    try {
        state.data = await api("/api/search", { q, limit: loadSettings().limit });
        state.analyses.clear();
        state.filters.minScore = 0;
        state.quick = "all";
        state.shown = 60;
        pushRecent(q);
        storage()?.setItem("oos-last", JSON.stringify(state.data));
    }
    catch (e) {
        state.error = e;
        state.data = null;
    }
    finally {
        state.loading = false;
        if (btn)
            btn.disabled = false;
        renderResultsArea();
    }
}
function currentResult(r) {
    const a = state.analyses.get(r.company.id);
    return a ? { score: a.score, recommended: a.recommended, opportunities: a.opportunities, analyzed: true } : { score: r.score, recommended: r.recommended, opportunities: r.opportunities, analyzed: false };
}
const hasBookingGap = (r) => currentResult(r).opportunities.some((o) => o.id === "booking");
const fewReviews = (r) => r.company.reviews !== undefined && r.company.reviews < 25;
const matchesMine = (r, mine) => currentResult(r).opportunities.some((o) => mine.has(o.id));
function visibleResults() {
    if (!state.data)
        return [];
    const { minScore, opp, sort } = state.filters;
    const mine = myOppIds();
    const q = state.quick;
    const list = state.data.results.filter((r) => {
        const c = currentResult(r);
        if (c.score.score < minScore)
            return false;
        if (opp && !c.opportunities.some((o) => o.id === opp))
            return false;
        if (q === "noweb" && r.company.website)
            return false;
        if (q === "nobooking" && !hasBookingGap(r))
            return false;
        if (q === "fewreviews" && !fewReviews(r))
            return false;
        if (q === "phone" && !r.company.phone)
            return false;
        if (q === "mine" && !matchesMine(r, mine))
            return false;
        return true;
    });
    const byScore = (a, b) => currentResult(b).score.score - currentResult(a).score.score;
    return list.sort((a, b) => {
        if (sort === "name")
            return a.company.name.localeCompare(b.company.name, "es");
        if (sort === "reviews")
            return (b.company.reviews ?? -1) - (a.company.reviews ?? -1) || byScore(a, b);
        if (sort === "agency") {
            // Primero los que no tienen web (lo que más vende una agencia), luego los que tienen teléfono para llamar
            const w = Number(!!a.company.website) - Number(!!b.company.website);
            if (w)
                return w;
            const p = Number(!b.company.phone) - Number(!a.company.phone);
            if (p)
                return -p;
            return byScore(a, b);
        }
        return byScore(a, b);
    });
}
function renderResultsArea() {
    const area = $("#results-area");
    if (!area)
        return;
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
        area.querySelectorAll("[data-recent]").forEach((b) => b.addEventListener("click", () => {
            $("#q").value = b.dataset.recent;
            search(b.dataset.recent);
        }));
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
    const nFew = all.filter(fewReviews).length;
    const nPhone = all.filter((r) => !!r.company.phone).length;
    const mine = myOppIds();
    const nMine = all.filter((r) => matchesMine(r, mine)).length;
    const avg = all.length ? Math.round(all.reduce((x, r) => x + r.score.score, 0) / all.length) : 0;
    const stat = (key, n, label, hint) => `<button type="button" class="stat${state.quick === key ? " is-on" : ""}" data-quick="${key}" title="${esc(hint)}"><span class="stat-n">${n}</span><span class="stat-l">${label}</span></button>`;
    area.innerHTML = `
    <div class="stats" role="group" aria-label="Filtros rápidos">
      ${stat("all", all.length, "Negocios", "Ver todos")}
      ${stat("noweb", nNoWeb, "Sin web", "Negocios sin página web registrada")}
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
        <select id="f-sort">${[
        ["agency", "Sin web primero"],
        ["score", "Mayor score"],
        ["reviews", "Más reseñas"],
        ["name", "Nombre"],
    ]
        .map(([v, l]) => `<option value="${v}"${state.filters.sort === v ? " selected" : ""}>${l}</option>`)
        .join("")}</select>
        <button class="btn btn-sm" id="batch-btn" type="button" title="Revisa la web de las 20 primeras con web registrada">Analizar top 20</button>
        <button class="btn btn-sm btn-ghost" id="csv-btn" type="button">Exportar CSV</button>
      </div>
    </div>
    ${warn}
    <div id="batch-progress"></div>
    <div id="map-msg"></div>
    <div class="split">
      <div class="results" id="results"></div>
      <div class="map-wrap"><div id="map"></div><div class="map-note" id="map-note">Cargando mapa…</div></div>
    </div>`;
    $("#f-min").addEventListener("input", (e) => {
        state.filters.minScore = Number(e.target.value);
        $("#f-min-v").textContent = String(state.filters.minScore);
        renderCards();
    });
    $("#f-opp").addEventListener("change", (e) => {
        state.filters.opp = e.target.value;
        renderCards();
    });
    $("#f-sort").addEventListener("change", (e) => {
        state.filters.sort = e.target.value;
        state.shown = 60;
        renderCards();
    });
    area.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", () => {
        state.quick = b.dataset.quick;
        state.shown = 60;
        area.querySelectorAll(".stat").forEach((x) => x.classList.toggle("is-on", x === b));
        renderCards();
    }));
    $("#batch-btn").addEventListener("click", batchAnalyze);
    $("#csv-btn").addEventListener("click", exportCsv);
    renderCards();
    initMap();
}
function presenceBadges(c) {
    const b = (on, label) => `<span class="badge ${on ? "on" : "off"}">${label}</span>`;
    const stars = c.rating !== undefined ? `<span class="badge on" title="Google Maps">${c.rating.toFixed(1)} ★ · ${c.reviews ?? 0}</span>` : "";
    return `<div class="presence">${b(!!c.website, "Web")}${b(!!c.phone, "Teléfono")}${b(!!(c.instagram || c.facebook), "Redes")}${b(!!c.openingHours, "Horario")}${c.whatsapp ? b(true, "WhatsApp") : ""}${stars}</div>`;
}
function cardHtml(r) {
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
      ${!c.website ? `<div class="tag tag-hot">Sin web · oportunidad directa</div>` : fit ? `<div class="tag">Puedes ofrecer: ${esc(fit.title)}</div>` : ""}
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
    if (!el)
        return;
    const list = visibleResults();
    const more = list.length > state.shown ? `<button class="btn more-btn" id="more-btn" type="button">Ver ${Math.min(60, list.length - state.shown)} más (${list.length - state.shown} restantes)</button>` : "";
    el.innerHTML = list.length ? list.slice(0, state.shown).map(cardHtml).join("") + more : `<div class="empty">Ninguna empresa cumple los filtros. ${state.data?.results.length ? "Baja el score mínimo o cambia la oportunidad." : "Prueba con otra zona o con otra forma de nombrar el sector."}</div>`;
    $("#more-btn")?.addEventListener("click", () => {
        state.shown += 60;
        renderCards();
    });
    el.querySelectorAll("[data-analyze]").forEach((b) => b.addEventListener("click", () => analyzeOne(b.dataset.analyze, b)));
    el.querySelectorAll(".card").forEach((card) => card.addEventListener("mouseenter", () => {
        setActive(card.dataset.id, false);
    }));
    updateMarkers(list);
}
async function analyzeOne(id, btn) {
    const r = state.data?.results.find((x) => x.company.id === id);
    if (!r)
        return;
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Analizando…";
    }
    try {
        const { analysis } = await api("/api/analyze", { company: r.company });
        state.analyses.set(id, analysis);
    }
    catch (e) {
        if (btn) {
            btn.textContent = "Reintentar";
            btn.disabled = false;
            btn.title = e.message;
        }
        throw e;
    }
    renderCards();
}
async function batchAnalyze() {
    if (!state.data || state.batch)
        return;
    const pending = visibleResults()
        .filter((r) => r.company.website && !state.analyses.has(r.company.id))
        .slice(0, 20);
    if (!pending.length)
        return;
    state.batch = { done: 0, total: pending.length };
    const prog = $("#batch-progress");
    const paint = () => (prog.innerHTML = state.batch ? `<div class="summary muted" style="font-size:13px">Revisando webs ${state.batch.done}/${state.batch.total}…</div><div class="progress"><div style="width:${(state.batch.done / state.batch.total) * 100}%"></div></div>` : "");
    paint();
    let failed = 0;
    const queue = [...pending];
    const worker = async () => {
        while (queue.length) {
            const r = queue.shift();
            try {
                await analyzeOne(r.company.id);
            }
            catch {
                failed++;
            }
            state.batch.done++;
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
    const cell = (v) => {
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
const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";
let googleMapsPromise = null;
let maplibrePromise = null;
let googleMapsFailed = false;
function loadScript(src) {
    return new Promise((resolve) => {
        const el = document.createElement("script");
        el.src = src;
        el.async = true;
        el.onload = () => resolve(true);
        el.onerror = () => resolve(false);
        document.head.appendChild(el);
    });
}
function loadGoogleMaps(key) {
    if (googleMapsPromise)
        return googleMapsPromise;
    googleMapsPromise = new Promise((resolve) => {
        window.__oosMapsReady = () => resolve(true);
        // Google llama a esta función si la clave no vale o la API no está activada
        window.gm_authFailure = () => {
            googleMapsFailed = true;
            state.mapNote = "El mapa de Google no se ha podido cargar: activa «Maps JavaScript API» en Google Cloud para la misma clave. Mientras, se usa el mapa alternativo.";
            if (state.data && $("#map"))
                initMap();
        };
        loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=es&region=ES&loading=async&callback=__oosMapsReady`).then((ok) => {
            if (!ok)
                resolve(false);
        });
        setTimeout(() => resolve(false), 12000);
    });
    return googleMapsPromise;
}
function loadMaplibre() {
    if (maplibrePromise)
        return maplibrePromise;
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = MAPLIBRE_CSS;
    document.head.appendChild(css);
    maplibrePromise = loadScript(MAPLIBRE_JS);
    return maplibrePromise;
}
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#7c8594";
}
function scoreHex(v) {
    return cssVar(v >= 70 ? "--high" : v >= 45 ? "--mid" : "--low");
}
const GOOGLE_DARK = [
    { elementType: "geometry", stylers: [{ color: "#1d2128" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#9aa3ad" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#111418" }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c333d" }] },
    { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1a26" }] },
];
const GOOGLE_LIGHT = [
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
];
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
    if (!el || !state.data)
        return;
    const token = ++mapToken;
    destroyMap();
    await ensureConfig();
    if (token !== mapToken)
        return;
    const key = state.config?.mapsKey;
    const note = $("#map-note");
    if (key && !googleMapsFailed && (await loadGoogleMaps(key)) && typeof google !== "undefined" && google.maps?.Map) {
        if (token !== mapToken || !document.body.contains(el))
            return;
        state.map = googleAdapter(el);
        if (note)
            note.textContent = "Google Maps";
    }
    else {
        if (!(await loadMaplibre()) || typeof maplibregl === "undefined") {
            el.innerHTML = `<div class="map-fallback">No se pudo cargar el mapa. Los resultados siguen disponibles en la lista.</div>`;
            return;
        }
        if (token !== mapToken || !document.body.contains(el))
            return;
        state.map = maplibreAdapter(el);
        if (note)
            note.textContent = "Mapa © OpenStreetMap · OpenFreeMap";
    }
    if (state.mapNote && $("#map-msg"))
        $("#map-msg").innerHTML = `<div class="notice" style="margin-bottom:10px">${esc(state.mapNote)}</div>`;
    state.map.setMarkers(visibleResults());
}
function googleAdapter(el) {
    const [s, w, n, e] = state.data.area.bbox;
    const map = new google.maps.Map(el, {
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        clickableIcons: false,
        gestureHandling: "greedy",
        styles: isDark() ? GOOGLE_DARK : GOOGLE_LIGHT,
    });
    map.fitBounds({ south: s, west: w, north: n, east: e }, 30);
    const info = new google.maps.InfoWindow();
    let markers = new Map();
    const icon = (r, active) => ({
        path: google.maps.SymbolPath.CIRCLE,
        scale: active ? 10 : 7,
        fillColor: scoreHex(currentResult(r).score.score),
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 2,
    });
    const byId = new Map();
    return {
        kind: "google",
        setMarkers(list) {
            markers.forEach((m) => m.setMap(null));
            markers = new Map();
            byId.clear();
            for (const r of list) {
                byId.set(r.company.id, r);
                const m = new google.maps.Marker({ position: { lat: r.company.lat, lng: r.company.lon }, map, title: `${r.company.name} · ${currentResult(r).score.score}`, icon: icon(r, state.activeId === r.company.id), zIndex: state.activeId === r.company.id ? 999 : 1 });
                m.addListener("click", () => {
                    setActive(r.company.id, true);
                    const c = r.company;
                    info.setContent(`<div class="iw"><strong>${esc(c.name)}</strong><div>${esc(c.sectorLabel)} · score ${currentResult(r).score.score}</div>${c.rating !== undefined ? `<div>${c.rating.toFixed(1)} ★ · ${c.reviews ?? 0} reseñas</div>` : ""}<div>${c.website ? "Tiene web" : "<b>Sin web</b>"}${c.phone ? ` · ${esc(c.phone)}` : ""}</div><a href="#/empresa/${encodeURIComponent(c.id)}">Ver perfil →</a></div>`);
                    info.open({ anchor: m, map });
                });
                markers.set(r.company.id, m);
            }
        },
        highlight(id) {
            markers.forEach((m, mid) => {
                const r = byId.get(mid);
                if (!r)
                    return;
                m.setIcon(icon(r, mid === id));
                m.setZIndex(mid === id ? 999 : 1);
            });
        },
        applyTheme() {
            map.setOptions({ styles: isDark() ? GOOGLE_DARK : GOOGLE_LIGHT });
        },
        destroy() {
            markers.forEach((m) => m.setMap(null));
            markers.clear();
            info.close();
        },
    };
}
function maplibreAdapter(el) {
    const [s, w, n, e] = state.data.area.bbox;
    const map = new maplibregl.Map({ container: el, style: "https://tiles.openfreemap.org/styles/positron", bounds: [[w, s], [e, n]], fitBoundsOptions: { padding: 30 }, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const theme = () => {
        const canvas = el.querySelector(".maplibregl-canvas");
        if (canvas)
            canvas.style.filter = isDark() ? "invert(0.92) hue-rotate(180deg) saturate(0.6)" : "";
    };
    map.on("load", theme);
    map.on("error", () => { });
    let markers = new Map();
    return {
        kind: "maplibre",
        setMarkers(list) {
            markers.forEach((m) => m.remove());
            markers = new Map();
            for (const r of list) {
                const div = document.createElement("div");
                div.className = `marker${state.activeId === r.company.id ? " is-active" : ""}`;
                div.style.background = scoreColor(currentResult(r).score.score);
                div.title = `${r.company.name} · ${currentResult(r).score.score}`;
                div.addEventListener("click", () => setActive(r.company.id, true));
                markers.set(r.company.id, new maplibregl.Marker({ element: div }).setLngLat([r.company.lon, r.company.lat]).addTo(map));
            }
        },
        highlight(id) {
            markers.forEach((m, mid) => m.getElement().classList.toggle("is-active", mid === id));
        },
        applyTheme: theme,
        destroy() {
            markers.forEach((m) => m.remove());
            map.remove();
        },
    };
}
function updateMarkers(list) {
    state.map?.setMarkers(list);
}
function setActive(id, scrollCard) {
    if (state.activeId === id)
        return;
    state.activeId = id;
    document.querySelectorAll(".card.is-active").forEach((c) => c.classList.remove("is-active"));
    const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    card?.classList.add("is-active");
    if (scrollCard)
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
    state.map?.highlight(id);
}
// ---------- Perfil de empresa ----------
function findCompany(id) {
    if (!state.data) {
        const raw = storage()?.getItem("oos-last");
        if (raw) {
            try {
                state.data = JSON.parse(raw);
            }
            catch { }
        }
    }
    return state.data?.results.find((r) => r.company.id === id);
}
async function renderProfile(id) {
    destroyMap();
    const app = $("#app");
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
            analysis = (await api("/api/analyze", { company: c })).analysis;
            state.analyses.set(id, analysis);
            if (location.hash === `#/empresa/${encodeURIComponent(id)}`) {
                $("#profile").innerHTML = profileHtml(c, analysis, r);
                bindProfile(c);
            }
        }
        catch (e) {
            $("#analysis-status").innerHTML = errorBox(e);
        }
    }
}
function signalRow(s) {
    return `<li><span>${esc(s.label)}${s.evidence ? ` <small>${esc(s.evidence)}</small>` : ""}</span><span class="badge ${s.confidence === "verificado" ? "verified" : "inferred"}" title="Fuente: ${esc(s.source)}">${s.confidence}</span></li>`;
}
function profileHtml(c, a, r) {
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
        <div class="tabs" role="tablist">${["propuesta", "email", "whatsapp", "linkedin", "llamada"].map((k, i) => `<button class="tab" role="tab" data-kind="${k}" aria-selected="${i === 0}">${{ propuesta: "Propuesta", email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn", llamada: "Guion de llamada" }[k]}</button>`).join("")}</div>
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
function bindProfile(c) {
    let kind = "propuesta";
    let lastText = "";
    const legal = () => {
        $("#gen-legal").textContent =
            kind === "email" || kind === "whatsapp"
                ? "Aviso legal (LSSI art. 21): no envíes este mensaje por email o WhatsApp a quien no te lo haya pedido o autorizado. Úsalo tras un primer contacto por teléfono o en persona, o si ya existe relación."
                : "";
    };
    legal();
    document.querySelectorAll("#gen-panel .tab").forEach((t) => t.addEventListener("click", () => {
        kind = t.dataset.kind;
        document.querySelectorAll("#gen-panel .tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
        legal();
    }));
    $("#gen-btn")?.addEventListener("click", async () => {
        const btn = $("#gen-btn");
        const out = $("#gen-out");
        btn.disabled = true;
        btn.textContent = "Generando…";
        out.innerHTML = `<span class="muted">Escribiendo a partir de las señales detectadas…</span>`;
        try {
            const res = await api("/api/generate", { kind, company: c });
            lastText = res.text;
            out.textContent = res.text;
            $("#copy-btn").hidden = false;
            $("#gen-meta").textContent = `${res.meta.model} · ${res.meta.inputTokens + res.meta.outputTokens} tokens${res.meta.estimatedCostUsd != null ? ` · ≈ ${res.meta.estimatedCostUsd.toFixed(4)} US$` : ""}`;
        }
        catch (e) {
            out.innerHTML = errorBox(e);
        }
        finally {
            btn.disabled = false;
            btn.textContent = "Generar con IA";
        }
    });
    $("#copy-btn")?.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(lastText);
            $("#copy-btn").textContent = "Copiado";
            setTimeout(() => ($("#copy-btn").textContent = "Copiar"), 1500);
        }
        catch { }
    });
    $("#google-btn")?.addEventListener("click", async () => {
        const btn = $("#google-btn");
        const out = $("#google-out");
        btn.disabled = true;
        try {
            const { place } = await api("/api/google", { name: c.name, city: c.city, lat: c.lat, lon: c.lon });
            if (!place)
                out.innerHTML = `<p class="muted">Google no devuelve una ficha para este negocio.</p>`;
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
        }
        catch (e) {
            out.innerHTML = `<div style="margin-top:10px">${errorBox(e)}</div>`;
            btn.disabled = false;
        }
    });
}
// ---------- Ajustes ----------
let configPromise = null;
function ensureConfig() {
    if (state.config)
        return Promise.resolve(state.config);
    configPromise ??= api("/api/config")
        .then((c) => (state.config = c))
        .catch(() => null)
        .finally(() => (configPromise = null));
    return configPromise;
}
async function renderSettings() {
    destroyMap();
    const app = $("#app");
    const st = loadSettings();
    app.innerHTML = `<section class="view narrow">
    <div class="eyebrow">Ajustes</div><h1 class="hero">Configura tu OpportunityOS</h1>
    <form class="panel" id="settings-form">
      <h2>Tu agencia</h2>
      <label class="field"><span>Nombre de tu agencia</span><input name="agencyName" value="${esc(st.agencyName)}" maxlength="60"></label>
      <p class="muted" style="margin:14px 0 8px">Servicios que ofreces: los negocios que los necesitan se marcan con «Puedes ofrecer» y aparecen en el filtro «Encajan contigo».</p>
      <div class="checks">${SERVICES.map(([id, label]) => `<label class="check"><input type="checkbox" name="svc" value="${id}"${st.services.includes(id) ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}</div>
      <h2 style="margin-top:22px">Búsqueda</h2>
      <div class="field-row">
        <label class="field"><span>Orden por defecto</span><select name="sort">${[
        ["agency", "Sin web primero"],
        ["score", "Mayor score"],
        ["reviews", "Más reseñas"],
        ["name", "Nombre"],
    ]
        .map(([v, l]) => `<option value="${v}"${st.sort === v ? " selected" : ""}>${l}</option>`)
        .join("")}</select></label>
        <label class="field"><span>Resultados por búsqueda</span><select name="limit">${[100, 200, 300, 500].map((n) => `<option value="${n}"${st.limit === n ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:16px"><button class="btn btn-primary" type="submit">Guardar ajustes</button><span class="muted" id="settings-saved" aria-live="polite"></span></div>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">Se guardan en este navegador.</p>
    </form>
    <div class="panel"><h2>Conexiones</h2><div id="cfg"><div class="skeleton"></div></div></div>
  </section>`;
    $("#settings-form").addEventListener("submit", (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        const next = {
            agencyName: String(f.get("agencyName") ?? "").trim() || DEFAULT_SETTINGS.agencyName,
            services: f.getAll("svc").map(String),
            sort: String(f.get("sort")),
            limit: Number(f.get("limit")) || 300,
        };
        saveSettings(next);
        state.filters.sort = next.sort;
        $("#settings-saved").textContent = "Guardado ✓";
        setTimeout(() => ($("#settings-saved").textContent = ""), 2000);
    });
    try {
        state.config = null;
        const cfg = (await ensureConfig());
        if (!cfg)
            throw new Error("No se pudo leer la configuración");
        const i = cfg.integrations;
        const row = (ok, name, desc, variable) => `<li><div><span class="dot${ok ? " ok" : ""}"></span><strong>${name}</strong><div class="muted" style="font-size:13px;margin-left:16px">${desc}</div></div><div class="muted" style="font-size:12.5px;text-align:right">${ok ? "Conectado" : `Falta <code class="mono">${variable}</code>`}</div></li>`;
        $("#cfg").innerHTML = `<ul class="status-list">
      ${row(i.googlePlaces, "Google Maps · búsqueda", `Fuente principal: prácticamente todos los negocios de la zona, con teléfono, web, valoración y reseñas. Hasta ${i.googleMaxCalls ?? 12} consultas por búsqueda (1.000 gratis al mes).`, "GOOGLE_PLACES_API_KEY")}
      ${row(!!i.googleMaps && !googleMapsFailed, "Google Maps · mapa", googleMapsFailed ? "La clave no tiene activada «Maps JavaScript API». Actívala en Google Cloud (misma clave) y recarga." : "Mapa de Google en los resultados (10.000 cargas gratis al mes). Si falla, se usa un mapa alternativo.", "GOOGLE_PLACES_API_KEY")}
      ${row(true, "OpenStreetMap", "Zonas y negocios gratis. Completa los datos de Google (email, redes). Siempre activo.", "")}
      ${row(i.ai, `IA${i.aiProvider ? ` · ${esc(i.aiProvider)}` : ""}`, i.aiFree ? "Asistente y textos comerciales (propuestas, emails, WhatsApp, guiones). IA gratuita de Cloudflare con límite diario; con ANTHROPIC_API_KEY usa Claude." : "Propuestas, emails, WhatsApp, LinkedIn y guiones de llamada.", "ANTHROPIC_API_KEY")}
      ${row(!!i.contactEmail, "Email de contacto (opcional)", "Recomendado por la política de uso de OpenStreetMap. Sin él, la búsqueda funciona igual.", "CONTACT_EMAIL")}
    </ul><p class="muted" style="margin-top:14px;font-size:13px">Las claves se añaden en Cloudflare → Workers → opportunity-os → Settings → Variables and Secrets (tipo Secret). Reglas del Opportunity Engine: versión <span class="mono">${esc(cfg.rulesVersion)}</span>.</p>`;
    }
    catch (e) {
        $("#cfg").innerHTML = errorBox(e);
    }
}
// ---------- Ayuda y contacto ----------
async function renderHelp() {
    destroyMap();
    const app = $("#app");
    const cfg = await ensureConfig();
    const c = cfg?.contact ?? { company: "ZYRA", web: "https://digitalzyra.com", contactPage: "https://digitalzyra.com/es-es/contacto/", email: "zyradigitalpersonal@gmail.com", phone: "+34 643 41 24 54", whatsapp: "https://wa.me/34643412454", instagram: "https://www.instagram.com/zyra_personal", linkedin: "https://www.linkedin.com/in/digital-zyra-730293439", tiktok: "https://www.tiktok.com/@digitalzyra" };
    const faq = [
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
const ASSISTANT_SUGGESTIONS = ["¿Cómo encuentro negocios sin web?", "¿Qué significa el score?", "¿Cuánto me cuesta Google?", "¿Cómo preparo una llamada de venta?"];
function renderAssistantLog() {
    const log = $("#assistant-log");
    if (!log)
        return;
    const fmt = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
    log.innerHTML =
        (state.chat.length ? "" : `<div class="msg msg-a">¡Hola! Soy el asistente de OpportunityOS. Pregúntame cómo buscar negocios, qué significa cada dato o cómo preparar una propuesta.</div>`) +
            state.chat.map((m) => `<div class="msg ${m.role === "user" ? "msg-u" : "msg-a"}">${fmt(m.content)}</div>`).join("") +
            (state.chatBusy ? `<div class="msg msg-a msg-typing"><span></span><span></span><span></span></div>` : "");
    log.scrollTop = log.scrollHeight;
    const sug = $("#assistant-suggest");
    if (sug)
        sug.innerHTML = state.chat.length ? "" : ASSISTANT_SUGGESTIONS.map((q) => `<button type="button" class="chip chip-soft" data-ask="${esc(q)}">${esc(q)}</button>`).join("");
    sug?.querySelectorAll("[data-ask]").forEach((b) => b.addEventListener("click", () => askAssistant(b.dataset.ask)));
}
async function askAssistant(text) {
    const q = text.trim();
    if (!q || state.chatBusy)
        return;
    state.chat.push({ role: "user", content: q });
    state.chatBusy = true;
    renderAssistantLog();
    try {
        const res = await api("/api/assistant", { messages: state.chat.slice(-10) });
        state.chat.push({ role: "assistant", content: res.text });
    }
    catch (e) {
        state.chat.push({ role: "assistant", content: `No he podido responder: ${e.message}` });
    }
    finally {
        state.chatBusy = false;
        renderAssistantLog();
    }
}
function openAssistant() {
    const panel = $("#assistant");
    if (!panel)
        return;
    panel.hidden = false;
    document.body.classList.add("assistant-open");
    renderAssistantLog();
    $("#assistant-input")?.focus();
}
function bindAssistantOpeners(root = document) {
    root.querySelectorAll("[data-open-assistant]").forEach((b) => {
        if (b.dataset.bound)
            return;
        b.dataset.bound = "1";
        b.addEventListener("click", openAssistant);
    });
}
function initAssistant() {
    bindAssistantOpeners();
    $("#assistant-close")?.addEventListener("click", () => {
        $("#assistant").hidden = true;
        document.body.classList.remove("assistant-open");
    });
    $("#assistant-form")?.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const input = $("#assistant-input");
        const v = input.value;
        input.value = "";
        askAssistant(v);
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !$("#assistant").hidden) {
            $("#assistant").hidden = true;
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
export {};
