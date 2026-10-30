// Served as /order.js. Runs in the visitor's browser (no server, no payment).
//   mode "order": every item with a price gets an Add button; a cart collects them; the order (name, phone, pickup or delivery,
//                 address, notes) is written as a WhatsApp message to the owner. The customer pays the owner in cash when they receive it.
//   mode "book":  every item gets a Book button. With the owner's booking link it opens that link; without one an appointment request
//                 (service, day, time, name, phone) is written as a WhatsApp message to the owner.
// The cart lives in this browser only (localStorage, when allowed). Nothing is sent anywhere except the WhatsApp chat the visitor opens.
(function () {
  var cfg = document.getElementById('order-config');
  if (!cfg) return;
  var wa = cfg.getAttribute('data-wa') || '';
  var mode = cfg.getAttribute('data-mode') === 'book' ? 'book' : 'order';
  var fmt = cfg.getAttribute('data-fmt') || '#';
  var bookUrl = cfg.getAttribute('data-book-url') || '';
  var lang = (cfg.getAttribute('data-lang') || 'en').slice(0, 2);
  var to = cfg.getAttribute('data-to') === 'panel' ? 'panel' : 'whatsapp'; // where an order goes: the owner's live panel, or his WhatsApp
  var api = (cfg.getAttribute('data-api') || '').replace(/\/$/, ''); var siteId = cfg.getAttribute('data-site') || '';
  var fulfil = (cfg.getAttribute('data-fulfil') || 'pickup,delivery').split(',').filter(Boolean);
  var fee = Number(cfg.getAttribute('data-fee')) || 0;
  var calendar = cfg.getAttribute('data-calendar') === '1' && to === 'panel'; // appointments from a real calendar (opening hours known)
  var services = [];
  try { services = JSON.parse(cfg.getAttribute('data-services') || '[]'); } catch (e) { services = []; }

  var TEXT = {
    en: { add: 'Add', book: 'Book', view: 'View order', items: 'items', item: 'item', your: 'Your order', total: 'Total', name: 'Your name', phone: 'Phone number', pickup: 'Pick up', delivery: 'Delivery', address: 'Delivery address', notes: 'Notes (optional)', cash: 'You pay in cash when you receive your order.', send: 'Send order on WhatsApp', remove: 'Remove', empty: 'Your order is empty.', need: 'Please fill in the highlighted fields.', thanks: 'Your order is ready to send: finish it in WhatsApp.', title: 'New order', how: 'How', pay: 'Payment: cash on delivery', bookTitle: 'Book an appointment', service: 'Service', day: 'Day', time: 'Time', sendBook: 'Send request on WhatsApp', request: 'Appointment request', thanksBook: 'Your request is ready to send: finish it in WhatsApp.', note: 'We will confirm by WhatsApp.', close: 'Close', pick: 'Choose a service' },
    ar: { add: 'أضف', book: 'احجز', view: 'عرض الطلب', items: 'عناصر', item: 'عنصر', your: 'طلبك', total: 'المجموع', name: 'اسمك', phone: 'رقم الهاتف', pickup: 'استلام من المحل', delivery: 'توصيل', address: 'عنوان التوصيل', notes: 'ملاحظات (اختياري)', cash: 'الدفع نقدًا عند الاستلام.', send: 'أرسل الطلب عبر واتساب', remove: 'حذف', empty: 'طلبك فارغ.', need: 'يرجى تعبئة الحقول المحددة.', thanks: 'طلبك جاهز للإرسال: أكمله في واتساب.', title: 'طلب جديد', how: 'الطريقة', pay: 'الدفع: نقدًا عند الاستلام', bookTitle: 'احجز موعدًا', service: 'الخدمة', day: 'اليوم', time: 'الوقت', sendBook: 'أرسل الطلب عبر واتساب', request: 'طلب موعد', thanksBook: 'طلبك جاهز للإرسال: أكمله في واتساب.', note: 'سنؤكد لك عبر واتساب.', close: 'إغلاق', pick: 'اختر خدمة' },
    fr: { add: 'Ajouter', book: 'Réserver', view: 'Voir la commande', items: 'articles', item: 'article', your: 'Votre commande', total: 'Total', name: 'Votre nom', phone: 'Téléphone', pickup: 'À emporter', delivery: 'Livraison', address: 'Adresse de livraison', notes: 'Remarques (facultatif)', cash: 'Vous payez en espèces à la réception.', send: 'Envoyer la commande sur WhatsApp', remove: 'Retirer', empty: 'Votre commande est vide.', need: 'Merci de remplir les champs signalés.', thanks: 'Votre commande est prête : terminez-la dans WhatsApp.', title: 'Nouvelle commande', how: 'Mode', pay: 'Paiement : en espèces à la livraison', bookTitle: 'Prendre rendez-vous', service: 'Service', day: 'Jour', time: 'Heure', sendBook: 'Envoyer la demande sur WhatsApp', request: 'Demande de rendez-vous', thanksBook: 'Votre demande est prête : terminez-la dans WhatsApp.', note: 'Nous confirmerons sur WhatsApp.', close: 'Fermer', pick: 'Choisissez un service' },
    es: { add: 'Añadir', book: 'Reservar', view: 'Ver pedido', items: 'artículos', item: 'artículo', your: 'Tu pedido', total: 'Total', name: 'Tu nombre', phone: 'Teléfono', pickup: 'Recoger', delivery: 'Entrega', address: 'Dirección de entrega', notes: 'Notas (opcional)', cash: 'Pagas en efectivo al recibir tu pedido.', send: 'Enviar pedido por WhatsApp', remove: 'Quitar', empty: 'Tu pedido está vacío.', need: 'Completa los campos marcados.', thanks: 'Tu pedido está listo: termínalo en WhatsApp.', title: 'Nuevo pedido', how: 'Modo', pay: 'Pago: en efectivo a la entrega', bookTitle: 'Reservar una cita', service: 'Servicio', day: 'Día', time: 'Hora', sendBook: 'Enviar solicitud por WhatsApp', request: 'Solicitud de cita', thanksBook: 'Tu solicitud está lista: termínala en WhatsApp.', note: 'Confirmaremos por WhatsApp.', close: 'Cerrar', pick: 'Elige un servicio' },
    de: { add: 'Hinzufügen', book: 'Buchen', view: 'Bestellung ansehen', items: 'Artikel', item: 'Artikel', your: 'Ihre Bestellung', total: 'Summe', name: 'Ihr Name', phone: 'Telefonnummer', pickup: 'Abholung', delivery: 'Lieferung', address: 'Lieferadresse', notes: 'Hinweise (optional)', cash: 'Sie zahlen bar bei Erhalt.', send: 'Bestellung per WhatsApp senden', remove: 'Entfernen', empty: 'Ihre Bestellung ist leer.', need: 'Bitte füllen Sie die markierten Felder aus.', thanks: 'Ihre Bestellung ist bereit: schließen Sie sie in WhatsApp ab.', title: 'Neue Bestellung', how: 'Art', pay: 'Zahlung: bar bei Lieferung', bookTitle: 'Termin buchen', service: 'Leistung', day: 'Tag', time: 'Uhrzeit', sendBook: 'Anfrage per WhatsApp senden', request: 'Terminanfrage', thanksBook: 'Ihre Anfrage ist bereit: schließen Sie sie in WhatsApp ab.', note: 'Wir bestätigen per WhatsApp.', close: 'Schließen', pick: 'Leistung wählen' },
  };
  var MORE = {
    en: { dinein: 'Eat in', table: 'Table number (optional)', fee: 'Delivery fee', place: 'Place order', placed: 'Thank you! Your order #{n} was received. We will confirm it shortly. You pay in cash.', failed: 'Sorry, the order could not be sent. Please try again or contact us directly.', placeBook: 'Send appointment request', placedBook: 'Thank you! Your request #{n} was received. We will confirm it shortly.', chooseDay: 'Choose a day', chooseTime: 'Choose a time', noTimes: 'No free times that day.', taken: 'Already taken', closed: 'Closed', full: 'Fully booked', sending: 'Sending...', soon: 'We will confirm your appointment shortly.' },
    ar: { dinein: 'تناول الطعام في المكان', table: 'رقم الطاولة (اختياري)', fee: 'رسوم التوصيل', place: 'أرسل الطلب', placed: 'شكرًا لك! تم استلام طلبك رقم {n}. سنؤكده قريبًا. الدفع نقدًا.', failed: 'عذرًا، تعذّر إرسال الطلب. حاول مرة أخرى أو تواصل معنا مباشرة.', placeBook: 'أرسل طلب الموعد', placedBook: 'شكرًا لك! تم استلام طلبك رقم {n}. سنؤكده قريبًا.', chooseDay: 'اختر يومًا', chooseTime: 'اختر وقتًا', noTimes: 'لا توجد أوقات متاحة في هذا اليوم.', taken: 'محجوز', closed: 'مغلق', full: 'محجوز بالكامل', sending: 'جارٍ الإرسال...', soon: 'سنؤكد موعدك قريبًا.' },
    fr: { dinein: 'Sur place', table: 'Numéro de table (facultatif)', fee: 'Frais de livraison', place: 'Passer la commande', placed: 'Merci ! Votre commande n° {n} a bien été reçue. Nous la confirmons très vite. Paiement en espèces.', failed: "Désolé, la commande n'a pas pu être envoyée. Réessayez ou contactez-nous directement.", placeBook: 'Envoyer la demande', placedBook: 'Merci ! Votre demande n° {n} a bien été reçue. Nous la confirmons très vite.', chooseDay: 'Choisissez un jour', chooseTime: 'Choisissez une heure', noTimes: 'Aucune heure libre ce jour-là.', taken: 'Déjà pris', closed: 'Fermé', full: 'Complet', sending: 'Envoi...', soon: 'Nous confirmerons votre rendez-vous très vite.' },
    es: { dinein: 'Comer aquí', table: 'Número de mesa (opcional)', fee: 'Gastos de envío', place: 'Hacer el pedido', placed: '¡Gracias! Recibimos tu pedido n.º {n}. Lo confirmaremos enseguida. Pagas en efectivo.', failed: 'Lo sentimos, no se pudo enviar el pedido. Inténtalo de nuevo o contáctanos directamente.', placeBook: 'Enviar solicitud de cita', placedBook: '¡Gracias! Recibimos tu solicitud n.º {n}. La confirmaremos enseguida.', chooseDay: 'Elige un día', chooseTime: 'Elige una hora', noTimes: 'No hay horas libres ese día.', taken: 'Ya reservado', closed: 'Cerrado', full: 'Completo', sending: 'Enviando...', soon: 'Confirmaremos tu cita enseguida.' },
    de: { dinein: 'Vor Ort essen', table: 'Tischnummer (optional)', fee: 'Liefergebühr', place: 'Bestellung aufgeben', placed: 'Danke! Ihre Bestellung Nr. {n} ist eingegangen. Wir bestätigen sie in Kürze. Sie zahlen bar.', failed: 'Leider konnte die Bestellung nicht gesendet werden. Bitte versuchen Sie es erneut oder kontaktieren Sie uns direkt.', placeBook: 'Terminanfrage senden', placedBook: 'Danke! Ihre Anfrage Nr. {n} ist eingegangen. Wir bestätigen sie in Kürze.', chooseDay: 'Tag wählen', chooseTime: 'Uhrzeit wählen', noTimes: 'An diesem Tag ist nichts mehr frei.', taken: 'Schon vergeben', closed: 'Geschlossen', full: 'Ausgebucht', sending: 'Wird gesendet...', soon: 'Wir bestätigen Ihren Termin in Kürze.' },
  };
  var T = {};
  [TEXT.en, TEXT[lang], MORE.en, MORE[lang]].forEach(function (set) { Object.keys(set || {}).forEach(function (k) { T[k] = set[k]; }); });
  // an order goes to the owner's panel through the order service (the prices are checked there), or to his WhatsApp
  function post(body) {
    body.website = ''; // a hidden field for bots: a person never fills it
    return fetch(api + '/api/order/' + siteId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || T.failed); return d; }); });
  }
  var rtl = lang === 'ar';
  var NL = String.fromCharCode(10);

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function money(n) { return fmt.replace('#', String(Math.round(n * 100) / 100)); }

  // colors: the page's own background and text, so the cart is readable on any design
  function paint() {
    var bg = getComputedStyle(document.body).backgroundColor;
    if (!bg || /rgba\(.*,\s*0\)$/.test(bg) || bg === 'transparent') bg = getComputedStyle(document.documentElement).backgroundColor;
    if (!bg || /rgba\(.*,\s*0\)$/.test(bg) || bg === 'transparent') bg = '#ffffff';
    var root = document.documentElement.style;
    root.setProperty('--o-bg', bg);
    root.setProperty('--o-fg', getComputedStyle(document.body).color || '#111111');
  }
  paint();

  // ---- cart ----
  var KEY = 'order-cart-' + wa;
  var cart = {};
  try { cart = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { cart = {}; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) { /* the cart still works for this visit */ } }
  function count() { return Object.keys(cart).reduce(function (s, k) { return s + cart[k].qty; }, 0); }
  function total() { return Object.keys(cart).reduce(function (s, k) { return s + cart[k].qty * cart[k].price; }, 0); }
  function change(name, price, delta) {
    var line = cart[name] || { qty: 0, price: price };
    line.qty += delta; line.price = price;
    if (line.qty <= 0) delete cart[name]; else cart[name] = line;
    save(); refresh();
  }

  // ---- buttons on the items ----
  var rows = Array.prototype.slice.call(document.querySelectorAll('[data-item]'));
  function controlFor(row) {
    var name = row.getAttribute('data-item'); var price = Number(row.getAttribute('data-price'));
    var box = row.querySelector('[data-o-control]');
    if (!box) { box = el('div', { 'data-o-control': '', class: 'o-control' }); (row.querySelector('.min-w-0') || row).appendChild(box); }
    box.textContent = '';
    if (mode === 'book') {
      if (bookUrl) box.appendChild(el('a', { class: 'o-btn', href: bookUrl, target: '_blank', rel: 'noopener noreferrer', text: T.book }));
      else { var b = el('button', { type: 'button', class: 'o-btn', text: T.book }); b.addEventListener('click', function () { openBook(name); }); box.appendChild(b); }
      return;
    }
    var line = cart[name];
    if (!line) { var add = el('button', { type: 'button', class: 'o-btn', text: '+ ' + T.add }); add.addEventListener('click', function () { change(name, price, 1); }); box.appendChild(add); return; }
    var minus = el('button', { type: 'button', class: 'o-step', 'aria-label': T.remove, text: '−' });
    var plus = el('button', { type: 'button', class: 'o-step', 'aria-label': T.add, text: '+' });
    minus.addEventListener('click', function () { change(name, price, -1); });
    plus.addEventListener('click', function () { change(name, price, 1); });
    box.appendChild(minus); box.appendChild(el('span', { class: 'o-qty', text: String(line.qty) })); box.appendChild(plus);
  }

  // ---- the bar and the panel ----
  var bar = el('button', { type: 'button', class: 'o-bar', hidden: '' });
  var overlay = el('div', { class: 'o-overlay', hidden: '', dir: rtl ? 'rtl' : 'ltr' });
  var panel = el('div', { class: 'o-panel', role: 'dialog', 'aria-modal': 'true' });
  overlay.appendChild(panel);
  document.body.appendChild(bar); document.body.appendChild(overlay);
  var thanks = ''; // what was said after the last order, shown instead of an empty cart until the panel is closed
  function close() { thanks = ''; overlay.hidden = true; document.body.classList.remove('o-lock'); }
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  function refresh() {
    rows.forEach(function (row) { if (mode === 'book' || row.hasAttribute('data-price')) controlFor(row); });
    if (mode === 'order') {
      var n = count();
      bar.hidden = n === 0;
      bar.textContent = T.view + ' · ' + n + ' ' + (n === 1 ? T.item : T.items) + ' · ' + money(total());
      if (!overlay.hidden) drawOrder();
    } else bar.hidden = false;
  }

  function field(label, input, id) {
    var wrap = el('label', { class: 'o-field' }, [el('span', { text: label }), input]);
    if (id) input.id = id;
    return wrap;
  }
  function note(text) { return el('p', { class: 'o-note', text: text }); }
  function head(title) {
    var x = el('button', { type: 'button', class: 'o-x', 'aria-label': T.close, text: '×' });
    x.addEventListener('click', close);
    return el('div', { class: 'o-head' }, [el('h2', { text: title }), x]);
  }
  function mark(input, bad) { input.classList.toggle('o-bad', bad); return bad; }

  var form = { type: fulfil[0] };
  function drawOrder() {
    panel.textContent = '';
    panel.appendChild(head(T.your));
    var names = Object.keys(cart);
    if (!names.length) { panel.appendChild(el('p', { class: thanks ? 'o-done' : 'o-note', role: 'status', text: thanks || T.empty })); return; }
    var list = el('div', { class: 'o-lines' });
    names.forEach(function (name) {
      var line = cart[name];
      var minus = el('button', { type: 'button', class: 'o-step', 'aria-label': T.remove, text: '−' });
      var plus = el('button', { type: 'button', class: 'o-step', 'aria-label': T.add, text: '+' });
      minus.addEventListener('click', function () { change(name, line.price, -1); });
      plus.addEventListener('click', function () { change(name, line.price, 1); });
      list.appendChild(el('div', { class: 'o-line' }, [el('span', { class: 'o-name', text: name }), el('span', { class: 'o-ctl' }, [minus, el('span', { class: 'o-qty', text: String(line.qty) }), plus]), el('span', { class: 'o-sum', text: money(line.qty * line.price) })]));
    });
    panel.appendChild(list);
    var feeRow = el('div', { class: 'o-feeRow' });
    var totalB = el('b');
    function grand() { return total() + (form.type === 'delivery' ? fee : 0); }
    function totals() {
      feeRow.textContent = ''; feeRow.hidden = !(form.type === 'delivery' && fee > 0);
      if (!feeRow.hidden) { feeRow.appendChild(el('span', { text: T.fee })); feeRow.appendChild(el('span', { text: money(fee) })); }
      totalB.textContent = money(grand());
    }
    panel.appendChild(feeRow);
    panel.appendChild(el('div', { class: 'o-total' }, [el('span', { text: T.total }), totalB]));

    var nameIn = el('input', { type: 'text', autocomplete: 'name', value: form.name || '' });
    var phoneIn = el('input', { type: 'tel', autocomplete: 'tel', inputmode: 'tel', value: form.phone || '' });
    var addrIn = el('textarea', { rows: '2', autocomplete: 'street-address' }); addrIn.value = form.address || '';
    var notesIn = el('textarea', { rows: '2' }); notesIn.value = form.notes || '';
    var kinds = el('div', { class: 'o-kinds' });
    var addrLabel = el('span');
    var addrWrap = el('label', { class: 'o-field' }, [addrLabel, addrIn]);
    function showAddress() {
      addrWrap.hidden = form.type === 'pickup';
      addrLabel.textContent = form.type === 'dinein' ? T.table : T.address;
      addrIn.rows = form.type === 'dinein' ? 1 : 2;
    }
    if (fulfil.indexOf(form.type) < 0) form.type = fulfil[0];
    fulfil.forEach(function (k) {
      var r = el('input', { type: 'radio', name: 'o-type', value: k }); r.checked = form.type === k;
      r.addEventListener('change', function () { form.type = k; showAddress(); totals(); });
      kinds.appendChild(el('label', { class: 'o-kind' }, [r, el('span', { text: T[k] })]));
    });
    showAddress(); totals();
    panel.appendChild(field(T.name, nameIn)); panel.appendChild(field(T.phone, phoneIn));
    if (fulfil.length > 1) panel.appendChild(kinds);
    panel.appendChild(addrWrap); panel.appendChild(field(T.notes, notesIn));
    panel.appendChild(note(T.cash));
    var trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', class: 'o-trap' });
    panel.appendChild(trap);
    var send = el('button', { type: 'button', class: 'o-send', text: to === 'panel' ? T.place : T.send });
    var msg = el('p', { class: 'o-note', role: 'status', 'aria-live': 'polite' });
    var opened = Date.now();
    send.addEventListener('click', function () {
      form.name = nameIn.value; form.phone = phoneIn.value; form.address = addrIn.value; form.notes = notesIn.value;
      var bad = mark(nameIn, !nameIn.value.trim());
      bad = mark(phoneIn, phoneIn.value.replace(/[^0-9]/g, '').length < 6) || bad;
      bad = mark(addrIn, form.type === 'delivery' && !addrIn.value.trim()) || bad;
      if (bad) { msg.textContent = T.need; return; }
      if (to === 'panel') {
        if (trap.value) { msg.textContent = T.placed.replace('{n}', ''); return; }
        send.disabled = true; msg.textContent = T.sending;
        post({ type: form.type, name: form.name.trim(), phone: form.phone.trim(), address: form.type === 'pickup' ? '' : form.address.trim(), notes: form.notes.trim(), items: Object.keys(cart).map(function (k) { return { name: k, qty: cart[k].qty }; }) })
          .then(function (d) { thanks = T.placed.replace('{n}', d.ref); cart = {}; save(); refresh(); })
          .catch(function (e) { msg.textContent = e.message && e.message !== 'Failed to fetch' ? e.message : T.failed; send.disabled = false; });
        return;
      }
      var lines = [T.title, ''];
      Object.keys(cart).forEach(function (k) { lines.push(cart[k].qty + ' × ' + k + ' — ' + money(cart[k].qty * cart[k].price)); });
      if (form.type === 'delivery' && fee > 0) lines.push(T.fee + ': ' + money(fee));
      lines.push('', T.total + ': ' + money(grand()), '', T.name + ': ' + form.name.trim(), T.phone + ': ' + form.phone.trim(), T.how + ': ' + T[form.type]);
      if (form.type !== 'pickup' && form.address.trim()) lines.push((form.type === 'dinein' ? T.table.replace(/ \(.*\)$/, '') : T.address) + ': ' + form.address.trim());
      if (form.notes.trim()) lines.push(T.notes.replace(/ \(.*\)$/, '') + ': ' + form.notes.trim());
      lines.push('', T.pay);
      window.open('https://wa.me/' + wa + '?text=' + encodeURIComponent(lines.join(NL)), '_blank', 'noopener');
      thanks = T.thanks;
      cart = {}; save(); refresh();
    });
    panel.appendChild(send); panel.appendChild(msg);
  }

  // A real calendar (the owner gave opening hours): the next days and the times of the chosen day come from the server. Days and times that
  // are closed, full or already taken are shown faded and cannot be tapped, so nobody can ask for a time that is gone.
  function getJson(path) { return fetch(api + path, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(T.failed); return r.json(); }); }
  function dayLabel(iso) {
    var d = new Date(iso + 'T12:00:00');
    var loc = { en: 'en-GB', ar: 'ar', fr: 'fr-FR', es: 'es-ES', de: 'de-DE' }[lang] || 'en-GB';
    return [d.toLocaleDateString(loc, { weekday: 'short' }), d.toLocaleDateString(loc, { day: 'numeric', month: 'short' })];
  }
  function drawCalendarBook(host, inline) {
    host = host || panel; host.textContent = '';
    if (!inline) host.appendChild(head(T.bookTitle));
    var pick = el('select');
    pick.appendChild(el('option', { value: '', text: T.pick }));
    services.forEach(function (s) { var o = el('option', { value: s, text: s }); if (s === pre) o.selected = true; pick.appendChild(o); });
    var chosen = { day: '', time: '' };
    var daysBox = el('div', { class: 'o-days' }); var slotsBox = el('div', { class: 'o-slots' });
    var nameIn = el('input', { type: 'text', autocomplete: 'name' });
    var phoneIn = el('input', { type: 'tel', autocomplete: 'tel', inputmode: 'tel' });
    var notesIn = el('textarea', { rows: '2' });
    var msg = el('p', { class: 'o-note', role: 'status', 'aria-live': 'polite' });
    var send = el('button', { type: 'button', class: 'o-send', text: to === 'panel' ? T.placeBook : T.sendBook });

    function showSlots(day) {
      chosen.time = ''; slotsBox.textContent = ''; slotsBox.appendChild(el('p', { class: 'o-note', text: T.sending }));
      return getJson('/api/availability/' + siteId + '?day=' + day).then(function (a) {
        slotsBox.textContent = '';
        if (!a.slots.some(function (s) { return s.free; })) { slotsBox.appendChild(el('p', { class: 'o-note', text: T.noTimes })); }
        a.slots.forEach(function (s) {
          var b = el('button', { type: 'button', class: 'o-slot' + (s.free ? '' : ' o-off'), text: s.time });
          if (!s.free) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); b.title = T.taken; }
          else b.addEventListener('click', function () {
            chosen.time = s.time;
            Array.prototype.forEach.call(slotsBox.querySelectorAll('.o-slot'), function (x) { x.classList.toggle('o-on', x === b); });
          });
          slotsBox.appendChild(b);
        });
      }).catch(function () { slotsBox.textContent = ''; slotsBox.appendChild(el('p', { class: 'o-note', text: T.failed })); });
    }
    function showDays() {
      return getJson('/api/availability/' + siteId + '?days=14').then(function (c) {
        daysBox.textContent = '';
        c.days.forEach(function (d) {
          var off = !d.open || d.free === 0;
          var label = dayLabel(d.day);
          var b = el('button', { type: 'button', class: 'o-day' + (off ? ' o-off' : '') }, [el('span', { text: label[0] }), el('b', { text: label[1] })]);
          if (off) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); b.title = d.open ? T.full : T.closed; }
          else b.addEventListener('click', function () {
            chosen.day = d.day;
            Array.prototype.forEach.call(daysBox.querySelectorAll('.o-day'), function (x) { x.classList.toggle('o-on', x === b); });
            showSlots(d.day);
          });
          daysBox.appendChild(b);
        });
      }).catch(function () { daysBox.textContent = ''; daysBox.appendChild(el('p', { class: 'o-note', text: T.failed })); });
    }
    if (services.length) host.appendChild(field(T.service, pick));
    host.appendChild(el('p', { class: 'o-label', text: T.chooseDay })); host.appendChild(daysBox);
    host.appendChild(el('p', { class: 'o-label', text: T.chooseTime })); host.appendChild(slotsBox);
    slotsBox.appendChild(el('p', { class: 'o-note', text: T.chooseDay }));
    host.appendChild(field(T.name, nameIn)); host.appendChild(field(T.phone, phoneIn)); host.appendChild(field(T.notes, notesIn));
    host.appendChild(note(to === 'panel' ? T.soon : T.note));
    var trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', class: 'o-trap' });
    host.appendChild(trap);
    send.addEventListener('click', function () {
      var bad = mark(pick, services.length > 0 && !pick.value);
      bad = mark(nameIn, !nameIn.value.trim()) || bad;
      bad = mark(phoneIn, phoneIn.value.replace(/[^0-9]/g, '').length < 6) || bad;
      if (bad || !chosen.day || !chosen.time) { msg.textContent = T.need + (chosen.day && chosen.time ? '' : ' ' + T.chooseTime); return; }
      send.disabled = true; msg.textContent = T.sending;
      post({ service: pick.value, day: chosen.day, time: chosen.time, name: nameIn.value.trim(), phone: phoneIn.value.trim(), notes: notesIn.value.trim() })
        .then(function (d) { thanks = T.placedBook.replace('{n}', d.ref); host.textContent = ''; if (!inline) host.appendChild(head(T.bookTitle)); host.appendChild(el('p', { class: 'o-done', role: 'status', text: thanks + ' ' + chosen.day + ' ' + chosen.time })); })
        .catch(function (e) {
          msg.textContent = e.message && e.message !== 'Failed to fetch' ? e.message : T.failed; send.disabled = false;
          if (chosen.day) { showDays(); showSlots(chosen.day); } // somebody was faster: the times are shown again, now without it
        });
    });
    host.appendChild(send); host.appendChild(msg);
    showDays();
  }

  var pre = '';
  function drawBook() {
    if (calendar) return drawCalendarBook();
    panel.textContent = '';
    panel.appendChild(head(T.bookTitle));
    var pick = el('select');
    pick.appendChild(el('option', { value: '', text: T.pick }));
    services.forEach(function (s) { var o = el('option', { value: s, text: s }); if (s === pre) o.selected = true; pick.appendChild(o); });
    var today = new Date(); var iso = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
    var dayIn = el('input', { type: 'date', min: iso });
    var timeIn = el('input', { type: 'time' });
    var nameIn = el('input', { type: 'text', autocomplete: 'name' });
    var phoneIn = el('input', { type: 'tel', autocomplete: 'tel', inputmode: 'tel' });
    var notesIn = el('textarea', { rows: '2' });
    if (services.length) panel.appendChild(field(T.service, pick));
    panel.appendChild(el('div', { class: 'o-two' }, [field(T.day, dayIn), field(T.time, timeIn)]));
    panel.appendChild(field(T.name, nameIn)); panel.appendChild(field(T.phone, phoneIn)); panel.appendChild(field(T.notes, notesIn));
    panel.appendChild(note(to === 'panel' ? T.soon : T.note));
    var send = el('button', { type: 'button', class: 'o-send', text: to === 'panel' ? T.placeBook : T.sendBook });
    var msg = el('p', { class: 'o-note', role: 'status', 'aria-live': 'polite' });
    send.addEventListener('click', function () {
      var bad = mark(pick, services.length > 0 && !pick.value);
      bad = mark(dayIn, !dayIn.value) || bad; bad = mark(timeIn, !timeIn.value) || bad;
      bad = mark(nameIn, !nameIn.value.trim()) || bad;
      bad = mark(phoneIn, phoneIn.value.replace(/[^0-9]/g, '').length < 6) || bad;
      if (bad) { msg.textContent = T.need; return; }
      if (to === 'panel') {
        send.disabled = true; msg.textContent = T.sending;
        post({ service: pick.value, day: dayIn.value, time: timeIn.value, name: nameIn.value.trim(), phone: phoneIn.value.trim(), notes: notesIn.value.trim() })
          .then(function (d) { msg.textContent = T.placedBook.replace('{n}', d.ref); setTimeout(close, 6000); })
          .catch(function (e) { msg.textContent = e.message && e.message !== 'Failed to fetch' ? e.message : T.failed; send.disabled = false; });
        return;
      }
      var lines = [T.request, ''];
      if (pick.value) lines.push(T.service + ': ' + pick.value);
      lines.push(T.day + ': ' + dayIn.value, T.time + ': ' + timeIn.value, T.name + ': ' + nameIn.value.trim(), T.phone + ': ' + phoneIn.value.trim());
      if (notesIn.value.trim()) lines.push(T.notes.replace(/ \(.*\)$/, '') + ': ' + notesIn.value.trim());
      window.open('https://wa.me/' + wa + '?text=' + encodeURIComponent(lines.join(NL)), '_blank', 'noopener');
      msg.textContent = T.thanksBook;
      setTimeout(close, 2500);
    });
    panel.appendChild(send); panel.appendChild(msg);
  }
  function openBook(name) { pre = name || ''; drawBook(); overlay.hidden = false; document.body.classList.add('o-lock'); }

  // any link to #book (the designer's "Book now" buttons) opens the calendar: in place when the page has one, otherwise as a pop-up
  var inlineBox = document.querySelector('[data-inline-calendar]');
  if (inlineBox && calendar && mode === 'book') drawCalendarBook(inlineBox, true);
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[href="#book"]') : null;
    if (!a || mode !== 'book' || bookUrl) return;
    e.preventDefault();
    if (inlineBox) inlineBox.scrollIntoView({ behavior: 'smooth', block: 'start' }); else openBook('');
  });
  if (mode === 'order') bar.addEventListener('click', function () { drawOrder(); overlay.hidden = false; document.body.classList.add('o-lock'); });
  else {
    bar.textContent = T.bookTitle;
    if (bookUrl) { var link = el('a', { class: 'o-bar', href: bookUrl, target: '_blank', rel: 'noopener noreferrer', text: T.bookTitle }); document.body.replaceChild(link, bar); }
    else bar.addEventListener('click', function () { openBook(''); });
  }
  refresh();
})();
