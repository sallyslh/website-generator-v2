// Matches a folder of product photos to the customer's product list by file name.
// One file, two users: the customer's browser (served as /match.js) and the tests (require).
//
// A photo is matched to a product when every meaningful word of its file name is in the product's name. Capitals, accents, punctuation,
// small words ("the", "de", "eau", "ml"), sizes and a trailing photo number ("gucci bloom-2") do not matter.
//   matched    the file name and the product name say the same thing (all words on both sides)
//   probable   the file name is a part of exactly one product's name ("tobacco vanille" for "Tom Ford Tobacco Vanille")
//   ambiguous  the file name fits several products ("sauvage" for "Dior Sauvage" and "Dior Sauvage Elixir"): the customer chooses
//   none       it fits no product: the photo is kept as a picture of the place
(function (root) {
  var STOP = ['the', 'de', 'of', 'and', 'for', 'eau', 'parfum', 'edp', 'spray', 'box', 'ml', 'photo', 'img', 'image', 'pic'];

  function norm(s) {
    return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')            // the extension
      .replace(/[-_ ]+\(?\d+\)?$/, '')        // a trailing photo number: "-2", " (3)"
      .replace(/[^a-z0-9؀-ۿ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function toks(s) {
    return norm(s).split(' ').filter(function (t) { return t && STOP.indexOf(t) < 0 && !/^\d+$/.test(t); });
  }

  // name: a file name or a path. items: [{ name }]. Returns { kind, cands: [item index] }.
  function matchFile(name, items) {
    var base = String(name).split('/').pop();
    var ft = toks(base);
    if (!ft.length) return { kind: 'none', cands: [] };
    var scored = [];
    items.forEach(function (it, i) {
      var nt = toks(it.name);
      if (!nt.length) return;
      var inside = ft.filter(function (t) { return nt.indexOf(t) >= 0; }).length;
      if (inside / ft.length < 0.99) return;
      var back = nt.filter(function (t) { return ft.indexOf(t) >= 0; }).length;
      scored.push({ i: i, same: back / nt.length >= 0.99 });
    });
    if (!scored.length) return { kind: 'none', cands: [] };
    var exact = scored.filter(function (c) { return c.same; });
    if (exact.length === 1) return { kind: 'matched', cands: [exact[0].i] };
    if (scored.length === 1) return { kind: 'probable', cands: [scored[0].i] };
    return { kind: 'ambiguous', cands: scored.map(function (c) { return c.i; }) };
  }

  // The category from the folders: "Shop/Women/a.jpg" is in "Women" (the first folder is the one the customer picked).
  function categoryOf(path) {
    var parts = String(path).split('/');
    return parts.length >= 3 ? parts[1] : '';
  }

  // photos: [{ path }] (the file name, or the path inside the picked folder). overrides: { photoIndex: itemIndex | -1 }.
  //   -1 = "not this product" (the photo goes to the pictures of the place).
  // Returns { photos: [{ n, path, name, category, m, item, confirmed }], byItem: [[photo]], extras: [photo], counts }.
  function analyse(items, photos, overrides) {
    overrides = overrides || {};
    var list = photos.map(function (p, n) {
      var path = p.path || p.name;
      var m = matchFile(path, items);
      var set = overrides[n] != null;
      var item = set ? (overrides[n] >= 0 ? overrides[n] : null) : (m.kind === 'matched' || m.kind === 'probable' ? m.cands[0] : null);
      return { n: n, path: path, name: String(path).split('/').pop(), category: categoryOf(path), m: m, item: item, confirmed: set || m.kind === 'matched' };
    });
    var byItem = items.map(function (it, i) { return list.filter(function (p) { return p.item === i; }); });
    var extras = list.filter(function (p) { return p.item == null; });
    return { photos: list, byItem: byItem, extras: extras };
  }

  // 'ok' all photos certain, 'check' a probable match not yet confirmed, 'missing' no photo, 'left' no photo and the customer accepted that
  function status(analysis, i, noPhoto) {
    var ph = analysis.byItem[i];
    if (!ph.length) return noPhoto && noPhoto[i] ? 'left' : 'missing';
    return ph.every(function (p) { return p.confirmed; }) ? 'ok' : 'check';
  }

  // The owner's list typed or pasted as text: one product per line, "Name - price - description" (a | or a tab works too).
  // The price is the part that looks like one ($8, 8 USD, 12.50); everything else after the name is the description. Nothing is invented.
  var PRICE = /^(?:(?:[$€£]|usd|eur|lbp)\s?)?\d[\d.,']*\s?(?:[$€£]|usd|eur|lbp|k)?$/i;
  function parseList(block) {
    return String(block).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (line) {
      var parts = line.split(/\t|\s*\|\s*|\s+[-–—]\s+/).map(function (p) { return p.trim(); }).filter(Boolean);
      if (parts.length === 1) { // "Haircut $25" or "Haircut 25 USD"
        var m = line.match(/^(.*?\S)\s*((?:[$€£]\s?\d[\d.,]*)|(?:\d[\d.,]*\s?(?:[$€£]|usd|eur|lbp)))$/i);
        if (m) return { name: m[1].trim(), price: m[2].trim(), description: '' };
      }
      var price = ''; var desc = [];
      parts.slice(1).forEach(function (p) { if (!price && PRICE.test(p)) price = p; else desc.push(p); });
      return { name: parts[0], price: price, description: desc.join(' - ') };
    });
  }

  // A list saved as a file (CSV, TSV, or a plain text file). With a header row ("Dish, Price, Description, Category") the columns are
  // found by their titles; without one, the first column is the name, the first price-like cell is the price and the rest is the
  // description. A file with no columns at all is read line by line like typed text.
  function splitRow(line, d) {
    var out = []; var cur = ''; var q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === d) { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim());
    return out;
  }
  var HEAD = { name: /^(name|dish|item|product|service|treatment|offer|offering|meal|title|item name|service name|product name|الاسم|الصنف)$/i, price: /^(price|cost|amount|rate|fee|tariff|السعر)$/i, description: /^(description|desc|details|ingredients|about|notes|summary|الوصف)$/i, category: /^(category|section|type|group|department|collection|القسم)$/i };
  // delimited: true for .csv/.tsv files. A .txt file is read line by line (its commas belong to the sentences).
  function parseTable(text, delimited) {
    var lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lines.length) return [];
    if (!delimited) return parseList(lines.join('\n'));
    var best = null;
    ['\t', ';', ','].forEach(function (d) {
      var counts = lines.map(function (l) { return splitRow(l, d).length - 1; });
      var usual = counts.filter(function (n) { return n === counts[0]; }).length;
      if (counts[0] > 0 && usual / lines.length >= 0.8 && (!best || counts[0] > best.n)) best = { d: d, n: counts[0] };
    });
    if (!best) return parseList(lines.join('\n'));
    var rows = lines.map(function (l) { return splitRow(l, best.d); });
    var col = {};
    rows[0].forEach(function (cell, i) { Object.keys(HEAD).forEach(function (k) { if (col[k] === undefined && HEAD[k].test(cell.trim())) col[k] = i; }); });
    // A header row is recognised by its titles. If it names a price, description or category but not the name column (a column called
    // "Treatment" or "Cut"), the name is the first column that is none of those: the header is never mistaken for a dish.
    var named = Object.keys(col).length;
    if (col.name === undefined && named >= 1) {
      var taken = Object.keys(col).map(function (k) { return col[k]; });
      for (var c = 0; c < rows[0].length; c++) if (taken.indexOf(c) < 0 && rows[0][c].trim()) { col.name = c; break; }
    }
    var hasHeader = col.name !== undefined;
    return rows.slice(hasHeader ? 1 : 0).map(function (r) {
      if (hasHeader) return { name: r[col.name] || '', price: (col.price !== undefined && r[col.price]) || '', description: (col.description !== undefined && r[col.description]) || '', category: (col.category !== undefined && r[col.category]) || '' };
      var price = ''; var desc = [];
      r.slice(1).forEach(function (c) { if (!c) return; if (!price && PRICE.test(c)) price = c; else desc.push(c); });
      return { name: r[0], price: price, description: desc.join(' - '), category: '' };
    }).filter(function (r) { return r.name; });
  }

  // A photo that fits no dish exactly but is a typing slip away from one ("shrimps-pan" for "Shrimps Pané"): the closest dish, to be
  // confirmed by the owner (never used without a click). Edit distance of the normalised names, at most 2 letters (and under a quarter of the name).
  function distance(a, b) {
    var d = []; for (var i = 0; i <= a.length; i++) { d[i] = [i]; } for (var j = 1; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function suggest(name, items) {
    var f = toks(String(name).split('/').pop()).join(' ');
    if (!f) return null;
    var best = null;
    items.forEach(function (it, i) {
      var n = toks(it.name).join(' ');
      if (!n) return;
      var dist = distance(f, n);
      if (dist <= 2 && dist <= Math.floor(n.length / 4) && (!best || dist < best.dist)) best = { item: i, dist: dist };
    });
    return best ? best.item : null;
  }

  var api = { suggest: suggest, parseTable: parseTable, parseList: parseList, norm: norm, toks: toks, matchFile: matchFile, categoryOf: categoryOf, analyse: analyse, status: status };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ItemMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
