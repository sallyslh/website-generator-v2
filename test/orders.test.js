import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointBookingAtCalendar, bookingButtonsToCalendar, replaceBookingWidget, addOrdering, dropWhatsAppOrderButtons, rewordWhatsAppOrder, priceFormat, orderableRows, catalogOf, ORDER_JS } from '../src/stages/08-features/orders.js';
import { numericPrice } from '../src/lib/price.js';
import { splitWishes } from '../src/stages/01-discovery/index.js';
import { renderDishList } from '../src/lib/htmlRows.js';

test('the number inside a price is read the way the owner wrote it', () => {
  assert.equal(numericPrice('32.0'), 32);
  assert.equal(numericPrice('$8'), 8);
  assert.equal(numericPrice('12,5'), 12.5);
  assert.equal(numericPrice('50,000 LBP'), 50000);
  assert.equal(numericPrice('1.250,50'), 1250.5);
  assert.equal(numericPrice(''), null);
  assert.equal(numericPrice('ask us'), null);
});

test('the currency format keeps the owner\'s sign: "$#" or "# LBP"', () => {
  assert.equal(priceFormat('USD'), '$#');
  assert.equal(priceFormat('LBP'), '# LBP');
  assert.equal(priceFormat(''), '#');
});

test('a standard row says what it is and what it costs (only when it has a price)', () => {
  const html = '<section id="s"><div><div class="r"><span>A</span></div><div class="r"><span>B</span></div></div></section>';
  const out = renderDishList(html, { sectionId: 's', dishes: [{ name: 'A', description: '', price: '$5', priceRaw: '5.0', photo: '' }, { name: 'B', description: '', price: '', priceRaw: '', photo: '' }] }).html;
  assert.match(out, /data-item="A" data-price="5"/);
  assert.match(out, /data-item="B"/);
  assert.equal(orderableRows(out), 1);
});

test('ordering is added once per page, with the owner\'s number, mode and currency; nothing without a number', () => {
  const page = '<main>x</main>';
  const r = addOrdering(page, { mode: 'order', digits: '96103030303', currency: 'USD', language: 'en' });
  assert.ok(r.added);
  assert.match(r.html, /id="order-config"[^>]*data-mode="order"[^>]*data-wa="96103030303"[^>]*data-fmt="\$#"/);
  assert.match(r.html, /\/order\.js/);
  assert.equal(addOrdering(r.html, { mode: 'order', digits: '96103030303' }).added, false);
  assert.equal(addOrdering(page, { mode: 'order', digits: '' }).added, false);
  assert.equal(addOrdering(page, { mode: 'nope', digits: '1' }).added, false);
});

test('the browser script takes no payment: it only talks to the order service (or opens WhatsApp), and the customer pays in cash', () => {
  assert.match(ORDER_JS, /wa\.me/);
  assert.match(ORDER_JS, /cash/i);
  assert.doesNotMatch(ORDER_JS, /XMLHttpRequest|stripe|paypal|card number|cvv|credit/i);
  // two kinds of request, both to the service the page was built for: the order, and reading the free times of the calendar
  assert.equal((ORDER_JS.match(/fetch\(/g) ?? []).length, 2);
  assert.match(ORDER_JS, /fetch\(api \+ '\/api\/order\/'/);
  assert.match(ORDER_JS, /fetch\(api \+ path, \{ cache: 'no-store' \}\)/);
});

test('the form answer decides ordering: menu and shop order, services book, "none" (the default) turns it off', () => {
  const o = (siteType, orderMode) => splitWishes({ siteType, orderMode }).ordering;
  assert.equal(o('menu', 'whatsapp'), 'order');
  assert.equal(o('shop', 'panel'), 'order');
  assert.equal(o('services', 'panel'), 'book');
  assert.equal(o('menu', 'none'), '');
  assert.equal(o('menu', undefined), '');
  assert.equal(o('intro', 'panel'), '');
  const s = splitWishes({ siteType: 'menu', orderMode: 'panel', fulfil: ['delivery', 'dinein', 'drone', 'delivery'], deliveryFee: '$2.50 please' });
  assert.equal(s.orderTo, 'panel');
  assert.deepEqual(s.fulfil, ['delivery', 'dinein']);
  assert.equal(s.deliveryFee, '2.50');
});

test('the order address (or none: the same address as the website) and the site id go into the page config', () => {
  const r = addOrdering('<main>x</main>', { mode: 'order', to: 'panel', api: 'https://orders.example.com', siteId: 'c-abc123', fulfil: ['pickup', 'delivery'], fee: 2, currency: 'USD' });
  assert.ok(r.added);
  assert.match(r.html, /data-to="panel"[^>]*data-api="https:\/\/orders\.example\.com"[^>]*data-site="c-abc123"[^>]*data-fulfil="pickup,delivery"[^>]*data-fee="2"/);
  assert.equal(addOrdering('<main>x</main>', { mode: 'order', to: 'panel', api: '', siteId: '' }).added, false); // a site id is needed
  assert.match(addOrdering('<main>x</main>', { mode: 'order', to: 'panel', api: '', siteId: 'c-abc123' }).html, /data-api=""[^>]*data-site="c-abc123"/); // same address as the website
});

test('the catalog is read from the rows the site really shows (names with quotes and ampersands come back as written)', () => {
  const html = '<div data-item="Tom &amp; Jerry &quot;Big&quot;" data-price="7.5"></div><div data-item="Water"></div><div data-item="Tom &amp; Jerry &quot;Big&quot;" data-price="9"></div>';
  assert.deepEqual(catalogOf([html]), [{ name: 'Tom & Jerry "Big"', price: 7.5 }, { name: 'Water', price: 0 }]);
});

test('when orders are placed on the site, "Order on WhatsApp" buttons go (and the empty box they leave), other WhatsApp links stay', () => {
  const html = '<header><a href="/">Home</a><a href="https://wa.me/961">Order on WhatsApp</a></header><div class="c"><a href="https://wa.me/961">\n Order on WhatsApp\n</a></div><p><a href="https://wa.me/961">Chat with us on WhatsApp</a></p><a href="https://wa.me/961">اطلب عبر واتساب</a>';
  const r = dropWhatsAppOrderButtons(html);
  assert.equal(r.removed, 3);
  assert.doesNotMatch(r.html, /Order on WhatsApp|اطلب/);
  assert.doesNotMatch(r.html, /<div class="c">/);
  assert.match(r.html, /Chat with us on WhatsApp/);
  assert.match(r.html, /href="\/">Home/);
});

test('"order on WhatsApp" in the copy becomes "order on this website" (any case), other sentences are left alone', () => {
  assert.equal(rewordWhatsAppOrder('Order on WhatsApp, or call us on 03030303.'), 'Order on this website, or call us on 03030303.');
  assert.equal(rewordWhatsAppOrder('see the dishes, and order via WhatsApp.'), 'see the dishes, and order on this website.');
  assert.equal(rewordWhatsAppOrder('Chat with us on WhatsApp.'), 'Chat with us on WhatsApp.');
});

test('cleaning the page never removes the cart\'s settings box, and the cart is added after the cleaning', () => {
  const settings = '<div id="order-config" data-mode="order" hidden></div>';
  assert.match(dropWhatsAppOrderButtons(`<a href="https://wa.me/1">Order on WhatsApp</a>${settings}`).html, /id="order-config"/);
  const cleaned = dropWhatsAppOrderButtons('<main><a href="https://wa.me/1">Order on WhatsApp</a></main>').html;
  const r = addOrdering(cleaned, { mode: 'order', to: 'panel', api: 'http://x', siteId: 'site-1' });
  assert.match(r.html, /id="order-config"/);
});

test('"Book now" buttons that point at the external booking address open the website\'s own calendar instead', () => {
  const url = 'https://calendly.com/layla-skin-studio/consultation';
  const html = `<a data-e="a" class="btn" href="${url}" target="_blank" rel="noopener noreferrer">Book</a><a href="https://example.com/other">Other</a><a href="${url}">Again</a>`;
  const out = pointBookingAtCalendar(html, url);
  assert.equal((out.match(/href="#book"/g) ?? []).length, 2);
  assert.doesNotMatch(out, /calendly|target="_blank"/);
  assert.match(out, /href="https:\/\/example\.com\/other"/); // other links stay
});

test('with the website\'s own calendar, in-page buttons about booking open it, other in-page links stay', () => {
  const html = '<a class="x" href="#visit">Book consultation</a><a href="#path">See services and prices</a><a href="#book">Book</a><a href="#visit"><span>Reserve a time</span></a>';
  const out = bookingButtonsToCalendar(html);
  assert.equal((out.match(/href="#book"/g) ?? []).length, 3);
  assert.match(out, /href="#path">See services/);
  assert.equal(pointBookingAtCalendar('<a href="">x</a>', ''), '<a href="">x</a>'); // no address: nothing is touched
});

test('the designer\'s fake "Book your consultation" calendar is replaced by the real one (the heading stays)', () => {
  const html = '<main><section class="s" id="contact-booking"><div class="line"></div><div><h2>Book your consultation</h2><p>Choose a time</p></div><div class="card"><button>chevron_left</button><div>fake month grid</div></div></section><section id="other"><h2>Keep</h2></section></main>';
  const r = replaceBookingWidget(html);
  assert.ok(r.replaced);
  assert.match(r.html, /<h2>Book your consultation<\/h2>/);
  assert.match(r.html, /<div id="book" data-inline-calendar/);
  assert.doesNotMatch(r.html, /fake month grid|chevron_left/);
  assert.match(r.html, /<section id="other"><h2>Keep<\/h2><\/section>/);
  assert.equal(replaceBookingWidget('<section id="about"><h2>About</h2><p>x</p></section>').replaced, false);
  // the "#book" buttons get a target: the inline calendar when there is one, otherwise a marker
  assert.match(addOrdering('<main>x</main>', { mode: 'book', to: 'panel', siteId: 'abc-123', calendar: true }).html, /<span id="book"><\/span>/);
  assert.doesNotMatch(addOrdering(r.html, { mode: 'book', to: 'panel', siteId: 'abc-123', calendar: true }).html, /<span id="book">/);
});
