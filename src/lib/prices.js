// Price helpers shared by the stages and their checks: reading prices from document facts,
// and finding out which prices of the brief are missing from a piece of text (copy, a Stitch page, a built page).
// A price is "present" when its number appears as a number in the text ("$25", "25 USD" and "from $25" all match 25).

const CURRENCY = '(?:[$€£]\\s?\\d[\\d.,]*|\\d[\\d.,]*\\s?(?:\\$|€|£|usd|eur|lbp|ll)\\b)';
const FACT_WITH_PRICE = new RegExp(`^(.{2,60}?)\\s*(?::|–|—|\\s-\\s)\\s*((?:from\\s+)?${CURRENCY}(?:\\s?(?:/|per)\\s?\\w+)?)\\s*$`, 'i');

// "Haircut: $25" -> { name: "Haircut", price: "$25" }, or null when the fact is not a name + price.
export function priceFromFact(fact) {
  const m = String(fact).trim().match(FACT_WITH_PRICE);
  return m ? { name: m[1].trim(), price: m[2].trim() } : null;
}

// The numbers written in a text, without thousands separators: "$1,200 or 25.5" -> ["1200", "25.5"].
export function numbersIn(text) {
  return [...String(text).matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/,(?=\d{3}(\D|$))/g, ''));
}

// The brief's offerings that have a price with a number in it.
export const pricedOfferings = (brief) => brief.offerings.filter((o) => o.price && /\d/.test(o.price));

// Priced offerings whose price number does not appear in `text`.
export function missingPrices(text, brief) {
  const present = new Set(numbersIn(text));
  return pricedOfferings(brief).filter((o) => !numbersIn(o.price).every((n) => present.has(n)));
}
