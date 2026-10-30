// WhatsApp links (wa.me) need the number in international form, digits only, with the country code and no leading zeros.
// A local number such as "71-014463" cannot be turned into one without guessing the country, so a number only counts
// when the owner wrote it with "+" or "00" in front of the country code.

// Returns the digits for wa.me, or "" when the number is not clearly international.
export function whatsappDigits(input) {
  const raw = String(input ?? '').trim();
  if (!/^(\+|00)\s*\d/.test(raw)) return '';
  const digits = raw.replace(/^(\+|00)/, '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0') ? digits : '';
}

// Shows digits as a number people recognise: 96171014463 -> +96171014463
export const whatsappLink = (digits, text = '') => `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
