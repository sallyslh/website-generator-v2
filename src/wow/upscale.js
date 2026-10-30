// Makes a picture sharp at a large size: fal.ai "Recraft crisp upscale" (about 3x), then a web-friendly size.
// Stitch's pictures are at most 1376 px wide; a full-screen hero needs far more. If the upscale fails the caller keeps the original.

import sharp from 'sharp';
import { config } from '../config.js';
import { logCall } from '../lib/costLog.js';

export const UPSCALE_MODEL = 'fal-ai/recraft/upscale/crisp';
export const MAX_WIDTH = 2880; // enough for a full-screen picture on a high-density laptop screen
export const upscaleAvailable = () => Boolean(config.falKey) && process.env.IMAGE_GENERATION !== 'off';

// bytes (any picture format) -> { buffer (jpeg, at most MAX_WIDTH wide), width, height }
export async function upscale(bytes, { projectId, fetchImpl = fetch } = {}) {
  const started = Date.now();
  const jpeg = await sharp(bytes).jpeg({ quality: 92 }).toBuffer();
  const res = await fetchImpl(`https://fal.run/${UPSCALE_MODEL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${config.falKey}` },
    body: JSON.stringify({ image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Upscale failed (${res.status}): ${String(body.detail?.[0]?.msg ?? body.detail ?? body.error ?? 'no details').slice(0, 160)}`);
  const url = body.image?.url ?? body.images?.[0]?.url;
  if (!url) throw new Error('The upscaler returned no picture.');
  const got = await fetchImpl(url);
  if (!got.ok) throw new Error(`The upscaled picture could not be downloaded (${got.status}).`);
  const out = await sharp(Buffer.from(await got.arrayBuffer())).resize({ width: MAX_WIDTH, withoutEnlargement: true }).jpeg({ quality: 84, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  // the price is not returned by the service: it is left empty here, not guessed (the fal.ai billing page is the truth)
  if (projectId) logCall({ projectId, stage: 'wow-upscale', provider: 'fal', model: UPSCALE_MODEL, durationMs: Date.now() - started });
  return { buffer: out.data, width: out.info.width, height: out.info.height };
}
