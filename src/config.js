// Reads .env and exports the app settings.
// Keys are only checked when a command actually needs them (see requireKey).

import 'dotenv/config';

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  stitchApiKey: process.env.STITCH_API_KEY || '',
  formEndpoint: process.env.FORM_ENDPOINT || '',
  formAccessKey: process.env.FORM_ACCESS_KEY || '',
  falKey: process.env.FAL_KEY || '',
  chatModel: process.env.CHAT_MODEL || '', // the model of the website assistant (empty: the same as ANTHROPIC_MODEL)
  chatMonthlyBudgetUsd: Number(process.env.CHAT_MONTHLY_BUDGET_USD) > 0 ? Number(process.env.CHAT_MONTHLY_BUDGET_USD) : 5, // what one business's assistant may cost per month
  ordersUrl: (process.env.ORDERS_URL || '').replace(/\/$/, ''), // empty: the orders go to the same address as the website (the normal way); set it only when they go elsewhere
};

// Price per million tokens, per model: { input, output } in USD.
// Claude Sonnet 5.5 list prices (checked 2026-10-11): $2 per million input tokens, $10 per million output tokens.
// Add a line here when you switch ANTHROPIC_MODEL. Stitch is free in Google Labs, so it has no price.
export const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 }, // prompts up to 100K tokens
  'claude-opus-5-5': { input: 4, output: 20 },
};

// Call this right before using a key, so unrelated commands never fail on missing keys.
export function requireKey(name) {
  const envName = { anthropic: 'ANTHROPIC_API_KEY', stitch: 'STITCH_API_KEY', form: 'FORM_ENDPOINT' }[name];
  const value = { anthropic: config.anthropicApiKey, stitch: config.stitchApiKey, form: config.formEndpoint }[name];
  if (!value) throw new Error(`${envName} is missing. Add it to your .env file (see .env.example).`);
  return value;
}

// Masks a secret for display: keeps the first 4 characters only.
export function mask(value) {
  if (!value) return '(not set)';
  return value.slice(0, 4) + '*'.repeat(Math.max(4, value.length - 4));
}

// The assistant's two ways: "standard" (the model of CHAT_MODEL, else ANTHROPIC_MODEL: more careful) and "economy" (a smaller model, much cheaper).
// Returns the model to ask for, or undefined for the default one.
export const chatModelFor = (choice) => (choice === 'economy' ? (process.env.CHAT_MODEL_ECONOMY || 'claude-haiku-5-5') : (config.chatModel || undefined));
