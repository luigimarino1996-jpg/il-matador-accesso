// Runs at build time on Netlify: copies the landing chosen with the LANDING variable
// (a file name in landings/, without .html) to public/index.html. No variable: "classica".
import { copyFileSync, existsSync } from "node:fs";

const name = process.env.LANDING || "classica";
if (!/^[a-z0-9-]+$/.test(name) || !existsSync(`landings/${name}.html`)) {
  console.error(`Landing "${name}" non trovata in landings/`);
  process.exit(1);
}
copyFileSync(`landings/${name}.html`, "public/index.html");
console.log(`Landing pubblicata: ${name}`);
