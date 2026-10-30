// Stage 8, pure functions: the website assistant's bubble on every page of the site. No AI. The browser part is chat-client.js (/chat.js)
// and chat.css (/chat.css). The conversation goes to the business's own server (/api/chat); nothing is stored by the website.

import fs from 'node:fs';

export const CHAT_JS = fs.readFileSync(new URL('./chat-client.js', import.meta.url), 'utf8');
export const CHAT_CSS = fs.readFileSync(new URL('./chat.css', import.meta.url), 'utf8');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// siteId: the business's id on its own server. api: '' = the same address as the website. Returns { html, added }.
export function addChat(html, { siteId, name = '', language = 'en', api = '' }) {
  if (!siteId || html.includes('id="chat-config"')) return { html, added: false };
  const attrs = { 'data-site': siteId, 'data-api': api, 'data-name': name, 'data-lang': language };
  const config = `<div id="chat-config" data-features="chat" hidden ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}></div>`;
  return { html: `${html}\n<link rel="stylesheet" href="/chat.css">\n${config}\n<script src="/chat.js" defer></script>\n`, added: true };
}
