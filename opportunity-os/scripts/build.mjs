// Compila el frontend (src/web/app.ts) a public/app.js. El Worker lo empaqueta wrangler.
import { execSync } from "node:child_process";
import { copyFileSync } from "node:fs";
execSync("npx tsc -p tsconfig.web.json", { stdio: "inherit" });
copyFileSync(".web-build/web/app.js", "public/app.js");
console.log("✓ public/app.js");
