// Utilidades compartidas por todas las pantallas. Todo dato externo pasa por esc() antes de pintarse.
export const $ = (sel, root = document) => root.querySelector(sel);
export function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
export function safeHref(u) {
    if (!u)
        return "#";
    return /^https?:\/\//i.test(u) ? esc(u) : "#";
}
export function storage() {
    try {
        return window.sessionStorage;
    }
    catch {
        return null;
    }
}
export function local() {
    try {
        return window.localStorage;
    }
    catch {
        return null;
    }
}
export function scoreColor(v) {
    return v >= 70 ? "var(--high)" : v >= 45 ? "var(--mid)" : "var(--low)";
}
/** `good`: escala en la que más es mejor (encaje): verde arriba. La comercial usa rojo = más oportunidad. */
export function scoreRing(v, lg = false, label = "Opportunity Score", good = false) {
    const c = good ? (v >= 70 ? "var(--verified)" : v >= 45 ? "var(--mid)" : "var(--low)") : scoreColor(v);
    return `<div class="score${lg ? " lg" : ""}" style="--v:${v};--c:${c}" role="img" aria-label="${esc(label)} ${v} de 100"><span>${v}</span></div>`;
}
export function hostOf(u) {
    try {
        return u ? new URL(u).hostname.replace(/^www\./, "") : "";
    }
    catch {
        return u ?? "";
    }
}
export async function api(path, body) {
    let res;
    try {
        res = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    }
    catch {
        const err = new Error("Sin conexión con el servidor. Comprueba tu conexión y vuelve a intentarlo.");
        err.status = 0;
        throw err;
    }
    if (res.status === 401) {
        location.href = "/login";
        throw new Error("Sesión caducada");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error ?? `Error ${res.status}`);
        err.status = res.status;
        err.missing = data.missing;
        throw err;
    }
    return data;
}
export function errorBox(e) {
    const cfg = e.missing ? `<p>Configura la variable <code>${esc(e.missing)}</code> en Cloudflare (Workers → tu worker → Settings → Variables and Secrets).</p>` : "";
    return `<div class="error-box" role="alert"><strong>${esc(e.message)}</strong>${cfg}</div>`;
}
export const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const fmtDate = (d) => {
    if (!d)
        return "—";
    const t = todayStr();
    const day = d.slice(0, 10);
    if (day === t)
        return "Hoy";
    const diff = Math.round((Date.parse(day) - Date.parse(t)) / 86400000);
    if (diff === 1)
        return "Mañana";
    if (diff === -1)
        return "Ayer";
    if (diff < 0)
        return `Hace ${-diff} días`;
    if (diff < 7)
        return `En ${diff} días`;
    return new Date(day + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short", year: diff > 300 || diff < -300 ? "numeric" : undefined });
};
export const CONFIDENCE_LABEL = { alta: "Confianza alta", media: "Confianza media", baja: "Confianza baja" };
export function confidenceBadge(level, reasons = []) {
    return `<span class="badge conf conf-${level}" title="${esc(reasons.join(" · ") || CONFIDENCE_LABEL[level])}">${CONFIDENCE_LABEL[level]}</span>`;
}
const stars = (n) => (n === undefined ? "" : `<span class="rv-stars" aria-label="${n} de 5 estrellas">${"★".repeat(Math.round(n))}${"☆".repeat(5 - Math.round(n))}</span>`);
/**
 * Reseña completa y legible: las largas se muestran plegadas con «Leer completa».
 * `highlight` es el fragmento que motivó la señal (se resalta dentro del texto completo).
 */
export function reviewHtml(r, opts = {}) {
    const text = r.text.trim();
    let body = esc(text);
    const frag = opts.highlight?.replace(/^…|…$/g, "").trim();
    if (frag && frag.length > 8) {
        const i = text.indexOf(frag);
        if (i >= 0)
            body = `${esc(text.slice(0, i))}<mark>${esc(frag)}</mark>${esc(text.slice(i + frag.length))}`;
    }
    const long = text.length > 280;
    const meta = [r.author ? esc(r.author) : "", r.when ? esc(r.when) : ""].filter(Boolean).join(" · ");
    const link = r.uri ?? r.authorUri;
    return `<article class="review${long ? " is-long" : ""}">
    <header>${stars(r.rating)}<span class="rv-meta">${meta || "Reseña"}</span></header>
    <div class="rv-text"${long ? ' data-collapsed="true"' : ""}>${body}</div>
    <footer>${long ? `<button type="button" class="link-btn" data-rv-toggle>Leer completa</button>` : ""}${link ? `<a href="${safeHref(link)}" target="_blank" rel="noopener noreferrer">Ver en ${esc(opts.source ?? "Google Maps")} ↗</a>` : ""}</footer>
  </article>`;
}
/** Activa los botones «Leer completa / Mostrar menos» dentro de `root`. */
export function bindReviews(root) {
    root.querySelectorAll("[data-rv-toggle]").forEach((b) => {
        if (b.dataset.bound)
            return;
        b.dataset.bound = "1";
        b.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const t = b.closest(".review")?.querySelector(".rv-text");
            if (!t)
                return;
            const collapsed = t.dataset.collapsed === "true";
            t.dataset.collapsed = collapsed ? "false" : "true";
            b.textContent = collapsed ? "Mostrar menos" : "Leer completa";
        });
    });
}
export function csvDownload(filename, header, rows) {
    const cell = (v) => {
        const s = String(v ?? "");
        const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // evita fórmulas al abrir en Excel
        return `"${safe.replace(/"/g, '""')}"`;
    };
    const blob = new Blob(["﻿" + [header.map(cell).join(";"), ...rows.map((r) => r.map(cell).join(";"))].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
