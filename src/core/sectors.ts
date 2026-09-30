// Taxonomía propia de sectores, con su mapeo a etiquetas de OpenStreetMap
// y el perfil de necesidades que usa el Opportunity Engine.

export interface SectorProfile {
  id: string;
  label: string;
  /** palabras que el buscador reconoce (sin acentos, minúsculas, singular o plural) */
  aliases: string[];
  /** filtros Overpass: [clave, regex de valores] */
  osm: Array<[string, string]>;
  /** El negocio funciona con citas o reservas */
  appointmentBased: boolean;
  /** Suele gestionarse mucho por teléfono */
  phoneHeavy: boolean;
  /** Suele recibir las mismas preguntas (precios, horarios, disponibilidad) */
  repetitiveQuestions: boolean;
  /** Clientes recurrentes: encaja un CRM / fidelización */
  recurringClients: boolean;
  /** 0-10: cuánto suele aportar la digitalización a este tipo de negocio */
  digitalFit: number;
  /** Problemas de negocio típicos del sector (mostrados como inferidos) */
  typicalNeeds: string[];
}

export const SECTORS: SectorProfile[] = [
  { id: "peluqueria", label: "Peluquería / barbería", aliases: ["peluqueria", "peluquerias", "barberia", "barberias", "barber", "salon de belleza"], osm: [["shop", "^hairdresser$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 9, typicalNeeds: ["Citas", "Recordatorios", "Cancelaciones", "Atención telefónica"] },
  { id: "estetica", label: "Centro de estética", aliases: ["estetica", "centro de estetica", "centros de estetica", "unas", "manicura", "spa"], osm: [["shop", "^(beauty|massage)$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 9, typicalNeeds: ["Citas", "Recordatorios", "Bonos", "Atención telefónica"] },
  { id: "clinica_dental", label: "Clínica dental", aliases: ["dentista", "dentistas", "clinica dental", "clinicas dentales", "odontologo", "odontologia"], osm: [["amenity", "^dentist$"], ["healthcare", "^dentist$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 9, typicalNeeds: ["Citas", "Recordatorios", "Atención telefónica", "Formularios de paciente", "Gestión de pacientes"] },
  { id: "clinica", label: "Clínica / consulta médica", aliases: ["clinica", "clinicas", "medico", "medicos", "consulta", "consultas", "centro medico", "centros medicos"], osm: [["amenity", "^(clinic|doctors)$"], ["healthcare", "^(clinic|doctor)$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 8, typicalNeeds: ["Citas", "Recordatorios", "Atención telefónica", "Formularios", "Gestión de pacientes"] },
  { id: "fisioterapia", label: "Fisioterapia", aliases: ["fisioterapia", "fisioterapeuta", "fisioterapeutas", "fisio", "fisios", "osteopata"], osm: [["healthcare", "^physiotherapist$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 8, typicalNeeds: ["Citas", "Recordatorios", "Bonos de sesiones", "Seguimiento de pacientes"] },
  { id: "veterinario", label: "Veterinario", aliases: ["veterinario", "veterinarios", "veterinaria", "veterinarias", "clinica veterinaria"], osm: [["amenity", "^veterinary$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 8, typicalNeeds: ["Citas", "Recordatorios de vacunas", "Atención telefónica", "Urgencias"] },
  { id: "restaurante", label: "Restaurante", aliases: ["restaurante", "restaurantes", "comida", "pizzeria", "pizzerias", "asador"], osm: [["amenity", "^restaurant$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: false, digitalFit: 7, typicalNeeds: ["Reservas", "Pedidos", "Reputación", "Fidelización", "Marketing"] },
  { id: "bar_cafe", label: "Bar / cafetería", aliases: ["bar", "bares", "cafeteria", "cafeterias", "cafe", "cafes"], osm: [["amenity", "^(bar|cafe|pub)$"]], appointmentBased: false, phoneHeavy: false, repetitiveQuestions: false, recurringClients: true, digitalFit: 4, typicalNeeds: ["Reputación", "Fidelización", "Marketing"] },
  { id: "hotel", label: "Hotel / alojamiento", aliases: ["hotel", "hoteles", "hostal", "hostales", "alojamiento", "alojamientos", "casa rural", "casas rurales", "apartamentos turisticos"], osm: [["tourism", "^(hotel|guest_house|hostel|motel|apartment|chalet)$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: false, digitalFit: 8, typicalNeeds: ["Reservas directas", "Atención 24h", "WhatsApp", "Upselling"] },
  { id: "gimnasio", label: "Gimnasio / centro deportivo", aliases: ["gimnasio", "gimnasios", "gym", "gyms", "crossfit", "pilates", "yoga", "centro deportivo"], osm: [["leisure", "^fitness_centre$"]], appointmentBased: true, phoneHeavy: false, repetitiveQuestions: true, recurringClients: true, digitalFit: 8, typicalNeeds: ["Captación", "Reservas de clases", "Renovaciones", "Pagos", "Comunicación"] },
  { id: "taller", label: "Taller mecánico", aliases: ["taller", "talleres", "taller mecanico", "talleres mecanicos", "mecanico", "mecanicos"], osm: [["shop", "^(car_repair|tyres|motorcycle_repair)$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 7, typicalNeeds: ["Citas", "Presupuestos", "Avisos de reparación terminada", "Recordatorios ITV/revisión"] },
  { id: "abogados", label: "Despacho de abogados", aliases: ["abogado", "abogados", "despacho", "despachos", "bufete", "bufetes"], osm: [["office", "^lawyer$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: false, digitalFit: 7, typicalNeeds: ["Captación de leads", "Primera consulta", "Gestión documental", "Procesamiento de documentos"] },
  { id: "asesoria", label: "Asesoría / gestoría", aliases: ["asesoria", "asesorias", "gestoria", "gestorias", "contable", "contables", "asesor fiscal"], osm: [["office", "^(accountant|tax_advisor)$"]], appointmentBased: false, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 7, typicalNeeds: ["Procesamiento de documentos", "Recogida de facturas", "Atención de consultas", "CRM"] },
  { id: "inmobiliaria", label: "Inmobiliaria", aliases: ["inmobiliaria", "inmobiliarias", "agencia inmobiliaria"], osm: [["office", "^estate_agent$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: false, digitalFit: 8, typicalNeeds: ["Captación de leads", "Cualificación de leads", "Visitas", "CRM"] },
  { id: "construccion", label: "Construcción / reformas", aliases: ["construccion", "constructora", "constructoras", "reformas", "empresa de construccion", "empresas de construccion", "albanil"], osm: [["craft", "^(builder|carpenter|tiler|roofer)$"], ["office", "^construction_company$"]], appointmentBased: false, phoneHeavy: true, repetitiveQuestions: false, recurringClients: false, digitalFit: 6, typicalNeeds: ["Presupuestos", "Captación de leads", "Seguimiento de obras", "Gestión de empleados"] },
  { id: "autoescuela", label: "Autoescuela", aliases: ["autoescuela", "autoescuelas"], osm: [["amenity", "^driving_school$"], ["shop", "^driving_school$"]], appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: false, digitalFit: 7, typicalNeeds: ["Matrículas", "Reservas de prácticas", "Preguntas frecuentes"] },
  { id: "academia", label: "Academia / formación", aliases: ["academia", "academias", "escuela de idiomas", "clases particulares", "formacion"], osm: [["amenity", "^(language_school|music_school|training|prep_school|dancing_school)$"]], appointmentBased: true, phoneHeavy: false, repetitiveQuestions: true, recurringClients: true, digitalFit: 7, typicalNeeds: ["Matrículas", "Captación", "Comunicación con alumnos", "Pagos"] },
  { id: "comercio", label: "Comercio", aliases: ["comercio", "comercios", "tienda", "tiendas"], osm: [["shop", "^(clothes|shoes|jewelry|gift|furniture|electronics|books|florist|optician|bicycle|sports|toys|boutique|pet|interior_decoration)$"]], appointmentBased: false, phoneHeavy: false, repetitiveQuestions: true, recurringClients: true, digitalFit: 6, typicalNeeds: ["Venta online", "Fidelización", "Marketing", "Inventario"] },
];

/** Sectores usados cuando la búsqueda no nombra ninguno, según la intención. */
export const INTENT_DEFAULT_SECTORS: Record<string, string[]> = {
  ia: ["peluqueria", "estetica", "clinica_dental", "clinica", "fisioterapia", "veterinario", "restaurante", "taller"],
  reservas: ["peluqueria", "estetica", "clinica_dental", "fisioterapia", "restaurante", "gimnasio"],
  automatizacion: ["peluqueria", "clinica_dental", "fisioterapia", "taller", "asesoria", "inmobiliaria"],
  web: ["restaurante", "taller", "construccion", "comercio", "peluqueria", "abogados"],
  crm: ["inmobiliaria", "asesoria", "gimnasio", "clinica_dental", "abogados"],
  marketing: ["restaurante", "comercio", "gimnasio", "hotel", "estetica"],
  software: ["construccion", "asesoria", "taller", "academia"],
  default: ["peluqueria", "clinica_dental", "restaurante", "taller", "fisioterapia", "estetica"],
};

export function getSector(id: string): SectorProfile | undefined {
  return SECTORS.find((s) => s.id === id);
}
