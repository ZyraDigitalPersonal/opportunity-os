// Opportunity Engine: EMPRESA → SEÑALES → SCORE (con motivos) → OPORTUNIDADES → SOLUCIÓN.
// Determinista y sin IA: cada punto sale de una señal con su fuente y su nivel de confianza.

import type { Analysis, Company, Opportunity, OpportunityScore, Priority, ScoreItem, Signal, WebAudit } from "./types.js";
import { getSector, type SectorProfile } from "./sectors.js";

export const RULES_VERSION = "2026-09-29.1";
const SLOW_MS = 3000;

const DIMENSION_CAPS: Record<ScoreItem["dimension"], number> = {
  "Presencia digital": 35,
  "Reservas y automatización": 30,
  "Atención al cliente": 15,
  "Potencial comercial": 10,
  "Encaje del sector": 10,
};

export function extractSignals(c: Company, audit: WebAudit | undefined, sector: SectorProfile, now = new Date()): Signal[] {
  const s: Signal[] = [];
  const osm = "OpenStreetMap";
  const web = "Web de la empresa";
  const prof = "Perfil del sector";

  if (c.website) s.push({ key: "has_website", label: "Tiene web registrada", confidence: "verificado", source: osm, evidence: c.website });
  else s.push({ key: "no_website_found", label: "No se ha encontrado web en las fuentes consultadas", confidence: "inferido", source: osm, evidence: "OpenStreetMap no registra web; podría tenerla igualmente" });
  if (c.phone) s.push({ key: "has_phone", label: "Teléfono publicado", confidence: "verificado", source: osm, evidence: c.phone });
  if (c.email) s.push({ key: "has_email", label: "Email de empresa publicado", confidence: "verificado", source: osm, evidence: c.email });
  if (c.openingHours) s.push({ key: "has_hours", label: "Horario publicado", confidence: "verificado", source: osm, evidence: c.openingHours });
  if (c.instagram || c.facebook) s.push({ key: "osm_social", label: "Redes sociales registradas", confidence: "verificado", source: osm, evidence: [c.instagram, c.facebook].filter(Boolean).join(" · ") });
  if (c.whatsapp) s.push({ key: "osm_whatsapp", label: "WhatsApp publicado", confidence: "verificado", source: osm, evidence: c.whatsapp });
  if (c.reservation && /^(yes|required|recommended)$/.test(c.reservation)) s.push({ key: "takes_reservations", label: "Acepta o requiere reserva", confidence: "verificado", source: osm, evidence: `reservation=${c.reservation}` });

  if (audit) {
    if (audit.blockedByRobots) s.push({ key: "robots_blocked", label: "La web no permite el análisis automático (robots.txt)", confidence: "verificado", source: web, evidence: audit.url });
    else if (!audit.reachable) s.push({ key: "web_unreachable", label: audit.error ?? "La web no responde", confidence: "verificado", source: web, evidence: audit.url });
    else {
      if (!audit.https) s.push({ key: "no_https", label: "La web no usa HTTPS", confidence: "verificado", source: web, evidence: audit.finalUrl });
      if (!audit.viewport) s.push({ key: "no_viewport", label: "La web no está adaptada a móvil (sin meta viewport)", confidence: "verificado", source: web });
      if ((audit.responseMs ?? 0) > SLOW_MS) s.push({ key: "slow", label: `La web tarda ${(audit.responseMs! / 1000).toFixed(1)} s en responder`, confidence: "verificado", source: web });
      if (!audit.metaDescription) s.push({ key: "no_meta_description", label: "Sin meta descripción (SEO básico)", confidence: "verificado", source: web });
      if (!audit.h1) s.push({ key: "no_h1", label: "Sin título H1 (SEO básico)", confidence: "verificado", source: web });
      if (!audit.schemaLocalBusiness) s.push({ key: "no_schema", label: "Sin datos estructurados de negocio local", confidence: "verificado", source: web });
      if (audit.copyrightYear && audit.copyrightYear <= now.getUTCFullYear() - 3) s.push({ key: "old_copyright", label: `Pie de página con año ${audit.copyrightYear} (web posiblemente desactualizada)`, confidence: "verificado", source: web, evidence: `© ${audit.copyrightYear}` });
      if (audit.ctas.length === 0) s.push({ key: "no_cta", label: "No se detectan llamadas a la acción (reservar, pedir cita, presupuesto…)", confidence: "verificado", source: web });
      else s.push({ key: "has_cta", label: "Tiene llamadas a la acción", confidence: "verificado", source: web, evidence: audit.ctas.join(", ") });
      if (audit.forms === 0) s.push({ key: "no_form", label: "Sin formulario de contacto", confidence: "verificado", source: web });
      if (audit.bookingProviders.length) s.push({ key: "booking_detected", label: `Reserva online con ${audit.bookingProviders.join(", ")}`, confidence: "verificado", source: web, evidence: audit.bookingProviders.join(", ") });
      else s.push({ key: "no_booking_detected", label: "No se detecta sistema de reserva online en su web", confidence: "verificado", source: web });
      if (audit.whatsappLink) s.push({ key: "whatsapp_link", label: "Enlace directo a WhatsApp en la web", confidence: "verificado", source: web });
      if (audit.chatWidgets.length) s.push({ key: "chat_widget", label: `Chat en la web: ${audit.chatWidgets.join(", ")}`, confidence: "verificado", source: web });
      else s.push({ key: "no_chat_widget", label: "Sin chat ni asistente en la web", confidence: "verificado", source: web });
      if (audit.telLinks) s.push({ key: "tel_link", label: "La web invita a llamar por teléfono", confidence: "verificado", source: web });
      if (audit.socials.length) s.push({ key: "web_social", label: `Enlaza a ${audit.socials.join(", ")}`, confidence: "verificado", source: web });
      if (audit.publicEmails.length) s.push({ key: "web_email", label: "Email genérico publicado en la web", confidence: "verificado", source: web, evidence: audit.publicEmails.join(", ") });
    }
  }

  if (sector.appointmentBased) s.push({ key: "appointment_based", label: "Negocio que funciona con citas o reservas", confidence: "inferido", source: prof });
  if (sector.phoneHeavy) s.push({ key: "phone_heavy", label: "Sector con mucha gestión telefónica", confidence: "inferido", source: prof });
  if (sector.repetitiveQuestions) s.push({ key: "repetitive_questions", label: "Sector con preguntas repetitivas (precios, horarios, disponibilidad)", confidence: "inferido", source: prof });
  if (sector.recurringClients) s.push({ key: "recurring_clients", label: "Clientes recurrentes", confidence: "inferido", source: prof });
  return s;
}

export function computeScore(signals: Signal[], sector: SectorProfile, audited: boolean): OpportunityScore {
  const has = (k: string) => signals.some((x) => x.key === k);
  const items: ScoreItem[] = [];
  const add = (dimension: ScoreItem["dimension"], points: number, signalKey: string, reason?: string) => {
    const sig = signals.find((x) => x.key === signalKey);
    items.push({ dimension, points, signalKey, reason: reason ?? sig?.label ?? signalKey, confidence: sig?.confidence ?? "inferido" });
  };

  // Presencia digital
  if (has("no_website_found")) add("Presencia digital", 25, "no_website_found");
  if (has("web_unreachable")) add("Presencia digital", 22, "web_unreachable");
  if (has("no_viewport")) add("Presencia digital", 10, "no_viewport");
  if (has("no_https")) add("Presencia digital", 6, "no_https");
  if (has("old_copyright")) add("Presencia digital", 5, "old_copyright");
  if (has("slow")) add("Presencia digital", 5, "slow");
  if (has("no_cta")) add("Presencia digital", 5, "no_cta");
  if (has("no_meta_description")) add("Presencia digital", 3, "no_meta_description");
  if (has("no_h1")) add("Presencia digital", 2, "no_h1");
  if (has("no_schema")) add("Presencia digital", 2, "no_schema");

  // Reservas y automatización
  const noBooking = !has("booking_detected");
  if (sector.appointmentBased && has("no_booking_detected")) add("Reservas y automatización", 18, "no_booking_detected");
  else if (sector.appointmentBased && (has("no_website_found") || has("web_unreachable"))) add("Reservas y automatización", 14, "appointment_based", "Negocio de citas sin web operativa: las reservas probablemente van por teléfono o en persona");
  if (has("takes_reservations") && noBooking) add("Reservas y automatización", 4, "takes_reservations", "Trabaja con reservas y no se ha visto reserva online");
  if ((has("whatsapp_link") || has("osm_whatsapp")) && !has("chat_widget")) add("Reservas y automatización", 5, has("whatsapp_link") ? "whatsapp_link" : "osm_whatsapp", "Atiende por WhatsApp sin automatización visible");
  if (has("no_form") && noBooking) add("Reservas y automatización", 3, "no_form", "Sin formulario ni reserva online: todo el contacto es manual");

  // Atención al cliente
  if (sector.phoneHeavy && has("has_phone")) add("Atención al cliente", 6, "phone_heavy", "Sector con mucha gestión telefónica y teléfono como canal publicado");
  if (sector.repetitiveQuestions && (has("no_chat_widget") || has("no_website_found"))) add("Atención al cliente", 5, "repetitive_questions", "Preguntas repetitivas típicas del sector sin asistente automático");
  if (has("tel_link") && noBooking && has("no_form")) add("Atención al cliente", 4, "tel_link", "La web solo ofrece llamar para contactar");

  // Potencial comercial (qué tan contactable y activo es el negocio)
  if (has("has_phone")) add("Potencial comercial", 3, "has_phone");
  if (has("has_hours")) add("Potencial comercial", 2, "has_hours");
  if (has("osm_social") || has("web_social")) add("Potencial comercial", 3, has("osm_social") ? "osm_social" : "web_social", "Activo en redes sociales");
  if (has("has_email") || has("web_email")) add("Potencial comercial", 2, has("has_email") ? "has_email" : "web_email");

  // Encaje del sector
  add("Encaje del sector", sector.digitalFit, "sector_fit", `${sector.label}: encaje ${sector.digitalFit}/10 con soluciones de digitalización`);
  items[items.length - 1].confidence = "inferido";

  const byDimension: Record<string, number> = {};
  for (const [dim, cap] of Object.entries(DIMENSION_CAPS)) {
    const sum = items.filter((i) => i.dimension === dim).reduce((a, b) => a + b.points, 0);
    byDimension[dim] = Math.min(cap, sum);
  }
  const score = Math.min(100, Object.values(byDimension).reduce((a, b) => a + b, 0));
  items.sort((a, b) => b.points - a.points);
  return { score, items, byDimension, partial: !audited && has("has_website") };
}

const PRIORITY_ORDER: Record<Priority, number> = { alta: 0, media: 1, baja: 2 };

export function detectOpportunities(signals: Signal[], sector: SectorProfile, c: Company): Opportunity[] {
  const has = (k: string) => signals.some((x) => x.key === k);
  const noWeb = has("no_website_found");
  const webDown = has("web_unreachable");
  const webLive = has("has_website") && !webDown && !has("robots_blocked");
  const audited = has("no_booking_detected") || has("booking_detected");
  const noBooking = !has("booking_detected");
  const ops: Opportunity[] = [];

  if (sector.phoneHeavy && c.phone && noBooking) {
    ops.push({
      id: "voice_agent",
      title: "Agente de voz IA",
      priority: sector.appointmentBased ? "alta" : "media",
      problem: sector.appointmentBased ? "Las citas y consultas se gestionan por teléfono: llamadas perdidas fuera de horario o con el personal ocupado." : "Muchas consultas llegan por teléfono y ocupan tiempo del equipo.",
      solution: "Agente de voz que atiende llamadas 24/7, responde preguntas frecuentes y agenda citas en el calendario.",
      basedOn: ["phone_heavy", "has_phone", audited ? "no_booking_detected" : "appointment_based"],
    });
  }
  if (sector.appointmentBased && noBooking) {
    ops.push({
      id: "booking",
      title: "Sistema de reservas online",
      priority: audited || noWeb || webDown ? "alta" : "media",
      problem: audited ? "Su web no ofrece reserva online: el cliente tiene que llamar o escribir." : "No hay constancia de reserva online.",
      solution: "Reservas online con calendario, confirmación automática y enlace en web, Google y redes.",
      basedOn: [audited ? "no_booking_detected" : "appointment_based"],
    });
    ops.push({
      id: "reminders",
      title: "Recordatorios automáticos de citas",
      priority: "media",
      problem: "Sin sistema de reservas no hay recordatorios automáticos: más ausencias y huecos vacíos.",
      solution: "Recordatorios por WhatsApp/SMS/email con confirmación o cancelación en un clic.",
      basedOn: ["appointment_based", audited ? "no_booking_detected" : "appointment_based"],
    });
  }
  if ((has("whatsapp_link") || has("osm_whatsapp")) && !has("chat_widget")) {
    ops.push({ id: "whatsapp", title: "Automatización de WhatsApp", priority: "media", problem: "Atiende por WhatsApp de forma manual.", solution: "WhatsApp Business API con respuestas automáticas, catálogo y derivación a persona.", basedOn: [has("whatsapp_link") ? "whatsapp_link" : "osm_whatsapp"] });
  }
  if (noWeb) {
    ops.push({ id: "new_web", title: "Página web", priority: "alta", problem: "No se ha encontrado web: el negocio depende del boca a boca y de directorios de terceros.", solution: "Web corporativa rápida con SEO local, botón de WhatsApp y reservas integradas.", basedOn: ["no_website_found"] });
  } else if (webDown) {
    ops.push({ id: "fix_web", title: "Recuperar la web", priority: "alta", problem: "La web registrada no funciona: los clientes que la buscan encuentran un error.", solution: "Nueva web o migración a un hosting fiable, con monitorización.", basedOn: ["web_unreachable"] });
  } else if (webLive) {
    const issues = ["no_viewport", "no_https", "old_copyright", "slow"].filter(has);
    if (issues.length >= 2 || has("no_viewport")) {
      ops.push({ id: "redesign", title: "Rediseño web", priority: issues.length >= 3 ? "media" : "baja", problem: `Problemas técnicos visibles en la web (${issues.length}).`, solution: "Rediseño responsive y rápido, con CTA claros y medición de conversiones.", basedOn: issues });
    }
    if (sector.repetitiveQuestions && has("no_chat_widget")) {
      ops.push({ id: "chatbot", title: "Chatbot IA en la web", priority: "baja", problem: "Las preguntas repetitivas se contestan a mano.", solution: "Asistente IA entrenado con sus servicios, precios y horarios, que deriva a reserva o WhatsApp.", basedOn: ["repetitive_questions", "no_chat_widget"] });
    }
    const seo = ["no_meta_description", "no_h1", "no_schema"].filter(has);
    if (seo.length >= 2) ops.push({ id: "seo", title: "SEO local", priority: "baja", problem: "Faltan elementos básicos de SEO.", solution: "Optimización on-page, datos estructurados de negocio local y ficha de Google cuidada.", basedOn: seo });
    if (has("no_form") && has("no_cta") && !sector.appointmentBased) {
      ops.push({ id: "leads", title: "Captación de leads", priority: "media", problem: "La web no invita a contactar ni pedir presupuesto.", solution: "Formularios de presupuesto, CTA y seguimiento automático de cada contacto.", basedOn: ["no_form", "no_cta"] });
    }
  }
  if (sector.recurringClients) {
    ops.push({ id: "crm", title: "CRM y fidelización", priority: "baja", problem: "Con clientes recurrentes, sin CRM se pierden seguimientos y ventas repetidas.", solution: "CRM sencillo con historial de cliente, campañas y avisos de seguimiento.", basedOn: ["recurring_clients"] });
  }
  return ops.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

export function recommend(ops: Opportunity[]): string {
  if (!ops.length) return "Sin oportunidades claras con los datos disponibles.";
  return ops.slice(0, 2).map((o) => o.title).join(" + ");
}

export function analyzeCompany(c: Company, audit?: WebAudit, now = new Date()): Analysis {
  const sector = getSector(c.sectorId);
  if (!sector) throw new Error(`Sector desconocido: ${c.sectorId}`);
  const signals = extractSignals(c, audit, sector, now);
  const score = computeScore(signals, sector, !!audit);
  const opportunities = detectOpportunities(signals, sector, c);
  return { company: c, signals, score, opportunities, recommended: recommend(opportunities), audit };
}
