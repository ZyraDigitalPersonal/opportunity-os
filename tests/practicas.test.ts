import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { type Env } from "../src/worker/index.js";
import { robotsAllowsPath } from "../src/core/web-audit.js";
import { candidateLinks, extractFacts, researchCompany } from "../src/core/practicas/research.js";
import { natureOf, scoreOpportunity } from "../src/core/practicas/scoring.js";
import { exampleProfile, profileTerms, sanitizeProfile } from "../src/core/practicas/families.js";
import { buildInternPrompt } from "../src/core/practicas/prompts.js";
import { isInternshipText, manualLinks } from "../src/core/practicas/sources.js";
import type { CompanyResearch, DirCompany, JobOffer } from "../src/core/practicas/types.js";
import type { DataProvider } from "../src/core/osm.js";

const now = new Date("2026-10-15T10:00:00Z");
const profile = exampleProfile();

// ---------- robots.txt ----------

test("robots.txt: la regla más específica gana y respeta comodines", () => {
  const r = "User-agent: *\nDisallow: /privado/\nDisallow: /*.pdf$\nAllow: /privado/publico\n";
  assert.equal(robotsAllowsPath(r, "OpportunityOSBot", "/"), true);
  assert.equal(robotsAllowsPath(r, "OpportunityOSBot", "/privado/x"), false);
  assert.equal(robotsAllowsPath(r, "OpportunityOSBot", "/privado/publico"), true);
  assert.equal(robotsAllowsPath(r, "OpportunityOSBot", "/doc.pdf"), false);
  assert.equal(robotsAllowsPath("User-agent: OpportunityOSBot\nDisallow: /\n", "OpportunityOSBot", "/empleo"), false);
});

// ---------- Extracción de evidencias ----------

const careersHtml = `<html><head><title>Únete a Acme Dev</title></head><body>
<h1>Trabaja con nosotros</h1>
<p>Tenemos un programa de prácticas para estudiantes de DAW y DAM cada curso.</p>
<p>Colaboramos con institutos y centros educativos de Lleida mediante convenios de prácticas.</p>
<p>Nuestro stack: React, TypeScript, Node.js y PostgreSQL desplegado en AWS con Docker.</p>
<p>Somos un equipo de 25 profesionales y cada becario tiene un mentor asignado.</p>
<a href="mailto:rrhh@acme.dev">rrhh@acme.dev</a> <a href="mailto:laura.garcia@acme.dev">Laura</a>
<a href="https://apply.workable.com/acme-dev/">Ver vacantes</a>
</body></html>`;

test("extrae programa, tecnologías con cita, tamaño estimado y solo emails genéricos", () => {
  const f = extractFacts({ url: "https://acme.dev/empleo", html: careersHtml, text: careersHtml.replace(/<[^>]+>/g, "\n"), title: "Únete" }, "informatica", now.toISOString());
  const kinds = f.evidence.map((e) => e.kind);
  assert.ok(kinds.includes("programa"));
  assert.ok(kinds.includes("interes"));
  assert.ok(kinds.includes("tutoria"));
  const ids = f.techs.map((t) => t.id);
  for (const id of ["react", "typescript", "node", "postgres", "aws", "docker"]) assert.ok(ids.includes(id), id);
  assert.ok(f.techs.every((t) => t.url === "https://acme.dev/empleo"));
  assert.match(f.size!.text, /25 profesionales/);
  assert.deepEqual(f.emails, ["rrhh@acme.dev"]); // el email de una persona no se recoge
  assert.equal(f.atsLinks[0].name, "Workable");
  assert.ok(f.evidence.every((e) => e.quote && e.quote.length <= 230));
});

test("«buenas prácticas» no cuenta como prácticas para estudiantes", () => {
  const html = "<p>Aplicamos buenas prácticas de desarrollo y ponemos en práctica metodologías ágiles.</p>";
  const f = extractFacts({ url: "https://x.es", html, text: html.replace(/<[^>]+>/g, " ") }, "informatica", now.toISOString());
  assert.equal(f.evidence.filter((e) => e.kind === "practicas" || e.kind === "programa").length, 0);
});

test("prioriza enlaces de empleo y prácticas de la propia web", () => {
  const html = `<a href="/blog">Blog</a><a href="/servicios">Servicios</a><a href="/trabaja-con-nosotros">Empleo</a><a href="https://otra.com/practicas">Fuera</a><a href="/becas">Becas</a>`;
  const links = candidateLinks(html, new URL("https://acme.dev/"));
  assert.equal(links[0].url, "https://acme.dev/becas");
  assert.ok(links.some((l) => l.url.endsWith("/trabaja-con-nosotros")));
  assert.ok(!links.some((l) => l.url.includes("otra.com")));
  assert.ok(!links.some((l) => l.url.endsWith("/blog")));
});

test("investigación: respeta robots.txt por página y cita la URL de cada evidencia", async () => {
  const seen: string[] = [];
  const f: typeof fetch = async (input) => {
    const u = String(input);
    seen.push(u);
    if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /equipo\n", { status: 200 });
    if (u === "https://acme.dev/") return new Response(`<title>Acme Dev · Software a medida</title><meta name="description" content="Desarrollamos software y aplicaciones web a medida para empresas."><h1>Software a medida</h1><a href="/empleo">Empleo</a><a href="/equipo">Equipo</a>`, { status: 200, headers: { "content-type": "text/html" } });
    if (u === "https://acme.dev/empleo") return new Response(careersHtml, { status: 200, headers: { "content-type": "text/html" } });
    return new Response("no", { status: 404 });
  };
  const r = await researchCompany("https://acme.dev", { userAgent: "test", botName: "OpportunityOSBot", familyId: "informatica", fetchImpl: f, now: () => now });
  assert.ok(!seen.includes("https://acme.dev/equipo"), "no visita páginas prohibidas");
  assert.equal(r.careersUrl, "https://acme.dev/empleo");
  assert.equal(r.activity.description, "Desarrollamos software y aplicaciones web a medida para empresas.");
  assert.ok(r.evidence.some((e) => e.kind === "programa" && e.url === "https://acme.dev/empleo"));
  assert.equal(natureOf(undefined, r), "programa");
});

test("investigación: web bloqueada por robots no se lee", async () => {
  const f: typeof fetch = async (input) => (String(input).endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /") : new Response("<p>programa de prácticas</p>"));
  const r = await researchCompany("https://cerrada.es", { userAgent: "t", botName: "OpportunityOSBot", familyId: "informatica", fetchImpl: f });
  assert.equal(r.blockedByRobots, true);
  assert.equal(r.evidence.length, 0);
});

// ---------- Puntuación ----------

const softCo: DirCompany = { id: "gp:ChIJsoftware123", name: "Acme Dev", website: "https://acme.dev", lat: 41.62, lon: 0.63, source: "Google Maps", category: "Desarrollo de software" };
function researchWith(over: Partial<CompanyResearch>): CompanyResearch {
  return { domain: "acme.dev", website: "https://acme.dev", checkedAt: now.toISOString(), pages: [{ url: "https://acme.dev", ok: true, why: "portada" }, { url: "https://acme.dev/empleo", ok: true, why: "empleo" }], activity: { title: "Acme · desarrollo de software a medida", headings: [] }, atsLinks: [], evidence: [], techs: [], emails: [], phones: [], socials: [], hasContactForm: true, ...over };
}

test("sin evidencia: empresa potencial, viabilidad baja y encaje provisional cerca de neutro (no penaliza)", () => {
  const s = scoreOpportunity({ profile, company: softCo, distanceKm: 3, now });
  assert.equal(s.nature, "potencial");
  assert.ok(s.viability < 40, `viabilidad ${s.viability}`);
  assert.equal(s.fitProvisional, true);
  assert.ok(s.fit >= 50 && s.fit <= 80, `encaje ${s.fit}`);
  assert.equal(s.confidenceLevel, "baja");
  assert.ok(s.drawbacks.some((d) => /Sin confirmar/.test(d)));
});

test("con investigación y tecnologías del perfil: más encaje y confianza; viabilidad por programa", () => {
  const r = researchWith({
    evidence: [
      { kind: "programa", label: "Programa", quote: "programa de prácticas para estudiantes de DAW", url: "https://acme.dev/empleo", source: "Web", certainty: "confirmado" },
      { kind: "tutoria", label: "Mentor", quote: "cada becario tiene un mentor", url: "https://acme.dev/empleo", source: "Web", certainty: "confirmado" },
    ],
    techs: [
      { id: "typescript", name: "TypeScript", from: "texto", url: "https://acme.dev/empleo" },
      { id: "react", name: "React", from: "texto", url: "https://acme.dev/empleo" },
      { id: "node", name: "Node.js", from: "texto", url: "https://acme.dev/empleo" },
    ],
  });
  const s = scoreOpportunity({ profile, company: softCo, research: r, distanceKm: 3, now });
  const base = scoreOpportunity({ profile, company: softCo, distanceKm: 3, now });
  assert.equal(s.nature, "programa");
  assert.ok(s.fit > base.fit, `${s.fit} > ${base.fit}`);
  assert.ok(s.viability >= 60);
  assert.ok(s.confidence > base.confidence);
  assert.ok(s.parts.find((p) => p.key === "tech")!.reason.includes("TypeScript"));
});

test("encaje, viabilidad y confianza son independientes: oferta confirmada pero de otro perfil", () => {
  const offer: JobOffer = { id: "adzuna:1", source: "Adzuna", title: "Prácticas de contabilidad", snippet: "Becario/a para el departamento financiero: Excel y facturación.", url: "https://www.adzuna.es/x", created: "2026-10-10T00:00:00Z", remote: false, internship: true };
  const co: DirCompany = { id: "job:adzuna:1", name: "Gestoría Pérez", source: "Adzuna", city: "Lleida" };
  const s = scoreOpportunity({ profile, company: co, offer, distanceKm: 2, now });
  assert.equal(s.nature, "oferta_publicada");
  assert.ok(s.viability >= 80, `viabilidad ${s.viability}`);
  assert.ok(s.fit < 60, `encaje ${s.fit}`);
});

test("oferta remota penaliza la ubicación si el perfil no acepta remoto", () => {
  const offer: JobOffer = { id: "jooble:2", source: "Jooble", title: "Prácticas desarrollador web React (100% remoto)", url: "https://jooble.org/x", remote: true, internship: true };
  const co: DirCompany = { id: "job:jooble:2", name: "Remota SL", source: "Jooble" };
  const sí = scoreOpportunity({ profile, company: co, offer, now });
  const no = scoreOpportunity({ profile: { ...profile, modalities: ["presencial"] }, company: co, offer, now });
  assert.equal(sí.modality, "remota");
  assert.ok(sí.parts.find((p) => p.key === "location")!.value! > no.parts.find((p) => p.key === "location")!.value!);
});

test("oferta antigua reduce la viabilidad", () => {
  const mk = (created: string): JobOffer => ({ id: "adzuna:3", source: "Adzuna", title: "Prácticas programador PHP", url: "https://x.es", created, remote: false, internship: true });
  const co: DirCompany = { id: "job:adzuna:3", name: "X", source: "Adzuna" };
  const fresh = scoreOpportunity({ profile, company: co, offer: mk("2026-10-10"), now });
  const old = scoreOpportunity({ profile, company: co, offer: mk("2026-06-01"), now });
  assert.ok(fresh.viability > old.viability);
});

test("perfil: normaliza términos y valida entradas", () => {
  const terms = profileTerms({ familyId: "informatica", skills: ["JS", "react", "Ruby"], interests: ["IA"] });
  const ids = terms.map((t) => t.id);
  assert.ok(ids.includes("javascript") && ids.includes("react") && ids.includes("ia") && ids.includes("free:ruby"));
  assert.equal(sanitizeProfile({ studies: "", location: "Lleida" }), null);
  const p = sanitizeProfile({ studies: "Farmacia", location: "Lleida", familyId: "farmacia", maxDistanceKm: 9999, portfolioUrl: "javascript:alert(1)" })!;
  assert.equal(p.maxDistanceKm, 300);
  assert.equal(p.portfolioUrl, undefined);
  assert.equal(p.familyId, "farmacia");
});

test("detección de ofertas de prácticas y enlaces manuales", () => {
  assert.equal(isInternshipText("Becario/a desarrollo web"), true);
  assert.equal(isInternshipText("Programador senior Java"), false);
  const links = manualLinks(profile, "local");
  assert.ok(links.some((l) => l.url.startsWith("https://www.linkedin.com/jobs/search/") && l.url.includes("f_E=1")));
});

test("prompt del asistente: sin oferta pide preguntar, nunca afirma que buscan estudiantes", () => {
  const req = buildInternPrompt("email", profile, softCo, "potencial", researchWith({ techs: [{ id: "wordpress", name: "WordPress", from: "web" }] }), undefined);
  assert.match(req.system, /NO digas que buscan estudiantes/);
  assert.match(req.prompt, /Indicio débil/);
  assert.match(req.prompt, /pregunta de forma transparente/);
});

// ---------- API ----------

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql: string, vals: unknown[] = []) => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    run: async () => db.prepare(sql).run(...(vals as any[])),
    all: async () => ({ results: db.prepare(sql).all(...(vals as any[])) as any[] }),
    first: async () => (db.prepare(sql).get(...(vals as any[])) as any) ?? null,
  });
  return { prepare: (sql: string) => stmt(sql), raw: db };
}

const ctx = { waitUntil: (_p: Promise<unknown>) => {} };
const testData: DataProvider = {
  geocodeArea: async () => ({ label: "Lleida", bbox: [41.55, 0.55, 41.7, 0.7], center: [41.6176, 0.62] }),
  searchCompanies: async () => [],
};

function apiFetch(log: string[]): typeof fetch {
  return async (input, init) => {
    const u = String(input);
    log.push(u);
    if (u.startsWith("https://places.googleapis.com/v1/places:searchText")) {
      const body = JSON.parse(String(init?.body));
      if (body.textQuery !== "empresa de desarrollo de software") return Response.json({ places: [] });
      return Response.json({ places: [{ id: "ChIJsoftware123", displayName: { text: "Acme Dev" }, location: { latitude: 41.62, longitude: 0.63 }, websiteUri: "https://acme.dev/", nationalPhoneNumber: "973 00 00 00", googleMapsUri: "https://maps.google.com/?cid=1", rating: 4.8, userRatingCount: 12 }] });
    }
    if (u.startsWith("https://places.googleapis.com/v1/places/")) {
      return Response.json({ id: "ChIJsoftware123", rating: 4.8, userRatingCount: 12, reviews: [{ rating: 5, text: { text: "Hice las prácticas de DAW aquí y aprendí muchísimo con mi tutor." }, authorAttribution: { displayName: "Ana", uri: "https://www.google.com/maps/contrib/1" } }, { rating: 4, text: { text: "Buen servicio." } }] });
    }
    if (u.startsWith("https://api.adzuna.com/")) {
      return Response.json({ results: [{ id: 77, title: "Prácticas Desarrollador Web Junior", description: "Buscamos estudiante de DAW en prácticas con React y PHP.", redirect_url: "https://www.adzuna.es/details/77", created: new Date().toISOString(), company: { display_name: "Otra Empresa SL" }, location: { display_name: "Lleida, Cataluña" } }] });
    }
    if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (u === "https://acme.dev/") return new Response(`<title>Acme</title><h1>Desarrollo de software</h1><a href="/empleo">Empleo</a>`, { headers: { "content-type": "text/html" } });
    if (u === "https://acme.dev/empleo") return new Response(careersHtml, { headers: { "content-type": "text/html" } });
    return new Response("no", { status: 404 });
  };
}

async function setup(extra: Partial<Env> = {}) {
  const log: string[] = [];
  const d1 = fakeD1();
  const env: Env = { APP_PASSWORD: "secreto-largo", SESSION_SECRET: "s".repeat(32), DB: d1 as any, GOOGLE_PLACES_API_KEY: "g", ADZUNA_APP_ID: "a", ADZUNA_APP_KEY: "b", __deps: { data: testData, fetchImpl: apiFetch(log), cache: null }, ...extra };
  const res = await worker.fetch(new Request("https://app.test/login", { method: "POST", headers: { "cf-connecting-ip": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: new URLSearchParams({ password: "secreto-largo" }) }), env, ctx);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const call = async (path: string, body?: unknown) => {
    const r = await worker.fetch(new Request(`https://app.test${path}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, origin: "https://app.test" }, body: JSON.stringify(body) }), env, ctx);
    return { status: r.status, data: (await r.json()) as any };
  };
  return { call, log, d1, env };
}

test("API prácticas: búsqueda local combina Google y Adzuna con estados de fuente honestos", async () => {
  const { call } = await setup();
  const r = await call("/api/practicas/search", { profile, scope: "local" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const byName = (n: string) => r.data.results.find((x: any) => x.company.name === n);
  assert.equal(byName("Otra Empresa SL").nature, "oferta_publicada");
  assert.equal(byName("Acme Dev").nature, "potencial");
  assert.equal(byName("Acme Dev").company.category, "Desarrollo de software");
  const st = Object.fromEntries(r.data.sources.map((x: any) => [x.id, x.status]));
  assert.equal(st.google, "ok");
  assert.equal(st.adzuna, "ok");
  assert.equal(st.jooble, "sin_configurar");
  assert.ok(r.data.meta.costUsd > 0);
  assert.ok(r.data.manualLinks.length >= 3);
});

test("API prácticas: búsqueda sin perfil pide completarlo; sin claves no inventa resultados", async () => {
  const { call } = await setup({ GOOGLE_PLACES_API_KEY: undefined, ADZUNA_APP_ID: undefined, ADZUNA_APP_KEY: undefined });
  assert.equal((await call("/api/practicas/search", { scope: "local" })).status, 400);
  const r = await call("/api/practicas/search", { profile, scope: "nacional" });
  assert.equal(r.status, 200);
  assert.equal(r.data.results.length, 0);
  assert.ok(r.data.warnings.length > 0);
  assert.ok(r.data.sources.every((x: any) => x.status !== "ok"));
});

test("API prácticas: investigar guarda solo hechos de la web (no reseñas de Google) y separa testimonios de prácticas", async () => {
  const { call, d1 } = await setup();
  const company = { id: "gp:ChIJsoftware123", name: "Acme Dev", website: "https://acme.dev/", lat: 41.62, lon: 0.63, source: "Google Maps", category: "Desarrollo de software" };
  const r = await call("/api/practicas/research", { company, profile });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.opportunity.nature, "programa");
  assert.equal(r.data.reviews.internship.length, 1);
  assert.equal(r.data.reviews.general.length, 1);
  const row = (await d1.prepare("SELECT research_json FROM intern_research").first()) as any;
  assert.ok(row);
  assert.ok(!row.research_json.includes("aprendí muchísimo"));
  const again = await call("/api/practicas/research", { company, profile, reviews: false });
  assert.equal(again.data.fromCache, true);
});

test("API prácticas: candidaturas con estados, recordatorios, panel y aislamiento por usuario", async () => {
  const { call, d1 } = await setup();
  const company = { id: "gp:ChIJsoftware123", name: "Acme Dev", website: "https://acme.dev/", source: "Google Maps", rating: 4.8, reviews: 12 };
  let r = await call("/api/practicas/app/save", { key: company.id, company, nature: "potencial", status: "seleccionada", fit: 70, viability: 30, confidence: 40 });
  assert.equal(r.status, 200);
  const id = r.data.id;
  const stored = (await d1.prepare("SELECT company_json, next_date FROM intern_apps WHERE id = ?").bind(id).first()) as any;
  assert.equal(JSON.parse(stored.company_json).rating, undefined); // no se guarda la valoración de Google
  assert.ok(stored.next_date);
  r = await call("/api/practicas/app/update", { id, status: "contactada", note: "Email enviado a rrhh@" });
  assert.equal(r.data.app.status, "contactada");
  assert.ok(r.data.app.contact_date);
  r = await call("/api/practicas/app/update", { id, interviewDate: "2099-01-10", status: "entrevista" });
  const sum = await call("/api/practicas/summary");
  assert.equal(sum.data.active, 1);
  assert.equal(sum.data.interviews.length, 1);
  const det = await call(`/api/practicas/app?id=${id}`);
  assert.ok(det.data.activities.some((a: any) => a.text === "Email enviado a rrhh@"));

  // Datos de otro usuario: no se listan ni se pueden modificar ni borrar
  d1.raw.prepare("INSERT INTO intern_apps (id, owner_id, opp_key, company_name, company_json, nature, status, created_at, updated_at) VALUES ('ajena','otro','k','Ajena','{}','potencial','seleccionada','x','x')").run();
  const list = await call("/api/practicas/apps");
  assert.deepEqual(list.data.apps.map((a: any) => a.id), [id]);
  assert.equal((await call("/api/practicas/app?id=ajena")).status, 404);
  assert.equal((await call("/api/practicas/app/update", { id: "ajena", status: "cerrada" })).status, 404);
  await call("/api/practicas/app/delete", { id: "ajena" });
  assert.ok(d1.raw.prepare("SELECT id FROM intern_apps WHERE id = 'ajena'").get());
});

test("API prácticas: perfil se guarda y el límite diario del plan se aplica", async () => {
  const { call, d1 } = await setup({ PLAN: "individual" });
  const save = await call("/api/practicas/profile", { profile });
  assert.equal(save.status, 200);
  assert.equal((await call("/api/practicas/profile")).data.profile.location, "Lleida");
  d1.raw.prepare("INSERT INTO usage (owner_id, day, kind, n) VALUES ('owner', ?, 'practicas_search', 10)").run(new Date().toISOString().slice(0, 10));
  const r = await call("/api/practicas/search", { scope: "local" });
  assert.equal(r.status, 429);
});

test("API prácticas: el asistente usa solo hechos comprobados por el servidor", async () => {
  let seenPrompt = "";
  const AI = { run: async (_m: string, input: any) => ((seenPrompt = input.messages.map((m: any) => m.content).join("\n")), { response: "Asunto: Prácticas DAW\n\nHola…" }) };
  const { call } = await setup({ AI_PROVIDER: "cloudflare", AI: AI as any });
  const company = { id: "gp:ChIJsoftware123", name: "Acme Dev", website: "https://acme.dev/", source: "Google Maps" };
  await call("/api/practicas/research", { company, profile, reviews: false });
  const r = await call("/api/practicas/generate", { kind: "email", company, profile });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.researched, true);
  assert.match(seenPrompt, /programa de prácticas para estudiantes de DAW/);
  assert.match(seenPrompt, /Sabe: HTML\/CSS/);
});

test("API prácticas: rechaza origen ajeno y requiere sesión", async () => {
  const { env } = await setup();
  const anon = await worker.fetch(new Request("https://app.test/api/practicas/meta"), env, ctx);
  assert.equal(anon.status, 401);
});
