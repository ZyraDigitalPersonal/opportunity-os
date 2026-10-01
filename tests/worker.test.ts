import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../src/worker/index.js";
import type { DataProvider } from "../src/core/osm.js";
import type { Company, GeoArea } from "../src/core/types.js";

const ctx = { waitUntil: (_p: Promise<unknown>) => {} };

const area: GeoArea = { label: "Lleida", overpassAreaId: 3600341409, bbox: [41.5, 0.5, 41.7, 0.7], center: [41.61, 0.62] };
const companies: Company[] = [
  { id: "osm:node/1", name: "Peluquería Sin Web", sectorId: "peluqueria", sectorLabel: "Peluquería / barbería", lat: 41.6, lon: 0.62, phone: "973", source: "OpenStreetMap", sourceUrl: "https://www.openstreetmap.org/node/1" },
  { id: "osm:node/2", name: "Peluquería Con Web", sectorId: "peluqueria", sectorLabel: "Peluquería / barbería", lat: 41.61, lon: 0.63, website: "https://conweb.es", source: "OpenStreetMap", sourceUrl: "https://www.openstreetmap.org/node/2" },
];

// Proveedor de prueba: solo existe en los tests, nunca en la app.
const testData: DataProvider = {
  geocodeArea: async () => area,
  searchCompanies: async () => companies,
};
const fakeFetch: typeof fetch = async (input) => {
  const u = String(input);
  if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
  return new Response(`<html><head><meta name="viewport" content="width=device-width"></head><body><a href="https://booksy.com/x">Reservar</a></body></html>`, { status: 200 });
};

const env: Env = { APP_PASSWORD: "secreto-largo", SESSION_SECRET: "s".repeat(32), CONTACT_EMAIL: "test@example.com", __deps: { data: testData, fetchImpl: fakeFetch, cache: null } };

let ipCounter = 0;
async function login(): Promise<string> {
  // Cada test usa una IP distinta para no chocar con el límite de intentos de login.
  const headers = { "cf-connecting-ip": `10.0.0.${++ipCounter}` };
  const res = await worker.fetch(new Request("https://app.test/login", { method: "POST", headers, body: new URLSearchParams({ password: "secreto-largo" }) }), env, ctx);
  assert.equal(res.status, 303);
  return res.headers.get("set-cookie")!.split(";")[0];
}

test("sin sesión: la API responde 401 y las páginas redirigen a login", async () => {
  const api = await worker.fetch(new Request("https://app.test/api/search", { method: "POST", body: "{}" }), env, ctx);
  assert.equal(api.status, 401);
  const page = await worker.fetch(new Request("https://app.test/"), env, ctx);
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/login");
  assert.ok(page.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
});

test("contraseña incorrecta", async () => {
  const res = await worker.fetch(new Request("https://app.test/login", { method: "POST", body: new URLSearchParams({ password: "no" }) }), env, ctx);
  assert.equal(res.status, 401);
});

test("sin APP_PASSWORD la app no arranca abierta", async () => {
  const res = await worker.fetch(new Request("https://app.test/"), { ...env, APP_PASSWORD: undefined }, ctx);
  assert.equal(res.status, 503);
});

test("búsqueda completa: ordena por score y explica", async () => {
  const cookie = await login();
  const res = await worker.fetch(new Request("https://app.test/api/search", { method: "POST", headers: { cookie, origin: "https://app.test" }, body: JSON.stringify({ q: "Peluquerías en Lleida" }) }), env, ctx);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.results.length, 2);
  assert.equal(data.results[0].company.name, "Peluquería Sin Web");
  assert.ok(data.results[0].score.items.length > 0);
  assert.equal(data.meta.source, "OpenStreetMap");
});

test("búsqueda «sin web» filtra", async () => {
  const cookie = await login();
  const res = await worker.fetch(new Request("https://app.test/api/search", { method: "POST", headers: { cookie }, body: JSON.stringify({ q: "Peluquerías en Lleida sin web" }) }), env, ctx);
  const data = (await res.json()) as any;
  assert.deepEqual(data.results.map((r: any) => r.company.id), ["osm:node/1"]);
});

test("búsqueda sin zona pide una zona", async () => {
  const cookie = await login();
  const res = await worker.fetch(new Request("https://app.test/api/search", { method: "POST", headers: { cookie }, body: JSON.stringify({ q: "peluquerías" }) }), env, ctx);
  assert.equal(res.status, 400);
});

test("analizar: audita la web y detecta Booksy", async () => {
  const cookie = await login();
  const res = await worker.fetch(new Request("https://app.test/api/analyze", { method: "POST", headers: { cookie }, body: JSON.stringify({ company: companies[1] }) }), env, ctx);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.deepEqual(data.analysis.audit.bookingProviders, ["Booksy"]);
  assert.ok(!data.analysis.opportunities.some((o: any) => o.id === "booking"));
});

test("analizar: rechaza empresas manipuladas", async () => {
  const cookie = await login();
  const res = await worker.fetch(new Request("https://app.test/api/analyze", { method: "POST", headers: { cookie }, body: JSON.stringify({ company: { ...companies[0], id: "../../etc" } }) }), env, ctx);
  assert.equal(res.status, 400);
});

test("CSRF: rechaza otro origen", async () => {
  const cookie = await login();
  const res = await worker.fetch(new Request("https://app.test/api/search", { method: "POST", headers: { cookie, origin: "https://malicioso.com" }, body: JSON.stringify({ q: "x en Lleida" }) }), env, ctx);
  assert.equal(res.status, 403);
});

test("Google e IA sin clave: mensaje claro, no datos falsos", async () => {
  const cookie = await login();
  const g = await worker.fetch(new Request("https://app.test/api/google", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "x", lat: 1, lon: 1 }) }), env, ctx);
  assert.equal(g.status, 503);
  assert.equal(((await g.json()) as any).missing, "GOOGLE_PLACES_API_KEY");
  const ai = await worker.fetch(new Request("https://app.test/api/generate", { method: "POST", headers: { cookie }, body: JSON.stringify({ kind: "email", company: companies[0] }) }), env, ctx);
  assert.equal(ai.status, 503);
  assert.equal(((await ai.json()) as any).missing, "ANTHROPIC_API_KEY");
});

test("IA con clave: llama a Anthropic con las señales", async () => {
  const cookie = await login();
  let sent: any;
  const aiFetch: typeof fetch = async (input, init) => {
    if (String(input).includes("anthropic.com")) {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Hola, he visto que…" }], usage: { input_tokens: 800, output_tokens: 150 } }), { status: 200 });
    }
    return fakeFetch(input, init);
  };
  const e2: Env = { ...env, ANTHROPIC_API_KEY: "k", __deps: { ...env.__deps, fetchImpl: aiFetch } };
  {
    const res = await worker.fetch(new Request("https://app.test/api/generate", { method: "POST", headers: { cookie }, body: JSON.stringify({ kind: "whatsapp", company: companies[0] }) }), e2, ctx);
    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.text, "Hola, he visto que…");
    assert.ok(data.meta.estimatedCostUsd > 0);
    assert.match(sent.messages[0].content, /no_website_found/);
  }
});

test("login: bloquea tras 8 intentos fallidos", async () => {
  const headers = { "cf-connecting-ip": "203.0.113.9" };
  let last: Response | undefined;
  for (let i = 0; i < 9; i++) last = await worker.fetch(new Request("https://app.test/login", { method: "POST", headers, body: new URLSearchParams({ password: "mal" }) }), env, ctx);
  assert.match(await last!.text(), /Demasiados intentos/);
});

test("búsqueda con Google: une fuentes y avisa si OSM falla", async () => {
  const cookie = await login();
  const googleCompanies: Company[] = [
    { id: "gp:ChIJabcdefghij", name: "Clínica Google", sectorId: "clinica_dental", sectorLabel: "Clínica dental", lat: 41.6, lon: 0.62, phone: "973", rating: 4.8, reviews: 12, source: "Google", sourceUrl: "https://maps.google.com/?cid=1" },
  ];
  const envG: Env = {
    ...env,
    __deps: {
      data: { geocodeArea: async () => area, searchCompanies: async () => { throw new Error("overpass caído"); } },
      google: { searchCompanies: async () => ({ companies: googleCompanies, calls: 2, truncated: false }) },
      fetchImpl: fakeFetch,
      cache: null,
    },
  };
  const res = await worker.fetch(new Request("https://app.test/api/search", { method: "POST", headers: { cookie, origin: "https://app.test" }, body: JSON.stringify({ q: "clinica dental lleida" }) }), envG, ctx);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].company.source, "Google");
  assert.ok(data.warnings.some((w: string) => /OpenStreetMap/.test(w)));
  assert.equal(data.meta.googleCalls, 2);

  // La ficha de Google se puede analizar
  const an = await worker.fetch(new Request("https://app.test/api/analyze", { method: "POST", headers: { cookie, origin: "https://app.test" }, body: JSON.stringify({ company: data.results[0].company }) }), envG, ctx);
  assert.equal(an.status, 200);
});

test("búsqueda sin CONTACT_EMAIL ya no se bloquea", async () => {
  const cookie = await login();
  const res = await worker.fetch(new Request("https://app.test/api/search", { method: "POST", headers: { cookie, origin: "https://app.test" }, body: JSON.stringify({ q: "Peluquerías en Lleida" }) }), { ...env, CONTACT_EMAIL: undefined }, ctx);
  assert.equal(res.status, 200);
});

test("favicon se sirve sin sesión", async () => {
  const assets = { fetch: async (r: Request) => new Response(new URL(r.url).pathname, { status: 200 }) };
  const res = await worker.fetch(new Request("https://app.test/favicon.ico"), { ...env, ASSETS: assets }, ctx);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "/favicon.svg");
});

test("asistente e IA gratis con Workers AI cuando no hay clave de pago", async () => {
  const cookie = await login();
  const calls: any[] = [];
  const AI = { run: async (model: string, input: any) => (calls.push({ model, input }), { response: "Respuesta de prueba", usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  const envAI: Env = { ...env, AI };
  const res = await worker.fetch(new Request("https://app.test/api/assistant", { method: "POST", headers: { cookie, origin: "https://app.test" }, body: JSON.stringify({ messages: [{ role: "user", content: "¿Qué es el score?" }] }) }), envAI, ctx);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).text, "Respuesta de prueba");
  assert.equal(calls[0].input.messages[0].role, "system");
  const gen = await worker.fetch(new Request("https://app.test/api/generate", { method: "POST", headers: { cookie, origin: "https://app.test" }, body: JSON.stringify({ kind: "email", company: companies[0] }) }), envAI, ctx);
  assert.equal(gen.status, 200);
  const cfg = await worker.fetch(new Request("https://app.test/api/config", { headers: { cookie } }), envAI, ctx);
  const c = (await cfg.json()) as any;
  assert.equal(c.integrations.ai, true);
  assert.equal(c.contact.email, "zyradigitalpersonal@gmail.com");
});

test("interruptores: desconectar Google y la IA desde Ajustes", async () => {
  const cookie = await login();
  const store = new Map<string, string>();
  const SETTINGS = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) };
  const AI = { run: async () => ({ response: "hola" }) };
  const envT: Env = { ...env, SETTINGS, AI, GOOGLE_PLACES_API_KEY: "k" };
  const post = (path: string, body: unknown) => worker.fetch(new Request(`https://app.test${path}`, { method: "POST", headers: { cookie, origin: "https://app.test" }, body: JSON.stringify(body) }), envT, ctx);
  const r = await post("/api/admin/toggles", { googleMap: false, ai: false });
  assert.equal(r.status, 200);
  const cfg = (await (await worker.fetch(new Request("https://app.test/api/config", { headers: { cookie } }), envT, ctx)).json()) as any;
  assert.equal(cfg.mapsKey, null);
  assert.equal(cfg.toggles.ai, false);
  const a = await post("/api/assistant", { messages: [{ role: "user", content: "hola" }] });
  assert.equal(a.status, 503);
  await post("/api/admin/toggles", { googleMap: true, ai: true });
  const cfg2 = (await (await worker.fetch(new Request("https://app.test/api/config", { headers: { cookie } }), envT, ctx)).json()) as any;
  assert.equal(cfg2.mapsKey, "k");
});
