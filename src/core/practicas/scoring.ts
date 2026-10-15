// Puntuación de prácticas. Responde a: «¿Hasta qué punto esta oportunidad encaja con el perfil,
// las preferencias y los objetivos formativos del estudiante?». Es independiente del Opportunity Score comercial.
//
// Tres valores que NO se mezclan:
//  - Encaje (0-100): cuánto se adapta al estudiante (tecnologías, actividad, ubicación/modalidad, aprendizaje).
//  - Viabilidad (0-100): qué posibilidades reales hay de conseguir las prácticas (oferta, programa, señales).
//  - Confianza (0-100): cuánto respaldo documental tienen los datos usados.
// La falta de datos no resta encaje: lo acerca a un valor neutro (50) y baja la confianza.

import { getFamily, profileTerms, foldText } from "./families.js";
import type { CompanyResearch, DirCompany, InternScore, JobOffer, Level, Modality, Nature, ScorePart, StudentProfile } from "./types.js";

/**
 * Pesos base del encaje (suman 100). Se multiplican por las prioridades del perfil (0–2) del modo avanzado.
 * Una marca conocida o muchas reseñas NO suman encaje: no aparecen aquí a propósito.
 */
export const FIT_WEIGHTS = {
  tech: { weight: 35, label: "Tecnologías y habilidades", doc: "Coincidencia entre lo que sabes o quieres aprender y lo que la empresa u oferta menciona (con cita)." },
  activity: { weight: 20, label: "Actividad de la empresa", doc: "Si a lo que se dedica la empresa encaja con tu familia profesional." },
  location: { weight: 25, label: "Ubicación y modalidad", doc: "Distancia frente a tu máximo y si la modalidad (presencial, híbrida, remota) es la que aceptas." },
  learning: { weight: 20, label: "Entorno de aprendizaje", doc: "Señales de tutoría, formación, programa de prácticas o proyectos reales." },
} as const;

/** Base de viabilidad por naturaleza de la oportunidad, antes de ajustes. */
export const VIABILITY_BASE: Record<Nature, number> = { oferta_publicada: 80, programa: 62, interes_estudiantes: 52, potencial: 22 };

export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Naturaleza de una oportunidad a partir de la oferta y de la investigación (la evidencia más fuerte manda). */
export function natureOf(offer?: JobOffer, research?: CompanyResearch | null): Nature {
  if (offer?.internship) return "oferta_publicada";
  const kinds = new Set(research?.evidence.map((e) => e.kind) ?? []);
  if (kinds.has("programa")) return "programa";
  if (kinds.has("practicas") || kinds.has("interes")) return "interes_estudiantes";
  return "potencial";
}

export function modalityOf(offer?: JobOffer, distanceKm?: number): Modality | "desconocida" {
  if (offer) {
    const f = foldText(`${offer.title} ${offer.snippet ?? ""} ${offer.location ?? ""}`);
    if (/\bhibrid/.test(f)) return "hibrida";
    if (offer.remote || /\b(remoto|teletrabajo|remote|100% online)\b/.test(f)) return "remota";
    return "presencial";
  }
  return distanceKm !== undefined ? "presencial" : "desconocida";
}

const daysSince = (iso: string | undefined, now: Date) => (iso && !Number.isNaN(Date.parse(iso)) ? Math.floor((now.getTime() - Date.parse(iso)) / 86400000) : undefined);

export interface ScoreInput {
  profile: StudentProfile;
  company: DirCompany;
  offer?: JobOffer;
  research?: CompanyResearch | null;
  distanceKm?: number;
  now?: Date;
}

export function scoreOpportunity(inp: ScoreInput): InternScore & { techs: string[]; nature: Nature; modality: Modality | "desconocida" } {
  const now = inp.now ?? new Date();
  const p = inp.profile;
  const fam = getFamily(p.familyId);
  const r = inp.research ?? null;
  const nature = natureOf(inp.offer, r);
  const modality = modalityOf(inp.offer, inp.distanceKm);
  const strengths: string[] = [];
  const drawbacks: string[] = [];
  const missing: string[] = [];

  // ---------- Encaje ----------
  const terms = profileTerms(p);
  const corpus: Array<{ text: string; from: string }> = [];
  if (inp.offer) corpus.push({ text: `${inp.offer.title}. ${inp.offer.snippet ?? ""}`, from: "la oferta" });
  const techNames = new Map<string, string>();
  for (const t of r?.techs ?? []) if (t.from === "texto") techNames.set(t.id, t.name);
  const webOnly = (r?.techs ?? []).filter((t) => t.from === "web");
  const matched = new Set<string>();
  for (const term of terms) {
    if (techNames.has(term.id)) matched.add(term.name);
    else if (corpus.some((c) => term.re.test(foldText(c.text)))) matched.add(term.name);
    else if (r && term.id.startsWith("free:") && r.evidence.some((e) => e.quote && term.re.test(foldText(e.quote)))) matched.add(term.name);
  }
  const offerTechs = inp.offer ? fam.vocabulary.filter((v) => v.re.test(foldText(`${inp.offer!.title} ${inp.offer!.snippet ?? ""}`))).map((v) => v.name) : [];
  const knownTechs = [...new Set([...techNames.values(), ...offerTechs])];
  const anyTechInfo = knownTechs.length > 0 || webOnly.length > 0;
  let techValue: number | null = null;
  let techReason = "No hay información sobre las tecnologías que usa: investiga la empresa.";
  if (anyTechInfo && terms.length) {
    const target = Math.min(4, terms.length);
    const webMatches = webOnly.filter((w) => terms.some((t) => t.id === w.id)).length;
    techValue = Math.min(1, (matched.size + webMatches * 0.5) / target);
    techReason = matched.size
      ? `Coincide en ${[...matched].slice(0, 5).join(", ")}`
      : webMatches
        ? `Su propia web usa ${webOnly.map((w) => w.name).join(", ")} (indicio débil)`
        : `Menciona ${knownTechs.slice(0, 4).join(", ")}, que no están en tu perfil`;
    if (matched.size >= 2) strengths.push(`Trabaja con tecnologías de tu perfil: ${[...matched].slice(0, 4).join(", ")}`);
    if (!matched.size && knownTechs.length) drawbacks.push(`Las tecnologías que menciona (${knownTechs.slice(0, 3).join(", ")}) no están en tu perfil`);
  } else if (!terms.length) {
    techReason = "Añade tecnologías o habilidades a tu perfil para calcular este punto.";
    missing.push("Habilidades en tu perfil");
  } else missing.push("Tecnologías que usa la empresa");

  let activityValue: number | null = null;
  let activityReason = "Sin datos sobre su actividad.";
  const actText = foldText([inp.company.category, r?.activity.title, r?.activity.description, ...(r?.activity.headings ?? []), inp.offer?.title].filter(Boolean).join(" · "));
  if (actText.trim()) {
    const hit = fam.activityRe.test(actText);
    const fromCategory = !!inp.company.category && !r && !inp.offer;
    activityValue = hit ? (fromCategory ? 0.75 : 1) : r ? 0.3 : 0.5;
    activityReason = hit
      ? fromCategory
        ? `Encontrada como «${inp.company.category}» (categoría de búsqueda, sin confirmar en su web)`
        : `Su actividad encaja con ${fam.label.toLowerCase()}`
      : r
        ? "Su web no describe una actividad de tu familia profesional"
        : "Actividad poco clara";
    if (hit && !fromCategory) strengths.push(`Su actividad encaja con ${fam.label.toLowerCase()}`);
    if (!hit && r) drawbacks.push("Su actividad principal parece de otro sector: comprueba si tiene equipo de tu área");
  }
  if (fam.id === "otra") {
    activityValue = null;
    activityReason = "Familia «otra»: no se evalúa la actividad automáticamente.";
  }

  let locValue: number | null = null;
  let locReason = "Ubicación no disponible.";
  const accepts = new Set(p.modalities);
  if (modality === "remota") {
    locValue = accepts.has("remota") ? 1 : 0.2;
    locReason = accepts.has("remota") ? "Remota: aceptas teletrabajo" : "Es en remoto y no lo has marcado como opción";
    if (!accepts.has("remota")) drawbacks.push("Es en remoto y prefieres presencial o híbrida");
  } else if (inp.distanceKm !== undefined) {
    const d = inp.distanceKm;
    const max = p.maxDistanceKm;
    const presencialOk = accepts.has("presencial") || accepts.has("hibrida");
    locValue = !presencialOk ? 0.25 : d <= max ? 1 - 0.4 * (d / max) : Math.max(0, 0.35 - (d - max) / (max * 4));
    locReason = `A ${d < 1 ? "menos de 1" : Math.round(d)} km de ${p.location}${d > max ? ` (más que tus ${max} km)` : ""}`;
    if (d <= Math.min(10, max)) strengths.push(`Muy cerca: ${Math.max(1, Math.round(d))} km`);
    if (d > max) drawbacks.push(`Está a ${Math.round(d)} km, por encima de tu máximo (${max} km)`);
  } else if (inp.offer?.location) {
    const near = foldText(inp.offer.location).includes(foldText(p.location));
    locValue = near ? 0.9 : 0.5;
    locReason = `Ubicación de la oferta: ${inp.offer.location}`;
  } else missing.push("Ubicación exacta");

  let learnValue: number | null = null;
  let learnReason = "Sin datos sobre tutoría o aprendizaje.";
  if (r || inp.offer) {
    const kinds = new Set(r?.evidence.map((e) => e.kind) ?? []);
    const offerText = foldText(`${inp.offer?.title ?? ""} ${inp.offer?.snippet ?? ""}`);
    let v = 0;
    const why: string[] = [];
    if (kinds.has("programa")) (v += 0.45), why.push("programa de prácticas/talento");
    if (kinds.has("tutoria") || /\b(tutor|mentor|formacion)\b/.test(offerText)) (v += 0.35), why.push("mentoría o formación");
    if (kinds.has("proyectos")) (v += 0.2), why.push("proyectos o productos reales");
    if (kinds.has("practicas") || kinds.has("interes") || inp.offer?.internship) (v += 0.2), why.push("experiencia con estudiantes");
    if (v > 0 || r) {
      learnValue = Math.min(1, v || 0.35);
      learnReason = why.length ? `Señales de ${why.join(", ")}` : "Su web no habla de tutoría ni de formación (no quiere decir que no la haya)";
    }
    if (kinds.has("tutoria") && p.wants.tutoring) strengths.push("Habla de mentoría o formación");
    if (p.wants.tutoring && r && !kinds.has("tutoria")) missing.push("Cómo es la tutoría (pregúntalo)");
  } else missing.push("Investigación de la empresa");

  const parts: ScorePart[] = [
    { key: "tech", label: FIT_WEIGHTS.tech.label, weight: FIT_WEIGHTS.tech.weight * p.priorities.tech, value: techValue, reason: techReason },
    { key: "activity", label: FIT_WEIGHTS.activity.label, weight: FIT_WEIGHTS.activity.weight * p.priorities.activity, value: activityValue, reason: activityReason },
    { key: "location", label: FIT_WEIGHTS.location.label, weight: FIT_WEIGHTS.location.weight * p.priorities.location, value: locValue, reason: locReason },
    { key: "learning", label: FIT_WEIGHTS.learning.label, weight: FIT_WEIGHTS.learning.weight * p.priorities.learning, value: learnValue, reason: learnReason },
  ];
  const wAll = parts.reduce((a, b) => a + b.weight, 0) || 1;
  const known = parts.filter((x) => x.value !== null);
  const wKnown = known.reduce((a, b) => a + b.weight, 0);
  const raw = wKnown ? (known.reduce((a, b) => a + b.weight * (b.value as number), 0) / wKnown) * 100 : 50;
  const coverage = wKnown / wAll;
  // Sin datos suficientes el encaje se acerca a 50 (neutro) en lugar de inventar precisión
  const fit = Math.round(50 + (raw - 50) * Math.min(1, coverage / 0.8));

  // ---------- Viabilidad ----------
  const vReasons: string[] = [];
  let viability = VIABILITY_BASE[nature];
  vReasons.push(
    {
      oferta_publicada: "Hay una oferta de prácticas publicada",
      programa: "Tiene un programa de prácticas o talento",
      interes_estudiantes: "Su web menciona prácticas, FCT o estudiantes",
      potencial: "No hay evidencia de que acepte estudiantes",
    }[nature],
  );
  const age = daysSince(inp.offer?.created, now);
  if (inp.offer && age !== undefined) {
    if (age > 60) (viability -= 20), vReasons.push(`La oferta tiene ${age} días: puede estar cerrada`), drawbacks.push(`Oferta antigua (${age} días)`);
    else if (age > 30) (viability -= 8), vReasons.push(`Oferta de hace ${age} días`);
    else (viability += 5), vReasons.push(`Oferta reciente (${age} días)`);
  }
  if (inp.offer && !inp.offer.internship) vReasons.push("Es una oferta de empleo, no de prácticas: indica que contratan perfiles de tu área");
  const kinds = new Set(r?.evidence.map((e) => e.kind) ?? []);
  if (kinds.has("contratando")) (viability += 10), vReasons.push("Está contratando o tiene página de empleo activa");
  if (kinds.has("junior")) (viability += 6), vReasons.push("Acepta perfiles junior");
  if (r?.careersUrl) (viability += 4), vReasons.push("Tiene página de empleo");
  const contactable = !!(r?.emails.length || r?.phones.length || inp.company.phone || r?.hasContactForm || r?.careersUrl || inp.offer);
  if (contactable) (viability += 4), vReasons.push("Tiene un canal de contacto o candidatura");
  else drawbacks.push("No se ha encontrado un canal de contacto claro");
  if (p.exclude.some((x) => x && foldText(`${inp.company.name} ${inp.company.category ?? ""}`).includes(foldText(x)))) {
    viability -= 30;
    drawbacks.push("Coincide con algo que has excluido en tu perfil");
  }
  viability = Math.max(0, Math.min(100, Math.round(viability)));
  if (nature === "potencial") drawbacks.push("Sin confirmar que acepte estudiantes: pregunta antes de dar nada por hecho");

  // ---------- Confianza de la investigación ----------
  const cReasons: string[] = [];
  let conf = 0;
  if (inp.offer) (conf += 30), cReasons.push(`Oferta con enlace directo (${inp.offer.source})`);
  if (r && !r.error && !r.blockedByRobots) {
    const okPages = r.pages.filter((x) => x.ok).length;
    conf += 25 + Math.min(10, (okPages - 1) * 3);
    cReasons.push(`Web de la empresa revisada (${okPages} página${okPages === 1 ? "" : "s"})`);
    const ev = r.evidence.filter((e) => e.url).length + r.techs.filter((t) => t.from === "texto").length;
    conf += Math.min(20, ev * 3);
    if (ev) cReasons.push(`${ev} evidencias con cita y enlace`);
    const old = daysSince(r.checkedAt, now) ?? 999;
    if (old <= 30) (conf += 10), cReasons.push("Comprobada hace menos de 30 días");
    else cReasons.push(`Comprobada hace ${old} días: vuelve a investigarla`);
  } else if (r?.blockedByRobots) cReasons.push("Su web no permite el análisis automático (robots.txt)");
  else if (r?.error) cReasons.push(`No se pudo revisar su web: ${r.error}`);
  else cReasons.push("Empresa sin investigar todavía");
  if (inp.offer?.created) conf += 5;
  if (inp.company.website) conf += 5;
  if (inp.company.source.includes("Google")) (conf += 5), cReasons.push("Datos de directorio de Google Maps");
  conf = Math.max(0, Math.min(100, conf));
  const level: Level = conf >= 60 ? "alta" : conf >= 35 ? "media" : "baja";
  const fitProvisional = coverage < 0.8 || !r;
  if (fitProvisional) missing.push("Evaluación provisional: faltan datos");

  return {
    fit,
    fitProvisional,
    viability,
    confidence: conf,
    confidenceLevel: level,
    parts,
    viabilityReasons: vReasons,
    confidenceReasons: cReasons,
    strengths: [...new Set(strengths)],
    drawbacks: [...new Set(drawbacks)],
    missing: [...new Set(missing)],
    techs: [...new Set([...knownTechs, ...webOnly.map((w) => w.name)])],
    nature,
    modality,
  };
}

/** La razón principal para investigar una oportunidad (una línea para la tarjeta). */
export function headlineOf(s: InternScore, nature: Nature): string {
  if (nature === "oferta_publicada") return "Oferta de prácticas publicada: revisa requisitos y fecha";
  if (s.strengths.length) return s.strengths[0];
  if (nature === "programa") return "Tiene un programa de prácticas o talento";
  if (nature === "interes_estudiantes") return "Su web menciona prácticas o estudiantes";
  return s.parts.find((p) => p.key === "activity" && (p.value ?? 0) >= 0.7)?.reason ?? "Empresa de tu sector para preguntar por prácticas";
}
