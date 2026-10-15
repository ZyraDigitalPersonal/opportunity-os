// Pantallas del módulo «Prácticas y empleo formativo». Comparte utilidades, estilos y sesión con el resto de la app.

import type { CompanyResearch, DirCompany, InternOpportunity, JobOffer, ManualLink, Nature, Scope, SourceStatus, StudentProfile } from "../core/practicas/types.js";
import type { Application, AppActivity } from "../core/practicas/tracker.js";
import type { ReviewItem } from "../core/types.js";
import { $, api, bindReviews, csvDownload, errorBox, esc, fmtDate, hostOf, reviewHtml, safeHref, scoreRing, storage, todayStr, type ApiError } from "./util.js";

// ---------- Tipos de respuesta ----------

interface Meta {
  families: Array<{ id: string; label: string; studiesHint: string; suggestedSkills: string[] }>;
  statuses: ReadonlyArray<{ id: string; label: string; color: string; open: boolean }>;
  natures: Record<Nature, string>;
  weights: Record<string, { weight: number; label: string; doc: string }>;
  viabilityBase: Record<Nature, number>;
  sources: { google: boolean; adzuna: boolean; jooble: boolean; ai: boolean };
  plan: { id: string; label: string; limits: Record<string, number> };
  usage: Record<string, { n: number; cost: number }>;
  example: StudentProfile;
}
interface SearchResp {
  profile: StudentProfile;
  scope: Scope;
  area: { label: string; center: [number, number] } | null;
  results: InternOpportunity[];
  sources: SourceStatus[];
  manualLinks: ManualLink[];
  warnings: string[];
  meta: { total: number; googleCalls: number; costUsd: number; offers: number; companies: number; researched: number; generatedAt: string };
}
interface ResearchResp {
  opportunity: InternOpportunity;
  fromCache: boolean;
  noWebsite: boolean;
  reviews: null | { rating?: number; count?: number; mapsUri?: string; internship: ReviewItem[]; general: ReviewItem[] };
  reviewsError: string | null;
  reputationLinks: ManualLink[];
}
interface Summary {
  today: string;
  byStatus: Record<string, number>;
  active: number;
  total: number;
  due: Application[];
  overdue: number;
  interviews: Application[];
  waiting: Application[];
  activity: Array<{ at: string; kind: string; text: string; to_status?: string; company_name: string; application_id: string }>;
}

const NATURE_SHORT: Record<Nature, string> = { oferta_publicada: "Oferta publicada", programa: "Programa de prácticas", interes_estudiantes: "Interés en estudiantes", potencial: "Potencial · sin confirmar" };
const MODALITY_LABEL: Record<string, string> = { presencial: "Presencial", hibrida: "Híbrida", remota: "Remota", desconocida: "Modalidad sin confirmar" };
const SORTS: Array<[string, string]> = [
  ["fit", "Mejor encaje"],
  ["viability", "Más viables"],
  ["recent", "Más recientes"],
  ["evidence", "Más evidencia"],
  ["distance", "Más cerca"],
];

const st = {
  meta: null as Meta | null,
  profile: null as StudentProfile | null,
  search: null as SearchResp | null,
  loading: false,
  error: null as ApiError | null,
  scope: "local" as Scope,
  filters: { text: "", nature: "", modality: "", minFit: 0, maxKm: 0, category: "", sort: "fit", onlySaved: false, recentDays: 0 },
  shown: 40,
  apps: new Map<string, Application>(),
  appsLoaded: false,
  research: new Map<string, ResearchResp>(),
  batch: null as null | { done: number; total: number },
};

// ---------- Datos ----------

async function ensureMeta(force = false): Promise<Meta> {
  if (!st.meta || force) st.meta = await api<Meta>("/api/practicas/meta");
  return st.meta;
}
async function ensureProfile(): Promise<StudentProfile | null> {
  if (!st.profile) st.profile = (await api<{ profile: StudentProfile | null }>("/api/practicas/profile")).profile;
  return st.profile;
}
async function loadApps(force = false) {
  if (st.appsLoaded && !force) return;
  const { apps } = await api<{ apps: Application[] }>("/api/practicas/apps");
  st.apps = new Map(apps.map((a) => [a.opp_key, a]));
  st.appsLoaded = true;
}
function restoreSearch() {
  if (st.search) return;
  try {
    const raw = storage()?.getItem("oos-prac-last");
    if (raw) st.search = JSON.parse(raw);
  } catch {}
}
function persistSearch() {
  try {
    storage()?.setItem("oos-prac-last", JSON.stringify(st.search));
  } catch {}
}
function compareKeys(): string[] {
  try {
    return JSON.parse(storage()?.getItem("oos-prac-compare") ?? "[]").slice(0, 4);
  } catch {
    return [];
  }
}
function setCompare(keys: string[]) {
  try {
    storage()?.setItem("oos-prac-compare", JSON.stringify(keys.slice(0, 4)));
  } catch {}
}

/** Sustituye una oportunidad de la búsqueda por su versión investigada. */
function upsertOpportunity(o: InternOpportunity) {
  if (!st.search) return;
  const i = st.search.results.findIndex((x) => x.key === o.key);
  if (i >= 0) st.search.results[i] = o;
  persistSearch();
}

function findOpp(key: string): InternOpportunity | undefined {
  restoreSearch();
  return st.search?.results.find((r) => r.key === key) ?? st.research.get(key)?.opportunity;
}

// ---------- Router del módulo ----------

export async function renderPracticas(hash: string) {
  const app = $("#app")!;
  const sub = hash.replace(/^#\/practicas\/?/, "");
  app.innerHTML = `<section class="view prac">${header(sub)}<div id="prac-body"><div class="skeleton"></div></div></section>`;
  try {
    await ensureMeta();
    if (sub.startsWith("empresa/")) return await renderCompany(decodeURIComponent(sub.slice("empresa/".length)));
    if (sub.startsWith("candidaturas")) return await renderApps();
    if (sub.startsWith("perfil")) return await renderProfileForm();
    if (sub.startsWith("comparar")) return await renderCompare();
    return await renderSearch();
  } catch (e) {
    $("#prac-body")!.innerHTML = errorBox(e as ApiError);
  }
}

function header(sub: string): string {
  const tab = (href: string, label: string, on: boolean) => `<a class="tab" role="tab" href="${href}" aria-selected="${on}">${label}</a>`;
  const isCompany = sub.startsWith("empresa/");
  return `<div class="eyebrow">Prácticas y empleo formativo</div>
    ${isCompany ? "" : `<h1 class="hero">Encuentra prácticas que merezcan la pena.</h1>`}
    <nav class="tabs prac-tabs" role="tablist">
      ${tab("#/practicas", "Buscar", sub === "" || sub.startsWith("?"))}
      ${tab("#/practicas/candidaturas", "Mis candidaturas", sub.startsWith("candidaturas"))}
      ${tab("#/practicas/comparar", `Comparar${compareKeys().length ? ` (${compareKeys().length})` : ""}`, sub.startsWith("comparar"))}
      ${tab("#/practicas/perfil", "Mi perfil", sub.startsWith("perfil"))}
    </nav>`;
}

// ---------- Perfil ----------

const tagsToList = (v: string) =>
  v
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

async function renderProfileForm(onSaved?: () => void, draft?: StudentProfile) {
  const meta = await ensureMeta();
  const p = draft ?? (await ensureProfile()) ?? { ...meta.example, skills: [], interests: [], location: "", studies: "" };
  const fam = meta.families.find((f) => f.id === p.familyId) ?? meta.families[0];
  const body = $("#prac-body")!;
  const chk = (name: string, v: string, on: boolean, label: string) => `<label class="check"><input type="checkbox" name="${name}" value="${v}"${on ? " checked" : ""}> ${label}</label>`;
  const range = (k: keyof StudentProfile["priorities"], label: string) => `<label class="field"><span>${label} <b class="mono" data-out="${k}">${p.priorities[k].toFixed(1)}×</b></span><input type="range" min="0" max="2" step="0.5" name="prio_${k}" value="${p.priorities[k]}"></label>`;
  body.innerHTML = `<form class="panel prac-form" id="prof-form">
    <div class="form-head"><div><h2>${st.profile ? "Tu perfil" : "Crea tu perfil para empezar"}</h2><p class="muted small">Solo lo necesario. Se usa para buscar, puntuar el encaje y redactar tus mensajes. Se guarda en tu cuenta y no se comparte.</p></div>
      ${st.profile || draft ? "" : `<button type="button" class="btn btn-sm" id="load-example">Cargar ejemplo: DAW en Lleida</button>`}</div>
    <div class="grid-form">
      <label class="field"><span>Familia profesional</span><select name="familyId">${meta.families.map((f) => `<option value="${f.id}"${f.id === p.familyId ? " selected" : ""}>${esc(f.label)}</option>`).join("")}</select></label>
      <label class="field"><span>Estudios *</span><input name="studies" required maxlength="120" value="${esc(p.studies)}" placeholder="${esc(fam.studiesHint)}"></label>
      <label class="field"><span>Localidad *</span><input name="location" required maxlength="80" value="${esc(p.location)}" placeholder="Lleida"></label>
      <label class="field"><span>Distancia máxima (km)</span><input name="maxDistanceKm" type="number" min="1" max="300" value="${p.maxDistanceKm}"></label>
      <label class="field span-2"><span>Lo que ya sabes (separado por comas)</span><input name="skills" value="${esc(p.skills.join(", "))}" placeholder="${esc(fam.suggestedSkills.join(", "))}"></label>
      <label class="field span-2"><span>Lo que quieres aprender</span><input name="interests" value="${esc(p.interests.join(", "))}" placeholder="React, Node.js, Docker, cloud, IA…"></label>
      <fieldset class="field span-2"><span>Modalidad que aceptas</span><div class="checks">${chk("modalities", "presencial", p.modalities.includes("presencial"), "Presencial")}${chk("modalities", "hibrida", p.modalities.includes("hibrida"), "Híbrida")}${chk("modalities", "remota", p.modalities.includes("remota"), "Remota")}</div></fieldset>
    </div>
    <details class="advanced"${p.advanced ? " open" : ""}><summary>Modo avanzado: más datos y prioridades</summary>
      <div class="grid-form">
        <label class="field"><span>Tu nombre (para firmar)</span><input name="name" maxlength="80" value="${esc(p.name ?? "")}"></label>
        <label class="field"><span>Especialidad u objetivo</span><input name="specialty" maxlength="120" value="${esc(p.specialty ?? "")}" placeholder="Full stack"></label>
        <label class="field"><span>Tipo de prácticas</span><input name="internshipType" maxlength="80" value="${esc(p.internshipType ?? "")}" placeholder="FCT / curriculares / extracurriculares / FP dual"></label>
        <label class="field"><span>Inicio previsto</span><input name="startDate" type="date" value="${esc(p.startDate ?? "")}"></label>
        <label class="field"><span>Duración (meses)</span><input name="durationMonths" type="number" min="1" max="24" value="${p.durationMonths ?? ""}"></label>
        <label class="field"><span>Disponibilidad</span><input name="availability" maxlength="120" value="${esc(p.availability ?? "")}" placeholder="Mañanas, 8 h/día…"></label>
        <label class="field"><span>Idiomas</span><input name="languages" value="${esc(p.languages.join(", "))}"></label>
        <label class="field"><span>Portfolio o GitHub (https://…)</span><input name="portfolioUrl" type="url" value="${esc(p.portfolioUrl ?? "")}"></label>
        <label class="field span-2"><span>Proyectos realizados</span><textarea name="projects" rows="2" maxlength="2000">${esc(p.projects ?? "")}</textarea></label>
        <label class="field span-2"><span>Experiencia</span><textarea name="experience" rows="2" maxlength="1500">${esc(p.experience ?? "")}</textarea></label>
        <label class="field"><span>Bolsa de prácticas de tu centro (enlace)</span><input name="centreBoardUrl" type="url" value="${esc(p.centreBoardUrl ?? "")}"></label>
        <label class="field"><span>Excluir empresas o palabras</span><input name="exclude" value="${esc(p.exclude.join(", "))}"></label>
        <fieldset class="field span-2"><span>Me importa</span><div class="checks">${chk("wants", "tutoring", p.wants.tutoring, "Buena tutoría")}${chk("wants", "learning", p.wants.learning, "Aprender mucho")}${chk("wants", "hiring", p.wants.hiring, "Posibilidad de contrato")}</div></fieldset>
      </div>
      <h3 class="sub">Prioridades del encaje (0 = no cuenta, 2 = cuenta el doble)</h3>
      <div class="grid-form">${range("tech", "Tecnologías")}${range("activity", "Actividad de la empresa")}${range("location", "Ubicación y modalidad")}${range("learning", "Aprendizaje y tutoría")}</div>
    </details>
    <div class="form-actions"><button class="btn btn-primary" type="submit">Guardar perfil</button><span class="muted small" id="prof-msg"></span></div>
  </form>`;
  const form = $("#prof-form") as HTMLFormElement;
  form.querySelectorAll<HTMLInputElement>("input[type=range]").forEach((r) => r.addEventListener("input", () => ($(`[data-out="${r.name.slice(5)}"]`)!.textContent = `${Number(r.value).toFixed(1)}×`)));
  $("#load-example")?.addEventListener("click", () => {
    renderProfileForm(onSaved, { ...meta.example }).then(() => ($("#prof-msg")!.textContent = "Ejemplo cargado: revísalo y pulsa «Guardar perfil»."));
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const g = (k: string) => String(fd.get(k) ?? "").trim();
    const prof: Partial<StudentProfile> = {
      id: "principal",
      familyId: g("familyId"),
      studies: g("studies"),
      location: g("location"),
      maxDistanceKm: Number(g("maxDistanceKm")) || 30,
      skills: tagsToList(g("skills")),
      interests: tagsToList(g("interests")),
      modalities: fd.getAll("modalities") as StudentProfile["modalities"],
      name: g("name") || undefined,
      specialty: g("specialty") || undefined,
      internshipType: g("internshipType") || undefined,
      startDate: g("startDate") || undefined,
      durationMonths: g("durationMonths") ? Number(g("durationMonths")) : undefined,
      availability: g("availability") || undefined,
      languages: tagsToList(g("languages")),
      portfolioUrl: g("portfolioUrl") || undefined,
      projects: g("projects") || undefined,
      experience: g("experience") || undefined,
      centreBoardUrl: g("centreBoardUrl") || undefined,
      exclude: tagsToList(g("exclude")),
      wants: { tutoring: fd.getAll("wants").includes("tutoring"), learning: fd.getAll("wants").includes("learning"), hiring: fd.getAll("wants").includes("hiring") },
      priorities: { tech: Number(g("prio_tech") || 1), activity: Number(g("prio_activity") || 1), location: Number(g("prio_location") || 1), learning: Number(g("prio_learning") || 1) },
      advanced: (form.querySelector("details.advanced") as HTMLDetailsElement).open,
    };
    const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    btn.disabled = true;
    try {
      const { profile } = await api<{ profile: StudentProfile }>("/api/practicas/profile", { profile: prof });
      st.profile = profile;
      $("#prof-msg")!.textContent = "Guardado ✓";
      if (onSaved) onSaved();
      else location.hash = "#/practicas";
    } catch (e) {
      $("#prof-msg")!.textContent = (e as Error).message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- Buscar ----------

async function renderSearch() {
  const profile = await ensureProfile();
  if (!profile) return renderProfileForm(() => renderSearch());
  restoreSearch();
  loadApps().then(() => st.search && renderResults()).catch(() => {});
  const meta = st.meta!;
  const fam = meta.families.find((f) => f.id === profile.familyId);
  const srcBadge = (on: boolean, label: string) => `<span class="badge ${on ? "on" : "off"}" title="${on ? "Conectada" : "Sin configurar"}">${label}</span>`;
  $("#prac-body")!.innerHTML = `
    <div class="panel prac-searchbar">
      <div class="prof-summary"><strong>${esc(profile.studies)}</strong><span class="muted">${esc(fam?.label ?? "")} · ${esc(profile.location)} · hasta ${profile.maxDistanceKm} km · ${profile.modalities.map((m) => MODALITY_LABEL[m]).join(", ")}</span>
        <span class="muted small">${profile.skills.length ? `Sabes: ${esc(profile.skills.slice(0, 6).join(", "))}` : "Añade tus habilidades para calcular el encaje"} <a href="#/practicas/perfil">Editar perfil</a></span></div>
      <div class="scope" role="radiogroup" aria-label="Ámbito">
        ${(["local", "nacional", "remota"] as Scope[]).map((s) => `<button type="button" class="seg${st.scope === s ? " is-on" : ""}" role="radio" aria-checked="${st.scope === s}" data-scope="${s}">${{ local: `Cerca de ${esc(profile.location)}`, nacional: "Toda España", remota: "Remotas" }[s]}</button>`).join("")}
      </div>
      <button class="btn btn-primary" id="prac-go" type="button">Buscar prácticas</button>
      <div class="sources-line">Fuentes: ${srcBadge(meta.sources.google, "Google Maps")}${srcBadge(true, "OpenStreetMap")}${srcBadge(meta.sources.adzuna, "Adzuna")}${srcBadge(meta.sources.jooble, "Jooble")}${srcBadge(meta.sources.ai, "IA")} <span class="muted small">· Plan ${esc(meta.plan.label)}: ${meta.usage.practicas_search?.n ?? 0}/${meta.plan.limits.practicasSearchPerDay} búsquedas hoy</span></div>
    </div>
    <div id="prac-results"></div>`;
  $("#prac-body")!.querySelectorAll<HTMLButtonElement>("[data-scope]").forEach((b) =>
    b.addEventListener("click", () => {
      st.scope = b.dataset.scope as Scope;
      $("#prac-body")!.querySelectorAll("[data-scope]").forEach((x) => {
        x.classList.toggle("is-on", x === b);
        x.setAttribute("aria-checked", String(x === b));
      });
    }),
  );
  $("#prac-go")!.addEventListener("click", runSearch);
  renderResults();
}

async function runSearch() {
  st.loading = true;
  st.error = null;
  renderResults();
  const btn = $("#prac-go") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    st.search = await api<SearchResp>("/api/practicas/search", { scope: st.scope });
    st.shown = 40;
    persistSearch();
    ensureMeta(true).catch(() => {});
  } catch (e) {
    st.error = e as ApiError;
  } finally {
    st.loading = false;
    if (btn) btn.disabled = false;
    renderResults();
  }
}

function evidenceCount(o: InternOpportunity): number {
  return (o.research?.evidence.filter((e) => e.url).length ?? 0) + (o.research?.techs.filter((t) => t.from === "texto").length ?? 0) + (o.offer ? 1 : 0);
}
const dateOf = (o: InternOpportunity) => Date.parse(o.offer?.created ?? o.research?.checkedAt ?? "") || 0;

function visible(): InternOpportunity[] {
  const s = st.search;
  if (!s) return [];
  const f = st.filters;
  const q = f.text.trim().toLowerCase();
  const list = s.results.filter((o) => {
    if (f.nature && o.nature !== f.nature) return false;
    if (f.modality && o.modality !== f.modality) return false;
    if (o.score.fit < f.minFit) return false;
    if (f.maxKm && (o.distanceKm === undefined || o.distanceKm > f.maxKm)) return false;
    if (f.category && (o.company.category ?? "Oferta de empleo") !== f.category) return false;
    if (f.onlySaved && !st.apps.has(o.key)) return false;
    if (f.recentDays && (!o.offer?.created || Date.now() - Date.parse(o.offer.created) > f.recentDays * 86400000)) return false;
    if (q) {
      const hay = [o.company.name, o.company.category, o.company.city, o.offer?.title, o.offer?.location, ...o.techs, o.research?.activity.description].filter(Boolean).join(" ").toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  return list.sort((a, b) => {
    switch (f.sort) {
      case "viability":
        return b.score.viability - a.score.viability || b.score.fit - a.score.fit;
      case "recent":
        return dateOf(b) - dateOf(a);
      case "evidence":
        return b.score.confidence - a.score.confidence || evidenceCount(b) - evidenceCount(a);
      case "distance":
        return (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999);
      default:
        return b.score.fit - a.score.fit || b.score.viability - a.score.viability;
    }
  });
}

function renderResults() {
  const area = $("#prac-results");
  if (!area) return;
  if (st.loading) {
    area.innerHTML = `<div class="summary muted">Buscando empresas y ofertas… (puede tardar 10–30 s)</div><div class="results">${'<div class="skeleton"></div>'.repeat(4)}</div>`;
    return;
  }
  if (st.error) {
    area.innerHTML = errorBox(st.error);
    return;
  }
  const s = st.search;
  if (!s) {
    area.innerHTML = `<div class="features">
      <div class="feature"><span class="feature-n">1</span><h3>Descubre</h3><p>Empresas de tu sector cerca de ti (Google Maps y OpenStreetMap) y ofertas reales de portales con API. Cada resultado dice si es una <b>oferta publicada</b> o una <b>empresa potencial</b>.</p></div>
      <div class="feature"><span class="feature-n">2</span><h3>Investiga</h3><p>Revisamos su web: tecnologías que menciona, página de empleo, si habla de prácticas o FCT, tutoría… siempre con la cita y el enlace.</p></div>
      <div class="feature"><span class="feature-n">3</span><h3>Consigue la entrevista</h3><p>Prepara el correo o la candidatura espontánea con datos verificables y lleva el seguimiento de cada contacto.</p></div>
    </div>`;
    return;
  }
  const all = s.results;
  const count = (n: Nature) => all.filter((o) => o.nature === n).length;
  const cats = [...new Set(all.map((o) => o.company.category ?? "Oferta de empleo"))];
  const f = st.filters;
  const stat = (n: Nature | "", label: string, num: number) => `<button type="button" class="stat${f.nature === n ? " is-on" : ""}" data-nat="${n}"><span class="stat-n">${num}</span><span class="stat-l">${label}</span></button>`;
  const srcRow = (x: SourceStatus) => `<li class="src src-${x.status}"><b>${esc(x.name)}</b> <span>${{ ok: "OK", sin_configurar: "Sin configurar", error: "Error", omitida: "Omitida" }[x.status]}</span> <small>${esc(x.detail)}</small></li>`;
  area.innerHTML = `
    <div class="stats" role="group" aria-label="Filtrar por naturaleza">
      ${stat("", "Resultados", all.length)}
      ${stat("oferta_publicada", "Ofertas publicadas", count("oferta_publicada"))}
      ${stat("programa", "Programas", count("programa"))}
      ${stat("interes_estudiantes", "Interés en estudiantes", count("interes_estudiantes"))}
      ${stat("potencial", "Potenciales", count("potencial"))}
    </div>
    ${s.warnings.map((w) => `<div class="notice">${esc(w)}</div>`).join("")}
    <details class="panel sources-panel"><summary>Fuentes consultadas · ${s.sources.filter((x) => x.status === "ok").length} de ${s.sources.length} con datos · ${s.meta.costUsd ? `≈ ${s.meta.costUsd.toFixed(2)} US$` : "coste 0"} · ${new Date(s.meta.generatedAt).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</summary>
      <ul class="src-list">${s.sources.map(srcRow).join("")}</ul>
      <h3 class="sub">Continúa a mano (fuentes sin acceso automático permitido)</h3>
      <ul class="manual-links">${s.manualLinks.map((l) => `<li><a href="${safeHref(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)} ↗</a> <small class="muted">${esc(l.hint)}</small></li>`).join("")}</ul>
      ${s.sources.some((x) => x.id === "adzuna" && x.status === "ok") ? `<p class="small muted">Ofertas de empleo de <a href="https://www.adzuna.es" target="_blank" rel="noopener noreferrer">Adzuna</a>.</p>` : ""}
    </details>
    <div class="toolbar prac-toolbar">
      <label class="sr-only" for="pf-text">Filtrar</label><input id="pf-text" class="input" placeholder="Filtrar por empresa, tecnología o localidad…" value="${esc(f.text)}">
      <select id="pf-mod" aria-label="Modalidad"><option value="">Cualquier modalidad</option>${Object.entries(MODALITY_LABEL).map(([v, l]) => `<option value="${v}"${f.modality === v ? " selected" : ""}>${l}</option>`).join("")}</select>
      <select id="pf-cat" aria-label="Sector"><option value="">Todos los tipos</option>${cats.map((c) => `<option${f.category === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <select id="pf-recent" aria-label="Fecha"><option value="0">Cualquier fecha</option>${[7, 30, 60].map((d) => `<option value="${d}"${f.recentDays === d ? " selected" : ""}>Ofertas de ≤ ${d} días</option>`).join("")}</select>
      <label class="inline">Encaje ≥ <input type="range" id="pf-fit" min="0" max="90" step="5" value="${f.minFit}"> <span class="mono" id="pf-fit-v">${f.minFit}</span></label>
      ${s.scope === "local" ? `<label class="inline">≤ <input type="number" id="pf-km" min="0" max="300" value="${f.maxKm || ""}" placeholder="km" style="width:64px"> km</label>` : ""}
      <label class="inline"><input type="checkbox" id="pf-saved"${f.onlySaved ? " checked" : ""}> Guardadas</label>
      <select id="pf-sort" aria-label="Orden">${SORTS.map(([v, l]) => `<option value="${v}"${f.sort === v ? " selected" : ""}>${l}</option>`).join("")}</select>
      <button class="btn btn-sm" id="pf-batch" type="button" title="Revisa la web de las 10 primeras con web y sin investigar">Investigar top 10</button>
      <button class="btn btn-sm btn-ghost" id="pf-csv" type="button">Exportar CSV</button>
    </div>
    <div id="pf-progress"></div>
    <div class="results prac-results" id="pf-cards"></div>`;
  const on = (id: string, ev: string, fn: (el: any) => void) => $(id)?.addEventListener(ev, (e) => fn(e.target));
  on("#pf-text", "input", (el) => ((f.text = el.value), (st.shown = 40), renderCards()));
  on("#pf-mod", "change", (el) => ((f.modality = el.value), renderCards()));
  on("#pf-cat", "change", (el) => ((f.category = el.value), renderCards()));
  on("#pf-recent", "change", (el) => ((f.recentDays = Number(el.value)), renderCards()));
  on("#pf-fit", "input", (el) => ((f.minFit = Number(el.value)), ($("#pf-fit-v")!.textContent = el.value), renderCards()));
  on("#pf-km", "input", (el) => ((f.maxKm = Number(el.value) || 0), renderCards()));
  on("#pf-saved", "change", (el) => ((f.onlySaved = el.checked), renderCards()));
  on("#pf-sort", "change", (el) => ((f.sort = el.value), renderCards()));
  $("#pf-batch")!.addEventListener("click", batchResearch);
  $("#pf-csv")!.addEventListener("click", exportCsv);
  area.querySelectorAll<HTMLButtonElement>("[data-nat]").forEach((b) =>
    b.addEventListener("click", () => {
      f.nature = b.dataset.nat ?? "";
      area.querySelectorAll(".stat").forEach((x) => x.classList.toggle("is-on", x === b));
      renderCards();
    }),
  );
  renderCards();
}

function natureBadge(n: Nature): string {
  return `<span class="nature nature-${n}" title="${esc(st.meta?.natures[n] ?? "")}">${NATURE_SHORT[n]}</span>`;
}
function triple(o: InternOpportunity, lg = false): string {
  const conf = { alta: "Alta", media: "Media", baja: "Baja" }[o.score.confidenceLevel];
  return `<div class="triple${lg ? " lg" : ""}">
    <div title="Encaje con tu perfil${o.score.fitProvisional ? " (provisional: faltan datos)" : ""}">${scoreRing(o.score.fit, lg, "Encaje", true)}<small>Encaje${o.score.fitProvisional ? "*" : ""}</small></div>
    <div class="mini"><span class="mini-n">${o.score.viability}</span><small>Viabilidad</small></div>
    <div class="mini conf-${o.score.confidenceLevel}"><span class="mini-n">${conf}</span><small>Confianza</small></div>
  </div>`;
}

function cardHtml(o: InternOpportunity): string {
  const c = o.company;
  const saved = st.apps.get(o.key);
  const cmp = compareKeys().includes(o.key);
  const sub = [c.category ?? (o.offer ? "Oferta de empleo" : ""), c.city ?? o.offer?.location, o.distanceKm !== undefined ? `${o.distanceKm < 1 ? "<1" : Math.round(o.distanceKm)} km` : ""].filter(Boolean).map(esc).join(" · ");
  const checked = o.research ? `Investigada ${fmtDate(o.research.checkedAt).toLowerCase()}` : o.offer?.created ? `Oferta del ${new Date(o.offer.created).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}` : "Sin investigar";
  return `<article class="card prac-card" data-key="${esc(o.key)}">
    <div>
      <div class="card-top">${natureBadge(o.nature)}<span class="badge">${esc(MODALITY_LABEL[o.modality])}</span>${saved ? `<span class="badge on">${esc(st.meta?.statuses.find((x) => x.id === saved.status)?.label ?? "Guardada")}</span>` : ""}</div>
      <h3>${esc(o.offer ? o.offer.title : c.name)}</h3>
      <div class="meta">${o.offer ? `${esc(c.name)} · ` : ""}${sub}</div>
      ${o.techs.length ? `<div class="tags">${o.techs.slice(0, 6).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <p class="headline">${esc(o.headline)}</p>
      ${o.warnings.length ? `<div class="warn-line">${o.warnings.map(esc).join(" · ")}</div>` : ""}
      <div class="meta small">${esc(checked)} · fuente ${esc(o.offer?.source ?? c.source)}</div>
    </div>
    ${triple(o)}
    <div class="actions">
      <a class="btn btn-sm btn-primary" href="#/practicas/empresa/${encodeURIComponent(o.key)}">Ver ficha</a>
      ${!o.research && c.website ? `<button class="btn btn-sm" type="button" data-research="${esc(o.key)}">Investigar</button>` : ""}
      ${saved ? "" : `<button class="btn btn-sm" type="button" data-save="${esc(o.key)}">☆ Guardar</button>`}
      <button class="btn btn-sm btn-ghost" type="button" data-cmp="${esc(o.key)}">${cmp ? "✓ Comparando" : "Comparar"}</button>
      ${o.offer ? `<a class="btn btn-sm btn-ghost" href="${safeHref(o.offer.url)}" target="_blank" rel="noopener noreferrer">Ver oferta ↗</a>` : c.website ? `<a class="btn btn-sm btn-ghost" href="${safeHref(c.website)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(c.website))} ↗</a>` : ""}
    </div>
  </article>`;
}

function renderCards() {
  const el = $("#pf-cards");
  if (!el) return;
  const list = visible();
  const more = list.length > st.shown ? `<button class="btn more-btn" id="pf-more" type="button">Ver ${Math.min(40, list.length - st.shown)} más (${list.length - st.shown} restantes)</button>` : "";
  el.innerHTML = list.length ? list.slice(0, st.shown).map(cardHtml).join("") + more : `<div class="empty">Ningún resultado cumple los filtros. ${st.search?.results.length ? "Quita algún filtro o baja el encaje mínimo." : "Prueba otro ámbito o amplía la distancia en tu perfil."}</div>`;
  $("#pf-more")?.addEventListener("click", () => ((st.shown += 40), renderCards()));
  el.querySelectorAll<HTMLButtonElement>("[data-research]").forEach((b) => b.addEventListener("click", () => researchOne(b.dataset.research!, b).catch(() => {})));
  el.querySelectorAll<HTMLButtonElement>("[data-save]").forEach((b) =>
    b.addEventListener("click", async () => {
      const o = findOpp(b.dataset.save!);
      if (!o) return;
      b.disabled = true;
      await saveApp(o, "seleccionada");
      renderCards();
    }),
  );
  el.querySelectorAll<HTMLButtonElement>("[data-cmp]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.cmp!;
      const cur = compareKeys();
      const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k].slice(-4);
      setCompare(next);
      document.querySelector(".prac-tabs a[href='#/practicas/comparar']")!.textContent = `Comparar${next.length ? ` (${next.length})` : ""}`;
      renderCards();
    }),
  );
}

async function researchOne(key: string, btn?: HTMLButtonElement, force = false): Promise<ResearchResp | null> {
  const o = findOpp(key);
  if (!o) return null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Investigando…";
  }
  try {
    const r = await api<ResearchResp>("/api/practicas/research", { company: o.company, offer: o.offer, force, reviews: !btn || !!force });
    r.opportunity.key = o.key;
    st.research.set(o.key, r);
    upsertOpportunity(r.opportunity);
    if (btn) renderCards();
    return r;
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Reintentar";
      btn.title = (e as Error).message;
    }
    throw e;
  }
}

async function batchResearch() {
  if (!st.search || st.batch) return;
  const pending = visible()
    .filter((o) => o.company.website && !o.research)
    .slice(0, 10);
  if (!pending.length) return;
  st.batch = { done: 0, total: pending.length };
  const prog = $("#pf-progress")!;
  const paint = () => (prog.innerHTML = st.batch ? `<div class="summary muted small">Investigando webs ${st.batch.done}/${st.batch.total}…</div><div class="progress"><div style="width:${(st.batch.done / st.batch.total) * 100}%"></div></div>` : "");
  paint();
  let failed = 0;
  let lastErr = "";
  const queue = [...pending];
  const worker = async () => {
    while (queue.length) {
      const o = queue.shift()!;
      try {
        const r = await api<ResearchResp>("/api/practicas/research", { company: o.company, offer: o.offer, reviews: false });
        r.opportunity.key = o.key;
        st.research.set(o.key, r);
        upsertOpportunity(r.opportunity);
      } catch (e) {
        failed++;
        lastErr = (e as Error).message;
        if ((e as ApiError).status === 429) queue.length = 0;
      }
      st.batch!.done++;
      paint();
    }
  };
  await Promise.all([worker(), worker()]);
  st.batch = null;
  prog.innerHTML = failed ? `<div class="notice">${failed} empresas no se pudieron investigar. ${esc(lastErr)}</div>` : "";
  renderCards();
}

function exportCsv() {
  const rows = visible().map((o) => [
    o.company.name,
    o.offer?.title ?? "",
    st.meta?.natures[o.nature] ?? o.nature,
    o.score.fit,
    o.score.viability,
    o.score.confidenceLevel,
    MODALITY_LABEL[o.modality],
    o.distanceKm ?? "",
    o.company.category ?? "",
    o.company.city ?? o.offer?.location ?? "",
    o.techs.join(", "),
    o.headline,
    o.warnings.join(" | "),
    o.company.website ?? "",
    o.offer?.url ?? o.company.sourceUrl ?? "",
    o.offer?.source ?? o.company.source,
    o.research?.checkedAt?.slice(0, 10) ?? o.offer?.created?.slice(0, 10) ?? "",
  ]);
  csvDownload(`practicas-${(st.search?.profile.location ?? "resultados").toLowerCase().replace(/\s+/g, "-")}.csv`, ["Empresa", "Oferta", "Naturaleza", "Encaje", "Viabilidad", "Confianza", "Modalidad", "Distancia km", "Tipo", "Localidad", "Tecnologías", "Motivo", "Advertencias", "Web", "Fuente (enlace)", "Fuente", "Última comprobación"], rows);
}

// ---------- Guardar y candidaturas ----------

async function saveApp(o: InternOpportunity, status = "seleccionada"): Promise<string | null> {
  try {
    const r = await api<{ id: string }>("/api/practicas/app/save", { key: o.key, company: o.company, offer: o.offer, nature: o.nature, status, fit: o.score.fit, viability: o.score.viability, confidence: o.score.confidence });
    await loadApps(true);
    return r.id;
  } catch (e) {
    alert((e as Error).message);
    return null;
  }
}

const statusPill = (id: string) => {
  const s = st.meta?.statuses.find((x) => x.id === id);
  return `<span class="pill" style="--pc:${s?.color ?? "#888"}">${esc(s?.label ?? id)}</span>`;
};

// ---------- Ficha de empresa ----------

async function renderCompany(key: string) {
  const body = $("#prac-body")!;
  await loadApps().catch(() => {});
  let o = findOpp(key);
  if (!o) {
    const app = [...st.apps.values()].find((a) => a.opp_key === key);
    if (app) {
      const company = JSON.parse(app.company_json) as DirCompany;
      const offer = app.offer_json ? (JSON.parse(app.offer_json) as JobOffer) : undefined;
      body.innerHTML = `<div class="skeleton"></div>`;
      try {
        const r = await api<ResearchResp>("/api/practicas/research", { company, offer, reviews: false });
        r.opportunity.key = key;
        st.research.set(key, r);
        o = r.opportunity;
      } catch (e) {
        body.innerHTML = errorBox(e as ApiError);
        return;
      }
    }
  }
  if (!o) {
    body.innerHTML = `<a class="back" href="#/practicas">← Volver</a><div class="empty">Esta oportunidad no está en tu última búsqueda ni en tus candidaturas.</div>`;
    return;
  }
  const prev = st.research.get(key) ?? null;
  paintCompany(o, prev);
  // Investiga al abrir si tiene web y no hay investigación, o si faltan las reseñas en vivo (la investigación sale de caché)
  const needsReviews = o.company.id.startsWith("gp:") && !!st.meta?.sources.google && (!prev || (prev.reviews === null && !prev.reviewsError));
  if ((o.company.website && !prev) || needsReviews) {
    $("#research-status")!.innerHTML = `<div class="notice">Investigando su web${o.company.id.startsWith("gp:") ? " y cargando reseñas de Google" : ""}…</div>`;
    try {
      const r = await researchOne(key);
      if (r && location.hash === `#/practicas/empresa/${encodeURIComponent(key)}`) paintCompany(r.opportunity, r);
    } catch (e) {
      const el = $("#research-status");
      if (el) el.innerHTML = errorBox(e as ApiError);
    }
  }
}

function evidenceList(o: InternOpportunity): string {
  const r = o.research;
  if (!r) return `<p class="muted">${o.company.website ? "Pendiente de investigar." : "No tenemos su web: añádela para investigar."}</p>`;
  if (r.blockedByRobots) return `<p class="muted">Su web pide no ser analizada automáticamente (robots.txt). Se respeta: revisa su web a mano.</p>`;
  if (r.error) return `<p>${esc(r.error)}</p>`;
  const order = ["programa", "practicas", "interes", "contratando", "junior", "tutoria", "proyectos", "tamano"];
  const label: Record<string, string> = { confirmado: "Confirmado", estimado: "Estimado", hipotesis: "Hipótesis" };
  const ev = [...r.evidence].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return ev.length
    ? `<ul class="evidence">${ev.map((e) => `<li><div><b>${esc(e.label)}</b>${e.quote ? `<blockquote>«${esc(e.quote)}»</blockquote>` : ""}<small>${e.url ? `<a href="${safeHref(e.url)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(e.url))}${esc(new URL(e.url).pathname.length > 1 ? new URL(e.url).pathname : "")} ↗</a>` : esc(e.source)}</small></div><span class="badge cert-${e.certainty}">${label[e.certainty]}</span></li>`).join("")}</ul>`
    : `<p class="muted">Su web no menciona prácticas, empleo, tutoría ni proyectos en las páginas revisadas. Eso no significa que no acepte estudiantes: pregúntalo.</p>`;
}

function paintCompany(o: InternOpportunity, rr: ResearchResp | null) {
  const body = $("#prac-body")!;
  const c = o.company;
  const r = o.research;
  const saved = st.apps.get(o.key);
  const meta = st.meta!;
  const parts = o.score.parts
    .map((p) => `<div class="dim"><span>${esc(p.label)} <small class="muted">peso ${Math.round(p.weight)}</small></span><div class="bar">${p.value === null ? "" : `<div style="width:${Math.round(p.value * 100)}%"></div>`}</div><span class="val">${p.value === null ? "s/d" : Math.round(p.value * 100)}</span></div><p class="dim-why">${esc(p.reason)}</p>`)
    .join("");
  const li = (xs: string[]) => xs.map((x) => `<li>${esc(x)}</li>`).join("");
  const techsHtml = r?.techs.length
    ? `<ul class="techs">${r.techs.map((t) => `<li><span class="tag${t.from === "web" ? " tag-weak" : ""}">${esc(t.name)}</span>${t.from === "web" ? `<small class="muted">Su propia web está hecha con esto (indicio, no confirma que trabajen con ello)</small>` : t.quote ? `<small>«${esc(t.quote)}» ${t.url ? `<a href="${safeHref(t.url)}" target="_blank" rel="noopener noreferrer">fuente ↗</a>` : ""}</small>` : ""}</li>`).join("")}</ul>`
    : `<p class="muted">${r ? "No menciona tecnologías en las páginas revisadas." : "Sin investigar."}</p>`;
  const rev = rr?.reviews;
  const reviewsHtml = rev
    ? `${rev.internship.length ? `<h3 class="sub">Testimonios que hablan de prácticas (${rev.internship.length})</h3><div class="reviews">${rev.internship.map((x) => reviewHtml(x)).join("")}</div>` : `<p class="notice">No hay testimonios sobre prácticas entre las reseñas que muestra Google. La ausencia de información no indica mala calidad.</p>`}
       ${rev.general.length ? `<details><summary>Otras reseñas de clientes (${rev.general.length}) · opinión general, no sobre prácticas</summary><div class="reviews">${rev.general.map((x) => reviewHtml(x)).join("")}</div></details>` : ""}
       <p class="small muted">Google muestra como mucho 5 reseñas elegidas por relevancia: es una muestra, no la experiencia de todos. ${rev.rating ? `Valoración global ${rev.rating.toFixed(1)} ★ (${rev.count ?? 0}); no se usa para puntuar.` : ""} <span class="google-attr">Datos de Google</span></p>`
    : rr?.reviewsError
      ? `<p class="muted">Reseñas de Google: ${esc(rr.reviewsError)}</p>`
      : `<p class="muted small">${c.id.startsWith("gp:") ? "Las reseñas de Google se cargan al investigar." : "No hay ficha de Google enlazada."}</p>`;
  body.innerHTML = `<a class="back" href="#/practicas" data-back>← Volver a resultados</a>
  <div class="profile-head">
    <div>
      <div class="card-top">${natureBadge(o.nature)}<span class="badge">${esc(MODALITY_LABEL[o.modality])}</span>${saved ? statusPill(saved.status) : ""}</div>
      <h1>${esc(c.name)}</h1>
      ${o.offer ? `<div class="offer-title">${esc(o.offer.title)}</div>` : ""}
      <div class="muted">${[c.category, c.address, c.city ?? o.offer?.location, o.distanceKm !== undefined ? `a ${Math.round(o.distanceKm)} km` : ""].filter(Boolean).map((x) => esc(x)).join(" · ")}</div>
      <p class="nature-hint">${esc(meta.natures[o.nature])}: ${esc({ oferta_publicada: "verifica en el enlace que sigue abierta.", programa: "su web habla de un programa de prácticas o talento.", interes_estudiantes: "su web menciona prácticas o estudiantes, sin oferta concreta.", potencial: "no consta que acepte estudiantes; puedes preguntarlo." }[o.nature])}</p>
    </div>
    ${triple(o, true)}
  </div>
  <div id="research-status">${rr?.fromCache ? `<p class="small muted">Investigación guardada del ${new Date(r!.checkedAt).toLocaleDateString("es-ES")} · <button class="link-btn" id="re-research" type="button">Volver a comprobar</button></p>` : ""}</div>
  <div class="grid-2">
    <div>
      ${o.offer ? `<div class="panel"><h2>Oferta</h2><dl class="kv"><dt>Puesto</dt><dd>${esc(o.offer.title)}</dd>${o.offer.company ? `<dt>Empresa</dt><dd>${esc(o.offer.company)}</dd>` : ""}${o.offer.location ? `<dt>Ubicación</dt><dd>${esc(o.offer.location)}</dd>` : ""}${o.offer.contract ? `<dt>Contrato</dt><dd>${esc(o.offer.contract)}</dd>` : ""}<dt>Publicada</dt><dd>${o.offer.created ? new Date(o.offer.created).toLocaleDateString("es-ES") : "Sin fecha"}</dd><dt>Tipo</dt><dd>${o.offer.internship ? "Prácticas / becas" : "Empleo (no de prácticas)"}</dd></dl>${o.offer.snippet ? `<p class="snippet">${esc(o.offer.snippet)}<small class="muted"> (fragmento del portal)</small></p>` : ""}<a class="btn btn-sm btn-primary" href="${safeHref(o.offer.url)}" target="_blank" rel="noopener noreferrer">Ver oferta completa en ${esc(o.offer.source)} ↗</a></div>` : ""}
      <div class="panel"><h2>Por qué esta puntuación</h2>
        <details class="definition"><summary>¿Qué significan encaje, viabilidad y confianza?</summary><p><b>Encaje</b>: cuánto se adapta a tu perfil (tecnologías, actividad, ubicación y aprendizaje). Si faltan datos se acerca a 50 y se marca con *. <b>Viabilidad</b>: posibilidades reales de conseguirlas (oferta, programa, señales de contratación). <b>Confianza</b>: cuánto respaldo documental tienen los datos. Son independientes: una empresa puede encajar mucho y no aceptar estudiantes.</p></details>
        <h3 class="sub">Encaje ${o.score.fit}${o.score.fitProvisional ? " · provisional" : ""}</h3><div class="dims">${parts}</div>
        <h3 class="sub">Viabilidad ${o.score.viability}</h3><ul class="reason-list plain">${li(o.score.viabilityReasons)}</ul>
        <h3 class="sub">Confianza ${o.score.confidence} (${o.score.confidenceLevel})</h3><ul class="reason-list plain">${li(o.score.confidenceReasons)}</ul>
        <div class="pros-cons">${o.score.strengths.length ? `<div><h3 class="sub">A favor</h3><ul class="strengths">${li(o.score.strengths)}</ul></div>` : ""}${o.score.drawbacks.length ? `<div><h3 class="sub">Inconvenientes</h3><ul class="drawbacks">${li(o.score.drawbacks)}</ul></div>` : ""}${o.score.missing.length ? `<div><h3 class="sub">Falta saber</h3><ul class="missing">${li(o.score.missing)}</ul></div>` : ""}</div>
      </div>
      <div class="panel"><h2>Evidencias</h2>${evidenceList(o)}</div>
      <div class="panel"><h2>Tecnologías</h2>${techsHtml}</div>
      <div class="panel" id="assist-panel"><h2>Asistente de candidatura</h2>
        <p class="muted small">Redacta con los hechos comprobados de esta empresa y tu perfil. ${o.nature === "oferta_publicada" ? "Se adapta a la oferta." : "Como no hay oferta, el mensaje pregunta de forma transparente si aceptan estudiantes."} Revisa siempre el texto antes de enviarlo.</p>
        <div class="tabs" role="tablist">${(
          [
            ["analisis", "Análisis"],
            ["email", "Correo"],
            ["espontanea", "Candidatura espontánea"],
            ["linkedin", "LinkedIn"],
            ["entrevista", "Entrevista"],
            ["seguimiento", "Seguimiento"],
          ] as const
        )
          .map(([k, l], i) => `<button class="tab" role="tab" data-kind="${k}" aria-selected="${i === 0}">${l}</button>`)
          .join("")}</div>
        <div class="gen-bar"><button class="btn btn-primary btn-sm" id="as-gen" type="button"${meta.sources.ai ? "" : " disabled title='La IA no está configurada'"}>Generar</button><span class="muted small" id="as-meta">${!r && c.website ? "Consejo: investiga la empresa primero para que el texto tenga datos concretos." : ""}</span></div>
        <textarea class="output" id="as-out" rows="10" aria-label="Texto generado (editable)" placeholder="${meta.sources.ai ? "Pulsa «Generar»." : "La IA no está configurada: añade ANTHROPIC_API_KEY o el binding AI en Cloudflare."}"></textarea>
        <div class="gen-actions" id="as-actions" hidden><button class="btn btn-sm" id="as-copy" type="button">Copiar</button><a class="btn btn-sm" id="as-mail" hidden>Abrir en el correo</a></div>
      </div>
    </div>
    <div>
      <div class="panel" id="app-panel"><h2>Mi candidatura</h2><div class="skeleton" style="height:60px"></div></div>
      <div class="panel"><h2>Ficha de la empresa</h2><dl class="kv">
        <dt>Web</dt><dd>${c.website ? `<a href="${safeHref(c.website)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(c.website))}</a>` : `<form id="web-form" class="inline-form"><input name="w" type="url" placeholder="https://… (si la conoces)" required><button class="btn btn-sm" type="submit">Investigar</button></form>`}</dd>
        <dt>Actividad</dt><dd>${r?.activity.description ? `«${esc(r.activity.description)}» <small class="muted">(su web)</small>` : r?.activity.title ? esc(r.activity.title) : c.category ? `${esc(c.category)} <small class="muted">(categoría de búsqueda, sin confirmar)</small>` : "Desconocida"}</dd>
        ${r?.activity.headings.length ? `<dt>Titulares</dt><dd>${r.activity.headings.map(esc).join(" · ")}</dd>` : ""}
        <dt>Tamaño</dt><dd>${r?.size ? `${esc(r.size.text)} <small class="muted">(estimación)</small>` : "Desconocido"}</dd>
        <dt>Empleo</dt><dd>${r?.careersUrl ? `<a href="${safeHref(r.careersUrl)}" target="_blank" rel="noopener noreferrer">Página de empleo ↗</a>` : r ? "No encontrada" : "Sin investigar"}${r?.atsLinks.length ? ` · ${r.atsLinks.map((a) => `<a href="${safeHref(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.name)} ↗</a>`).join(" · ")}` : ""}</dd>
        <dt>Contacto</dt><dd>${[...(r?.emails ?? []).map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`), ...[c.phone, ...(r?.phones ?? [])].filter((x, i, a) => x && a.indexOf(x) === i).map((p) => `<a href="tel:${esc(String(p).replace(/\s/g, ""))}">${esc(p)}</a> <button class="link-btn" type="button" data-copy="${esc(p)}">copiar</button>`), r?.hasContactForm ? "formulario en su web" : ""].filter(Boolean).join(" · ") || "No publicado"}</dd>
        ${r?.socials.length ? `<dt>Redes</dt><dd>${r.socials.map((x) => `<a href="${safeHref(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.name)}</a>`).join(" · ")}</dd>` : ""}
        <dt>Responsables</dt><dd class="muted small">No recopilamos nombres de personas. Búscalos tú en LinkedIn si quieres dirigirte a alguien.</dd>
        <dt>Fuente</dt><dd>${c.sourceUrl ? `<a href="${safeHref(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(c.source)} ↗</a>` : esc(c.source)}${c.alsoIn ? ` · también en ${esc(c.alsoIn)}` : ""}</dd>
        <dt>Comprobado</dt><dd>${r ? new Date(r.checkedAt).toLocaleString("es-ES") : "—"}</dd>
      </dl>${r?.pages.length ? `<details><summary>Páginas revisadas (${r.pages.filter((p) => p.ok).length})</summary><ul class="small">${r.pages.map((p) => `<li>${p.ok ? "✓" : "✗"} <a href="${safeHref(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.title ?? p.url)}</a> <span class="muted">(${esc(p.why)})</span></li>`).join("")}</ul></details>` : ""}</div>
      <div class="panel"><h2>Reputación y experiencias</h2>${reviewsHtml}
        <h3 class="sub">Investiga a mano</h3><ul class="manual-links">${(rr?.reputationLinks ?? []).map((l) => `<li><a href="${safeHref(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)} ↗</a> <small class="muted">${esc(l.hint)}</small></li>`).join("") || `<li class="muted">Se muestran al investigar.</li>`}</ul>
        <p class="small muted">No se extraen opiniones de Glassdoor, Indeed ni LinkedIn (sus condiciones no lo permiten). Una valoración baja no implica malas prácticas.</p>
      </div>
    </div>
  </div>`;
  bindReviews(body);
  body.querySelector<HTMLAnchorElement>("[data-back]")?.addEventListener("click", (e) => {
    if (history.length > 1) {
      e.preventDefault();
      history.back();
    }
  });
  body.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => b.addEventListener("click", () => navigator.clipboard?.writeText(b.dataset.copy!).then(() => (b.textContent = "copiado ✓"))));
  $("#re-research")?.addEventListener("click", async () => {
    $("#research-status")!.innerHTML = `<div class="notice">Volviendo a comprobar…</div>`;
    try {
      const nr = await researchOne(o.key, undefined, true);
      if (nr) paintCompany(nr.opportunity, nr);
    } catch (e) {
      $("#research-status")!.innerHTML = errorBox(e as ApiError);
    }
  });
  $("#web-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const w = ((ev.target as HTMLFormElement).elements.namedItem("w") as HTMLInputElement).value.trim();
    $("#research-status")!.innerHTML = `<div class="notice">Investigando ${esc(hostOf(w))}…</div>`;
    try {
      const nr = await api<ResearchResp>("/api/practicas/research", { company: o.company, offer: o.offer, website: w });
      nr.opportunity.key = o.key;
      st.research.set(o.key, nr);
      upsertOpportunity(nr.opportunity);
      paintCompany(nr.opportunity, nr);
    } catch (e) {
      $("#research-status")!.innerHTML = errorBox(e as ApiError);
    }
  });
  bindAssistant(o);
  loadAppPanel(o);
}

function bindAssistant(o: InternOpportunity) {
  let kind = "analisis";
  const texts = new Map<string, string>();
  const out = () => $("#as-out") as HTMLTextAreaElement;
  const email = o.research?.emails[0];
  const paint = () => {
    const text = out().value.trim();
    $("#as-actions")!.hidden = !text;
    const mail = $("#as-mail") as HTMLAnchorElement;
    const isMail = kind === "email" || kind === "espontanea" || kind === "seguimiento";
    mail.hidden = !isMail;
    if (isMail) {
      const m = text.match(/^\s*asunto:\s*(.+)$/im);
      mail.href = `mailto:${encodeURIComponent(email ?? "")}?subject=${encodeURIComponent(m ? m[1].trim() : `Prácticas · ${o.company.name}`)}&body=${encodeURIComponent(m ? text.replace(m[0], "").trim() : text)}`;
      mail.textContent = email ? `Abrir en el correo (${email})` : "Abrir en el correo";
    }
  };
  const gen = async () => {
    const btn = $("#as-gen") as HTMLButtonElement;
    const k = kind;
    btn.disabled = true;
    btn.textContent = "Generando…";
    try {
      const r = await api<{ text: string; researched: boolean; meta: { estimatedCostUsd: number | null } }>("/api/practicas/generate", { kind: k, company: o.company, offer: o.offer });
      texts.set(k, r.text);
      if (kind === k) out().value = r.text;
      $("#as-meta")!.textContent = `${r.researched ? "Basado en la investigación guardada" : "Sin investigación: texto genérico"} · ${r.meta.estimatedCostUsd ? `≈ ${r.meta.estimatedCostUsd.toFixed(4)} US$` : "IA gratuita"}`;
    } catch (e) {
      out().placeholder = (e as Error).message;
    } finally {
      btn.disabled = false;
      btn.textContent = texts.has(kind) ? "Regenerar" : "Generar";
      paint();
    }
  };
  document.querySelectorAll<HTMLButtonElement>("#assist-panel .tab").forEach((t) =>
    t.addEventListener("click", () => {
      texts.set(kind, out().value);
      kind = t.dataset.kind!;
      document.querySelectorAll("#assist-panel .tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
      out().value = texts.get(kind) ?? "";
      ($("#as-gen") as HTMLButtonElement).textContent = texts.has(kind) ? "Regenerar" : "Generar";
      paint();
    }),
  );
  $("#as-gen")?.addEventListener("click", gen);
  $("#as-out")?.addEventListener("input", paint);
  $("#as-copy")?.addEventListener("click", () => navigator.clipboard?.writeText(out().value).then(() => (($("#as-copy")!.textContent = "Copiado ✓"), setTimeout(() => ($("#as-copy")!.textContent = "Copiar"), 1500))));
  $("#as-mail")?.addEventListener("click", async () => {
    const a = st.apps.get(o.key);
    if (a) await api("/api/practicas/app/update", { id: a.id, kind: "contacto", note: `Correo abierto para enviar (${kind})` }).catch(() => {});
  });
}

async function loadAppPanel(o: InternOpportunity) {
  const el = $("#app-panel");
  if (!el) return;
  await loadApps().catch(() => {});
  const a = st.apps.get(o.key);
  if (!a) {
    el.innerHTML = `<h2>Mi candidatura</h2><p class="muted small">Guárdala para llevar estados, notas, fechas de contacto, entrevistas y recordatorios de seguimiento.</p><div class="btn-row"><button class="btn btn-primary" type="button" data-add="seleccionada">☆ Guardar</button><button class="btn" type="button" data-add="pendiente_contactar">Guardar y contactar</button></div>`;
    el.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        if (await saveApp(o, b.dataset.add)) loadAppPanel(o);
      }),
    );
    return;
  }
  let acts: AppActivity[] = [];
  try {
    acts = (await api<{ activities: AppActivity[] }>(`/api/practicas/app?id=${encodeURIComponent(a.id)}`)).activities;
  } catch {}
  const overdue = a.next_date && a.next_date < todayStr() && st.meta!.statuses.find((x) => x.id === a.status)?.open;
  el.innerHTML = `<h2>Mi candidatura ${statusPill(a.status)}</h2>
    <div class="lead-grid">
      <label class="field"><span>Estado</span><select id="ap-status">${st.meta!.statuses.map((s) => `<option value="${s.id}"${s.id === a.status ? " selected" : ""}>${esc(s.label)}</option>`).join("")}</select></label>
      <label class="field"><span>Próximo paso</span><input id="ap-step" maxlength="200" value="${esc(a.next_step ?? "")}"></label>
      <label class="field"><span>Fecha del próximo paso</span><input id="ap-next" type="date" value="${a.next_date ?? ""}"></label>
      <label class="field"><span>Fecha de contacto</span><input id="ap-contact" type="date" value="${a.contact_date ?? ""}"></label>
      <label class="field"><span>Entrevista</span><input id="ap-int" type="date" value="${a.interview_date ?? ""}"></label>
      <label class="field"><span>Favorita</span><select id="ap-fav"><option value="0"${a.favorite ? "" : " selected"}>No</option><option value="1"${a.favorite ? " selected" : ""}>Sí ★</option></select></label>
    </div>
    ${overdue ? `<p class="warn-line">Seguimiento atrasado (${esc(fmtDate(a.next_date))}).</p>` : ""}
    <label class="field"><span>Notas personales</span><textarea id="ap-notes" rows="3" maxlength="4000">${esc(a.notes ?? "")}</textarea></label>
    <div class="note-box"><textarea id="ap-note" rows="2" maxlength="2000" placeholder="Apunta lo que ha pasado: «Envié correo a rrhh@», «Me llamaron para entrevista»…"></textarea><button class="btn btn-sm" type="button" id="ap-note-btn">Añadir al historial</button></div>
    <ol class="timeline">${acts.map((x) => `<li><span class="tl-k">${esc(x.kind)}</span><div>${esc(x.text ?? "")}${x.to_status ? ` → ${statusPill(x.to_status)}` : ""}<small>${new Date(x.at).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small></div></li>`).join("") || `<li class="muted">Sin actividad.</li>`}</ol>
    <button class="btn btn-sm btn-ghost danger" type="button" id="ap-del">Quitar de mis candidaturas</button>`;
  const upd = async (payload: Record<string, unknown>) => {
    try {
      await api("/api/practicas/app/update", { id: a.id, ...payload });
      await loadApps(true);
      loadAppPanel(o);
    } catch (e) {
      alert((e as Error).message);
    }
  };
  const val = (id: string) => ($(id) as HTMLInputElement).value;
  $("#ap-status")!.addEventListener("change", () => upd({ status: val("#ap-status") }));
  $("#ap-step")!.addEventListener("change", () => upd({ nextStep: val("#ap-step") || null }));
  $("#ap-next")!.addEventListener("change", () => upd({ nextDate: val("#ap-next") || null }));
  $("#ap-contact")!.addEventListener("change", () => upd({ contactDate: val("#ap-contact") || null, kind: "contacto", note: val("#ap-contact") ? `Contacto el ${val("#ap-contact")}` : undefined }));
  $("#ap-int")!.addEventListener("change", () => upd({ interviewDate: val("#ap-int") || null, ...(val("#ap-int") ? { status: "entrevista", kind: "entrevista", note: `Entrevista el ${val("#ap-int")}` } : {}) }));
  $("#ap-fav")!.addEventListener("change", () => upd({ favorite: val("#ap-fav") === "1" }));
  $("#ap-notes")!.addEventListener("change", () => upd({ notes: val("#ap-notes") || null }));
  $("#ap-note-btn")!.addEventListener("click", () => {
    const v = ($("#ap-note") as HTMLTextAreaElement).value.trim();
    if (v) upd({ note: v, kind: "nota" });
  });
  $("#ap-del")!.addEventListener("click", async () => {
    if (!confirm(`¿Quitar «${a.company_name}» de tus candidaturas? Se borran sus notas.`)) return;
    await api("/api/practicas/app/delete", { id: a.id });
    await loadApps(true);
    loadAppPanel(o);
  });
}

// ---------- Mis candidaturas (panel + lista) ----------

async function renderApps() {
  const body = $("#prac-body")!;
  const [sum] = await Promise.all([api<Summary>(`/api/practicas/summary?today=${todayStr()}`), loadApps(true)]);
  const apps = [...st.apps.values()];
  const meta = st.meta!;
  const row = (a: Application) => {
    const company = JSON.parse(a.company_json) as DirCompany;
    const offer = a.offer_json ? (JSON.parse(a.offer_json) as JobOffer) : null;
    const late = a.next_date && a.next_date < sum.today && meta.statuses.find((x) => x.id === a.status)?.open;
    return `<tr data-id="${esc(a.id)}">
      <td><a href="#/practicas/empresa/${encodeURIComponent(a.opp_key)}"><b>${a.favorite ? "★ " : ""}${esc(a.company_name)}</b></a><div class="muted small">${esc(offer?.title ?? company.category ?? "")}${company.city ? ` · ${esc(company.city)}` : ""}</div></td>
      <td>${natureBadge(a.nature as Nature)}</td>
      <td><select class="app-st" data-id="${esc(a.id)}" aria-label="Estado">${meta.statuses.map((s) => `<option value="${s.id}"${s.id === a.status ? " selected" : ""}>${esc(s.label)}</option>`).join("")}</select></td>
      <td class="mono">${a.fit ?? "—"}/${a.viability ?? "—"}</td>
      <td>${esc(a.next_step ?? "")}<div class="small${late ? " warn-line" : " muted"}">${a.next_date ? esc(fmtDate(a.next_date)) : ""}</div></td>
      <td class="small">${a.contact_date ? `Contacto ${esc(fmtDate(a.contact_date))}` : ""}${a.interview_date ? `<br>Entrevista ${esc(fmtDate(a.interview_date))}` : ""}</td>
    </tr>`;
  };
  const kpi = (n: number, l: string, cls = "") => `<div class="stat stat-static ${cls}"><span class="stat-n">${n}</span><span class="stat-l">${l}</span></div>`;
  const appLink = (a: Application, extra: string) => `<li><a href="#/practicas/empresa/${encodeURIComponent(a.opp_key)}">${esc(a.company_name)}</a> <span class="muted small">${extra}</span></li>`;
  body.innerHTML = `
    <div class="stats">${kpi(sum.active, "Activas")}${kpi(sum.waiting.length, "Esperando respuesta")}${kpi(sum.interviews.length, "Entrevistas próximas")}${kpi(sum.due.length, "Seguimientos (7 días)")}${kpi(sum.overdue, "Atrasados", sum.overdue ? "is-warn" : "")}</div>
    <div class="grid-3">
      <div class="panel"><h2>Seguimientos</h2><ul class="plain-list">${sum.due.map((a) => appLink(a, `${esc(a.next_step ?? "")} · ${esc(fmtDate(a.next_date))}`)).join("") || `<li class="muted">Nada pendiente.</li>`}</ul></div>
      <div class="panel"><h2>Entrevistas</h2><ul class="plain-list">${sum.interviews.map((a) => appLink(a, esc(fmtDate(a.interview_date)))).join("") || `<li class="muted">Sin entrevistas programadas.</li>`}</ul></div>
      <div class="panel"><h2>Esperando respuesta</h2><ul class="plain-list">${sum.waiting.map((a) => appLink(a, a.contact_date ? `contactada ${esc(fmtDate(a.contact_date).toLowerCase())}` : "")).join("") || `<li class="muted">Nadie pendiente.</li>`}</ul></div>
    </div>
    <div class="panel"><div class="form-head"><h2>Todas (${apps.length})</h2><div class="btn-row"><select id="apf" aria-label="Filtrar estado"><option value="">Todos los estados</option><option value="open">Solo activas</option>${meta.statuses.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("")}</select><button class="btn btn-sm btn-ghost" id="ap-csv" type="button">Exportar CSV</button></div></div>
      ${apps.length ? `<div class="table-wrap"><table class="apps"><thead><tr><th>Empresa</th><th>Naturaleza</th><th>Estado</th><th title="Encaje / viabilidad al guardar">E/V</th><th>Próximo paso</th><th>Fechas</th></tr></thead><tbody id="ap-rows">${apps.map(row).join("")}</tbody></table></div>` : `<div class="empty">Aún no has guardado ninguna. Busca prácticas y pulsa «☆ Guardar».</div>`}
    </div>
    <div class="panel"><h2>Actividad reciente</h2><ol class="timeline">${sum.activity.map((x) => `<li><span class="tl-k">${esc(x.kind)}</span><div><b>${esc(x.company_name)}</b> · ${esc(x.text ?? "")}${x.to_status ? ` → ${statusPill(x.to_status)}` : ""}<small>${new Date(x.at).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small></div></li>`).join("") || `<li class="muted">Sin actividad.</li>`}</ol></div>`;
  body.querySelectorAll<HTMLSelectElement>(".app-st").forEach((s) =>
    s.addEventListener("change", async () => {
      s.disabled = true;
      try {
        await api("/api/practicas/app/update", { id: s.dataset.id, status: s.value });
        renderApps();
      } catch (e) {
        alert((e as Error).message);
        s.disabled = false;
      }
    }),
  );
  $("#apf")?.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    body.querySelectorAll<HTMLTableRowElement>("#ap-rows tr").forEach((tr) => {
      const a = apps.find((x) => x.id === tr.dataset.id)!;
      tr.hidden = !!v && (v === "open" ? !meta.statuses.find((x) => x.id === a.status)?.open : a.status !== v);
    });
  });
  $("#ap-csv")?.addEventListener("click", () =>
    csvDownload(
      "candidaturas-practicas.csv",
      ["Empresa", "Oferta", "Naturaleza", "Estado", "Encaje", "Viabilidad", "Próximo paso", "Fecha próximo paso", "Contacto", "Entrevista", "Notas", "Web", "Enlace oferta"],
      apps.map((a) => {
        const c = JSON.parse(a.company_json) as DirCompany;
        const of = a.offer_json ? (JSON.parse(a.offer_json) as JobOffer) : null;
        return [a.company_name, of?.title, meta.natures[a.nature as Nature] ?? a.nature, meta.statuses.find((x) => x.id === a.status)?.label, a.fit, a.viability, a.next_step, a.next_date, a.contact_date, a.interview_date, a.notes, c.website, of?.url];
      }),
    ),
  );
}

// ---------- Comparar ----------

async function renderCompare() {
  const body = $("#prac-body")!;
  const keys = compareKeys();
  const opps = keys.map((k) => findOpp(k)).filter((x): x is InternOpportunity => !!x);
  if (opps.length < 2) {
    body.innerHTML = `<div class="empty">Marca «Comparar» en 2 a 4 resultados de la búsqueda para verlos lado a lado.</div>`;
    return;
  }
  const rows: Array<[string, (o: InternOpportunity) => string]> = [
    ["Naturaleza", (o) => natureBadge(o.nature)],
    ["Encaje", (o) => `<b>${o.score.fit}</b>${o.score.fitProvisional ? "*" : ""}`],
    ["Viabilidad", (o) => `<b>${o.score.viability}</b>`],
    ["Confianza", (o) => esc(o.score.confidenceLevel)],
    ["Modalidad", (o) => esc(MODALITY_LABEL[o.modality])],
    ["Distancia", (o) => (o.distanceKm !== undefined ? `${Math.round(o.distanceKm)} km` : "—")],
    ["Tecnologías", (o) => esc(o.techs.join(", ") || "—")],
    ...o_parts(),
    ["A favor", (o) => o.score.strengths.map(esc).join("<br>") || "—"],
    ["Inconvenientes", (o) => o.score.drawbacks.map(esc).join("<br>") || "—"],
    ["Falta saber", (o) => o.score.missing.map(esc).join("<br>") || "—"],
    ["Comprobado", (o) => (o.research ? new Date(o.research.checkedAt).toLocaleDateString("es-ES") : o.offer?.created ? `Oferta ${new Date(o.offer.created).toLocaleDateString("es-ES")}` : "Sin investigar")],
  ];
  body.innerHTML = `<div class="table-wrap"><table class="compare"><thead><tr><th></th>${opps.map((o) => `<th><a href="#/practicas/empresa/${encodeURIComponent(o.key)}">${esc(o.company.name)}</a>${o.offer ? `<div class="small muted">${esc(o.offer.title)}</div>` : ""}<button class="link-btn" type="button" data-rm="${esc(o.key)}">quitar</button></th>`).join("")}</tr></thead><tbody>${rows.map(([l, f]) => `<tr><th>${esc(l)}</th>${opps.map((o) => `<td>${f(o)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  body.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => {
      setCompare(compareKeys().filter((k) => k !== b.dataset.rm));
      location.hash = "#/practicas/comparar";
      renderPracticas("#/practicas/comparar");
    }),
  );
}

function o_parts(): Array<[string, (o: InternOpportunity) => string]> {
  return (["tech", "activity", "location", "learning"] as const).map((k) => [
    `· ${({ tech: "Tecnologías", activity: "Actividad", location: "Ubicación", learning: "Aprendizaje" } as const)[k]}`,
    (o: InternOpportunity) => {
      const p = o.score.parts.find((x) => x.key === k)!;
      return `${p.value === null ? "s/d" : Math.round(p.value * 100)} <small class="muted">${esc(p.reason)}</small>`;
    },
  ]);
}

export function practicasScreenContext(): string {
  const h = location.hash;
  if (!h.startsWith("#/practicas")) return "";
  const lines = ["Pantalla: Prácticas y empleo formativo."];
  if (st.profile) lines.push(`Perfil: ${st.profile.studies}, ${st.profile.location}, sabe ${st.profile.skills.join(", ")}`);
  const key = h.startsWith("#/practicas/empresa/") ? decodeURIComponent(h.slice("#/practicas/empresa/".length)) : null;
  const o = key ? findOpp(key) : null;
  if (o) lines.push(`Viendo: ${o.company.name} (${NATURE_SHORT[o.nature]}), encaje ${o.score.fit}, viabilidad ${o.score.viability}, confianza ${o.score.confidenceLevel}. Evidencias: ${(o.research?.evidence ?? []).map((e) => e.label).join("; ") || "ninguna"}.`);
  return lines.join("\n");
}

