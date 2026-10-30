// Configurable word lists for Stage 4 checks. Edit these arrays to tune the rules.

// Clichés the copy must not contain (case-insensitive).
export const BANNED_CLICHES = [
  'welcome to', 'elevate', 'unlock', 'seamless', 'your journey', 'look no further',
  "in today's world", 'discover the', 'experience the difference', 'world-class', 'state-of-the-art',
  'tailored to your needs', 'one-stop', 'second to none', 'passion for excellence', 'cutting-edge',
];

// Claims that sound like facts. A claim word is allowed only if the same word appears in the
// brief or the customer's documents (for example "handmade" when the owner said handmade).
export const CLAIM_WORDS = [
  'authentic', 'original', 'genuine', 'guaranteed', 'guarantee', 'certified', 'award', 'award-winning',
  'best-selling', 'bestselling', '#1', 'number one', 'thousands', 'millions', 'trusted by', 'years of',
  'since', 'founded', 'established', 'free delivery', 'free shipping', 'fast delivery', 'same-day',
  'cash on delivery', 'money-back', 'refund', 'warranty', 'lowest price', 'best price', 'discount',
  'handmade', 'hand-made', 'organic', 'natural', 'family-owned', 'family-run', 'locally',
];

// Marker the copy must use when a fact is missing: "NEEDS: prices from the customer".
export const NEEDS_MARKER = 'NEEDS:';
