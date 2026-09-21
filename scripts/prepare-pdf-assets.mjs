import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir, copyFile, readdir } from "node:fs/promises";
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const out = new URL("../apps/web/public/vendor/ocr/", import.meta.url);
await mkdir(out, { recursive: true });
const pdf = dirname(require.resolve("pdfjs-dist/package.json"));
await copyFile(
  join(pdf, "build/pdf.worker.min.mjs"),
  new URL("../pdf.worker.min.mjs", out),
);
const tess = dirname(require.resolve("tesseract.js/package.json"));
await copyFile(join(tess, "dist/worker.min.js"), new URL("worker.min.js", out));
const tessRequire = createRequire(join(tess, "package.json"));
const core = dirname(tessRequire.resolve("tesseract.js-core/package.json"));
for (const file of await readdir(core))
  if (/\.wasm(?:\.js)?$/.test(file))
    await copyFile(join(core, file), new URL(file, out));
const eng = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
await copyFile(
  join(eng, "4.0.0/eng.traineddata.gz"),
  new URL("eng.traineddata.gz", out),
);
for (const [name, root] of [
  ["pdfjs", pdf],
  ["tesseract", tess],
  ["tesseract-core", core],
]) {
  const files = await readdir(root);
  const license = files.find((f) => /^LICENSE/i.test(f));
  if (license)
    await copyFile(join(root, license), new URL(`${name}-LICENSE`, out));
}
