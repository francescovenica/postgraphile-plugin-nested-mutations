// The root package is CommonJS; mark the compiled V5 build as ESM.
import { writeFileSync } from "node:fs";
writeFileSync(
  new URL("../dist/package.json", import.meta.url),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
);
