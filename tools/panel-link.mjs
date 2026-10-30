// The handover link of a restaurant's panel, from the team's side.
//   node tools/panel-link.mjs <projectId>     the one-time setup link, while nobody has created the owner account yet
// That is ALL this tool does. A business's orders, customers and staff are the business's own: the team that builds the website has no
// page, no tool and no reset link that gets into an owner's account. The owner keeps a recovery code (shown once when the account is
// created) to reset their own password; staff are reset by the owner. Give the setup link to the owner and never open it yourself.

import { createStore } from '../src/server/orders/store.js';
import { ordersDir } from '../src/server/orders/server.js';
import { projectPath } from '../src/lib/project.js';
import fs from 'node:fs';
import path from 'node:path';

const [id] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!id) { console.log('Usage: node tools/panel-link.mjs <projectId>'); process.exit(1); }
const siteId = String(id).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
const store = createStore(path.join(ordersDir(), siteId)); // each business has its own database folder
if (!store.getSite(siteId)) { console.log(`The site "${siteId}" is not registered with the order service. Build its site with orders on the website first.`); process.exit(1); }
if (store.hasOwner(siteId)) {
  console.log('The owner account already exists, so there is no setup link any more. This tool shows nothing else about the business: its orders, customers and staff are its own.');
} else {
  const file = projectPath(id, 'panel.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const base = process.env.SITE_URL || 'http://localhost:3100';
  console.log(saved?.setupToken ? `No owner account yet. Give this one-time link to the owner (do not open it yourself):\n${base}/panel#setup=${saved.setupToken}` : 'No owner account yet, and the setup token is not in panel.json. Build the site again to make a new one.');
}
store.close();
