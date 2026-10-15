// Detecta en las reseñas quejas que indican que al negocio le falta un sistema:
// no cogen el teléfono, esperas largas o desorganización con citas, mala atención o no responden mensajes.
// Devuelve el fragmento donde aparece la queja Y la reseña completa para que se pueda leer entera.

import type { Complaint, ReviewItem } from "./types.js";

export const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const PATTERNS: Array<[Complaint["type"], RegExp]> = [
  ["telefono", /(no|nunca|jamas) (te |me |nos )?(cogen|coge|contestan|contesta|responden|responde|atienden|atiende)( el| al)? (telefono|movil|llamadas?)|imposible (contactar|hablar|localizar|comunicar)|no hay (manera|forma) de (contactar|hablar|comunicar)|(llame|llamamos|llamado|llamando) .{0,40}(nadie|nunca|sin respuesta|no (cogen|contestan|responden))|no (cogen|contestan) (nunca|jamas)|telefono .{0,25}(nadie|no (lo )?cogen|no contestan|comunicando)/],
  ["esperas", /(espera(mos|r|ndo|do)?|espere) .{0,25}(mas de|casi|hora|horas|\d+ ?min)|sin cita previa .{0,30}(espera|cola)|(perdieron|anularon|cancelaron|no respetaron|no respetan) (la |mi |nuestra )?(cita|reserva)|overbooking|lista de espera|(dificil|imposible) (conseguir|coger|pedir) (una )?(cita|reserva|mesa)|no (tenian|tienen) (constancia|registrada) (de )?(la |mi )?(cita|reserva)/],
  ["atencion", /(no|nunca) (me |nos )?(responden|contestan|respondieron|contestaron) (los |a los |el |al )?(mensajes?|correos?|emails?|e-mails?|whatsapps?)|whatsapp .{0,30}(no|nunca) (responden|contestan)|mala atencion|pesima atencion|desorganizad|caos|(no|nadie) (nos |me )?(atendio|atendieron|atiende)|falta de (organizacion|comunicacion)/],
];

/** Normaliza para buscar sin acentos manteniendo la misma longitud que el original (para recortar citas). */
function foldSameLength(s: string): string {
  return [...s].map((ch) => {
    const f = fold(ch);
    return f.length === 1 ? f : ch.toLowerCase();
  }).join("");
}

export function detectComplaints(reviews: ReviewItem[] | Array<{ text?: string; rating?: number }>): Complaint[] {
  const out: Complaint[] = [];
  for (const r of reviews as ReviewItem[]) {
    const raw = (r.text ?? "").replace(/\s+/g, " ").trim();
    if (!raw || (r.rating !== undefined && r.rating >= 5)) continue;
    const f = foldSameLength(raw);
    for (const [type, re] of PATTERNS) {
      if (out.some((c) => c.type === type)) continue;
      const m = f.match(re);
      if (!m || m.index === undefined) continue;
      // Cita alrededor de la coincidencia, cortada en límites de palabra
      let start = Math.max(0, m.index - 40);
      if (start > 0) start = raw.indexOf(" ", start) + 1 || start;
      let end = Math.min(raw.length, m.index + m[0].length + 60);
      if (end < raw.length) {
        const sp = raw.indexOf(" ", end);
        end = sp === -1 ? raw.length : sp;
      }
      const quote = (start > 0 ? "…" : "") + raw.slice(start, end).trim() + (end < raw.length ? "…" : "");
      out.push({ type, quote, text: raw, rating: r.rating, author: r.author, when: r.when, uri: r.uri ?? r.authorUri });
    }
  }
  return out;
}

const INTERNSHIP_WORDS = /\b(practicas|becari[oa]s?|beca|estudiantes? en practicas|fct|fp dual|internship|intern|trainee)\b/;

/** Reseñas que hablan de prácticas o becas (útil para el módulo de prácticas). */
export function mentionsInternship(text: string): boolean {
  return INTERNSHIP_WORDS.test(fold(text));
}
