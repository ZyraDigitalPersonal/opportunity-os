// Utilidades HTTP comunes: timeout, límite de tamaño y protección SSRF.

export class ExternalError extends Error {
  constructor(message: string, public readonly service: string, public readonly status?: number) {
    super(message);
  }
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10000, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Lee el cuerpo como texto hasta `maxBytes`; corta el resto. */
export async function readTextLimited(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    return { text: text.slice(0, maxBytes), bytes: text.length, truncated: text.length > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    chunks.push(value);
    if (bytes >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const all = new Uint8Array(Math.min(bytes, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.min(c.byteLength, all.byteLength - off));
    all.set(slice, off);
    off += slice.byteLength;
    if (off >= all.byteLength) break;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(all), bytes, truncated };
}

/**
 * Solo permite URLs públicas http(s). Bloquea IPs literales, localhost y dominios internos
 * para que el auditor web no pueda usarse contra la red interna (SSRF).
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ExternalError("URL no válida", "web");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new ExternalError("Solo se permiten URLs http(s)", "web");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(":") ||
    !host.includes(".")
  ) {
    throw new ExternalError("Dirección no permitida", "web");
  }
  if (url.username || url.password) throw new ExternalError("URL con credenciales no permitida", "web");
  url.hash = "";
  return url;
}
