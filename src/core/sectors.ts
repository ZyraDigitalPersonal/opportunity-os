// Taxonomía propia de sectores, con su mapeo a etiquetas de OpenStreetMap,
// el texto que se usa en Google Places y el perfil de necesidades que usa el Opportunity Engine.

export interface SectorProfile {
  id: string;
  label: string;
  /** palabras que el buscador reconoce (sin acentos, minúsculas, singular o plural) */
  aliases: string[];
  /** filtros Overpass: [clave, regex de valores] */
  osm: Array<[string, string]>;
  /** Texto para buscar este sector en Google Places ("clínica dental") */
  google: string;
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

type P = Omit<SectorProfile, "id" | "label" | "aliases" | "osm" | "google">;
const CITAS: P = { appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 9, typicalNeeds: ["Citas", "Recordatorios", "Cancelaciones", "Atención telefónica"] };
const SALUD: P = { appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 8, typicalNeeds: ["Citas", "Recordatorios", "Atención telefónica", "Formularios", "Gestión de pacientes"] };
const TIENDA: P = { appointmentBased: false, phoneHeavy: false, repetitiveQuestions: true, recurringClients: true, digitalFit: 6, typicalNeeds: ["Venta online", "Fidelización", "Marketing", "Inventario"] };
const OFICINA: P = { appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: false, digitalFit: 7, typicalNeeds: ["Captación de leads", "Primera consulta", "Gestión documental", "CRM"] };
const OFICIO: P = { appointmentBased: false, phoneHeavy: true, repetitiveQuestions: false, recurringClients: false, digitalFit: 6, typicalNeeds: ["Presupuestos", "Captación de leads", "Avisos y urgencias", "Gestión de trabajos"] };

const s = (id: string, label: string, aliases: string[], osm: Array<[string, string]>, google: string, p: P, over: Partial<P> = {}): SectorProfile => ({ id, label, aliases, osm, google, ...p, ...over });

export const SECTORS: SectorProfile[] = [
  // Belleza y bienestar
  s("peluqueria", "Peluquería / barbería", ["peluqueria", "peluquerias", "barberia", "barberias", "barber", "barbers", "barbero", "barberos", "peluquero", "peluqueros", "salon de belleza", "salones de belleza", "salon de peluqueria"], [["shop", "^hairdresser$"]], "peluquería", CITAS),
  s("estetica", "Centro de estética", ["estetica", "esteticas", "centro de estetica", "centros de estetica", "unas", "manicura", "manicuras", "salon de unas", "salones de unas", "depilacion", "centro de belleza", "centros de belleza", "masajes", "masaje"], [["shop", "^(beauty|massage|cosmetics)$"]], "centro de estética", CITAS, { typicalNeeds: ["Citas", "Recordatorios", "Bonos", "Atención telefónica"] }),
  s("spa", "Spa / wellness", ["spa", "spas", "wellness", "balneario", "balnearios"], [["leisure", "^(spa|sauna)$"], ["amenity", "^(spa|public_bath)$"]], "spa", CITAS),
  s("tatuajes", "Estudio de tatuajes", ["tatuaje", "tatuajes", "tattoo", "tattoos", "estudio de tatuajes", "estudios de tatuajes", "piercing", "piercings"], [["shop", "^(tattoo|piercing)$"]], "estudio de tatuajes", CITAS, { phoneHeavy: false, digitalFit: 7 }),

  // Salud
  s("clinica_dental", "Clínica dental", ["dentista", "dentistas", "clinica dental", "clinicas dentales", "odontologo", "odontologos", "odontologia", "ortodoncia", "ortodoncista", "ortodoncistas", "dental", "dentales"], [["amenity", "^dentist$"], ["healthcare", "^dentist$"]], "clínica dental", SALUD, { digitalFit: 9 }),
  s("clinica", "Clínica / consulta médica", ["clinica", "clinicas", "medico", "medicos", "consulta", "consultas", "centro medico", "centros medicos", "policlinica", "policlinicas", "clinica medica", "clinicas medicas", "dermatologo", "dermatologos", "ginecologo", "ginecologos", "pediatra", "pediatras", "oftalmologo", "oftalmologos", "traumatologo", "traumatologos"], [["amenity", "^(clinic|doctors)$"], ["healthcare", "^(clinic|doctor|centre)$"]], "clínica médica", SALUD),
  s("fisioterapia", "Fisioterapia", ["fisioterapia", "fisioterapeuta", "fisioterapeutas", "fisio", "fisios", "osteopata", "osteopatas", "osteopatia", "quiropractico", "quiropracticos", "podologo", "podologos", "podologia"], [["healthcare", "^(physiotherapist|podiatrist|chiropractor)$"], ["healthcare:speciality", "^(physiotherapy|osteopathy|chiropractic|podiatry)"]], "fisioterapia", SALUD, { typicalNeeds: ["Citas", "Recordatorios", "Bonos de sesiones", "Seguimiento de pacientes"] }),
  s("psicologo", "Psicología / terapia", ["psicologo", "psicologos", "psicologa", "psicologas", "psicologia", "terapeuta", "terapeutas", "psicoterapia", "logopeda", "logopedas", "nutricionista", "nutricionistas", "dietista", "dietistas"], [["healthcare", "^(psychotherapist|psychologist|speech_therapist|nutrition_counselling|dietitian)$"], ["office", "^(psychologist|therapist)$"]], "psicólogo", SALUD),
  s("optica", "Óptica", ["optica", "opticas", "optico", "opticos", "optometrista", "optometristas"], [["shop", "^optician$"]], "óptica", TIENDA, { appointmentBased: true, digitalFit: 7 }),
  s("farmacia", "Farmacia", ["farmacia", "farmacias", "parafarmacia", "parafarmacias"], [["amenity", "^pharmacy$"], ["healthcare", "^pharmacy$"]], "farmacia", TIENDA, { digitalFit: 5, typicalNeeds: ["Pedidos por WhatsApp", "Fidelización", "Venta online de parafarmacia"] }),
  s("veterinario", "Veterinario", ["veterinario", "veterinarios", "veterinaria", "veterinarias", "clinica veterinaria", "clinicas veterinarias", "hospital veterinario"], [["amenity", "^veterinary$"]], "veterinario", SALUD, { typicalNeeds: ["Citas", "Recordatorios de vacunas", "Atención telefónica", "Urgencias"] }),
  s("residencia", "Residencia / centro de mayores", ["residencia", "residencias", "residencia de ancianos", "residencias de ancianos", "geriatrico", "geriatricos", "centro de dia", "centros de dia"], [["amenity", "^(nursing_home|social_facility)$"]], "residencia de mayores", SALUD, { recurringClients: false, digitalFit: 6 }),

  // Hostelería y turismo
  s("restaurante", "Restaurante", ["restaurante", "restaurantes", "comida", "pizzeria", "pizzerias", "asador", "asadores", "marisqueria", "marisquerias", "guachinche", "guachinches", "sushi", "hamburgueseria", "hamburgueserias", "comida rapida", "tasca", "tascas", "taberna", "tabernas", "bodegon", "bodegones", "steakhouse", "kebab", "kebabs", "tapas"], [["amenity", "^(restaurant|fast_food)$"]], "restaurante", { appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: false, digitalFit: 7, typicalNeeds: ["Reservas", "Pedidos", "Reputación", "Fidelización", "Marketing"] }),
  s("bar_cafe", "Bar / cafetería", ["bar", "bares", "cafeteria", "cafeterias", "cafe", "cafes", "pub", "pubs", "chiringuito", "chiringuitos", "heladeria", "heladerias", "cerveceria", "cervecerias", "discoteca", "discotecas", "coctel", "cocteleria", "cocteleria"], [["amenity", "^(bar|cafe|pub|ice_cream|biergarten|nightclub)$"]], "bar", { appointmentBased: false, phoneHeavy: false, repetitiveQuestions: false, recurringClients: true, digitalFit: 4, typicalNeeds: ["Reputación", "Fidelización", "Marketing"] }),
  s("hotel", "Hotel / alojamiento", ["hotel", "hoteles", "hostal", "hostales", "alojamiento", "alojamientos", "casa rural", "casas rurales", "apartamentos turisticos", "apartamento turistico", "albergue", "albergues", "pension", "pensiones", "aparthotel", "apartahotel", "camping", "campings", "vivienda vacacional", "viviendas vacacionales"], [["tourism", "^(hotel|guest_house|hostel|motel|apartment|chalet|camp_site)$"]], "hotel", { appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: false, digitalFit: 8, typicalNeeds: ["Reservas directas", "Atención 24h", "WhatsApp", "Upselling"] }),
  s("agencia_viajes", "Agencia de viajes / actividades", ["agencia de viajes", "agencias de viajes", "viajes", "excursiones", "actividades turisticas", "tour", "tours", "alquiler de barcos", "buceo", "escuela de surf", "escuelas de surf"], [["shop", "^travel_agency$"], ["office", "^travel_agent$"], ["tourism", "^(attraction)$"], ["leisure", "^(water_park)$"]], "agencia de viajes", OFICINA, { digitalFit: 8, typicalNeeds: ["Reservas online", "Atención multilingüe", "WhatsApp", "Reseñas"] }),
  s("catering", "Catering / eventos", ["catering", "caterings", "eventos", "organizacion de eventos", "wedding planner", "bodas", "salon de bodas", "salones de bodas", "fincas para bodas"], [["craft", "^caterer$"], ["office", "^event_management$"], ["amenity", "^events_venue$"]], "catering", OFICINA, { typicalNeeds: ["Presupuestos", "Captación de leads", "Seguimiento", "Reservas de fechas"] }),

  // Deporte y formación
  s("gimnasio", "Gimnasio / centro deportivo", ["gimnasio", "gimnasios", "gym", "gyms", "crossfit", "pilates", "yoga", "centro deportivo", "centros deportivos", "box", "entrenador personal", "entrenadores personales", "artes marciales", "boxeo", "padel", "club de padel", "clubes de padel"], [["leisure", "^(fitness_centre|sports_centre)$"], ["sport", "^(yoga|pilates|crossfit|padel)$"]], "gimnasio", { appointmentBased: true, phoneHeavy: false, repetitiveQuestions: true, recurringClients: true, digitalFit: 8, typicalNeeds: ["Captación", "Reservas de clases", "Renovaciones", "Pagos", "Comunicación"] }),
  s("academia", "Academia / formación", ["academia", "academias", "escuela de idiomas", "escuelas de idiomas", "clases particulares", "formacion", "centro de formacion", "centros de formacion", "escuela de musica", "escuelas de musica", "escuela de baile", "escuelas de baile", "idiomas", "refuerzo escolar", "guarderia", "guarderias", "escuela infantil", "escuelas infantiles"], [["amenity", "^(language_school|music_school|training|prep_school|dancing_school|kindergarten|childcare)$"], ["office", "^educational_institution$"]], "academia", { appointmentBased: true, phoneHeavy: false, repetitiveQuestions: true, recurringClients: true, digitalFit: 7, typicalNeeds: ["Matrículas", "Captación", "Comunicación con familias/alumnos", "Pagos"] }),
  s("autoescuela", "Autoescuela", ["autoescuela", "autoescuelas"], [["amenity", "^driving_school$"], ["shop", "^driving_school$"]], "autoescuela", { appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: false, digitalFit: 7, typicalNeeds: ["Matrículas", "Reservas de prácticas", "Preguntas frecuentes"] }),

  // Motor
  s("taller", "Taller mecánico", ["taller", "talleres", "taller mecanico", "talleres mecanicos", "mecanico", "mecanicos", "chapa y pintura", "neumaticos", "taller de motos", "talleres de motos", "electromecanica"], [["shop", "^(car_repair|tyres|motorcycle_repair)$"], ["craft", "^(car_repair)$"]], "taller mecánico", { appointmentBased: true, phoneHeavy: true, repetitiveQuestions: true, recurringClients: true, digitalFit: 7, typicalNeeds: ["Citas", "Presupuestos", "Avisos de reparación terminada", "Recordatorios ITV/revisión"] }),
  s("concesionario", "Concesionario / compraventa", ["concesionario", "concesionarios", "compraventa de coches", "venta de coches", "coches de segunda mano", "alquiler de coches", "rent a car", "motos"], [["shop", "^(car|motorcycle)$"], ["amenity", "^car_rental$"]], "concesionario de coches", OFICINA, { digitalFit: 7, typicalNeeds: ["Captación de leads", "Cualificación", "Citas de prueba", "CRM"] }),
  s("lavado", "Lavadero de coches", ["lavadero", "lavaderos", "lavado de coches", "autolavado", "car wash"], [["amenity", "^car_wash$"]], "lavado de coches", TIENDA, { digitalFit: 5 }),

  // Profesionales
  s("abogados", "Despacho de abogados", ["abogado", "abogados", "abogada", "abogadas", "despacho", "despachos", "bufete", "bufetes", "despacho de abogados", "despachos de abogados", "notaria", "notarias", "notario", "notarios", "procurador", "procuradores"], [["office", "^(lawyer|notary)$"]], "abogados", OFICINA, { typicalNeeds: ["Captación de leads", "Primera consulta", "Gestión documental", "Procesamiento de documentos"] }),
  s("asesoria", "Asesoría / gestoría", ["asesoria", "asesorias", "gestoria", "gestorias", "contable", "contables", "asesor fiscal", "asesores fiscales", "asesoria fiscal", "asesorias fiscales", "economista", "economistas", "gestor", "gestores"], [["office", "^(accountant|tax_advisor|consulting|financial_advisor)$"]], "asesoría", OFICINA, { appointmentBased: false, recurringClients: true, typicalNeeds: ["Procesamiento de documentos", "Recogida de facturas", "Atención de consultas", "CRM"] }),
  s("seguros", "Seguros / correduría", ["seguros", "aseguradora", "aseguradoras", "correduria", "corredurias", "corredor de seguros", "agente de seguros", "agentes de seguros"], [["office", "^insurance$"]], "correduría de seguros", OFICINA, { recurringClients: true, typicalNeeds: ["Captación de leads", "Renovaciones", "Atención de siniestros", "CRM"] }),
  s("inmobiliaria", "Inmobiliaria", ["inmobiliaria", "inmobiliarias", "agencia inmobiliaria", "agencias inmobiliarias", "agente inmobiliario", "agentes inmobiliarios", "administrador de fincas", "administradores de fincas"], [["office", "^(estate_agent|property_management)$"], ["shop", "^estate_agent$"]], "inmobiliaria", OFICINA, { digitalFit: 8, typicalNeeds: ["Captación de leads", "Cualificación de leads", "Visitas", "CRM"] }),
  s("arquitectura", "Arquitectura / ingeniería", ["arquitecto", "arquitectos", "estudio de arquitectura", "estudios de arquitectura", "ingenieria", "ingenierias", "ingeniero", "ingenieros", "interiorismo", "interiorista", "interioristas", "decoracion de interiores"], [["office", "^(architect|engineer|surveyor)$"], ["craft", "^interior_decorator$"]], "estudio de arquitectura", OFICINA, { appointmentBased: false, typicalNeeds: ["Captación de leads", "Presupuestos", "Portfolio online", "Gestión de proyectos"] }),
  s("marketing", "Agencia / consultoría", ["agencia de marketing", "agencias de marketing", "agencia de publicidad", "agencias de publicidad", "consultoria", "consultorias", "consultora", "consultoras", "imprenta", "imprentas", "fotografo", "fotografos", "estudio de fotografia", "estudios de fotografia"], [["office", "^(advertising_agency|consulting|company|it)$"], ["shop", "^(copyshop|photo)$"], ["craft", "^(photographer|printer)$"]], "agencia de marketing", OFICINA, { digitalFit: 6 }),

  // Hogar y oficios
  s("construccion", "Construcción / reformas", ["construccion", "constructora", "constructoras", "reformas", "reforma", "empresa de construccion", "empresas de construccion", "empresa de reformas", "empresas de reformas", "albanil", "albaniles"], [["craft", "^(builder|tiler|roofer|stonemason|plasterer|floorer)$"], ["office", "^construction_company$"]], "empresa de reformas", OFICIO, { typicalNeeds: ["Presupuestos", "Captación de leads", "Seguimiento de obras", "Gestión de empleados"] }),
  s("instalaciones", "Fontanería / electricidad / clima", ["fontanero", "fontaneros", "fontaneria", "fontanerias", "electricista", "electricistas", "electricidad", "climatizacion", "aire acondicionado", "calefaccion", "instalador", "instaladores", "placas solares", "energia solar", "cerrajero", "cerrajeros", "cerrajeria", "cerrajerias"], [["craft", "^(plumber|electrician|hvac|heating_engineer|solar_installer|locksmith|glaziery|insulation)$"], ["shop", "^locksmith$"]], "fontanero", OFICIO, { digitalFit: 7 }),
  s("carpinteria", "Carpintería / cerrajería metálica", ["carpintero", "carpinteros", "carpinteria", "carpinterias", "carpinteria metalica", "aluminio", "herrero", "herreros", "herreria", "pintor", "pintores", "jardinero", "jardineros", "jardineria", "limpieza", "empresa de limpieza", "empresas de limpieza", "mudanzas", "empresa de mudanzas", "empresas de mudanzas"], [["craft", "^(carpenter|joiner|metal_construction|window_construction|painter|gardener|cleaning|blacksmith)$"], ["office", "^(moving_company|cleaning)$"], ["shop", "^(garden_centre)$"]], "carpintería", OFICIO),
  s("ferreteria", "Ferretería / materiales", ["ferreteria", "ferreterias", "bricolaje", "materiales de construccion", "almacen de materiales", "drogueria", "droguerias"], [["shop", "^(hardware|doityourself|trade|building_materials|paint)$"]], "ferretería", TIENDA, { digitalFit: 5 }),

  // Comercio
  s("comercio", "Comercio / tienda", ["comercio", "comercios", "tienda", "tiendas", "boutique", "boutiques", "tienda de ropa", "tiendas de ropa", "zapateria", "zapaterias", "joyeria", "joyerias", "regalos", "jugueteria", "jugueterias", "libreria", "librerias", "papeleria", "papelerias", "muebles", "tienda de muebles", "tiendas de muebles", "electronica", "informatica", "tienda de informatica", "tiendas de informatica", "moviles", "tienda de moviles", "deportes", "tienda de deportes", "bicicletas", "tienda de bicicletas"], [["shop", "^(clothes|shoes|jewelry|gift|furniture|electronics|computer|mobile_phone|books|stationery|bicycle|sports|toys|boutique|interior_decoration|fashion_accessories|bag|watches|houseware|lighting|kitchen|bed|outdoor|video_games|music|art|frame|fabric|second_hand|variety_store|perfumery)$"]], "tienda", TIENDA),
  s("floristeria", "Floristería", ["floristeria", "floristerias", "florista", "floristas", "flores", "vivero", "viveros"], [["shop", "^(florist|garden_centre)$"]], "floristería", TIENDA, { phoneHeavy: true }),
  s("mascotas", "Tienda / peluquería de mascotas", ["tienda de mascotas", "tiendas de mascotas", "mascotas", "peluqueria canina", "peluquerias caninas", "residencia canina", "residencias caninas", "guarderia canina"], [["shop", "^(pet|pet_grooming)$"], ["amenity", "^animal_boarding$"]], "peluquería canina", TIENDA, { appointmentBased: true, digitalFit: 7 }),
  s("alimentacion", "Alimentación (panadería, carnicería…)", ["panaderia", "panaderias", "pasteleria", "pastelerias", "reposteria", "carniceria", "carnicerias", "pescaderia", "pescaderias", "fruteria", "fruterias", "charcuteria", "charcuterias", "supermercado", "supermercados", "alimentacion", "tienda de alimentacion", "tiendas de alimentacion", "vinoteca", "vinotecas", "bodega", "bodegas", "gourmet", "dulceria", "confiteria", "confiterias", "herboristeria", "herboristerias", "dietetica"], [["shop", "^(bakery|pastry|confectionery|butcher|seafood|greengrocer|deli|cheese|supermarket|convenience|wine|alcohol|beverages|health_food|chocolate|coffee|tea|herbalist|farm)$"]], "panadería", TIENDA, { digitalFit: 5, typicalNeeds: ["Pedidos por WhatsApp", "Encargos online", "Fidelización", "Reseñas"] }),
  s("lavanderia", "Lavandería / tintorería / arreglos", ["lavanderia", "lavanderias", "tintoreria", "tintorerias", "arreglos de ropa", "costura", "zapatero", "reparacion de moviles", "reparacion de ordenadores"], [["shop", "^(laundry|dry_cleaning|tailor|shoe_repair|repair)$"], ["craft", "^(tailor|shoemaker|electronics_repair)$"]], "lavandería", TIENDA, { digitalFit: 5 }),
];

/** Sectores usados cuando la búsqueda no nombra ninguno, según la intención. */
export const INTENT_DEFAULT_SECTORS: Record<string, string[]> = {
  ia: ["peluqueria", "estetica", "clinica_dental", "clinica", "fisioterapia", "veterinario", "restaurante", "taller", "inmobiliaria", "hotel"],
  reservas: ["peluqueria", "estetica", "clinica_dental", "fisioterapia", "restaurante", "gimnasio", "spa", "tatuajes"],
  automatizacion: ["peluqueria", "clinica_dental", "fisioterapia", "taller", "asesoria", "inmobiliaria", "abogados", "academia"],
  web: ["restaurante", "taller", "construccion", "instalaciones", "comercio", "peluqueria", "abogados", "carpinteria"],
  crm: ["inmobiliaria", "asesoria", "gimnasio", "clinica_dental", "abogados", "seguros", "concesionario"],
  marketing: ["restaurante", "comercio", "gimnasio", "hotel", "estetica", "alimentacion"],
  software: ["construccion", "asesoria", "taller", "academia", "instalaciones"],
  default: ["peluqueria", "estetica", "clinica_dental", "clinica", "fisioterapia", "veterinario", "restaurante", "taller", "gimnasio", "inmobiliaria", "abogados", "asesoria", "academia", "optica"],
};

export function getSector(id: string): SectorProfile | undefined {
  return SECTORS.find((s) => s.id === id);
}

/** Sector genérico para búsquedas libres («floristerías ecológicas») que no encajan en el catálogo. */
export function customSector(keyword: string): SectorProfile {
  const label = keyword.charAt(0).toUpperCase() + keyword.slice(1);
  // «academia de ingles» hereda el perfil de «academia» (necesidades, encaje y etiquetas OSM)
  const words = ` ${keyword} `;
  const base = SECTORS.flatMap((s) => s.aliases.map((a) => ({ a, s }))).sort((x, y) => y.a.length - x.a.length).find(({ a }) => words.includes(` ${a} `))?.s;
  if (base) return { ...base, id: `custom:${keyword}`, label, google: keyword };
  return { id: `custom:${keyword}`, label, aliases: [], osm: [], google: keyword, appointmentBased: false, phoneHeavy: true, repetitiveQuestions: true, recurringClients: false, digitalFit: 6, typicalNeeds: ["Captación de clientes", "Atención al cliente", "Presencia online"] };
}

export function resolveSector(id: string): SectorProfile | undefined {
  if (id.startsWith("custom:")) {
    const kw = id.slice(7).trim();
    return kw && kw.length <= 40 ? customSector(kw) : undefined;
  }
  return getSector(id);
}
