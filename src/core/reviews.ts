// Detecta en las reseñas quejas que indican que al negocio le falta un sistema:
// no cogen el teléfono, esperas largas o desorganización con citas, mala atención o no responden mensajes.

import type { Complaint } from "./types.js";

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const PATTERNS: Array<[Complaint["type"], RegExp]> = [
  ["telefono", /(no|nunca|jamas) (te |me |nos )?(cogen|coge|contestan|contesta|responden|responde|atienden|atiende)( el| al)? (telefono|movil|llamadas?)|imposible (contactar|hablar|localizar|comunicar)|no hay (manera|forma) de (contactar|hablar|comunicar)|(llame|llamamos|llamado|llamando) .{0,40}(nadie|nunca|sin respuesta|no (cogen|contestan|responden))|no (cogen|contestan) (nunca|jamas)|telefono .{0,25}(nadie|no (lo )?cogen|no contestan|comunicando)/],
  ["esperas", /(espera(mos|r|ndo|do)?|esperé|espere) .{0,25}(mas de|casi|hora|horas|\d+ ?min)|sin cita previa .{0,30}(espera|cola)|(perdieron|anularon|cancelaron|no respetaron|no respetan) (la |mi |nuestra )?(cita|reserva)|overbooking|lista de espera|(dificil|imposible) (conseguir|coger|pedir) (una )?(cita|reserva|mesa)|no (tenian|tienen) (constancia|registrada) (de )?(la |mi )?(cita|reserva)/],
  ["atencion", /(no|nunca) (me |nos )?(responden|contestan|respondieron|contestaron) (los |a los |el |al )?(mensajes?|correos?|emails?|e-mails?|whatsapps?)|whatsapp .{0,30}(no|nunca) (responden|contestan)|mala atencion|pesima atencion|desorganizad|caos|(no|nadie) (nos |me )?(atendio|atendieron|atiende)|falta de (organizacion|comunicacion)/],
];

export function detectComplaints(reviews: Array<{ text?: string; rating?: number }>): Complaint[] {
  const out: Complaint[] = [];
  for (const r of reviews) {
    const raw = (r.text ?? "").replace(/\s+/g, " ").trim();
    if (!raw || (r.rating !== undefined && r.rating >= 5)) continue;
    const f = fold(raw);
    for (const [type, re] of PATTERNS) {
      if (out.some((c) => c.type === type)) continue;
      const m = f.match(re);
      if (!m || m.index === undefined) continue;
      // Cita corta alrededor de la coincidencia (los índices coinciden: fold no cambia la longitud salvo acentos combinados)
      const start = Math.max(0, m.index - 40);
      const quote = (start > 0 ? "…" : "") + raw.slice(start, Math.min(raw.length, m.index + m[0].length + 60)).trim() + (m.index + m[0].length + 60 < raw.length ? "…" : "");
      out.push({ type, quote: quote.slice(0, 180) });
    }
  }
  return out;
}
