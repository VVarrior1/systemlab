# SIM.JS Adapter

`simjs.js` contains SIM.JS 2.0.3 under its original MIT license. The npm release
ships a Browserify bundle whose entrypoint does not export its public API.
This adapter binds the existing bundle loader and exports `Sim` and `Entity`
directly from scheduler module 5. Browser entry module 7 and its automatic
startup are excluded because that entry writes a global `window.Sim`, which
does not exist inside a Web Worker. The scheduling implementation in modules
1 through 6 is unchanged.

The bundle contains all its dependencies. Its unused fallback to an external
CommonJS `require` is removed so browser bundlers can analyze the adapter
without dynamic dependency warnings.

Regenerate from the installed, locked dependency with:

```sh
node lib/simulation/vendor/regenerate.mjs
```

The generated file omits the package's embedded source map. Keep `LICENSE`
alongside it. The adapter contains no `eval` or runtime source transformation.
