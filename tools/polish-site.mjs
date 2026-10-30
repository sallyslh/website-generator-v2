// Makes the pages of a drafted website work on any device and connection (see src/wow/polish.js).
//   node tools/polish-site.mjs <site folder>        for example: projects/padel-wow-1/wow-site

import path from 'node:path';
import { polishSite } from '../src/wow/polish.js';

const dir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.log('Usage: node tools/polish-site.mjs <site folder>'); process.exit(1); }
const r = await polishSite({ dir });
console.log(`${dir}\n  styles: ${r.styles} | pages changed: ${r.pages} | pictures with phone sizes: ${r.pictures}`);
