// Une los resultados de Google y OpenStreetMap sin duplicados.
// Google manda (es más completo y actualizado); OSM aporta email, redes y WhatsApp cuando los tiene,
// y añade los negocios que Google no ha devuelto.

import type { Company } from "./types.js";
import { nameKey } from "./osm.js";

const NEAR_DEG = 0.003; // ~300 m

function similar(a: string, b: string): boolean {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length < kb.length ? [ka, kb] : [kb, ka];
  return short.length >= 5 && long.includes(short);
}

export function mergeCompanies(primary: Company[], secondary: Company[]): Company[] {
  const out = primary.map((c) => ({ ...c }));
  for (const o of secondary) {
    const match = out.find((g) => Math.abs(g.lat - o.lat) < NEAR_DEG && Math.abs(g.lon - o.lon) < NEAR_DEG && similar(g.name, o.name));
    if (match) {
      match.email ??= o.email;
      match.instagram ??= o.instagram;
      match.facebook ??= o.facebook;
      match.whatsapp ??= o.whatsapp;
      match.reservation ??= o.reservation;
      match.website ??= o.website;
      match.alsoIn = o.source;
    } else {
      out.push({ ...o });
    }
  }
  return out;
}
