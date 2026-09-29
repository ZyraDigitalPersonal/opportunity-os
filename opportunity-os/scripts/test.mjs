// Compila tests + código y los ejecuta con el runner nativo de Node (sin dependencias).
import { execSync } from "node:child_process";
import { rmSync, writeFileSync, readdirSync } from "node:fs";
rmSync(".test-build", { recursive: true, force: true });
execSync("npx tsc -p tsconfig.test.json", { stdio: "inherit" });
writeFileSync(".test-build/package.json", '{"type":"module"}');
const files = readdirSync(".test-build/tests").filter((f) => f.endsWith(".test.js")).map((f) => `.test-build/tests/${f}`);
execSync(`node --test ${files.join(" ")}`, { stdio: "inherit" });
