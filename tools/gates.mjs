// Runs every gate on a finished site folder and prints what would stop it from being published.   node tools/gates.mjs <site folder>
import path from 'node:path';
import { runGates } from '../src/wow/gates.js';
const dir = path.resolve(process.argv[2] ?? '');
const r = runGates({ dir, log: (m) => console.log('  ' + m) });
console.log(r.ok ? '\nALL GATES PASSED' : `\nBLOCKED (${r.blockers.length}):\n` + r.blockers.map((b) => '  - ' + b).join('\n'));
if (r.warnings.length) console.log(`\nwarnings (${r.warnings.length}):\n` + r.warnings.map((w) => '  - ' + w).join('\n'));
process.exit(r.ok ? 0 : 1);
