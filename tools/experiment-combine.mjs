// Puts a laptop version and a phone version of the same pages into ONE site that gives each device its own:
//   <out>/page.html   the laptop version      <out>/m/page.html   the phone version
// The switch sits at the END of the head, after the viewport tag, so the width it reads is the real one. A narrow screen (under 768 px) opens the phone version, a wide one the laptop version.   node tools/experiment-combine.mjs <laptop folder> <phone folder> <out>
import fs from 'node:fs'; import path from 'node:path';
const [lap, pho, out] = process.argv.slice(2).map((p) => path.resolve(p));
fs.rmSync(out, { recursive: true, force: true }); fs.cpSync(lap, out, { recursive: true }); fs.cpSync(pho, path.join(out, 'm'), { recursive: true });
const tag = (js) => `<script>${js}</script>`;
const GO_PHONE = "if(innerWidth<768&&!/[?&]stay/.test(location.search)){var f=location.pathname.split('/').pop()||'index.html';location.replace('m/'+f+location.hash)}";
const GO_LAPTOP = "if(innerWidth>=768&&!/[?&]stay/.test(location.search)){var f=location.pathname.split('/').pop()||'index.html';location.replace('../'+f+location.hash)}";
for (const [dir, js] of [[out, GO_PHONE], [path.join(out, 'm'), GO_LAPTOP]]) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
  const p = path.join(dir, f); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/<\/head>/i, `${tag(js)}</head>`));
}
console.log(`combined: ${fs.readdirSync(out).filter((x) => x.endsWith('.html')).length} laptop pages + ${fs.readdirSync(path.join(out, 'm')).filter((x) => x.endsWith('.html')).length} phone pages in ${out}`);
