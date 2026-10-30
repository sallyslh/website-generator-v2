// The editing overlay: loaded only in edit mode (/site/<id>/...?edit=1) by the customer server, never part of the delivered website.
// Click a text to change it, click a picture or the logo to replace it, see "Your changes" and go back to the original at any time.
(function () {
  var script = document.currentScript;
  var id = script.getAttribute('data-id');
  var prefix = script.getAttribute('data-prefix'); // "/site/<id>/"
  var owner = script.getAttribute('data-owner') === '1'; // the owner of a delivered website: no requests to a team, no AI pictures, "Done" goes back to the panel
  var api = script.getAttribute('data-api') || '/api/edit/' + id + '/';
  var state = { changes: [], pages: [], ready: true };

  // ---- the page's own look while editing: outlines on what can be changed ----
  var style = document.createElement('style');
  style.textContent = '[data-e]{cursor:pointer}[data-e]:hover{outline:2px dashed #2f6fed;outline-offset:3px}[data-e][data-editing]{outline:2px solid #2f6fed;outline-offset:3px;cursor:text}' +
    '.m-in{opacity:1!important;transform:none!important}body{padding-bottom:84px}';
  document.head.appendChild(style);

  // ---- our own interface, isolated from the site's styles ----
  var host = document.createElement('div');
  host.setAttribute('data-edit-ui', '');
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,Segoe UI,Arial,sans-serif}' +
    '.bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483646;background:#14213d;color:#fff;border-radius:14px;padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;max-width:calc(100vw - 24px);box-shadow:0 8px 30px rgba(0,0,0,.35);font-size:14px}' +
    '.bar a,.bar button{color:#fff;background:rgba(255,255,255,.14);border:0;border-radius:8px;padding:8px 12px;font-size:14px;cursor:pointer;text-decoration:none}.bar a.on{background:#2f6fed}.bar button.go{background:#2f6fed}.bar button:hover,.bar a:hover{background:rgba(255,255,255,.28)}.bar .hint{opacity:.8}' +
    '.panel{position:fixed;right:16px;bottom:84px;width:min(380px,calc(100vw - 32px));max-height:60vh;overflow:auto;z-index:2147483646;background:#fff;color:#14213d;border-radius:14px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.35);font-size:14px}' +
    '.panel h3{margin:0 0 8px;font-size:16px}.panel .row{border-top:1px solid #e5e8f0;padding:10px 0}.panel small{color:#5b667a;display:block;margin:2px 0}.panel button,.pop button{border:0;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:14px;background:#e8ecf5;color:#14213d}.panel button.go,.pop button.go{background:#2f6fed;color:#fff}' +
    '.pop{position:fixed;z-index:2147483647;background:#fff;color:#14213d;border-radius:14px;padding:14px;width:min(340px,calc(100vw - 24px));box-shadow:0 8px 30px rgba(0,0,0,.4);font-size:14px}' +
    '.pop label{display:block;margin:8px 0 4px;font-weight:600}.pop input[type=text],.pop textarea{width:100%;padding:8px;border:1px solid #c7cedd;border-radius:8px;font-size:14px}.pop .actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}.pop .err{color:#b3261e;margin-top:8px}.pop{max-height:calc(100vh - 24px);overflow:auto}.pop small{display:block;color:#5b667a;margin-top:8px}.pop .modes label{display:block;margin:6px 0;font-weight:400}.pop small.good{color:#1c8a4a}.pop small.warn{color:#9a5b00}.pop .shelf{display:flex;gap:8px;flex-wrap:wrap}.pop .shot{position:relative;margin:0;font-weight:400}.pop .shot img{width:64px;height:64px;object-fit:cover;border-radius:8px;display:block}.pop .shot input{position:absolute;top:4px;left:4px}.pop .shot .ok{position:absolute;right:4px;bottom:4px;background:#1c8a4a;color:#fff;border-radius:50%;width:18px;height:18px;font-size:12px;line-height:18px;text-align:center}' +
    '.toast{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;background:#14213d;color:#fff;border-radius:10px;padding:10px 16px;font-size:14px}' +
    '</style><div class="bar" id="bar"></div><div id="layer"></div>';
  document.body.appendChild(host);
  var $ = function (sel) { return root.querySelector(sel); };
  var el = function (tag, props, kids) { var e = document.createElement(tag); Object.keys(props || {}).forEach(function (k) { if (k === 'text') e.textContent = props[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]); else e.setAttribute(k, props[k]); }); (kids || []).forEach(function (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; };

  function toast(message) { var t = el('div', { class: 'toast', text: message }); root.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }
  function request(method, path, body, raw) {
    return fetch(api + path, { method: method, headers: raw ? {} : { 'Content-Type': 'application/json' }, body: raw ? body : body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.'); return j; }); });
  }

  // ---- toolbar and the list of changes ----
  var panelOpen = false;
  function drawBar() {
    var bar = $('#bar'); bar.textContent = '';
    state.pages.forEach(function (p) {
      var here = location.pathname.replace(/\/index\.html$/, '/') === (prefix.replace(/\/$/, '') + p.route);
      bar.appendChild(el('a', { href: prefix.replace(/\/$/, '') + p.route + '?edit=1', class: here ? 'on' : '', text: p.route === '/' ? 'Home' : (function (s) { return s.charAt(0).toUpperCase() + s.slice(1); })(p.route.replace(/\//g, '').replace(/-/g, ' ')) }));
    });
    bar.appendChild(el('span', { class: 'hint', text: 'Click a text or a picture to change it' }));
    if (!owner) bar.appendChild(el('button', { text: 'Ask for a change', onclick: askChange }));
    bar.appendChild(el('button', { class: panelOpen ? 'go' : '', text: 'Your changes (' + (state.changes.length + (state.requests || []).length) + ')', onclick: function () { panelOpen = !panelOpen; drawBar(); drawPanel(); } }));
    if (owner && state.changes.length) bar.appendChild(el('a', { href: location.pathname + '?original=1', target: '_blank', rel: 'noopener', text: 'See the original' }));
    bar.appendChild(el('button', { text: 'Done', onclick: function () { location.href = script.getAttribute('data-done') || (location.origin + '/'); } }));
  }
  function drawPanel() {
    var layer = $('#layer');
    layer.querySelectorAll('.panel').forEach(function (p) { p.remove(); });
    if (!panelOpen) return;
    var requests = state.requests || [];
    var total = state.changes.length + requests.length;
    var panel = el('div', { class: 'panel' }, [el('h3', { text: total ? 'Your changes' : 'No changes yet. The website is exactly as we made it.' })]);
    requests.forEach(function (r) {
      panel.appendChild(el('div', { class: 'row' }, [
        el('b', { text: r.status === 'applied' ? 'Look change' : 'Sent to our team' }),
        el('small', { text: 'You asked: ' + r.text }),
        el('small', { text: r.summary }),
        r.team.length ? el('small', { text: 'Our team will look at: ' + r.team.join(' ') }) : null,
        el('button', { text: r.status === 'applied' ? 'Undo this change' : 'Remove this request', onclick: function () { request('POST', 'request-undo', { id: r.id }).then(function () { location.reload(); }).catch(function (e) { toast(e.message); }); } }),
      ].filter(Boolean)));
    });
    state.changes.forEach(function (c) {
      panel.appendChild(el('div', { class: 'row' }, [
        el('b', { text: c.kind === 'text' ? 'Text' : 'Picture' }),
        c.outdated ? el('small', { text: 'Your website was updated and this part changed, so this change is not shown any more. You can remove it here.' }) : null,
        el('small', { text: c.kind === 'text' ? 'Before: ' + c.before : 'The original picture was replaced' }),
        el('small', { text: c.kind === 'text' ? 'Now: ' + c.after : 'Description: ' + c.after }),
        el('button', { text: c.outdated ? 'Remove this change' : 'Undo this change', onclick: function () { request('POST', 'undo', { key: c.key }).then(function () { location.reload(); }).catch(function (e) { toast(e.message); }); } }),
      ]));
    });
    if (total) panel.appendChild(el('div', { class: 'row' }, [el('button', { text: 'Restore everything to the original', onclick: function () { if (confirm('Put the whole website back exactly as we first made it? All your changes will be removed.')) request('POST', 'revert-all').then(function () { location.reload(); }).catch(function (e) { toast(e.message); }); } })]));
    layer.appendChild(panel);
  }
  function load() { return request('GET', 'state').then(function (s) { state = s; drawBar(); drawPanel(); }); }

  // ---- popovers ----
  function popover(target, title, build) {
    $('#layer').querySelectorAll('.pop').forEach(function (p) { p.remove(); });
    var r = target.getBoundingClientRect();
    var pop = el('div', { class: 'pop' }, [el('b', { text: title })]);
    build(pop);
    $('#layer').appendChild(pop);
    place(pop, target);
    return pop;
  }
  // keeps a popover fully on the screen (it scrolls inside when it is taller than the window)
  function place(node, target) {
    var pop = node.closest ? node.closest('.pop') : node;
    if (!pop) return;
    var r = target.getBoundingClientRect();
    pop.style.left = Math.max(12, Math.min(r.left, innerWidth - 352)) + 'px';
    var below = r.bottom + 10;
    pop.style.top = Math.max(12, Math.min(below, innerHeight - 12 - pop.offsetHeight)) + 'px';
  }
  var closePops = function () { $('#layer').querySelectorAll('.pop').forEach(function (p) { p.remove(); }); };
  var changedKeys = function () { var o = {}; state.changes.forEach(function (c) { o[c.key] = c; }); return o; };

  function editPicture(target, key) {
    var changed = changedKeys()[key];
    var alt = target.getAttribute('alt') || '';
    function upload(pop) {
      var file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
      var desc = el('input', { type: 'text', value: alt, placeholder: 'Describe the picture in a few words' });
      var err = el('div', { class: 'err' });
      pop.appendChild(el('label', { text: 'Choose a photo' })); pop.appendChild(file);
      pop.appendChild(el('label', { text: 'What does it show?' })); pop.appendChild(desc);
      pop.appendChild(err);
      var actions = el('div', { class: 'actions' }, [
        el('button', { class: 'go', text: 'Use this picture', onclick: function (ev) {
          var f = file.files[0];
          if (!f) { err.textContent = 'Please choose a photo first.'; return; }
          if (f.size > 5 * 1024 * 1024) { err.textContent = 'That photo is larger than 5 MB. Please choose a smaller one.'; return; }
          ev.target.disabled = true; ev.target.textContent = 'Saving...';
          request('PUT', 'image?key=' + encodeURIComponent(key) + '&alt=' + encodeURIComponent(desc.value), f, true).then(function () { location.reload(); }).catch(function (e) { err.textContent = e.message; ev.target.disabled = false; ev.target.textContent = 'Use this picture'; });
        } }),
        el('button', { text: 'Cancel', onclick: closePops }),
      ]);
      if (changed) actions.appendChild(el('button', { text: 'Go back to the original', onclick: function () { request('POST', 'undo', { key: key }).then(function () { location.reload(); }).catch(function (e) { err.textContent = e.message; }); } }));
      pop.appendChild(actions);
    }

    // a new picture made with AI: the customer's own products stay exactly as photographed, AI makes the place around them
    function makeWithAi(pop) {
      var ai = state.ai || { allowed: false, reason: 'Making pictures with AI is not available right now.', photos: [], remaining: 0 };
      if (!ai.allowed) { pop.appendChild(el('p', { text: ai.reason })); return; }
      var current = (target.getAttribute('src') || '').match(/\/images\/(asset-[\w-]+)\.webp/);
      var idea = el('textarea', { rows: '3', placeholder: 'Describe the place and the mood, for example: on a marble table with fresh roses, soft morning light' });
      var chips = el('div', { class: 'actions' }, ['Soft morning light', 'Dark and moody', 'Fresh flowers', 'Clean white studio'].map(function (t) {
        return el('button', { text: t, onclick: function () { idea.value = (idea.value.trim() ? idea.value.trim().replace(/[.,]$/, '') + ', ' : '') + t.toLowerCase(); } });
      }));
      var picked = {};
      var shelf = el('div', { class: 'shelf' }, ai.photos.map(function (p) {
        var box = el('input', { type: 'checkbox' });
        if (current && current[1] === p.id) { box.checked = true; picked[p.id] = true; }
        box.addEventListener('change', function () { if (box.checked) picked[p.id] = true; else delete picked[p.id]; });
        return el('label', { class: 'shot', title: p.label + (p.known ? ' (works well)' : '') }, [el('img', { src: p.picture, alt: '' }), box, p.known ? el('span', { class: 'ok', text: '✓' }) : null].filter(Boolean));
      }));
      var err = el('div', { class: 'err' });
      var result = el('div');
      pop.appendChild(el('label', { text: 'What should the picture look like?' })); pop.appendChild(idea); pop.appendChild(chips);
      if (ai.photos.length) { pop.appendChild(el('label', { text: 'Which of your products should be in it? (up to 3)' })); pop.appendChild(shelf); }
      // two ways: a natural photo shoot made from the customer's photo (best look; the smallest print can differ), or the exact way
      // (the product's own pixels, only the setting is new)
      var modeNatural = el('input', { type: 'radio', name: 'mode', checked: 'checked' });
      var modeExact = el('input', { type: 'radio', name: 'mode' });
      var modes = el('div', { class: 'modes' }, [
        el('label', {}, [modeNatural, ' Natural photo shoot (best look, recommended)']),
        el('label', {}, [modeExact, ' Keep my product exactly as photographed (the setting is new, the box is pasted in)']),
      ]);
      if (ai.photos.length) pop.appendChild(modes);
      pop.appendChild(el('small', { text: 'The picture is made from your own photo and checked against it. ' + ai.remaining + ' AI picture(s) left.' }));
      pop.appendChild(err); pop.appendChild(result);
      var make = el('button', { class: 'go', text: 'Make my picture' });
      make.addEventListener('click', function () {
        var ids = Object.keys(picked);
        if (ids.length > 3) { err.textContent = 'Please choose up to 3 products.'; return; }
        if (idea.value.trim().split(/\s+/).length < 3) { err.textContent = 'Please describe the picture in a few words.'; return; }
        err.textContent = ''; result.textContent = ''; make.disabled = true; make.textContent = 'Making your picture (about a minute)...';
        var box = target.getBoundingClientRect();
        request('POST', 'ai', { scene: idea.value, products: ids, ratio: box.width / Math.max(1, box.height), mode: modeExact.checked ? 'exact' : 'natural' }).then(function (r) {
          state.ai.remaining = r.remaining;
          result.textContent = '';
          result.appendChild(el('img', { onload: function () { place(pop, target); }, src: r.url, alt: 'Your new picture', style: 'width:100%;border-radius:10px;margin-top:10px' }));
          if (r.summary) result.appendChild(el('small', { class: /match your photo.$/.test(r.summary) ? 'good' : 'warn', text: r.summary }));
          result.appendChild(el('div', { class: 'actions' }, [
            el('button', { class: 'go', text: 'Use this picture', onclick: function (ev) {
              ev.target.disabled = true; ev.target.textContent = 'Saving...';
              request('POST', 'ai-use', { key: key, file: r.file, alt: idea.value.trim().slice(0, 180) }).then(function () { location.reload(); }).catch(function (e) { err.textContent = e.message; ev.target.disabled = false; ev.target.textContent = 'Use this picture'; });
            } }),
            el('button', { text: 'Not quite: try again', onclick: function () { result.textContent = ''; make.click(); } }),
          ]));
          make.disabled = false; make.textContent = 'Make another one';
        }).catch(function (e) { err.textContent = e.message; make.disabled = false; make.textContent = 'Make my picture'; place(pop, target); });
      });
      pop.appendChild(el('div', { class: 'actions' }, [make, el('button', { text: 'Cancel', onclick: closePops })]));
    }

    var isLogo = /\.logo/.test(key);
    popover(target, isLogo ? 'Change the logo' : 'Change this picture', function (pop) {
      if (isLogo || !state.ai) { upload(pop); return; } // a logo is never made by AI; a delivered website has no AI pictures
      var one = el('div'); var two = el('div'); two.style.display = 'none';
      var tabA = el('button', { class: 'go', text: 'Upload my photo' }); var tabB = el('button', { text: 'Make one with AI' });
      tabA.addEventListener('click', function () { one.style.display = ''; two.style.display = 'none'; tabA.className = 'go'; tabB.className = ''; });
      tabB.addEventListener('click', function () { one.style.display = 'none'; two.style.display = ''; tabB.className = 'go'; tabA.className = ''; place(pop, target); });
      pop.appendChild(el('div', { class: 'actions' }, [tabA, tabB]));
      upload(one); makeWithAi(two);
      pop.appendChild(one); pop.appendChild(two);
    });
  }

  function saveText(target, key, value, previous) {
    request('POST', 'text', { key: key, value: value }).then(function (s) { state = Object.assign(state, s); target.textContent = (s.changes.filter(function (c) { return c.key === key; })[0] || { after: value }).after; drawBar(); drawPanel(); toast('Saved. You can undo it in "Your changes".'); })
      .catch(function (e) { target.textContent = previous; toast(e.message); });
  }
  function editText(target, key) {
    closePops();
    var previous = target.textContent;
    if (target.closest('a, button')) { // links and buttons: a small box instead of typing on the page (the page would follow the link)
      popover(target, 'Change this text', function (pop) {
        var box = el('textarea', { rows: '3' }); box.value = previous;
        pop.appendChild(box);
        pop.appendChild(el('div', { class: 'actions' }, [
          el('button', { class: 'go', text: 'Save', onclick: function () { var v = box.value; closePops(); if (v.trim() && v.trim() !== previous) saveText(target, key, v, previous); } }),
          el('button', { text: 'Cancel', onclick: closePops }),
        ]));
        box.focus(); box.select();
      });
      return;
    }
    target.setAttribute('data-editing', '');
    target.contentEditable = 'plaintext-only'; if (target.contentEditable !== 'plaintext-only') target.contentEditable = 'true';
    target.focus();
    var range = document.createRange(); range.selectNodeContents(target); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    var finished = false;
    function finish(save) {
      if (finished) return; finished = true;
      target.removeAttribute('data-editing'); target.contentEditable = 'false'; target.removeAttribute('contenteditable');
      target.removeEventListener('keydown', onKey); target.removeEventListener('blur', onBlur);
      var v = target.textContent.replace(/\s+/g, ' ').trim();
      if (save && v && v !== previous.trim()) saveText(target, key, v, previous); else target.textContent = previous;
    }
    function onKey(ev) { if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); } ev.stopPropagation(); }
    function onBlur() { finish(true); }
    target.addEventListener('keydown', onKey); target.addEventListener('blur', onBlur);
  }

  // ---- a bigger change in the customer's own words (colours, fonts, text size, order of sections) ----
  function askChange() {
    var anchor = $('#bar');
    popover(anchor, 'Ask for a change', function (pop) {
      var box = el('textarea', { rows: '4', placeholder: 'Describe the change in your own words, for example: make the header dark brown with light text, make the text a bit bigger, use round buttons, move "How to order" above the perfumes' });
      var err = el('div', { class: 'err' });
      var chips = el('div', { class: 'actions' }, ['Make the text bigger', 'Round buttons', 'Dark header', 'Warmer colors'].map(function (t) {
        return el('button', { text: t, onclick: function () { box.value = t; } });
      }));
      var send = el('button', { class: 'go', text: 'Make this change' });
      send.addEventListener('click', function () {
        if (box.value.trim().split(/\s+/).length < 2) { err.textContent = 'Please describe the change you would like.'; return; }
        err.textContent = ''; send.disabled = true; send.textContent = 'Working on it...';
        request('POST', 'request', { text: box.value }).then(function (r) {
          try { sessionStorage.setItem('editOpenPanel', '1'); } catch (e) { /* storage is not available */ }
          location.reload();
        }).catch(function (e) { err.textContent = e.message; send.disabled = false; send.textContent = 'Make this change'; place(pop, anchor); });
      });
      pop.appendChild(box);
      pop.appendChild(el('small', { text: 'We can change colors, fonts, text size, button shape, and hide or move a section. Words, prices and pictures you change by clicking them. Anything else goes to our team. You can undo every change.' }));
      pop.appendChild(chips); pop.appendChild(err);
      pop.appendChild(el('div', { class: 'actions' }, [send, el('button', { text: 'Cancel', onclick: closePops })]));
      box.focus();
    });
  }

  // ---- clicks on the website itself ----
  document.addEventListener('click', function (ev) {
    if (ev.composedPath().indexOf(host) >= 0) return;
    var target = ev.target.closest ? ev.target.closest('[data-e]') : null;
    if (target && target.hasAttribute('data-editing')) return; // typing inside a text
    var link = ev.target.closest ? ev.target.closest('a, button, form') : null;
    if (link || target) { ev.preventDefault(); ev.stopPropagation(); }
    if (!target) { closePops(); return; }
    var key = target.getAttribute('data-e');
    if (/\.(img\d+|logo|logo-footer)$/.test(key)) editPicture(target, key); else editText(target, key);
  }, true);
  document.addEventListener('submit', function (ev) { ev.preventDefault(); }, true);

  load().then(function () { try { if (sessionStorage.getItem('editOpenPanel')) { sessionStorage.removeItem('editOpenPanel'); panelOpen = true; drawBar(); drawPanel(); } } catch (e) { /* storage is not available */ } }).catch(function (e) { toast(e.message); });
})();
