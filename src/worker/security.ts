// Sesión firmada (HMAC), rate limiting básico y cabeceras de seguridad.

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const SESSION_COOKIE = "oos_session";
const SESSION_DAYS = 7;

export async function createSessionCookie(secret: string, now = Date.now()): Promise<string> {
  const exp = now + SESSION_DAYS * 86400_000;
  const value = `${exp}.${await hmac(secret, String(exp))}`;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function hasValidSession(req: Request, secret: string, now = Date.now()): Promise<boolean> {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!m) return false;
  const [expStr, sig] = m[1].split(".");
  const exp = Number(expStr);
  if (!exp || exp < now || !sig) return false;
  return safeEqual(sig, await hmac(secret, expStr));
}

export async function passwordMatches(input: string, expected: string): Promise<boolean> {
  // Compara hashes para que el tiempo no dependa de la longitud de la contraseña.
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(input)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

/**
 * Rate limit en memoria por instancia del Worker. Es una primera barrera;
 * para límites globales se añade el binding de Rate Limiting de Cloudflare.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com https://maps.googleapis.com https://*.googleapis.com https://*.gstatic.com https://*.google.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://tiles.openfreemap.org https://*.googleapis.com https://*.gstatic.com https://*.google.com data: blob:",
    "worker-src 'self' blob:",
    "child-src blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export function withSecurityHeaders(res: Response): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
}
