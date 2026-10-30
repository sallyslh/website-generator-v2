// One menu for the whole site. Stitch draws every page on its own, so the top bar of one page may lack items the others have (a "More" list that is missing
// half its pages, a link that opens nothing). This copies the fullest header to every page and moves the "you are here" look to the link of that page.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const cheerio = createRequire(import.meta.url)('cheerio');

const pageLinks = ($, el) => $(el).find('a[href]').filter((_, a) => /\.html$/.test($(a).attr('href') ?? '')).toArray();
const cls = ($, el) => ($(el).attr('class') ?? '').trim();

// The class list most links of the top level share = the "not here" look.
function modal(values) {
  const counts = values.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map());
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

// Page names in the menu that a page file belongs to: "index.html" -> its own link(s).
export function syncMenus({ dir }) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  const docs = new Map(files.map((f) => [f, cheerio.load(fs.readFileSync(path.join(dir, f), 'utf8'), { decodeEntities: false })]));
  const withHeader = [...docs].filter(([, $]) => $('header').length);
  if (withHeader.length < 2) return { changed: [], reason: 'fewer than two pages have a header' };
  const size = ([f, $]) => new Set(pageLinks($, $('header')[0]).map((a) => $(a).attr('href'))).size;
  const best = withHeader.slice().sort((a, b) => size(b) - size(a) || (a[0] === 'index.html' ? -1 : 1))[0];
  const [bestFile, bestDoc] = best;
  const canonical = bestDoc('header').first();
  const nav = canonical.find('nav').first();
  const top = (nav.length ? nav : canonical).children('a[href]').toArray();
  const normal = modal(top.map((a) => cls(bestDoc, a)));
  const here = top.find((a) => cls(bestDoc, a) !== normal);
  const active = here ? cls(bestDoc, here) : null;
  const html = bestDoc.html(canonical);
  const changed = [];
  for (const [f, $] of withHeader) {
    const header = $('header').first();
    const before = $.html(header);
    const fresh = cheerio.load(html, { decodeEntities: false }, false);
    const top2 = (fresh('nav').first().length ? fresh('nav').first() : fresh.root()).children('a[href]').toArray();
    // the link of this page gets the "here" look, and the others the normal one
    if (active) {
      for (const a of top2) {
        const mine = fresh(a).attr('href') === f;
        fresh(a).attr('class', mine ? active : normal);
        if (mine) fresh(a).attr('aria-current', 'page'); else fresh(a).removeAttr('aria-current');
      }
    }
    const result = fresh.html();
    if (result !== before) { header.replaceWith(result); changed.push(f); fs.writeFileSync(path.join(dir, f), $.html()); }
  }
  return { source: bestFile, changed };
}

// ---------- the menu on phones ----------
// Stitch draws a laptop menu that disappears on narrow screens, and nothing replaces it. This adds a three-bar button (shown only when the menu is hidden) that opens
// a list of every page in the menu. It reads the real menu at the moment of the tap, so it follows later edits; colours are taken from the header itself.

const BURGER_CSS = `.wm-burger{display:none;align-items:center;justify-content:center;width:44px;height:44px;margin-left:8px;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer;flex:none}
.wm-burger.wm-on{display:inline-flex}.wm-burger svg{width:26px;height:26px}
.wm-panel{position:fixed;left:0;right:0;z-index:2147483000;overflow-y:auto;padding:8px 20px 20px;box-shadow:0 18px 40px rgba(0,0,0,.35);display:none}
[data-wm-open]>div{display:block !important}
.wm-panel.wm-open{display:block}.wm-panel a{display:block;padding:14px 4px;font-size:18px;text-decoration:none;color:inherit;border-bottom:1px solid rgba(127,127,127,.25)}
.wm-panel a.wm-cta{margin-top:14px;text-align:center;border:0;border-radius:10px;font-weight:700}`;

const BURGER_JS = String.raw`(function(){
  var h=document.querySelector('header');if(!h)return;var nav=h.querySelector('nav');if(!nav)return;
  // the top bar scrolls away with the page instead of following the visitor (a bar that stays is annoying, most of all on a phone)
  var pos=getComputedStyle(h).position;if(pos==='fixed')h.style.setProperty('position','absolute','important');else if(pos==='sticky')h.style.setProperty('position','relative','important');
  var b=document.createElement('button');b.type='button';b.className='wm-burger';b.setAttribute('aria-label','Menu');b.setAttribute('aria-expanded','false');
  b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  var bar=h.firstElementChild&&h.firstElementChild.children.length?h.firstElementChild:h;bar.appendChild(b);
  var p=document.createElement('div');p.className='wm-panel';p.setAttribute('role','navigation');document.body.appendChild(p);
  function label(a){var c=a.cloneNode(true);c.querySelectorAll('[class*=material],svg,img').forEach(function(x){x.remove()});return c.textContent.replace(/\s+/g,' ').trim()}
  function bg(){var e=h;while(e){var c=getComputedStyle(e).backgroundColor;if(c&&c!=='rgba(0, 0, 0, 0)'&&c!=='transparent'){var m=c.match(/[\d.]+/g);if(!m||m.length<4||+m[3]>0.6)return c.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/,'rgb($1,$2,$3)')}e=e.parentElement}return getComputedStyle(document.body).backgroundColor}
  function fill(){var seen={},html='';var links=[].slice.call(nav.querySelectorAll('a[href]'));
    links.forEach(function(a){var href=a.getAttribute('href');var t=label(a);if(!t||!href||href==='#'||seen[href])return;seen[href]=1;html+='<a href="'+href+'">'+t.replace(/</g,'&lt;')+'</a>'});
    var cta=[].slice.call(h.querySelectorAll('a[href]')).filter(function(a){return !nav.contains(a)&&a.getAttribute('href')!=='#'&&a.getAttribute('href')!=='index.html'}).pop();
    if(cta&&!seen[cta.getAttribute('href')]){var s=getComputedStyle(cta);html+='<a class="wm-cta" href="'+cta.getAttribute('href')+'" style="background:'+s.backgroundColor+';color:'+s.color+'">'+label(cta).replace(/</g,'&lt;')+'</a>'}
    p.innerHTML=html}
  function place(){var r=h.getBoundingClientRect();p.style.top=Math.max(0,r.bottom)+'px';p.style.maxHeight=(innerHeight-Math.max(0,r.bottom))+'px';p.style.background=bg();p.style.color=getComputedStyle(h).color}
  function close(){p.classList.remove('wm-open');b.setAttribute('aria-expanded','false')}
  b.addEventListener('click',function(e){e.stopPropagation();if(p.classList.contains('wm-open'))return close();fill();place();p.classList.add('wm-open');b.setAttribute('aria-expanded','true')});
  document.addEventListener('click',function(e){if(!p.contains(e.target))close()});document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
  function sync(){var hidden=getComputedStyle(nav).display==='none';b.classList.toggle('wm-on',hidden);if(!hidden)close()}
  // a "More" button with a list of links opens by tap or click too (the drawn design opens it only on mouse hover)
  [].slice.call(nav.querySelectorAll('button')).forEach(function(btn){var box=btn.parentElement;if(!box||!box.querySelector('a[href]'))return;
    btn.setAttribute('aria-haspopup','true');btn.setAttribute('aria-expanded','false');
    btn.addEventListener('click',function(e){e.stopPropagation();var on=box.hasAttribute('data-wm-open');document.querySelectorAll('[data-wm-open]').forEach(function(x){x.removeAttribute('data-wm-open')});if(!on){box.setAttribute('data-wm-open','');btn.setAttribute('aria-expanded','true')}else btn.setAttribute('aria-expanded','false')});
    document.addEventListener('click',function(){box.removeAttribute('data-wm-open');btn.setAttribute('aria-expanded','false')})});
  // the hero was moved from over the photo to under it (see hero.js): its buttons were drawn for a dark photo and can vanish on the page, so they are recoloured when too faint
  function rgb(c){var m=(c||'').match(/[\d.]+/g)||[];return {r:+m[0]||0,g:+m[1]||0,b:+m[2]||0,a:m.length>3?+m[3]:1}}
  function L(c){function f(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b)}
  function cr(a,b){var x=L(a),y=L(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)}
  function pageBg(from){var e=from;while(e){var c=rgb(getComputedStyle(e).backgroundColor);if(c.a>0.6)return c;e=e.parentElement}return {r:255,g:255,b:255,a:1}}
  function heroButtons(){var s=document.querySelector('[data-hero-stacked]');if(!s)return;var phone=innerWidth<768;
    s.querySelectorAll('a,button').forEach(function(b){
      if(b.closest('header'))return;
      if(!phone){['background-color','color','border-color'].forEach(function(p){b.style.removeProperty(p)});return}
      var bgp=pageBg(s.parentElement||s),ink=rgb(getComputedStyle(document.body).color),cs=getComputedStyle(b),bg=rgb(cs.backgroundColor),fg=rgb(cs.color);
      var solid=bg.a>0.6,eff=solid?bg:bgp;
      if(solid&&cr(bg,bgp)<1.35){b.style.setProperty('background-color','rgb('+ink.r+','+ink.g+','+ink.b+')','important');b.style.setProperty('color','rgb('+bgp.r+','+bgp.g+','+bgp.b+')','important')}
      else if(cr(fg,eff)<3){b.style.setProperty('color','rgb('+ink.r+','+ink.g+','+ink.b+')','important');if(!solid)b.style.setProperty('border-color','rgb('+ink.r+','+ink.g+','+ink.b+')','important')}
    })}
  // a safety net for readability: text that is nearly invisible on a plain colour (dark on dark, light on light) is flipped to black or white. It skips text on a
  // photo or gradient (the colour behind it is not known), faint decoration (low opacity) and very large lettering.
  function layers(el){var stack=[],e=el;while(e&&e.nodeType===1){var cs=getComputedStyle(e);if(cs.backgroundImage&&cs.backgroundImage!=='none')return null;var c=rgb(cs.backgroundColor);if(c.a>0){stack.push(c);if(c.a>=0.999)break}e=e.parentElement}
    var base={r:255,g:255,b:255};for(var i=stack.length-1;i>=0;i--){var c=stack[i];base={r:base.r*(1-c.a)+c.r*c.a,g:base.g*(1-c.a)+c.g*c.a,b:base.b*(1-c.a)+c.b*c.a}}return {r:base.r,g:base.g,b:base.b,a:1}}
  function guardText(){
    var media=[].slice.call(document.querySelectorAll('img,video,canvas,picture')).map(function(m){return m.getBoundingClientRect()}).filter(function(m){return m.width>40&&m.height>40});
    var els=document.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,span,a,button,label,td,th,dt,dd,small,strong,em,div');
    for(var i=0;i<els.length;i++){var el=els[i];
      if(!el.childNodes||![].some.call(el.childNodes,function(n){return n.nodeType===3&&n.textContent.trim().length>1}))continue;
      var r=el.getBoundingClientRect();if(r.width<4||r.height<4)continue;
      var cs=getComputedStyle(el);if(cs.visibility==='hidden'||cs.display==='none'||parseFloat(cs.fontSize)>56)continue;
      var op=1,p=el;while(p&&p.nodeType===1){op*=parseFloat(getComputedStyle(p).opacity);p=p.parentElement}if(op<0.6)continue;
      if(el.closest('[aria-hidden="true"],.wm-panel'))continue;
      if(media.some(function(m){return r.left<m.right&&r.right>m.left&&r.top<m.bottom&&r.bottom>m.top}))continue; // text over a photo: the colour behind it is not a plain one
      var bg=layers(el);if(!bg)continue;var fg=rgb(cs.color);if(fg.a<0.2)continue;
      if(cr(fg,bg)<3){var white={r:255,g:255,b:255},black={r:17,g:17,b:17};var use=cr(white,bg)>=cr(black,bg)?white:black;el.style.setProperty('color','rgb('+use.r+','+use.g+','+use.b+')','important');el.setAttribute('data-wm-contrast','')}
    }}
  setTimeout(guardText,400);addEventListener('load',function(){setTimeout(guardText,300)});addEventListener('resize',function(){setTimeout(guardText,200)});
  heroButtons();addEventListener('resize',heroButtons);
  sync();addEventListener('resize',sync);addEventListener('scroll',function(){if(p.classList.contains('wm-open'))place()},{passive:true});
})();`;

export function addPhoneMenus({ dir }) {
  const done = []; const skipped = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
    const file = path.join(dir, f); let html = fs.readFileSync(file, 'utf8');
    // an earlier copy of the menu (this tool's own style and script, possibly re-written by another step as data-wm-menu="") is replaced, so a newer menu reaches old pages
    html = html.replace(/<style data-wm-menu(?:="")?>[\s\S]*?<\/style>/g, '').replace(/<script data-wm-menu(?:="")?>[\s\S]*?<\/script>/g, '');
    if (!/<header[\s>]/i.test(html) || !/<nav[\s>]/i.test(html)) { skipped.push(`${f} (no header menu)`); continue; }
    html = html.replace(/<\/head>/i, `<style data-wm-menu>${BURGER_CSS}</style></head>`).replace(/<\/body>/i, `<script data-wm-menu>${BURGER_JS}</script></body>`);
    fs.writeFileSync(file, html); done.push(f);
  }
  return { done, skipped };
}
