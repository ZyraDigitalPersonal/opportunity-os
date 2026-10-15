// Planes, límites de uso y usuario actual. Hoy la app tiene un único usuario (contraseña compartida);
// todo se guarda con owner_id para poder pasar a cuentas, organizaciones (centros) y roles sin migrar datos.

export type PlanId = "individual" | "avanzado" | "centro";
export type Role = "estudiante" | "tutor" | "admin";

export interface Plan {
  id: PlanId;
  label: string;
  limits: { practicasSearchPerDay: number; researchPerDay: number; aiPerDay: number; googleCallsPerDay: number };
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  individual: {
    id: "individual",
    label: "Individual",
    limits: { practicasSearchPerDay: 10, researchPerDay: 25, aiPerDay: 15, googleCallsPerDay: 40 },
    features: ["perfil", "busqueda", "fichas", "candidaturas"],
  },
  avanzado: {
    id: "avanzado",
    label: "Avanzado",
    limits: { practicasSearchPerDay: 40, researchPerDay: 120, aiPerDay: 80, googleCallsPerDay: 200 },
    features: ["perfil", "busqueda", "fichas", "candidaturas", "comparar", "asistente", "alertas", "investigacion_lote"],
  },
  centro: {
    id: "centro",
    label: "Centro educativo",
    limits: { practicasSearchPerDay: 400, researchPerDay: 1500, aiPerDay: 800, googleCallsPerDay: 2000 },
    features: ["perfil", "busqueda", "fichas", "candidaturas", "comparar", "asistente", "alertas", "investigacion_lote", "organizacion", "tutores", "informes"],
  },
};

export interface CurrentUser {
  id: string;
  orgId: string | null;
  role: Role;
  plan: Plan;
}

/** Usuario de la sesión. Con la contraseña única actual todos los datos son del propietario. */
export function currentUser(env: { PLAN?: string }): CurrentUser {
  const plan = PLANS[(env.PLAN as PlanId) ?? "avanzado"] ?? PLANS.avanzado;
  return { id: "owner", orgId: null, role: "admin", plan };
}

export type UsageKind = "practicas_search" | "research" | "ai" | "google_calls";
export const USAGE_LIMIT_KEY: Record<UsageKind, keyof Plan["limits"]> = {
  practicas_search: "practicasSearchPerDay",
  research: "researchPerDay",
  ai: "aiPerDay",
  google_calls: "googleCallsPerDay",
};
