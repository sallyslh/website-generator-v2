// How a price is SHOWN. The owner's number is never changed; only the currency sign is added, so a price is clearly a price.
// "20.0" with currency USD is shown "$20". A price that already carries a sign or a code ("$8", "12 USD", "50,000 LBP") is left as written.

export const CURRENCIES = { USD: '$', EUR: '€', GBP: '£', LBP: 'LBP', AED: 'AED', SAR: 'SAR', EGP: 'EGP', JOD: 'JOD', QAR: 'QAR', KWD: 'KWD', TRY: '₺' };
const PREFIX = new Set(['$', '€', '£', '₺']); // signs written before the number; codes go after it

export const cleanCurrency = (v) => { const c = String(v ?? '').trim().toUpperCase(); return c in CURRENCIES ? c : /^[A-Z]{3}$/.test(c) ? c : ''; };

export function formatPrice(raw, currency = '') {
  const price = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!price) return '';
  if (/[^\d.,\s]/.test(price)) return price; // already has a sign or a code
  const code = cleanCurrency(currency);
  if (!code) return price;
  const number = price.replace(/[.,]0+$/, ''); // "20.0" -> "20" (the same value, written the usual way)
  const sign = CURRENCIES[code] ?? code;
  return PREFIX.has(sign) ? `${sign}${number}` : `${number} ${sign}`;
}

// The number inside the owner's price, for adding up an order ("32.0" -> 32, "50,000 LBP" -> 50000, "12,5" -> 12.5). null when there is none.
export function numericPrice(raw) {
  const m = String(raw ?? '').replace(/\s+/g, '').match(/\d[\d.,']*/);
  if (!m) return null;
  let n = m[0].replace(/'/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(n)) n = n.replace(/,/g, ''); // 50,000 and 1,250.50: thousands
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(n)) n = n.replace(/\./g, '').replace(',', '.'); // 1.250,50
  else n = n.replace(',', '.');
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}
