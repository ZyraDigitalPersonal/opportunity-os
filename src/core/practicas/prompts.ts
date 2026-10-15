// Asistente de candidaturas: los textos se basan solo en hechos verificados de la empresa y en el perfil.

import type { AIRequest } from "../ai.js";
import { getFamily } from "./families.js";
import { NATURE_LABEL, type CompanyResearch, type DirCompany, type JobOffer, type Nature, type StudentProfile } from "./types.js";

export type InternKind = "analisis" | "email" | "espontanea" | "linkedin" | "entrevista" | "seguimiento";
export const INTERN_KINDS: InternKind[] = ["analisis", "email", "espontanea", "linkedin", "entrevista", "seguimiento"];

const TASK: Record<InternKind, string> = {
  analisis:
    "Escribe un análisis breve en viñetas con 4 apartados: «Por qué puede encajar», «Posibles obstáculos», «Qué investigar antes de contactar» y «Qué proyectos o habilidades destacar». Basa cada punto en un hecho de la lista; si falta información, dilo. Máximo 220 palabras.",
  email:
    "Escribe un correo de presentación: primera línea «Asunto: …», 120-170 palabras. Si hay OFERTA, adapta el correo a sus requisitos y nombra la oferta. Si NO hay oferta, pregunta de forma transparente si aceptan estudiantes en prácticas y en qué condiciones (convenio, fechas). Menciona como mucho 2 hechos concretos de la empresa y 2 habilidades o proyectos del estudiante relacionados. Cierre cordial con disponibilidad para una llamada.",
  espontanea:
    "Escribe una candidatura espontánea para prácticas (carta breve, 180-230 palabras): quién es el estudiante, qué estudia y cuándo podría empezar, por qué esta empresa (con hechos reales), qué puede aportar y qué quiere aprender, y una petición clara (¿aceptáis estudiantes en prácticas?). Sin exagerar la experiencia.",
  linkedin: "Escribe un mensaje de LinkedIn de 60-90 palabras para alguien del equipo o de selección de la empresa (sin inventar su nombre: usa «Hola,»). Un hecho concreto de la empresa y una pregunta sobre prácticas.",
  entrevista:
    "Prepara la entrevista: 6 preguntas que probablemente le hagan (con una pista de cómo responder usando su perfil) y 6 preguntas inteligentes que el estudiante puede hacer sobre tutoría, proyectos, tecnologías y posibilidades de continuidad. Viñetas.",
  seguimiento: "Escribe un mensaje de seguimiento breve (50-80 palabras) para enviar 7-10 días después de un primer contacto sin respuesta. Educado, sin presión, recordando en una frase el motivo y ofreciendo enviar más información.",
};

export function buildInternPrompt(
  kind: InternKind,
  p: StudentProfile,
  company: DirCompany,
  nature: Nature,
  research: CompanyResearch | null | undefined,
  offer: JobOffer | undefined,
): AIRequest {
  const fam = getFamily(p.familyId);
  const facts: string[] = [];
  if (offer) facts.push(`- OFERTA (${offer.source}): «${offer.title}»${offer.company ? ` en ${offer.company}` : ""}${offer.location ? `, ${offer.location}` : ""}. Fragmento: ${(offer.snippet ?? "").slice(0, 400)} — ${offer.url}`);
  if (research?.activity.description) facts.push(`- Descripción en su web: «${research.activity.description.slice(0, 300)}»`);
  if (research?.activity.headings.length) facts.push(`- Titulares de su web: ${research.activity.headings.slice(0, 4).map((h) => `«${h}»`).join(", ")}`);
  for (const e of research?.evidence ?? []) facts.push(`- [${e.kind}] ${e.label}${e.quote ? `: «${e.quote}»` : ""}`);
  const texto = (research?.techs ?? []).filter((t) => t.from === "texto").map((t) => t.name);
  if (texto.length) facts.push(`- Tecnologías que menciona en su web: ${texto.join(", ")}`);
  const web = (research?.techs ?? []).filter((t) => t.from === "web").map((t) => t.name);
  if (web.length) facts.push(`- (Indicio débil) Su propia web está hecha con: ${web.join(", ")}. NO afirmes que trabajan con esto.`);

  const system = [
    "Ayudas a un estudiante a conseguir prácticas. Escribes en español de España, con tono profesional, cercano y honesto.",
    "REGLAS ESTRICTAS:",
    "1. Usa solo los HECHOS DE LA EMPRESA de la lista. No inventes tecnologías, proyectos, nombres de personas, programas ni que la empresa busque estudiantes.",
    `2. Naturaleza de la oportunidad: «${NATURE_LABEL[nature]}». Si no es una oferta publicada, NO digas que buscan estudiantes: pregunta si los aceptan.`,
    "3. Usa solo los datos del PERFIL DEL ESTUDIANTE. No exageres su experiencia ni inventes proyectos.",
    "4. Nada de frases vacías («soy una persona proactiva y apasionada»). Concreta.",
    "5. Devuelve solo el texto final, sin comentarios.",
  ].join("\n");
  const prompt = [
    `EMPRESA: ${company.name}${company.city ? ` (${company.city})` : ""}${company.website ? ` — ${company.website}` : ""}`,
    `NATURALEZA: ${NATURE_LABEL[nature]}`,
    "HECHOS DE LA EMPRESA:",
    ...(facts.length ? facts : ["- (sin investigar: no hay hechos; dilo y redacta un contacto genérico y transparente)"]),
    "",
    "PERFIL DEL ESTUDIANTE:",
    `- Estudios: ${p.studies}${p.specialty ? ` · objetivo: ${p.specialty}` : ""} (${fam.label})`,
    `- Sabe: ${p.skills.join(", ") || "(no indicado)"}`,
    `- Quiere aprender: ${p.interests.join(", ") || "(no indicado)"}`,
    p.projects ? `- Proyectos: ${p.projects}` : "",
    p.experience ? `- Experiencia: ${p.experience}` : "",
    p.portfolioUrl ? `- Portfolio: ${p.portfolioUrl}` : "",
    p.internshipType ? `- Tipo de prácticas: ${p.internshipType}` : "",
    p.startDate ? `- Inicio previsto: ${p.startDate}` : "",
    p.durationMonths ? `- Duración aproximada: ${p.durationMonths} meses` : "",
    p.availability ? `- Disponibilidad: ${p.availability}` : "",
    p.languages.length ? `- Idiomas: ${p.languages.join(", ")}` : "",
    `- Vive en: ${p.location}`,
    p.name ? `- Firma: ${p.name}` : "- Firma: [tu nombre]",
    "",
    `TAREA: ${TASK[kind]}`,
  ]
    .filter((x) => x !== "")
    .join("\n");
  return { system, prompt, maxTokens: kind === "entrevista" || kind === "espontanea" ? 1100 : 700 };
}
