// Netlify "ignore" command: exit 0 = skip this build, exit 1 = build.
// Saves deploy credits when several projects share this repository.
//
// Commit message tags:
//   [solo: nome1, nome2]  only the listed projects build (Netlify project names)
//   [tutti]               every project builds
// Without tags: projects with AGGIORNA_SOLO_SU_RICHIESTA=1 are skipped, the others build.
import { execSync } from "node:child_process";

let message = "";
try {
  message = execSync("git log -1 --format=%B", { encoding: "utf8" });
} catch {
  // No git history available: build to be safe.
  process.exit(1);
}

const site = (process.env.SITE_NAME || "").toLowerCase();
const skip = (why) => { console.log(`Aggiornamento saltato: ${why}`); process.exit(0); };

if (message.includes("[tutti]")) process.exit(1);

const only = message.match(/\[solo:\s*([^\]]+)\]/i);
if (only) {
  const names = only[1].split(",").map((n) => n.trim().toLowerCase());
  if (site && names.includes(site)) process.exit(1);
  skip(`modifica solo per ${names.join(", ")}.`);
}

if (process.env.AGGIORNA_SOLO_SU_RICHIESTA === "1") {
  skip("questo progetto si aggiorna solo su richiesta.");
}
process.exit(1);
