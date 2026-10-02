// Compila el frontend (src/web/app.ts) a public/app.js. El Worker lo empaqueta wrangler.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
execSync("npx tsc -p tsconfig.web.json", { stdio: "inherit" });
copyFileSync(".web-build/web/app.js", "public/app.js");
// Módulos compartidos que la web importa en tiempo de ejecución (sin dependencias propias)
mkdirSync("public/core", { recursive: true });
copyFileSync(".web-build/core/crm.js", "public/core/crm.js");
console.log("✓ public/app.js");
