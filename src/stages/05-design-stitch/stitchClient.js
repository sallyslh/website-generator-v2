// ALL Google Stitch calls live in this file, so Stitch can be replaced later without touching the stage.
// Every call is retried once on RATE_LIMITED / NETWORK_ERROR and logged in the cost log (provider "stitch").
//
// What we learned about the real responses (the SDK README does not describe them):
//  - generate_screen_from_text returns { outputComponents: [ {design:{screens:[...],theme}}, {text}, {suggestion}... ] }.
//  - A screen has { id, title, width, height, screenType, htmlCode:{downloadUrl}, screenshot:{downloadUrl} }.
//  - The SDK's own Screen wrapper can return a helper screen (for example a small SVG logo badge Stitch drew
//    for the header) instead of the page, so we read the raw tool response and pick the page ourselves.

import fs from 'node:fs';
import path from 'node:path';
import { Stitch, StitchToolClient, StitchError } from '@google/stitch-sdk';
import { requireKey } from '../../config.js';
import { logCall } from '../../lib/costLog.js';
import { log } from '../../lib/log.js';

const RETRY_WAIT_MS = 15_000;
// The SDK waits 5 minutes for one call. A page with a long list (a 100-dish menu) needs longer, so the wait is 15 minutes.
const STITCH_TIMEOUT_MS = 15 * 60_000;
let toolClient = null; let domain = null;
const client = () => (toolClient ??= new StitchToolClient({ apiKey: process.env.STITCH_API_KEY, baseUrl: process.env.STITCH_HOST || undefined, timeout: STITCH_TIMEOUT_MS }));
const stitch = {
  createProject: (title) => (domain ??= new Stitch(client())).createProject(title),
  callTool: (name, args) => client().callTool(name, args),
};
const RETRYABLE = ['RATE_LIMITED', 'NETWORK_ERROR'];

// Runs one Stitch call with timing, cost logging and one retry.
async function tracked(projectId, label, call) {
  requireKey('stitch');
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      const result = await call();
      logCall({ projectId, stage: 'design', provider: 'stitch', model: label, durationMs: Date.now() - started });
      return result;
    } catch (err) {
      logCall({ projectId, stage: 'design', provider: 'stitch', model: `${label} (failed)`, durationMs: Date.now() - started });
      const retry = err instanceof StitchError && RETRYABLE.includes(err.code) && attempt === 1;
      if (!retry) throw err;
      log.info('design', `${err.code}, waiting ${RETRY_WAIT_MS / 1000}s and trying once more`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
    }
  }
}

// Every screen found in a tool response, as { screenId, title, width, height, htmlUrl, imageUrl }.
export function screensIn(response) {
  const found = [];
  for (const component of response?.outputComponents ?? [])
    for (const s of component.design?.screens ?? []) {
      if (!s.id || !s.htmlCode?.downloadUrl || !s.screenshot?.downloadUrl) continue;
      found.push({ screenId: s.id, title: s.title ?? '', width: s.width ?? 0, height: s.height ?? 0, type: s.screenType ?? '', htmlUrl: s.htmlCode.downloadUrl, imageUrl: s.screenshot.downloadUrl });
    }
  return found;
}

// The real page among the screens: DESIGN screens only, the tallest first (helper screens like logos are small).
export function pickPages(screens) {
  const designs = screens.filter((s) => !s.type || s.type === 'DESIGN');
  return (designs.length ? designs : screens).sort((a, b) => b.width * b.height - a.width * a.height);
}

export async function createProject(projectId, title) {
  const project = await tracked(projectId, 'create_project', () => stitch.createProject(title));
  return project.projectId;
}

export async function generateScreen(projectId, stitchProjectId, prompt) {
  const response = await tracked(projectId, 'generate_screen_from_text', () =>
    stitch.callTool('generate_screen_from_text', { projectId: stitchProjectId, prompt, deviceType: process.env.STITCH_DEVICE === 'MOBILE' ? 'MOBILE' : 'DESKTOP' })); // MOBILE only for the laptop-or-phone experiments
  const pages = pickPages(screensIn(response));
  if (!pages.length) throw new Error('Stitch returned no screen with HTML and a screenshot.');
  return pages[0];
}

// The variants of an existing screen, as a list of screens.
export async function generateVariants(projectId, stitchProjectId, screenId, prompt, { count = 3 } = {}) {
  const response = await tracked(projectId, 'generate_variants', () =>
    stitch.callTool('generate_variants', {
      projectId: stitchProjectId, prompt, selectedScreenIds: [screenId], deviceType: 'DESKTOP',
      variantOptions: { variantCount: count, creativeRange: 'EXPLORE', aspects: ['LAYOUT', 'COLOR_SCHEME'] },
    }));
  return pickPages(screensIn(response)).filter((s) => s.screenId !== screenId);
}

// The stitch.googleapis.com download address wraps the file in JSON: {"dataString": "<the html>"} for a page, and {"imageMetadata": {...}, "dataString": "<base64>"}
// for a picture. Anything that is not that wrapper is returned as it came.
export function unwrapDownload(buffer) {
  if (buffer[0] !== 0x7b) return buffer;
  try {
    const json = JSON.parse(buffer.toString('utf8'));
    if (typeof json?.dataString !== 'string') return buffer;
    return json.imageMetadata ? Buffer.from(json.dataString, 'base64') : Buffer.from(json.dataString, 'utf8');
  } catch { return buffer; }
}

// Stitch returns download URLs, so the files have to be fetched and saved (with a few retries).
export async function downloadTo(url, destination) {
  let status = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      // downloads from stitch.googleapis.com need the key; the older public file addresses must not get it
      const response = await fetch(url, /^https:\/\/stitch\.googleapis\.com\//.test(url) ? { headers: { 'X-Goog-Api-Key': process.env.STITCH_API_KEY } } : undefined);
      status = response.status;
      if (response.ok) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, unwrapDownload(Buffer.from(await response.arrayBuffer())));
        return;
      }
    } catch (err) {
      status = `network error: ${err.message}`;
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
  throw new Error(`Download failed (${status}) for ${destination}`);
}
