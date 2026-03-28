import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
console.log(JSON.stringify({ bytes: source.length }, null, 2));
