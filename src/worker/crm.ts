// API del pipeline comercial (CRM) sobre Cloudflare D1.

import { addDays, OPEN_STATUSES, STATUS_IDS, statusLabel, type Activity, type Lead } from "../core/crm.js";
import type { Company } from "../core/types.js";

export interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): D1Stmt } & D1Stmt;
  batch?(stmts: D1Stmt[]): Promise<unknown>;
}
interface D1Stmt {
  run(): Promise<unknown>;
  all<T = any>(): Promise<{ results: T[] }>;
  first<T = any>(): Promise<T | null>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, name TEXT NOT NULL, sector_id TEXT, sector_label TEXT, city TEXT, address TEXT, phone TEXT, website TEXT, email TEXT, lat REAL, lon REAL, source TEXT, source_url TEXT, status TEXT NOT NULL DEFAULT 'nueva', value_eur INTEGER, next_action TEXT, next_date TEXT, score INTEGER, solution TEXT, system TEXT, company_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, from_status TEXT, to_status TEXT)`,
];
const schemaReady = new WeakSet<object>();
async function ensureSchema(db: D1Like) {
  if (schemaReady.has(db)) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  schemaReady.add(db);
}

const nowIso = () => new Date().toISOString();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);
const s = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Datos de Google que no deben guardarse en servidor (términos de Google Maps Platform). */
function storableCompany(c: Company): Partial<Company> {
  const { rating, reviews, complaints, openingHours, ...rest } = c;
  void rating, reviews, complaints, openingHours;
  return c.source === "Google" ? rest : c;
}

async function log(db: D1Like, leadId: string, kind: Activity["kind"], text: string | null, from: string | null = null, to: string | null = null) {
  await db.prepare("INSERT INTO activities (lead_id, at, kind, text, from_status, to_status) VALUES (?, ?, ?, ?, ?, ?)").bind(leadId, nowIso(), kind, text, from, to).run();
}

export async function handleCrm(req: Request, db: D1Like | undefined, path: string, body: any, validCompany: (v: any) => Company | null): Promise<Response> {
  if (!db) return fail(503, "Falta la base de datos del pipeline (D1). Vuelve a publicar la app.");
  await ensureSchema(db);
  const url = new URL(req.url);

  if (path === "/api/crm/leads" && req.method === "GET") {
    const { results } = await db.prepare("SELECT id, name, sector_label, city, phone, website, email, status, value_eur, next_action, next_date, score, solution, system, source_url, updated_at, created_at FROM leads ORDER BY updated_at DESC LIMIT 2000").all<Lead>();
    return json({ leads: results });
  }

  if (path === "/api/crm/lead" && req.method === "GET") {
    const id = url.searchParams.get("id") ?? "";
    const lead = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first<Lead>();
    if (!lead) return json({ lead: null, activities: [] });
    const { results } = await db.prepare("SELECT * FROM activities WHERE lead_id = ? ORDER BY at DESC LIMIT 200").bind(id).all<Activity>();
    return json({ lead, activities: results });
  }

  if (path === "/api/crm/summary" && req.method === "GET") {
    const today = s(url.searchParams.get("today"), 10) ?? nowIso().slice(0, 10);
    const open = OPEN_STATUSES.map((x) => `'${x}'`).join(",");
    const [counts, due, value, recent, acts] = await Promise.all([
      db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(value_eur),0) AS v FROM leads GROUP BY status").all<{ status: string; n: number; v: number }>(),
      db.prepare(`SELECT id, name, sector_label, city, phone, status, next_action, next_date, score, system, value_eur FROM leads WHERE status IN (${open}) AND next_date IS NOT NULL AND next_date <= ? ORDER BY next_date ASC, score DESC LIMIT 100`).bind(today).all<Lead>(),
      db.prepare(`SELECT COALESCE(SUM(value_eur),0) AS v FROM leads WHERE status IN (${open})`).first<{ v: number }>(),
      db.prepare("SELECT id, name, sector_label, city, status, score, system, updated_at FROM leads ORDER BY created_at DESC LIMIT 8").all<Lead>(),
      db.prepare("SELECT a.at, a.kind, a.text, a.to_status, l.name, l.id AS lead_id FROM activities a JOIN leads l ON l.id = a.lead_id ORDER BY a.at DESC LIMIT 12").all<any>(),
    ]);
    const by: Record<string, { n: number; v: number }> = {};
    for (const r of counts.results) by[r.status] = { n: r.n, v: r.v };
    const total = counts.results.reduce((a, r) => a + r.n, 0);
    const contacted = counts.results.filter((r) => !["nueva", "contactar"].includes(r.status)).reduce((a, r) => a + r.n, 0);
    const won = by.cliente?.n ?? 0;
    return json({
      today,
      total,
      byStatus: by,
      pipelineValue: value?.v ?? 0,
      wonValue: by.cliente?.v ?? 0,
      contacted,
      won,
      conversion: contacted ? Math.round((won / contacted) * 1000) / 10 : 0,
      due: due.results,
      recent: recent.results,
      activity: acts.results,
    });
  }

  if (req.method !== "POST") return fail(405, "Método no permitido.");

  if (path === "/api/crm/save") {
    const c = validCompany(body.company);
    if (!c) return fail(400, "Empresa no válida.");
    const status = STATUS_IDS.includes(body.status) ? body.status : "nueva";
    const existing = await db.prepare("SELECT id, status FROM leads WHERE id = ?").bind(c.id).first<{ id: string; status: string }>();
    const t = nowIso();
    const score = Number.isFinite(body.score) ? Math.round(body.score) : null;
    if (existing) {
      await db
        .prepare("UPDATE leads SET name=?, sector_id=?, sector_label=?, city=?, address=?, phone=?, website=?, email=?, lat=?, lon=?, source=?, source_url=?, score=COALESCE(?, score), solution=COALESCE(?, solution), system=COALESCE(?, system), company_json=?, updated_at=? WHERE id=?")
        .bind(c.name, c.sectorId, c.sectorLabel, c.city ?? null, c.address ?? null, c.phone ?? null, c.website ?? null, c.email ?? null, c.lat, c.lon, c.source, c.sourceUrl, score, s(body.solution, 200), s(body.system, 120), JSON.stringify(storableCompany(c)), t, c.id)
        .run();
      return json({ ok: true, created: false, status: existing.status });
    }
    await db
      .prepare("INSERT INTO leads (id, name, sector_id, sector_label, city, address, phone, website, email, lat, lon, source, source_url, status, next_action, next_date, score, solution, system, company_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(c.id, c.name, c.sectorId, c.sectorLabel, c.city ?? null, c.address ?? null, c.phone ?? null, c.website ?? null, c.email ?? null, c.lat, c.lon, c.source, c.sourceUrl, status, s(body.nextAction, 200), isDate(body.nextDate) ? body.nextDate : null, score, s(body.solution, 200), s(body.system, 120), JSON.stringify(storableCompany(c)), t, t)
      .run();
    await log(db, c.id, "sistema", `Añadida al pipeline${body.from ? ` desde ${s(body.from, 80)}` : ""}`, null, status);
    return json({ ok: true, created: true, status });
  }

  if (path === "/api/crm/update") {
    const id = s(body.id, 300);
    if (!id) return fail(400, "Falta el id.");
    const lead = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first<Lead>();
    if (!lead) return fail(404, "Ese negocio no está en tu pipeline.");
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    let newStatus: string | null = null;
    if (typeof body.status === "string" && STATUS_IDS.includes(body.status) && body.status !== lead.status) {
      newStatus = body.status;
      set("status", body.status);
    }
    if (body.valueEur === null || Number.isFinite(body.valueEur)) set("value_eur", body.valueEur === null ? null : Math.max(0, Math.round(body.valueEur)));
    if (body.nextDate === null || isDate(body.nextDate)) set("next_date", body.nextDate);
    if (body.nextAction === null || typeof body.nextAction === "string") set("next_action", body.nextAction === null ? null : s(body.nextAction, 200));
    if (Number.isFinite(body.addDays)) {
      set("next_date", addDays(new Date(), Math.max(0, Math.min(365, body.addDays))));
    }
    set("updated_at", nowIso());
    await db.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
    const kind: Activity["kind"] = ["nota", "llamada", "email", "whatsapp", "reunion", "propuesta"].includes(body.kind) ? body.kind : newStatus ? "estado" : "nota";
    const note = s(body.note, 2000);
    if (newStatus || note) await log(db, id, kind, note ?? `Estado: ${statusLabel(newStatus!)}`, newStatus ? lead.status : null, newStatus);
    const updated = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first<Lead>();
    return json({ ok: true, lead: updated });
  }

  if (path === "/api/crm/delete") {
    const id = s(body.id, 300);
    if (!id) return fail(400, "Falta el id.");
    await db.prepare("DELETE FROM activities WHERE lead_id = ?").bind(id).run();
    await db.prepare("DELETE FROM leads WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  return fail(404, "Ruta no encontrada.");
}
