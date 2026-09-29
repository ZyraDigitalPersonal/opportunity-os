import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery } from "../src/core/query-parser.js";
import { buildOverpassQuery, elementsToCompanies, toGeoArea } from "../src/core/osm.js";
import { analyzeHtml, auditWebsite, robotsAllowsRoot } from "../src/core/web-audit.js";
import { analyzeCompany } from "../src/core/opportunity-engine.js";
import { assertPublicHttpUrl } from "../src/core/http.js";
import { buildGenerationPrompt, createProvider } from "../src/core/ai.js";
import { getSector } from "../src/core/sectors.js";
import type { Company } from "../src/core/types.js";
import type { OverpassElement } from "../src/core/osm.js";

// ---------- Parser ----------

test("parser: sector + ciudad", () => {
  const p = parseQuery("Peluquerías en Lleida");
  assert.deepEqual(p.sectorIds, ["peluqueria"]);
  assert.equal(p.location, "Lleida");
});

test("parser: corta la ubicación en la condición y detecta intención", () => {
  const p = parseQuery("Peluquerías en Lleida que necesitan automatización");
  assert.equal(p.location, "Lleida");
  assert.deepEqual(p.intents, ["automatizacion"]);
});

test("parser: sin sector usa los sectores de la intención", () => {
  const p = parseQuery("Quiero encontrar negocios en Lleida que puedan necesitar agentes de IA.");
  assert.equal(p.location, "Lleida");
  assert.ok(p.intents.includes("ia"));
  assert.ok(p.sectorsFromIntent);
  assert.ok(p.sectorIds.includes("clinica_dental"));
});

test("parser: sectores de varias palabras y filtros", () => {
  const p = parseQuery("Clínicas dentales en Madrid sin web");
  assert.deepEqual(p.sectorIds, ["clinica_dental"]);
  assert.equal(p.location, "Madrid");
  assert.equal(p.filters.withoutWebsite, true);
  const q = parseQuery("Empresas de construcción en Zaragoza");
  assert.deepEqual(q.sectorIds, ["construccion"]);
  assert.equal(q.location, "Zaragoza");
});

test("parser: condición «con más de 100 reseñas» no se cuela en la ubicación", () => {
  const p = parseQuery("Busca peluquerías en Lleida con más de 100 reseñas y sin sistema de reservas");
  assert.equal(p.location, "Lleida");
  assert.equal(p.filters.withoutBooking, true);
});

test("parser: código postal", () => {
  const p = parseQuery("Restaurantes en 25001");
  assert.equal(p.postcode, "25001");
  assert.equal(p.location, undefined);
});

// ---------- OSM ----------

test("osm: área de relación y consulta Overpass", () => {
  const area = toGeoArea({ osm_type: "relation", osm_id: 341409, lat: "41.61", lon: "0.62", boundingbox: ["41.5", "41.7", "0.5", "0.7"], display_name: "Lleida, Segrià, Lleida, Cataluña, España" });
  assert.equal(area.overpassAreaId, 3600341409);
  assert.deepEqual(area.bbox, [41.5, 0.5, 41.7, 0.7]);
  const q = buildOverpassQuery(area, [getSector("peluqueria")!], 50);
  assert.match(q, /area\(3600341409\)->\.a;/);
  assert.match(q, /nwr\["shop"~"\^hairdresser\$"\]\["name"\]\(area\.a\);/);
});

test("osm: convierte elementos, normaliza web y deduplica", () => {
  const els: OverpassElement[] = [
    { type: "node" as const, id: 1, lat: 41.6, lon: 0.62, tags: { name: "Peluquería María", shop: "hairdresser", phone: "+34 973 00 00 00", website: "peluqueriamaria.es", "addr:street": "Carrer Major", "addr:housenumber": "3", "addr:city": "Lleida" } },
    { type: "node" as const, id: 2, lat: 41.60001, lon: 0.62001, tags: { name: "Peluquería María", shop: "hairdresser" } },
    { type: "way" as const, id: 3, center: { lat: 41.61, lon: 0.63 }, tags: { name: "Barber Joe", shop: "hairdresser", "contact:instagram": "@barberjoe" } },
    { type: "node" as const, id: 4, lat: 41.6, lon: 0.6, tags: { shop: "hairdresser" } },
  ];
  const cs = elementsToCompanies(els, [getSector("peluqueria")!], 10);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].website, "https://peluqueriamaria.es");
  assert.equal(cs[0].address, "Carrer Major 3");
  assert.equal(cs[1].instagram, "https://instagram.com/barberjoe");
  assert.equal(cs[1].sourceUrl, "https://www.openstreetmap.org/way/3");
});

// ---------- Auditoría web ----------

const OLD_SITE = `<html><head><title>Peluquería María</title><meta name="generator" content="WordPress 4.9"></head>
<body><p>Llámanos</p><a href="tel:+34973000000">973 00 00 00</a><a href="https://wa.me/34600000000">WhatsApp</a>
<a href="mailto:info@peluqueriamaria.es">info</a><a href="mailto:maria.garcia@gmail.com">María</a><footer>© 2016 Peluquería María</footer></body></html>`;

const MODERN_SITE = `<html><head><title>Dental Nova</title><meta name="viewport" content="width=device-width"><meta name="description" content="Clínica dental en Lleida con implantes y ortodoncia invisible">
<script type="application/ld+json">{"@type":"Dentist","name":"Dental Nova"}</script></head><body><h1>Dental Nova</h1>
<a class="btn" href="https://www.doctoralia.es/clinicas/dental-nova">Pide cita</a><form><input type="submit" value="Enviar"></form>
<script src="https://embed.tawk.to/abc/default"></script><a href="https://instagram.com/dentalnova">IG</a><footer>© 2019-2026 Dental Nova</footer></body></html>`;

test("auditoría: web antigua sin móvil ni reservas", () => {
  const a = analyzeHtml(OLD_SITE, "http://peluqueriamaria.es/", new Date("2026-09-29"));
  assert.equal(a.https, false);
  assert.equal(a.viewport, false);
  assert.equal(a.h1, false);
  assert.equal(a.telLinks, true);
  assert.equal(a.whatsappLink, true);
  assert.deepEqual(a.bookingProviders, []);
  assert.equal(a.copyrightYear, 2016);
  assert.equal(a.generator, "WordPress 4.9");
  assert.deepEqual(a.publicEmails, ["info@peluqueriamaria.es"], "no guarda emails personales");
});

test("auditoría: web moderna con reservas y chat", () => {
  const a = analyzeHtml(MODERN_SITE, "https://dentalnova.es/", new Date("2026-09-29"));
  assert.equal(a.viewport, true);
  assert.equal(a.metaDescription, true);
  assert.equal(a.schemaLocalBusiness, true);
  assert.deepEqual(a.bookingProviders, ["Doctoralia"]);
  assert.deepEqual(a.chatWidgets, ["Tawk.to"]);
  assert.equal(a.copyrightYear, 2026);
  assert.ok(a.ctas.includes("pide cita"));
  assert.deepEqual(a.socials, ["Instagram"]);
});

test("robots.txt", () => {
  assert.equal(robotsAllowsRoot("User-agent: *\nDisallow: /", "OpportunityOSBot"), false);
  assert.equal(robotsAllowsRoot("User-agent: *\nDisallow: /wp-admin/", "OpportunityOSBot"), true);
  assert.equal(robotsAllowsRoot("User-agent: *\nDisallow:", "OpportunityOSBot"), true);
  assert.equal(robotsAllowsRoot("User-agent: OpportunityOSBot\nDisallow: /\n\nUser-agent: *\nAllow: /", "OpportunityOSBot"), false);
});

test("SSRF: bloquea direcciones internas", () => {
  for (const u of ["http://localhost", "http://127.0.0.1", "http://10.0.0.1/admin", "http://[::1]/", "file:///etc/passwd", "http://intranet", "http://user:pw@example.com"]) {
    assert.throws(() => assertPublicHttpUrl(u), Error, u);
  }
  assert.equal(assertPublicHttpUrl("ejemplo.es").href, "https://ejemplo.es/");
});

test("auditWebsite respeta robots y mide la respuesta", async () => {
  const calls: string[] = [];
  const fake: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /privado", { status: 200 });
    const r = new Response(MODERN_SITE, { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(r, "url", { value: "https://dentalnova.es/" });
    return r;
  };
  let t = 1000;
  const audit = await auditWebsite("dentalnova.es", { userAgent: "test", botName: "OpportunityOSBot", fetchImpl: fake, now: () => (t += 400) });
  assert.equal(audit.reachable, true);
  assert.equal(audit.responseMs, 400);
  assert.deepEqual(audit.bookingProviders, ["Doctoralia"]);
  assert.deepEqual(calls, ["https://dentalnova.es/robots.txt", "https://dentalnova.es/"]);

  const blocked = await auditWebsite("dentalnova.es", { userAgent: "t", botName: "OpportunityOSBot", fetchImpl: async () => new Response("User-agent: *\nDisallow: /") });
  assert.equal(blocked.blockedByRobots, true);
});

// ---------- Opportunity Engine ----------

const base: Company = { id: "osm:node/1", name: "Peluquería María", sectorId: "peluqueria", sectorLabel: "Peluquería / barbería", lat: 41.6, lon: 0.62, city: "Lleida", phone: "+34 973 00 00 00", source: "OpenStreetMap", sourceUrl: "https://www.openstreetmap.org/node/1" };

test("engine: peluquería sin web → web + reservas + agente de voz, con motivos", () => {
  const a = analyzeCompany(base);
  const titles = a.opportunities.map((o) => o.title);
  assert.ok(titles.includes("Página web"));
  assert.ok(titles.includes("Sistema de reservas online"));
  assert.ok(titles.includes("Agente de voz IA"));
  assert.ok(a.score.score >= 60, `score ${a.score.score}`);
  assert.ok(a.score.items.every((i) => i.reason.length > 5));
  const noWeb = a.signals.find((s) => s.key === "no_website_found")!;
  assert.equal(noWeb.confidence, "inferido", "sin web en OSM no es un hecho comprobado");
  assert.equal(a.score.partial, false);
});

test("engine: web moderna con reservas y chat puntúa menos que web antigua", async () => {
  const withWeb = { ...base, website: "https://x.es" };
  const now = new Date("2026-09-29");
  const oldAudit = { url: "https://x.es", reachable: true, responseMs: 900, auditedAt: now.toISOString(), ...analyzeHtml(OLD_SITE, "http://x.es/", now) };
  const newAudit = { url: "https://x.es", reachable: true, responseMs: 300, auditedAt: now.toISOString(), ...analyzeHtml(MODERN_SITE.replace("Dentist", "HairSalon"), "https://x.es/", now) };
  const old = analyzeCompany(withWeb, oldAudit, now);
  const modern = analyzeCompany(withWeb, newAudit, now);
  assert.ok(old.score.score > modern.score.score + 25, `${old.score.score} vs ${modern.score.score}`);
  assert.ok(!modern.opportunities.some((o) => o.id === "booking"), "no propone reservas si ya las tiene");
  assert.ok(old.opportunities.some((o) => o.id === "whatsapp"));
  assert.ok(old.signals.some((s) => s.key === "old_copyright"));
  for (const d of Object.values(old.score.byDimension)) assert.ok(d >= 0);
  assert.ok(old.score.score <= 100);
});

test("engine: web con score parcial hasta auditarla", () => {
  const a = analyzeCompany({ ...base, website: "https://x.es" });
  assert.equal(a.score.partial, true);
});

// ---------- IA ----------

test("IA: el prompt separa verificados de inferidos y exige no inventar", () => {
  const a = analyzeCompany(base);
  const req = buildGenerationPrompt(a, "email", "Kilian");
  assert.match(req.system, /No inventes/);
  assert.match(req.prompt, /HECHOS VERIFICADOS:[\s\S]*has_phone/);
  assert.match(req.prompt, /HECHOS INFERIDOS[\s\S]*no_website_found/);
});

test("IA: sin clave devuelve la variable que falta", () => {
  assert.deepEqual(createProvider({}), { missing: "ANTHROPIC_API_KEY" });
  assert.deepEqual(createProvider({ AI_PROVIDER: "openai" }), { missing: "OPENAI_API_KEY" });
  const p = createProvider({ ANTHROPIC_API_KEY: "k" });
  assert.ok("generate" in p && p.model === "claude-sonnet-5-5");
});
