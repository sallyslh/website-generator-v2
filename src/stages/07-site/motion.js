// The motion layer of a generated site: public/motion.css + public/motion.js, tuned by the director's motion style.
// Rules that never change:
//  - only transform and opacity move (nothing that re-flows the page), nothing adds content or changes a word;
//  - everything sits inside @media (prefers-reduced-motion: no-preference), and the script stops itself when the visitor asked for less motion,
//    so those visitors (and anyone without scripts) get the plain, finished page;
//  - the header, the footer and the first screen are never hidden before they animate in (no blank first screen).

export const MOTION_STYLES = {
  calm: { rise: '14px', time: '.9s', step: '90ms', zoom: 1.03, hover: false, parallax: 0 },
  lively: { rise: '24px', time: '.7s', step: '80ms', zoom: 1.06, hover: true, parallax: 0 },
  bold: { rise: '44px', time: '.6s', step: '70ms', zoom: 1.1, hover: true, parallax: 0.08 },
};

export const motionCss = (style) => {
  const m = MOTION_STYLES[style];
  return `/* motion: ${style}. Only transform and opacity. Nothing here applies when the visitor prefers reduced motion. */
@view-transition { navigation: auto; }
@media (prefers-reduced-motion: no-preference) {
  html[data-motion] { --m-rise: ${m.rise}; --m-time: ${m.time}; --m-step: ${m.step}; --m-zoom: ${m.zoom}; }
  html.m-on .m-in { opacity: 0; transform: translate3d(0, var(--m-rise), 0); transition: opacity var(--m-time) cubic-bezier(.2,.7,.2,1), transform var(--m-time) cubic-bezier(.2,.7,.2,1); transition-delay: calc(var(--i, 0) * var(--m-step)); will-change: opacity, transform; }
  html.m-on .m-in.m-zoom { transform: scale(var(--m-zoom)); }
  html.m-on .m-in.in { opacity: 1; transform: none; will-change: auto; }
  html.m-on .m-first { animation: m-up var(--m-time) cubic-bezier(.2,.7,.2,1) both; animation-delay: calc(var(--i, 0) * var(--m-step) + 80ms); }
  @keyframes m-up { from { opacity: 0; transform: translate3d(0, var(--m-rise), 0); } to { opacity: 1; transform: none; } }
${m.hover ? `  @media (hover: hover) {
    html.m-on a[class*="bg-"], html.m-on button { transition: transform .25s ease, box-shadow .25s ease, background-color .25s ease; }
    html.m-on a[class*="bg-"]:hover, html.m-on button:hover { transform: translate3d(0, -2px, 0); }
    html.m-on .m-card img { transition: transform .9s cubic-bezier(.2,.7,.2,1); }
    html.m-on .m-card:hover img { transform: scale(var(--m-zoom)); }
  }
` : ''}${m.parallax ? '  html.m-on [data-parallax] { transform: translate3d(0, var(--py, 0px), 0) scale(1.12); will-change: transform; }\n' : ''}}
`;
};

export const motionJs = (style) => {
  const m = MOTION_STYLES[style];
  return `// motion: ${style}. Marks what exists on the page, never adds content. Does nothing when reduced motion is requested.
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  var root = document.documentElement;
  var main = document.querySelector('main') || document.body;
  var chrome = 'header, footer, nav';
  var skip = function (el) { return el.closest(chrome) || el.closest('form') || el.closest('[aria-hidden="true"]') || el.closest('.m-in'); };
  var clips = function (el) { var p = el.parentElement; return p && /(hidden|clip)/.test(getComputedStyle(p).overflow); };
  var vh = innerHeight;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
  var mark = function (el, i, zoom) { el.classList.add('m-in'); if (zoom) el.classList.add('m-zoom'); el.style.setProperty('--i', String(i % 6)); io.observe(el); };

  // the first screen: its text and buttons rise one after the other (a CSS animation: no blank frame, nothing waits for scroll)
  var sections = Array.prototype.slice.call(main.children);
  var firstTexts = sections.length ? sections[0].querySelectorAll('h1, h2, p, a, button') : [];
  Array.prototype.forEach.call(firstTexts, function (el, i) { if (!el.closest(chrome)) { el.classList.add('m-first'); el.style.setProperty('--i', String(Math.min(i, 5))); } });
${m.parallax ? `  var hero = sections.length ? sections[0].querySelector('img') : null;
  if (hero && clips(hero)) {
    hero.setAttribute('data-parallax', '');
    var ticking = false;
    addEventListener('scroll', function () {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () { hero.style.setProperty('--py', Math.round(Math.min(scrollY, vh) * ${m.parallax} * -1) + 'px'); ticking = false; });
    }, { passive: true });
  }
` : ''}
  // the rest: cards of a grid or row come in one after the other, then headings, text and loose pictures
  sections.slice(1).forEach(function (section) {
    Array.prototype.forEach.call(section.querySelectorAll('*'), function (el) {
      var kids = el.children;
      if (kids.length < 3 || skip(el)) return;
      var d = getComputedStyle(el).display;
      if (d !== 'grid' && d !== 'flex') return;
      Array.prototype.forEach.call(kids, function (kid, i) { if (!skip(kid) && kid.offsetHeight > 24) { kid.classList.add('m-card'); mark(kid, i, false); } });
    });
    Array.prototype.forEach.call(section.querySelectorAll('h1, h2, h3, p, img, picture, figure, blockquote, a, button'), function (el, i) {
      if (skip(el) || (el.tagName === 'P' && el.textContent.trim().length < 2)) return;
      var pic = /^(IMG|PICTURE|FIGURE)$/.test(el.tagName);
      mark(el, pic ? 0 : Math.min(i, 3), pic && clips(el));
    });
  });
  root.classList.add('m-on');
})();
`;
};
