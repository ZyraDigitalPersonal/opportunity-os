// Organizador de candidaturas: estados, recordatorios y resumen. Sin dependencias (worker + web).
export const APP_STATUSES = [
    { id: "por_investigar", label: "Por investigar", color: "#8a929e", open: true },
    { id: "seleccionada", label: "Seleccionada", color: "#3b82f6", open: true },
    { id: "pendiente_contactar", label: "Pendiente de contactar", color: "#6366f1", open: true },
    { id: "contactada", label: "Contactada", color: "#8b5cf6", open: true },
    { id: "pendiente_respuesta", label: "Pendiente de respuesta", color: "#f59e0b", open: true },
    { id: "seguimiento", label: "Seguimiento pendiente", color: "#f97316", open: true },
    { id: "entrevista", label: "Entrevista programada", color: "#06b6d4", open: true },
    { id: "en_proceso", label: "En proceso de selección", color: "#0ea5e9", open: true },
    { id: "oferta", label: "Oferta recibida", color: "#10b981", open: true },
    { id: "rechazada", label: "Rechazada", color: "#ef4444", open: false },
    { id: "cerrada", label: "Cerrada", color: "#64748b", open: false },
];
export const APP_STATUS_IDS = APP_STATUSES.map((s) => s.id);
export const OPEN_APP_STATUSES = APP_STATUSES.filter((s) => s.open).map((s) => s.id);
export const appStatusLabel = (id) => APP_STATUSES.find((s) => s.id === id)?.label ?? id;
/** Siguiente paso sugerido al cambiar de estado (fecha relativa en días). */
export const STATUS_FOLLOWUP = {
    seleccionada: { days: 2, step: "Preparar el mensaje y revisar qué proyectos destacar" },
    pendiente_contactar: { days: 1, step: "Enviar el mensaje o la candidatura" },
    contactada: { days: 7, step: "Si no responden, enviar un seguimiento breve" },
    pendiente_respuesta: { days: 7, step: "Enviar un seguimiento breve" },
    seguimiento: { days: 0, step: "Enviar el seguimiento" },
    entrevista: { days: 0, step: "Preparar la entrevista" },
    en_proceso: { days: 7, step: "Preguntar por los plazos del proceso" },
    oferta: { days: 2, step: "Revisar condiciones (convenio, horario, tutor) y responder" },
};
