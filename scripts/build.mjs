// Compila el frontend (src/web/*.ts) y los módulos de core que importa, y los copia a public/.
// El Worker lo empaqueta wrangler.
import { execSync } from "node:child_process";
import { cpSync, rmSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
rmSync(".web-build", { recursive: true, force: true });
execSync("npx tsc -p tsconfig.web.json", { stdio: "inherit" });
for (const f of readdirSync(".web-build/web")) if (f.endsWith(".js")) copyFileSync(`.web-build/web/${f}`, `public/${f}`);
// Módulos compartidos que la web importa en tiempo de ejecución (sin dependencias propias)
rmSync("public/core", { recursive: true, force: true });
mkdirSync("public/core", { recursive: true });
cpSync(".web-build/core", "public/core", { recursive: true });
console.log("✓ public/*.js y public/core/");
