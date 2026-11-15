// Runs at build time on Netlify and picks the landing(s) from landings/ (names without .html).
//
// - LANDING_IT + LANDING_ESTERO: visitors from Italy get LANDING_IT, everyone else
//   LANDING_ESTERO, on the same address. Preview the Italian one from anywhere with ?anteprima=it
// - otherwise LANDING (default "classica") for everyone.
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";

function source(name) {
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(`landings/${name}.html`)) {
    console.error(`Landing "${name}" non trovata in landings/`);
    process.exit(1);
  }
  return `landings/${name}.html`;
}

const italy = process.env.LANDING_IT;
const abroad = process.env.LANDING_ESTERO;
rmSync("public/it.html", { force: true });
rmSync("public/_redirects", { force: true });

if (italy && abroad) {
  copyFileSync(source(abroad), "public/index.html");
  copyFileSync(source(italy), "public/it.html");
  // Rewrites (200): the address stays the same and the query string (fbclid, utm) is kept.
  writeFileSync("public/_redirects", [
    "/  anteprima=it      /it.html     200!",
    "/  anteprima=estero  /index.html  200!",
    "/  /it.html  200!  Country=it",
    "",
  ].join("\n"));
  console.log(`Landing per paese: Italia → ${italy}, estero → ${abroad}`);
} else {
  const name = process.env.LANDING || "classica";
  copyFileSync(source(name), "public/index.html");
  console.log(`Landing pubblicata: ${name}`);
}
