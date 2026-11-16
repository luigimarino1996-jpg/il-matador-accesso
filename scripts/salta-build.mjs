// Netlify "ignore" command: exit 0 = skip this build, exit 1 = build.
// Projects with AGGIORNA_SOLO_SU_RICHIESTA=1 are skipped (saves deploy credits),
// unless the commit message contains [tutti].
import { execSync } from "node:child_process";

if (process.env.AGGIORNA_SOLO_SU_RICHIESTA !== "1") process.exit(1);

let message = "";
try {
  message = execSync("git log -1 --format=%B", { encoding: "utf8" });
} catch {
  // No git history available: build to be safe.
  process.exit(1);
}
if (message.includes("[tutti]")) process.exit(1);

console.log("Aggiornamento saltato: questo progetto si aggiorna solo su richiesta.");
process.exit(0);
