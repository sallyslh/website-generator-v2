// The owner's social pages as real links. The form keeps a handle ("@ateliernour") or a link; both become a link the site can use, found by
// the platform name ("instagram"), by the handle as text ("@ateliernour"), or by the handle without the @.

const BASE = { instagram: (h) => `https://www.instagram.com/${h}`, tiktok: (h) => `https://www.tiktok.com/@${h}`, facebook: (h) => `https://www.facebook.com/${h}` };
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function socialUrl(platform, value) {
  const v = String(value ?? '').trim();
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, '').replace(/^\/+/, '');
  return handle && BASE[String(platform).toLowerCase()] ? BASE[String(platform).toLowerCase()](handle) : v;
}

// Map: platform name, handle text and handle without @ -> the link
export function socialLinksOf(socialLinks = []) {
  const out = new Map();
  for (const l of socialLinks) {
    const url = socialUrl(l.platform, l.url);
    out.set(String(l.platform).toLowerCase(), url);
    const handle = String(l.url ?? '').trim();
    if (handle && !/^https?:\/\//i.test(handle)) out.set(norm(handle), url);
  }
  return out;
}
