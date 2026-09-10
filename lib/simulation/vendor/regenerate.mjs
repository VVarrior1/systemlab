import { readFileSync, writeFileSync } from "node:fs";

const dependency = new URL("../../../node_modules/simjs/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", dependency), "utf8"));
if (manifest.version !== "2.0.3") throw new Error("Review the SIM.JS entrypoint before upgrading this adapter.");
const bundle = readFileSync(new URL("sim.js", dependency), "utf8").replace(/^\/\/# sourceMappingURL=.*$/gm, "").trim();
const browserEntry = bundle.indexOf(",7:[function(require,module,exports){");
if (browserEntry < 0 || !bundle.endsWith("},{},[7])")) throw new Error("The SIM.JS Browserify module layout has changed.");
const externalFallback = 'var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);';
const externalBinding = 'var i=typeof require=="function"&&require;';
if (!bundle.includes(externalFallback) || !bundle.includes(externalBinding)) throw new Error("The SIM.JS Browserify external fallback has changed.");
const engineBundle = `${bundle.slice(0, browserEntry).replace(externalFallback, "").replace(externalBinding, "")}},{},[]);`;
const output = `// SIM.JS 2.0.3, MIT. See LICENSE and regenerate.mjs.\n// Export scheduler module 5 directly, excluding browser-global entry module 7.\nconst loadSimJs = ${engineBundle}\nconst { Sim, Entity } = loadSimJs(5);\nexport { Sim, Entity };\n`;
writeFileSync(new URL("simjs.js", import.meta.url), output);
writeFileSync(new URL("LICENSE", import.meta.url), readFileSync(new URL("LICENSE", dependency)));
