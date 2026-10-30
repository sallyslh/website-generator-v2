// Serves ONE business: its finished website, its own orders panel and its orders, all from the same address.
//   node tools/serve-site.mjs <projectId> [--port 3100]
//   site        http://localhost:3100/
//   panel       http://localhost:3100/panel          (the owner's and staff's page)
//   data        orders-data/<siteId>/orders.db       (this business's own database: orders, accounts, history)
// Live, a business runs exactly like this behind its own domain (the host puts HTTPS in front); the panel is then <domain>/panel.

import fs from 'node:fs';
import path from 'node:path';
import { createOrdersServer, ordersDir } from '../src/server/orders/server.js';
import { createStore } from '../src/server/orders/store.js';
import { projectPath } from '../src/lib/project.js';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--') && a !== args[args.indexOf('--port') + 1]);
const port = Number(args[args.indexOf('--port') + 1]) || 3100;
if (!id) { console.log('Usage: node tools/serve-site.mjs <projectId> [--port 3100]'); process.exit(1); }
const siteId = String(id).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
const dist = projectPath(id, 'site/dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.log(`The site is not built yet: run  node src/cli.js site --project ${id} --build`); process.exit(1); }
const dir = path.join(ordersDir(), siteId);
const probe = createStore(dir);
if (!probe.getSite(siteId)) { console.log('This site has no orders panel (ordering was not switched on when it was built).'); probe.close(); process.exit(1); }
const needsSetup = !probe.hasOwner(siteId); probe.close();

const { server } = createOrdersServer({ dir, siteId, dist });
server.listen(port, process.env.ORDERS_HOST || '127.0.0.1', () => {
  const base = `http://localhost:${port}`;
  console.log(`[site] ${base}/            the website`);
  const saved = fs.existsSync(projectPath(id, 'panel.json')) ? JSON.parse(fs.readFileSync(projectPath(id, 'panel.json'), 'utf8')) : null;
  console.log(`[site] ${base}/panel       the owner's panel${needsSetup && saved?.setupToken ? `\n[site] first time, open this link to create the owner account:\n       ${base}/panel#setup=${saved.setupToken}` : ''}`);
});
