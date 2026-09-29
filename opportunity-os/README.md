# OpportunityOS · v0.1 (Entrega A)

Busca negocios por sector y zona, revisa su web pública y calcula un **Opportunity Score** con los motivos de cada punto, las oportunidades detectadas y la solución recomendada. Desde el perfil de cada empresa genera propuestas, emails, mensajes de WhatsApp o LinkedIn y guiones de llamada con IA.

Funciona en **Cloudflare Workers**, sin base de datos todavía. El frontend es TypeScript sin framework; la lógica de negocio (`src/core`) no depende de ninguno.

## Qué hay en esta versión

| Función | Estado | Fuente |
| --- | --- | --- |
| Buscador en lenguaje natural («Peluquerías en Lleida que necesitan automatización») | Funciona | Reglas propias |
| Zonas: ciudad, provincia, comunidad o código postal | Funciona | Nominatim (OpenStreetMap) |
| Empresas en mapa y tarjetas, filtros por score y oportunidad | Funciona | Overpass (OpenStreetMap) |
| Auditoría web: HTTPS, móvil, velocidad, reservas online (Booksy, Treatwell, CoverManager, Doctoralia…), chat, WhatsApp, CTA, formularios, SEO básico, redes | Funciona | Web pública de cada negocio (respeta robots.txt) |
| Opportunity Score con motivos marcados como *verificado* o *inferido* | Funciona | Opportunity Engine |
| Oportunidades por prioridad y solución recomendada | Funciona | Opportunity Engine |
| Ficha de Google en vivo (valoración, reseñas, horario) | Necesita `GOOGLE_PLACES_API_KEY` | Google Places API (New) |
| Propuesta, email, WhatsApp, LinkedIn y guion de llamada | Necesita `ANTHROPIC_API_KEY` | Anthropic (u OpenAI con `AI_PROVIDER=openai`) |
| Exportar resultados a CSV (abre en Excel) | Funciona | — |
| Acceso con contraseña, sesión firmada, límite de peticiones, CSP, protección SSRF y CSRF | Funciona | — |

Todavía no incluye CRM, listas guardadas, asistente con herramientas, dashboard ni Oportunidades B2B. Esas partes necesitan la base de datos (Postgres) y llegan en las Entregas B–D del plan.

## Publicarlo (elige una opción)

### Opción 1 — Desde tu ordenador (unos 5 minutos)

Necesitas Node 20 o superior.

```bash
npm install
npx wrangler login                        # abre el navegador para entrar en tu cuenta de Cloudflare
npx wrangler secret put APP_PASSWORD      # la contraseña para entrar en la app
npx wrangler secret put SESSION_SECRET    # 32+ caracteres aleatorios
npx wrangler secret put CONTACT_EMAIL     # email de contacto (lo exige la política de uso de OpenStreetMap)
npx wrangler secret put ANTHROPIC_API_KEY       # opcional: activa la generación de textos
npx wrangler secret put GOOGLE_PLACES_API_KEY   # opcional: activa la ficha de Google
npm run deploy
```

Al terminar, wrangler muestra la URL: `https://opportunity-os.<tu-subdominio>.workers.dev`.

### Opción 2 — Con GitHub (como tus otros proyectos)

1. Sube esta carpeta a un repositorio nuevo, por ejemplo `opportunity-os`.
2. En Cloudflare: **Workers & Pages → Create → Import a repository** y elige el repositorio.
3. Build command: `npm run build` · Deploy command: `npx wrangler deploy`.
4. En **Settings → Variables and Secrets** añade `APP_PASSWORD`, `SESSION_SECRET`, `CONTACT_EMAIL` y, si quieres, `ANTHROPIC_API_KEY` y `GOOGLE_PLACES_API_KEY` como *Secret*.
5. Cada `git push` vuelve a desplegar.

### Desarrollo local

```bash
cp .dev.vars.example .dev.vars   # rellena los valores
npm run dev                      # http://localhost:8787
npm test                         # 30 tests: parser, auditoría, score, API, seguridad
npm run typecheck
```

## Costes

- OpenStreetMap (Nominatim + Overpass) y la auditoría web: 0 €. Son servicios públicos con uso razonable: la app cachea zonas 7 días y búsquedas 12 horas (la caché de Cloudflare puede no activarse en `workers.dev`; con un dominio propio sí).
- Google Places: unos 0,035 US$ por ficha abierta, 1.000 gratis al mes. Solo se consulta al pulsar el botón y no se guarda.
- IA: se muestra el coste aproximado de cada texto generado. Los precios por modelo están en `src/core/ai.ts` (`MODEL_PRICES_USD_PER_MTOK`); revísalos con la tarifa actual de tu proveedor.

## Legal, en corto

- **Google**: solo se puede conservar el `place_id`. Por eso la ficha se carga en vivo y se muestra en el perfil, lejos del mapa (términos del EEE).
- **LSSI art. 21**: no envíes emails ni WhatsApp comerciales a quien no te lo haya pedido o autorizado. La app redacta, no envía, y lo recuerda en esas pestañas.
- **RGPD**: de las webs solo se toman emails genéricos de empresa (info@, reservas@…), nunca de personas. No se guarda nada en servidor en esta versión.
- **OpenStreetMap**: datos bajo licencia ODbL, con atribución visible.

## Estructura

```text
src/core/        dominio sin framework (reutilizable al migrar a Next.js)
  query-parser.ts      texto → sector, zona, intención y filtros
  sectors.ts           18 sectores con su mapeo a OSM y perfil de necesidades
  osm.ts               proveedor de datos (interfaz DataProvider, intercambiable)
  web-audit.ts         auditoría de la web pública + robots.txt
  opportunity-engine.ts  señales → score con motivos → oportunidades → solución
  google-places.ts     ficha en vivo
  ai.ts                capa de proveedores de IA + prompt basado solo en señales
src/worker/      API, sesión, límites y cabeceras de seguridad
src/web/app.ts   interfaz (se compila a public/app.js)
public/          HTML y CSS
tests/           tests con el runner nativo de Node
```
