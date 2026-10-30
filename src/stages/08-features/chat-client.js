// Served as /chat.js. The website assistant's bubble, in the visitor's browser. It talks only to the business's own server (/api/chat):
// the key of the AI service never reaches the browser. The conversation lives in this tab only (sessionStorage, gone when it is closed);
// nothing of it is stored by the website. A reply that cannot be answered comes with a button to reach a person.
(function () {
  var cfg = document.getElementById('chat-config');
  if (!cfg) return;
  var api = (cfg.getAttribute('data-api') || '').replace(/\/$/, '');
  var siteId = cfg.getAttribute('data-site') || '';
  var name = cfg.getAttribute('data-name') || '';
  var lang = (cfg.getAttribute('data-lang') || 'en').slice(0, 2);
  var rtl = lang === 'ar';
  var feedbackApi = cfg.getAttribute('data-feedback') || ''; // set only on the owner's own page: a "Not right?" under each answer

  var TEXT = {
    en: { open: 'Chat with us', close: 'Close', title: 'Ask us', hello: 'Hi! I am the assistant of {name}. Ask me anything about us.', ph: 'Type your question...', send: 'Send', failed: 'Sorry, I could not send that. Please try again.', ai: 'I am an AI assistant. For anything important, please check with the team.', whatsapp: 'Talk to someone on WhatsApp', phone: 'Call us', contact: 'Contact us' },
    ar: { open: 'تحدّث معنا', close: 'إغلاق', title: 'اسألنا', hello: 'مرحبًا! أنا مساعد {name}. اسألني أي شيء عنّا.', ph: 'اكتب سؤالك...', send: 'إرسال', failed: 'عذرًا، تعذّر إرسال رسالتك. حاول مرة أخرى.', ai: 'أنا مساعد آلي. للأمور المهمة يرجى التأكد من الفريق.', whatsapp: 'تحدّث مع شخص عبر واتساب', phone: 'اتصل بنا', contact: 'تواصل معنا' },
    fr: { open: 'Discuter avec nous', close: 'Fermer', title: 'Posez-nous une question', hello: "Bonjour ! Je suis l'assistant de {name}. Posez-moi vos questions.", ph: 'Écrivez votre question...', send: 'Envoyer', failed: "Désolé, je n'ai pas pu envoyer ce message. Réessayez.", ai: "Je suis un assistant IA. Pour tout point important, vérifiez auprès de l'équipe.", whatsapp: "Parler à quelqu'un sur WhatsApp", phone: 'Nous appeler', contact: 'Nous contacter' },
    es: { open: 'Chatea con nosotros', close: 'Cerrar', title: 'Pregúntanos', hello: '¡Hola! Soy el asistente de {name}. Pregúntame lo que quieras.', ph: 'Escribe tu pregunta...', send: 'Enviar', failed: 'Lo siento, no pude enviarlo. Inténtalo de nuevo.', ai: 'Soy un asistente de IA. Para algo importante, consulta con el equipo.', whatsapp: 'Hablar con una persona por WhatsApp', phone: 'Llámanos', contact: 'Contáctanos' },
    de: { open: 'Mit uns chatten', close: 'Schließen', title: 'Fragen Sie uns', hello: 'Hallo! Ich bin der Assistent von {name}. Fragen Sie mich, was Sie wissen möchten.', ph: 'Ihre Frage...', send: 'Senden', failed: 'Leider konnte ich das nicht senden. Bitte versuchen Sie es erneut.', ai: 'Ich bin ein KI-Assistent. Bei Wichtigem fragen Sie bitte das Team.', whatsapp: 'Mit jemandem auf WhatsApp sprechen', phone: 'Anrufen', contact: 'Kontakt' },
  };
  var T = TEXT[lang] || TEXT.en;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  // the page's own colors, so the bubble fits any design
  var bg = getComputedStyle(document.body).backgroundColor;
  if (!bg || /rgba\(.*,\s*0\)$/.test(bg) || bg === 'transparent') bg = getComputedStyle(document.documentElement).backgroundColor;
  if (!bg || /rgba\(.*,\s*0\)$/.test(bg) || bg === 'transparent') bg = '#ffffff';
  document.documentElement.style.setProperty('--c-bg', bg);
  document.documentElement.style.setProperty('--c-fg', getComputedStyle(document.body).color || '#111111');

  // the conversation of this tab: [{ role, content, handoff? }]
  var KEY = 'chat-' + (feedbackApi ? 'owner-' : '') + siteId; var history = [];
  try { history = JSON.parse(sessionStorage.getItem(KEY) || '[]') || []; } catch (e) { history = []; }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-30))); } catch (e) { /* works without it */ } }

  var bubble = el('button', { type: 'button', class: 'c-bubble', 'aria-label': T.open, title: T.open });
  bubble.appendChild(el('span', { 'aria-hidden': 'true', text: '💬' }));
  var panel = el('div', { class: 'c-panel', role: 'dialog', 'aria-label': T.title, hidden: '', dir: rtl ? 'rtl' : 'ltr' });
  var close = el('button', { type: 'button', class: 'c-x', 'aria-label': T.close, text: '×' });
  var list = el('div', { class: 'c-list', 'aria-live': 'polite' });
  var input = el('input', { type: 'text', class: 'c-in', maxlength: '600', placeholder: T.ph, 'aria-label': T.ph, autocomplete: 'off' });
  var sendBtn = el('button', { type: 'button', class: 'c-send', text: T.send });
  var form = el('form', { class: 'c-form' }, [input, sendBtn]);
  panel.appendChild(el('div', { class: 'c-head' }, [el('b', { text: name || T.title }), close]));
  panel.appendChild(list);
  panel.appendChild(el('p', { class: 'c-ai', text: T.ai }));
  panel.appendChild(form);
  document.body.appendChild(bubble); document.body.appendChild(panel);

  function handoffButton(h) {
    var label = T[h.kind] || T.contact;
    var a = el('a', { class: 'c-handoff', href: h.url, text: label });
    if (/^https?:/i.test(h.url)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    return a;
  }
  function draw() {
    list.textContent = '';
    var all = [{ role: 'assistant', content: T.hello.replace('{name}', name || '') }].concat(history);
    all.forEach(function (m, i) {
      var row = el('div', { class: 'c-msg ' + (m.role === 'user' ? 'c-me' : m.role === 'note' ? 'c-note' : 'c-bot') }, [el('span', { text: m.content })]);
      if (m.handoff && m.handoff.url) row.appendChild(handoffButton(m.handoff));
      if (feedbackApi && m.role === 'assistant' && i > 0) row.appendChild(feedbackLink(i - 1));
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
  }

  // the owner's comment on an answer (the question it answered is the customer-style message just before it)
  function feedbackLink(index) {
    var wrap = el('div', { class: 'c-fb' });
    var link = el('button', { type: 'button', class: 'c-fblink', text: 'Not right?' });
    link.addEventListener('click', function () {
      wrap.textContent = '';
      var box = el('input', { type: 'text', class: 'c-in', placeholder: 'What should it do instead?', maxlength: '600' });
      var go = el('button', { type: 'button', class: 'c-send', text: 'Send' });
      function send() {
        var comment = box.value.trim(); if (!comment) return;
        var question = ''; for (var k = index - 1; k >= 0; k--) if (history[k] && history[k].role === 'user') { question = history[k].content; break; }
        go.disabled = true; box.disabled = true; go.textContent = '...';
        wrap.appendChild(el('div', { class: 'c-note-wait', text: 'Working on it, about half a minute...' }));
        fetch(feedbackApi, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: question, comment: comment }) })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong.'); return d; }); })
          .then(function (d) { history.push({ role: 'note', content: d.message + (d.after ? '\n\nNow it answers: ' + d.after : '') }); })
          .catch(function (e) { history.push({ role: 'note', content: e.message }); })
          .then(function () { save(); draw(); });
      }
      go.addEventListener('click', send); box.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
      wrap.appendChild(box); wrap.appendChild(go); box.focus();
    });
    wrap.appendChild(link);
    return wrap;
  }

  var busy = false;
  function ask(text) {
    if (busy || !text.trim()) return;
    busy = true; sendBtn.disabled = true;
    history.push({ role: 'user', content: text.trim() }); save(); draw();
    var wait = el('div', { class: 'c-msg c-bot c-wait' }, [el('span', { text: '…' })]); list.appendChild(wait); list.scrollTop = list.scrollHeight;
    var turns = history.filter(function (m) { return m.role === 'user' || m.role === 'assistant'; }).slice(-12).map(function (m) { return { role: m.role, content: m.content }; });
    fetch(api + '/api/chat/' + siteId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: turns }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || T.failed); return d; }); })
      .then(function (d) { history.push({ role: 'assistant', content: d.reply || T.failed, handoff: d.handoff || null }); })
      .catch(function (e) { history.push({ role: 'assistant', content: e.message && e.message !== 'Failed to fetch' ? e.message : T.failed }); })
      .then(function () { busy = false; sendBtn.disabled = false; save(); draw(); input.focus(); });
  }

  function open() { panel.hidden = false; bubble.hidden = true; draw(); setTimeout(function () { input.focus(); }, 50); }
  function shut() { panel.hidden = true; bubble.hidden = false; bubble.focus(); }
  bubble.addEventListener('click', open); close.addEventListener('click', shut);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) shut(); });
  form.addEventListener('submit', function (e) { e.preventDefault(); var t = input.value; input.value = ''; ask(t); });
  if (history.length) draw();
  if (cfg.getAttribute('data-open') === '1') open(); // the owner's page opens it at once
})();
