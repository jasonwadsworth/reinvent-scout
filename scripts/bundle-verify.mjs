// Fails when the committed bundle differs byte for byte from a fresh build, so CI catches a stale one.
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { buildOptions, OUTPUT } from "./bundle-options.mjs";

const fresh = (await build({ ...buildOptions(), write: false })).outputFiles[0].contents;
let committed;
try { committed = readFileSync(OUTPUT); } catch { committed = null; }
if (committed === null || !Buffer.from(fresh).equals(committed)) {
  process.stderr.write("The committed plugin script is stale. Run `npm run bundle` and commit the result.\n");
  process.exit(1);
}
