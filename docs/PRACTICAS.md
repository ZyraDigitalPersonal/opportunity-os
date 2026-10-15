# Módulo «Prácticas y empleo formativo»

Busca, investiga y evalúa empresas donde hacer prácticas, y lleva el seguimiento de cada candidatura.
Es independiente del buscador comercial: comparte sesión, diseño, base de datos (D1) y proveedores de IA.

## Flujo

1. **Perfil** (`/api/practicas/profile`): familia profesional, estudios, localidad, distancia, modalidades,
   lo que sabe y lo que quiere aprender. Modo avanzado: fechas, duración, idiomas, proyectos, portfolio,
   exclusiones y prioridades del encaje (0–2×).
2. **Búsqueda** (`/api/practicas/search`, ámbito `local | nacional | remota`):
   - Empresas del sector alrededor del estudiante: Google Places (consultas definidas por familia, máx.
     `PRACTICAS_GOOGLE_MAX_CALLS`, 6 por defecto) + OpenStreetMap (etiquetas `office=it`…).
   - Ofertas publicadas: Adzuna y Jooble, solo si hay claves (APIs oficiales). Caché 6 h.
   - Fuentes sin API permitida (LinkedIn, InfoJobs, Indeed, Tecnoempleo, bolsa del centro): enlaces de
     búsqueda para continuar a mano. No se hace scraping ni se saltan controles de acceso.
3. **Investigación** (`/api/practicas/research`): lee la portada y hasta 5 páginas internas relevantes
   (empleo, prácticas, nosotros, servicios), respetando robots.txt por página. Extrae hechos con cita y URL:
   programa de prácticas, menciones a FCT/FP dual/becarios, contratación, perfiles junior, tutoría,
   proyectos, tecnologías (texto vs. «su propia web usa X», indicio débil), tamaño (estimación),
   emails genéricos (nunca de personas), página de empleo y plataformas de selección.
   Se guarda 14 días en `intern_research` (solo hechos de la web de la empresa).
   Reseñas de Google: en vivo, separando las que hablan de prácticas; no se guardan.
4. **Candidaturas** (`/api/practicas/app/*`, `/api/practicas/summary`): 11 estados, notas, fechas de
   contacto y entrevista, próximo paso con fecha automática al cambiar de estado, historial y panel.
5. **Asistente** (`/api/practicas/generate`): análisis, correo, candidatura espontánea, LinkedIn,
   preguntas de entrevista y seguimiento. El servidor relee la investigación guardada: la IA solo recibe
   hechos comprobados. Sin oferta, el mensaje pregunta si aceptan estudiantes.

## Naturaleza de cada oportunidad

| Valor | Cuándo |
| --- | --- |
| `oferta_publicada` | Oferta de un portal con enlace directo cuyo texto habla de prácticas/becas/FCT |
| `programa` | La web de la empresa menciona un programa de prácticas, becas o talento |
| `interes_estudiantes` | La web menciona prácticas, FCT, FP dual, becarios o convenios con centros |
| `potencial` | Sin evidencia. Se indica siempre «sin confirmar que acepte estudiantes» |

## Puntuación (`src/core/practicas/scoring.ts`)

Tres valores independientes, 0–100:

- **Encaje** = media ponderada de: tecnologías (35), actividad (20), ubicación/modalidad (25),
  aprendizaje (20). Pesos en `FIT_WEIGHTS`, multiplicados por las prioridades del perfil.
  Las partes sin datos no restan: el resultado se acerca a 50 según la cobertura y se marca «provisional».
  No suman ni la fama ni el número de reseñas.
- **Viabilidad**: base por naturaleza (`VIABILITY_BASE`: 80/62/52/22) ± antigüedad de la oferta,
  señales de contratación, perfiles junior, página de empleo y canal de contacto.
- **Confianza**: oferta con enlace, web revisada (páginas), evidencias con cita, frescura (<30 días),
  datos de directorio. Alta ≥ 60, media ≥ 35.

## Datos y permisos

Tablas (D1, se crean solas, solo `CREATE … IF NOT EXISTS`): `intern_profiles`, `intern_apps`,
`intern_activities`, `intern_research`, `usage`, `kv_cache`. Todo lo personal lleva `owner_id`
(y `org_id` en candidaturas) y todas las consultas filtran por él. Hoy hay un único usuario (`owner`,
contraseña compartida); `currentUser()` en `src/core/plans.ts` es el único punto a cambiar para tener
cuentas.

## Hacia SaaS (preparado, no implementado)

- **Planes** (`src/core/plans.ts`): individual, avanzado y centro con límites diarios de búsquedas,
  investigaciones, IA y llamadas a Google. Se aplican ya con `PLAN` (por defecto `avanzado`) y el uso y
  coste estimado se registran por usuario y día en `usage`.
- **Centros educativos**: añadir tablas `orgs`, `users (org_id, role: estudiante|tutor|admin)` y sesión
  con identidad; los datos ya están separados por `owner_id`/`org_id`. Los tutores verían las
  candidaturas de su organización (consulta por `org_id`), nunca de otra. Catálogo de empresas
  colaboradoras = `intern_research` + una tabla `org_companies` con notas del centro.
- **Empresas que publican ofertas**: nueva fuente interna (`org_offers`) que entra en la búsqueda
  como `oferta_publicada`.
- Pagos: no implementados a propósito hasta validar el producto.

## Costes por búsqueda (aprox.)

- Google Places (búsqueda local): hasta 6 consultas × 0,035 US$ ≈ 0,21 US$ (1.000 gratis al mes).
- Reseñas al abrir una ficha de Google: ≈ 0,025 US$.
- Adzuna/Jooble: gratis dentro de sus límites (Adzuna 250/día por defecto).
- Investigación de webs y OpenStreetMap: 0 €.
- IA: gratis con Workers AI (límite diario) o según el modelo de pago.
