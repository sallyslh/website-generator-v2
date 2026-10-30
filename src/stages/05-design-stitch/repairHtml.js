// Repairs a known Stitch glitch: in some variants the logo's image address is printed as plain text
// where an <img> tag should be (for example ">\nhttps://lh3.googleusercontent.com/aida/...\n<").
// We turn such bare addresses into real images, reusing the alt text from another <img> with the same address.

import fs from 'node:fs';
import path from 'node:path';

const BARE_URL = />(\s*)(https:\/\/lh3\.googleusercontent\.com\/[^\s<>"']+)(\s*)</g;

export function repairHtml(html) {
  const altFor = (url) => html.match(new RegExp(`<img[^>]*src="${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'i'))?.[0].match(/alt="([^"]*)"/i)?.[1] ?? '';
  let count = 0;
  const fixed = html.replace(BARE_URL, (_, before, url, after) => {
    count++;
    return `>${before}<img src="${url}" alt="${altFor(url)}" class="h-full w-full object-contain">${after}<`;
  });
  return { html: fixed, repaired: count };
}

// Repairs every .html file below a folder. Returns the total number of repairs.
export function repairFolder(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += repairFolder(full);
    else if (entry.name.endsWith('.html') && entry.name !== 'preview.html') {
      const { html, repaired } = repairHtml(fs.readFileSync(full, 'utf8'));
      if (repaired) fs.writeFileSync(full, html);
      total += repaired;
    }
  }
  return total;
}
