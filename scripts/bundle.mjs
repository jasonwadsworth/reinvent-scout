// Builds the single script the plugin ships: src/script/main.ts and everything it imports, with no
// dependency outside Node's standard library. Run `npm run bundle` after changing any source it uses.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { build } from "esbuild";
import { buildOptions, OUTPUT } from "./bundle-options.mjs";

const result = await build({ ...buildOptions(), write: false });
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, result.outputFiles[0].contents);
