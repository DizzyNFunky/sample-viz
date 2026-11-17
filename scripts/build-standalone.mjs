// Turns `vite build --mode standalone` output into one self-contained HTML
// fragment (CSS, JS and wasm inlined) that can be hosted anywhere static,
// e.g. as a claude.ai Artifact. Storage is disabled in this build.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = "web/dist-standalone";
const html = await readFile(join(dir, "index.html"), "utf8");

const cssHref = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"/)?.[1];
const jsSrc = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
if (!cssHref || !jsSrc) throw new Error("could not find built CSS/JS in index.html");
const css = await readFile(join(dir, cssHref.replace(/^\.?\//, "")), "utf8");
const js = (await readFile(join(dir, jsSrc.replace(/^\.?\//, "")), "utf8")).replace(/<\/script/gi, "<\\/script");

const icon = html.match(/<link rel="icon"[^>]*>/)?.[0] ?? "";
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script type="module"[^>]*><\/script>/, "");

// The host supplies doctype/html/head/body, so emit the page content only.
const out = `<title>Sample Viz Editor</title>
<meta name="claude:viewport-fit-sides" content="cover">
${icon}
<style>${css}</style>
${body.trim()}
<script type="module">${js}</script>
`;
await writeFile(join(dir, "sample-viz.html"), out);
console.log(`wrote ${join(dir, "sample-viz.html")} (${(out.length / 1024).toFixed(0)} KB)`);
