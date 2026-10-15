// Familias profesionales: la lógica del buscador no está atada a una profesión.
// Añadir un perfil nuevo = añadir una entrada aquí (consultas de búsqueda, etiquetas OSM y vocabulario).

import type { StudentProfile } from "./types.js";

export interface VocabTerm {
  id: string;
  name: string;
  /** Se aplica sobre texto en minúsculas y sin acentos */
  re: RegExp;
}

export interface Family {
  id: string;
  label: string;
  /** Ejemplo de estudios para el formulario */
  studiesHint: string;
  /** Consultas para descubrir empresas en Google Maps (cada una es una llamada) */
  googleQueries: Array<{ q: string; category: string }>;
  /** Etiquetas de OpenStreetMap de empresas del sector */
  osm: Array<[string, string]>;
  /** Palabras para buscar ofertas en portales de empleo */
  jobKeywords: string[];
  /** Indica que la actividad de una empresa encaja con la familia (texto sin acentos) */
  activityRe: RegExp;
  vocabulary: VocabTerm[];
  suggestedSkills: string[];
}

const t = (id: string, name: string, re: RegExp): VocabTerm => ({ id, name, re });

const DEV_VOCAB: VocabTerm[] = [
  t("javascript", "JavaScript", /\bjavascript\b|\bjs\b(?!on)/),
  t("typescript", "TypeScript", /\btypescript\b/),
  t("html_css", "HTML/CSS", /\bhtml5?\b|\bcss3?\b|\bsass\b|\btailwind/),
  t("react", "React", /\breact(\.js|js)?\b(?! native)/),
  t("react_native", "React Native", /\breact native\b/),
  t("angular", "Angular", /\bangular\b/),
  t("vue", "Vue", /\bvue(\.js|js)?\b|\bnuxt/),
  t("next", "Next.js", /\bnext\.?js\b/),
  t("node", "Node.js", /\bnode(\.js|js)?\b|\bexpress(\.js|js)?\b|\bnestjs\b/),
  t("php", "PHP", /\bphp\b/),
  t("laravel", "Laravel", /\blaravel\b/),
  t("symfony", "Symfony", /\bsymfony\b/),
  t("java", "Java", /\bjava\b(?!script)/),
  t("spring", "Spring", /\bspring( boot)?\b/),
  t("dotnet", ".NET / C#", /\.net\b|\bc#|\bcsharp\b|\basp\.net\b/),
  t("python", "Python", /\bpython\b/),
  t("django", "Django", /\bdjango\b|\bflask\b|\bfastapi\b/),
  t("sql", "SQL", /\bsql\b|\bbases? de datos\b/),
  t("mysql", "MySQL", /\bmysql\b|\bmariadb\b/),
  t("postgres", "PostgreSQL", /\bpostgre(s|sql)\b/),
  t("mongodb", "MongoDB", /\bmongo(db)?\b|\bnosql\b/),
  t("api", "APIs REST", /\bapi(s)?\b|\brest(ful)?\b|\bgraphql\b/),
  t("git", "Git", /\bgit(hub|lab)?\b/),
  t("docker", "Docker", /\bdocker\b|\bcontenedores\b/),
  t("kubernetes", "Kubernetes", /\bkubernetes\b|\bk8s\b/),
  t("aws", "AWS", /\baws\b|\bamazon web services\b/),
  t("azure", "Azure", /\bazure\b/),
  t("gcp", "Google Cloud", /\bgoogle cloud\b|\bgcp\b|\bfirebase\b/),
  t("cloud", "Cloud", /\bcloud\b|\bnube\b/),
  t("devops", "DevOps / CI-CD", /\bdevops\b|\bci\/?cd\b|\bintegracion continua\b/),
  t("ia", "Inteligencia artificial", /\binteligencia artificial\b|\b(ia|ai)\b|\bmachine learning\b|\baprendizaje automatico\b|\bllm\b|\bchatgpt\b|\bgenerativa\b/),
  t("data", "Datos / BI", /\bbig data\b|\bpower ?bi\b|\banalitica de datos\b|\bbusiness intelligence\b|\bdata science\b/),
  t("automatizacion", "Automatización", /\bautomatizaci(o|on|ones)\b|\brpa\b|\bn8n\b|\bzapier\b|\bmake\.com\b/),
  t("mobile", "Apps móviles", /\bapps? (moviles?|nativas?)\b|\bandroid\b|\bios\b|\bflutter\b|\bkotlin\b|\bswift\b/),
  t("wordpress", "WordPress", /\bwordpress\b|\bwoocommerce\b/),
  t("ecommerce", "E-commerce", /\be-?commerce\b|\btienda(s)? online\b|\bshopify\b|\bprestashop\b|\bmagento\b/),
  t("erp", "ERP / CRM", /\berp\b|\bodoo\b|\bsap\b|\bsalesforce\b|\bdynamics\b|\bcrm\b/),
  t("ciberseguridad", "Ciberseguridad", /\bciberseguridad\b|\bseguridad informatica\b|\bpentest/),
  t("iot", "IoT / industria 4.0", /\biot\b|\binternet de las cosas\b|\bindustria 4\.0\b|\bplc\b/),
  t("testing", "Testing / QA", /\btesting\b|\bqa\b|\bpruebas automatizadas\b|\bjest\b|\bcypress\b|\bselenium\b/),
  t("agile", "Metodologías ágiles", /\bscrum\b|\bagile\b|\bagil(es)?\b|\bkanban\b/),
  t("ux", "UX/UI", /\bux\b|\bui\b|\bfigma\b|\bexperiencia de usuario\b/),
];

const PHARMA_VOCAB: VocabTerm[] = [
  t("atencion_farmaceutica", "Atención farmacéutica", /\batencion farmaceutica\b|\bdispensaci/),
  t("dermo", "Dermocosmética", /\bdermo(cosmetica|farmacia)\b|\bcosmetica\b/),
  t("formulacion", "Formulación magistral", /\bformulacion\b|\bformulas magistrales\b/),
  t("laboratorio", "Laboratorio", /\blaboratorio\b|\banalisis clinicos\b/),
  t("calidad", "Control de calidad / GMP", /\bcontrol de calidad\b|\bgmp\b|\bncf\b|\bnormas de correcta fabricacion\b/),
  t("idi", "I+D", /\bi\+d\b|\binvestigacion\b|\bensayos clinicos\b/),
  t("farmacovigilancia", "Farmacovigilancia", /\bfarmacovigilancia\b/),
  t("ortopedia", "Ortopedia", /\bortopedia\b/),
  t("nutricion", "Nutrición", /\bnutricion\b|\bdietetica\b/),
];

const ADMIN_VOCAB: VocabTerm[] = [
  t("contabilidad", "Contabilidad", /\bcontabilidad\b|\bcontable\b/),
  t("fiscal", "Fiscalidad", /\bfiscal(idad)?\b|\bimpuestos\b/),
  t("laboral", "Laboral / nóminas", /\blaboral\b|\bnominas\b|\brrhh\b|\brecursos humanos\b/),
  t("excel", "Excel / ofimática", /\bexcel\b|\bofimatica\b|\boffice\b/),
  t("erp", "ERP", /\berp\b|\bsap\b|\ba3\b|\bsage\b|\bholded\b|\bodoo\b/),
  t("atencion", "Atención al cliente", /\batencion al cliente\b/),
  t("logistica", "Logística", /\blogistica\b|\bcompras\b|\balmacen\b/),
  t("comercio_ext", "Comercio exterior", /\bcomercio (exterior|internacional)\b|\bexportaci/),
];

const MKT_VOCAB: VocabTerm[] = [
  t("seo", "SEO / SEM", /\bseo\b|\bsem\b|\bgoogle ads\b/),
  t("social", "Redes sociales", /\bredes sociales\b|\bsocial media\b|\bcommunity manager\b|\binstagram\b|\btiktok\b/),
  t("contenidos", "Contenidos / copy", /\bcontenidos?\b|\bcopywriting\b|\bblog\b/),
  t("analitica", "Analítica", /\banalytics\b|\banalitica\b|\bmetricas\b/),
  t("email", "Email marketing", /\bemail marketing\b|\bnewsletter\b|\bmailchimp\b/),
  t("branding", "Branding", /\bbranding\b|\bmarca\b/),
  t("video", "Vídeo / audiovisual", /\bvideo\b|\baudiovisual\b|\bedicion\b/),
  t("comunicacion", "Comunicación / prensa", /\bcomunicacion\b|\bprensa\b|\brelaciones publicas\b/),
];

const DESIGN_VOCAB: VocabTerm[] = [
  t("figma", "Figma", /\bfigma\b/),
  t("adobe", "Adobe (PS, AI, ID)", /\bphotoshop\b|\billustrator\b|\bindesign\b|\badobe\b/),
  t("ux", "UX/UI", /\bux\b|\bui\b|\bexperiencia de usuario\b/),
  t("branding", "Branding / identidad", /\bbranding\b|\bidentidad (visual|corporativa)\b/),
  t("3d", "3D", /\b3d\b|\bblender\b|\brender/),
  t("motion", "Motion graphics", /\bmotion\b|\bafter effects\b|\banimacion\b/),
  t("editorial", "Diseño editorial", /\beditorial\b|\bmaquetacion\b/),
];

const ENG_VOCAB: VocabTerm[] = [
  t("cad", "CAD (AutoCAD, SolidWorks)", /\bautocad\b|\bsolidworks\b|\bcatia\b|\bcad\b|\binventor\b/),
  t("bim", "BIM / Revit", /\bbim\b|\brevit\b/),
  t("plc", "Automatización / PLC", /\bplc\b|\bautomatizacion industrial\b|\bscada\b/),
  t("electrica", "Instalaciones eléctricas", /\belectric(a|idad)\b|\bbaja tension\b/),
  t("energia", "Energía / renovables", /\brenovables?\b|\bfotovoltaica\b|\beficiencia energetica\b/),
  t("calidad", "Calidad / prevención", /\bcalidad\b|\biso 9001\b|\bprevencion\b/),
  t("mantenimiento", "Mantenimiento", /\bmantenimiento\b/),
  t("matlab", "MATLAB / simulación", /\bmatlab\b|\bsimulacion\b/),
];

const GENERIC_VOCAB: VocabTerm[] = [
  t("ofimatica", "Ofimática", /\bofimatica\b|\bexcel\b/),
  t("atencion", "Atención al cliente", /\batencion al cliente\b/),
  t("idiomas", "Idiomas", /\bingles\b|\bfrances\b|\baleman\b/),
];

export const FAMILIES: Family[] = [
  {
    id: "informatica",
    label: "Informática y desarrollo de software",
    studiesHint: "CFGS Desarrollo de Aplicaciones Web (DAW)",
    googleQueries: [
      { q: "empresa de desarrollo de software", category: "Desarrollo de software" },
      { q: "consultoría informática", category: "Consultoría tecnológica" },
      { q: "desarrollo de aplicaciones web y móviles", category: "Producto digital / apps" },
      { q: "servicios informáticos para empresas", category: "Servicios IT" },
    ],
    osm: [["office", "^(it|telecommunication|software)$"], ["craft", "^(computer|electronics_repair)$"]],
    jobKeywords: ["desarrollador", "programador", "desarrollo web", "full stack", "frontend", "backend", "software"],
    activityRe: /\b(software|desarrollo (web|de (aplicaciones|software))|aplicaciones|programacion|consultoria (tecnologica|informatica)|informatica|transformacion digital|saas|plataforma|cloud|sistemas|tecnologia|apps?)\b/,
    vocabulary: DEV_VOCAB,
    suggestedSkills: ["HTML/CSS", "JavaScript", "TypeScript", "React", "Node.js", "PHP", "Java", "SQL", "Git", "Docker", "APIs REST"],
  },
  {
    id: "farmacia",
    label: "Farmacia y afines",
    studiesHint: "CFGM Farmacia y Parafarmacia / Grado en Farmacia",
    googleQueries: [
      { q: "farmacia", category: "Oficina de farmacia" },
      { q: "laboratorio farmacéutico", category: "Laboratorio / industria" },
      { q: "parafarmacia", category: "Parafarmacia" },
    ],
    osm: [["amenity", "^pharmacy$"], ["healthcare", "^(pharmacy|laboratory)$"]],
    jobKeywords: ["farmacia", "técnico de farmacia", "laboratorio farmacéutico"],
    activityRe: /\b(farmacia|parafarmacia|laboratorio|farmaceutic|medicamento|salud)\b/,
    vocabulary: PHARMA_VOCAB,
    suggestedSkills: ["Atención farmacéutica", "Dermocosmética", "Laboratorio", "Control de calidad / GMP"],
  },
  {
    id: "administracion",
    label: "Administración y gestión",
    studiesHint: "CFGS Administración y Finanzas",
    googleQueries: [
      { q: "asesoría gestoría", category: "Asesoría / gestoría" },
      { q: "departamento de administración empresa", category: "Administración de empresa" },
      { q: "consultoría empresarial", category: "Consultoría" },
    ],
    osm: [["office", "^(accountant|tax_advisor|consulting|financial|company)$"]],
    jobKeywords: ["administrativo", "contabilidad", "administración"],
    activityRe: /\b(asesoria|gestoria|contabilidad|administracion|fiscal|consultoria|finanzas)\b/,
    vocabulary: ADMIN_VOCAB,
    suggestedSkills: ["Contabilidad", "Excel / ofimática", "ERP", "Laboral / nóminas"],
  },
  {
    id: "marketing",
    label: "Marketing y comunicación",
    studiesHint: "CFGS Marketing y Publicidad / Grado en Publicidad",
    googleQueries: [
      { q: "agencia de marketing digital", category: "Agencia de marketing" },
      { q: "agencia de publicidad", category: "Publicidad" },
      { q: "agencia de comunicación", category: "Comunicación" },
    ],
    osm: [["office", "^(advertising_agency|consulting|company)$"]],
    jobKeywords: ["marketing", "community manager", "comunicación"],
    activityRe: /\b(marketing|publicidad|comunicacion|redes sociales|branding|seo)\b/,
    vocabulary: MKT_VOCAB,
    suggestedSkills: ["Redes sociales", "SEO / SEM", "Contenidos / copy", "Analítica"],
  },
  {
    id: "diseno",
    label: "Diseño",
    studiesHint: "CFGS Gráfica Publicitaria / Grado en Diseño",
    googleQueries: [
      { q: "estudio de diseño gráfico", category: "Estudio de diseño" },
      { q: "estudio de diseño web UX", category: "Diseño digital / UX" },
    ],
    osm: [["office", "^(graphic_design|advertising_agency)$"], ["craft", "^(graphic_design|signmaker)$"]],
    jobKeywords: ["diseñador gráfico", "diseño UX", "diseño"],
    activityRe: /\b(diseno|grafico|ux|ui|branding|creativ)\b/,
    vocabulary: DESIGN_VOCAB,
    suggestedSkills: ["Figma", "Adobe (PS, AI, ID)", "UX/UI", "Branding / identidad"],
  },
  {
    id: "ingenieria",
    label: "Ingeniería",
    studiesHint: "Grado en Ingeniería Industrial / CFGS Automatización",
    googleQueries: [
      { q: "ingeniería", category: "Ingeniería" },
      { q: "empresa industrial", category: "Industria" },
      { q: "automatización industrial", category: "Automatización industrial" },
    ],
    osm: [["office", "^(engineer|surveyor)$"], ["man_made", "^works$"]],
    jobKeywords: ["ingeniero", "ingeniería", "técnico industrial"],
    activityRe: /\b(ingenieria|industrial|fabricacion|automatizacion|proyectos tecnicos|energia)\b/,
    vocabulary: ENG_VOCAB,
    suggestedSkills: ["CAD (AutoCAD, SolidWorks)", "Automatización / PLC", "Calidad / prevención"],
  },
  {
    id: "otra",
    label: "Otra familia o estudios universitarios",
    studiesHint: "Escribe tus estudios",
    googleQueries: [],
    osm: [],
    jobKeywords: [],
    activityRe: /$^/,
    vocabulary: GENERIC_VOCAB,
    suggestedSkills: [],
  },
];

export function getFamily(id: string): Family {
  return FAMILIES.find((f) => f.id === id) ?? FAMILIES[FAMILIES.length - 1];
}

export const foldText = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Términos de vocabulario que aparecen en un texto. */
export function vocabIn(text: string, vocab: VocabTerm[]): VocabTerm[] {
  const f = foldText(text);
  return vocab.filter((v) => v.re.test(f));
}

/**
 * Términos del perfil (lo que sabe + lo que quiere aprender) normalizados al vocabulario de su familia.
 * Lo que no está en el vocabulario se conserva como texto libre para buscarlo literalmente.
 */
export function profileTerms(p: Pick<StudentProfile, "skills" | "interests" | "familyId">): Array<{ id: string; name: string; re: RegExp; known: boolean }> {
  const fam = getFamily(p.familyId);
  const vocab = [...fam.vocabulary, ...(fam.id === "informatica" ? [] : DEV_VOCAB)];
  const out = new Map<string, { id: string; name: string; re: RegExp; known: boolean }>();
  const add = (raw: string, known: boolean) => {
    const s = raw.trim();
    if (!s) return;
    const hit = vocab.find((v) => v.re.test(foldText(s)) || foldText(v.name) === foldText(s));
    if (hit) {
      const prev = out.get(hit.id);
      out.set(hit.id, { id: hit.id, name: hit.name, re: hit.re, known: known || !!prev?.known });
    } else {
      const f = foldText(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const id = `free:${foldText(s)}`;
      if (!out.has(id)) out.set(id, { id, name: s, re: new RegExp(`\\b${f}\\b`), known });
    }
  };
  p.skills.forEach((s) => add(s, true));
  p.interests.forEach((s) => add(s, false));
  return [...out.values()];
}

/** Perfil de validación del producto: estudiante de DAW en Lleida que quiere crecer hacia full stack. */
export function exampleProfile(): StudentProfile {
  return {
    id: "principal",
    familyId: "informatica",
    studies: "CFGS Desarrollo de Aplicaciones Web (DAW)",
    specialty: "Full stack",
    skills: ["HTML/CSS", "JavaScript", "TypeScript", "PHP", "SQL", "Git"],
    interests: ["React", "Node.js", "APIs REST", "Docker", "Cloud", "Automatización", "Inteligencia artificial"],
    experience: "",
    projects: "",
    internshipType: "Prácticas curriculares (FCT / FP)",
    location: "Lleida",
    maxDistanceKm: 30,
    modalities: ["presencial", "hibrida", "remota"],
    durationMonths: 3,
    languages: ["Español", "Catalán"],
    wants: { tutoring: true, hiring: true, learning: true },
    priorities: { tech: 1, activity: 1, location: 1, learning: 1 },
    exclude: [],
    advanced: false,
  };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, maxItems: number, maxLen: number) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, maxItems).map((x) => (x as string).trim().slice(0, maxLen)) : []);
const clamp = (n: unknown, lo: number, hi: number, def: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def);

/** Valida y normaliza un perfil que llega del navegador. Devuelve null si falta lo imprescindible. */
export function sanitizeProfile(v: any): StudentProfile | null {
  if (!v || typeof v !== "object") return null;
  const familyId = FAMILIES.some((f) => f.id === v.familyId) ? v.familyId : "otra";
  const location = str(v.location, 80);
  const studies = str(v.studies, 120);
  if (!location || !studies) return null;
  const mods = list(v.modalities, 3, 12).filter((m): m is StudentProfile["modalities"][number] => ["presencial", "hibrida", "remota"].includes(m));
  const pr = v.priorities ?? {};
  return {
    id: /^[a-z0-9_-]{1,40}$/i.test(v.id) ? v.id : "principal",
    name: str(v.name, 80) || undefined,
    familyId,
    studies,
    specialty: str(v.specialty, 120) || undefined,
    skills: list(v.skills, 40, 40),
    interests: list(v.interests, 40, 40),
    experience: str(v.experience, 1500) || undefined,
    projects: str(v.projects, 2000) || undefined,
    portfolioUrl: /^https:\/\/[^\s]{3,300}$/i.test(v.portfolioUrl ?? "") ? v.portfolioUrl : undefined,
    internshipType: str(v.internshipType, 80) || undefined,
    location,
    maxDistanceKm: Math.round(clamp(v.maxDistanceKm, 1, 300, 30)),
    modalities: mods.length ? mods : ["presencial", "hibrida", "remota"],
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(v.startDate ?? "") ? v.startDate : undefined,
    durationMonths: v.durationMonths === undefined ? undefined : clamp(v.durationMonths, 1, 24, 3),
    availability: str(v.availability, 120) || undefined,
    languages: list(v.languages, 10, 30),
    wants: { tutoring: v.wants?.tutoring !== false, hiring: v.wants?.hiring !== false, learning: v.wants?.learning !== false },
    priorities: { tech: clamp(pr.tech, 0, 2, 1), activity: clamp(pr.activity, 0, 2, 1), location: clamp(pr.location, 0, 2, 1), learning: clamp(pr.learning, 0, 2, 1) },
    centreBoardUrl: /^https:\/\/[^\s]{3,300}$/i.test(v.centreBoardUrl ?? "") ? v.centreBoardUrl : undefined,
    exclude: list(v.exclude, 30, 60),
    advanced: !!v.advanced,
  };
}
