// Pipeline comercial (CRM): estados, siguiente acción y resumen. Sin dependencias: lo usan el worker y la web.

import type { Company, Opportunity, Signal } from "./types.js";

export const STATUSES = [
  { id: "nueva", label: "Nueva", color: "#8a929e" },
  { id: "contactar", label: "Contactar", color: "#3b82f6" },
  { id: "contactada", label: "Contactada", color: "#8b5cf6" },
  { id: "respondio", label: "Respondió", color: "#f59e0b" },
  { id: "reunion", label: "Reunión", color: "#06b6d4" },
  { id: "propuesta", label: "Propuesta", color: "#ec4899" },
  { id: "cliente", label: "Cliente", color: "#10b981" },
  { id: "no_interesado", label: "No interesado", color: "#ef4444" },
] as const;

export type LeadStatus = (typeof STATUSES)[number]["id"];
export const STATUS_IDS = STATUSES.map((s) => s.id) as string[];
export const OPEN_STATUSES: LeadStatus[] = ["nueva", "contactar", "contactada", "respondio", "reunion", "propuesta"];

export function statusLabel(id: string): string {
  return STATUSES.find((s) => s.id === id)?.label ?? id;
}

export interface Lead {
  id: string;
  name: string;
  sector_id?: string | null;
  sector_label?: string | null;
  city?: string | null;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  email?: string | null;
  lat?: number | null;
  lon?: number | null;
  source?: string | null;
  source_url?: string | null;
  status: LeadStatus;
  value_eur?: number | null;
  next_action?: string | null;
  next_date?: string | null; // YYYY-MM-DD
  score?: number | null;
  solution?: string | null;
  system?: string | null;
  company_json?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Activity {
  id: number;
  lead_id: string;
  at: string;
  kind: "nota" | "estado" | "llamada" | "email" | "whatsapp" | "reunion" | "propuesta" | "sistema";
  text?: string | null;
  from_status?: string | null;
  to_status?: string | null;
}

/** Resultados rápidos tras un contacto: qué estado y qué seguimiento ponen. */
export const OUTCOMES: Array<{ id: string; label: string; kind: Activity["kind"]; status?: LeadStatus; days: number | null; next?: string; note: string }> = [
  { id: "no_contesta", label: "No contesta", kind: "llamada", status: "contactada", days: 2, next: "Volver a llamar", note: "Llamada: no contesta" },
  { id: "llamar_luego", label: "Que llame más tarde", kind: "llamada", status: "contactada", days: 7, next: "Volver a llamar (lo pidió)", note: "Llamada: pide que se le llame más adelante" },
  { id: "interesado", label: "Interesado", kind: "llamada", status: "respondio", days: 1, next: "Agendar reunión o enviar información", note: "Muestra interés" },
  { id: "reunion", label: "Reunión agendada", kind: "reunion", status: "reunion", days: 3, next: "Preparar y hacer la reunión", note: "Reunión agendada" },
  { id: "propuesta", label: "Propuesta enviada", kind: "propuesta", status: "propuesta", days: 3, next: "Seguimiento de la propuesta", note: "Propuesta enviada" },
  { id: "cliente", label: "¡Cliente!", kind: "estado", status: "cliente", days: null, note: "Se convierte en cliente" },
  { id: "no_interesado", label: "No interesado", kind: "estado", status: "no_interesado", days: null, note: "No está interesado" },
];

export function addDays(base: Date, days: number): string {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface NextAction {
  action: string;
  channel: "llamada" | "email" | "whatsapp" | "instagram" | "visita" | "ninguna";
  reason: string;
}

/** Siguiente acción recomendada para un negocio, por reglas explicables. */
export function suggestNextAction(c: Company, ops: Opportunity[], status: string = "nueva"): NextAction {
  if (status === "cliente") return { action: "Cuidar al cliente", channel: "ninguna", reason: "Ya es cliente: ofrécele mejoras cuando tenga sentido." };
  if (status === "no_interesado") return { action: "No contactar por ahora", channel: "ninguna", reason: "Dijo que no está interesado. Puedes volver a intentarlo en unos meses." };
  const high = ops.filter((o) => o.priority === "alta").length;
  const sys = ops.find((o) => o.system);
  const motivo = sys ? `le falta un ${sys.title.toLowerCase()}` : `${ops.length} oportunidad${ops.length === 1 ? "" : "es"}${high ? ` (${high} de prioridad alta)` : ""}`;
  if (status === "propuesta") return { action: "Hacer seguimiento de la propuesta", channel: c.phone ? "llamada" : "email", reason: "Las propuestas se cierran con seguimiento: llama 2–3 días después de enviarla." };
  if (status === "reunion") return { action: "Preparar la reunión", channel: "ninguna", reason: "Lleva el diagnóstico y una propuesta clara de 1–2 soluciones." };
  if (c.phone) return { action: status === "contactada" ? "Volver a llamar" : "Llamar hoy", channel: "llamada", reason: `Tiene teléfono publicado y ${motivo}.` };
  if (c.email) return { action: "Enviar un email", channel: "email", reason: `No hay teléfono, pero sí email; ${motivo}.` };
  if (c.instagram) return { action: "Escribir por Instagram", channel: "instagram", reason: `Su canal visible es Instagram; ${motivo}.` };
  return { action: "Visitar en persona", channel: "visita", reason: "No hay teléfono, email ni redes publicados: la visita es la vía más directa." };
}

/** Lo que el negocio ya hace bien: explica «por qué no es 100». */
export function strengths(signals: Signal[]): string[] {
  const has = (k: string) => signals.some((s) => s.key === k);
  const out: string[] = [];
  if (has("has_website") && !has("web_unreachable")) out.push("Ya tiene web funcionando");
  if (has("booking_detected")) out.push("Ya tiene reserva online");
  if (has("chat_widget")) out.push("Ya tiene chat en su web");
  if (has("whatsapp_link") || has("osm_whatsapp")) out.push("Ya atiende por WhatsApp");
  if (has("has_cta")) out.push("Su web invita a contactar");
  if (has("google_rating")) out.push("Buena valoración en Google");
  if (has("osm_social") || has("web_social")) out.push("Activo en redes sociales");
  if (has("busy_business")) out.push("Mucho volumen de reseñas");
  return out;
}
