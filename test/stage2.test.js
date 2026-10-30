// Unit tests for Stage 2 helpers (no API calls): image size reading and the file scanner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readImageInfo, orientationOf } from '../src/lib/imageInfo.js';
import { scanAssets } from '../src/stages/02-assets/scan.js';
import { setProjectsRoot } from '../src/lib/project.js';

const FIXTURE_ASSETS = path.resolve('test/fixtures/demo-restaurant/inputs/assets');

test('png: real fixture files', () => {
  const info = readImageInfo(fs.readFileSync(path.join(FIXTURE_ASSETS, 'interior.png')), '.png');
  assert.deepEqual(info, { width: 400, height: 300, orientation: 'landscape' });
  const logo = readImageInfo(fs.readFileSync(path.join(FIXTURE_ASSETS, 'logo.png')), '.png');
  assert.equal(logo.orientation, 'square');
});

// Builds a minimal JPEG: SOI, optional EXIF orientation, SOF0 with size.
function fakeJpeg(width, height, exifOrientation) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (exifOrientation) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(exifOrientation, 18);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const header = Buffer.from([0xff, 0xe1, 0, 0]);
    header.writeUInt16BE(body.length + 2, 2);
    parts.push(header, body);
  }
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

test('jpeg: size, and EXIF rotation swaps width and height', () => {
  assert.deepEqual(readImageInfo(fakeJpeg(4032, 3024), '.jpg'), { width: 4032, height: 3024, orientation: 'landscape' });
  assert.deepEqual(readImageInfo(fakeJpeg(4032, 3024, 6), '.jpeg'), { width: 3024, height: 4032, orientation: 'portrait' });
});

test('webp (VP8X) and svg', () => {
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBP', 8, 'latin1');
  webp.write('VP8X', 12, 'latin1');
  webp.writeUIntLE(1199, 24, 3);
  webp.writeUIntLE(799, 27, 3);
  assert.deepEqual(readImageInfo(webp, '.webp'), { width: 1200, height: 800, orientation: 'landscape' });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>');
  assert.deepEqual(readImageInfo(svg, '.svg'), { width: 200, height: 100, orientation: 'landscape' });
});

test('orientationOf treats near-equal sides as square', () => {
  assert.equal(orientationOf({ width: 100, height: 103 }), 'square');
  assert.equal(orientationOf({ width: 100, height: 150 }), 'portrait');
});

test('scanner: finds supported files, skips others, hashes and sizes them', () => {
  setProjectsRoot(path.resolve('test/fixtures'));
  const { files, skipped } = scanAssets('demo-restaurant');
  assert.equal(files.length, 4);
  assert.deepEqual(skipped, ['README.txt']);
  assert.ok(files.every((f) => f.hash.length === 64 && f.rel.startsWith('inputs/assets/')));
  assert.equal(files.find((f) => f.name === 'blurry-street.png').info.width, 40);
});

test('a picture of a menu or price list (named document-...) is a document like a PDF, never a photo of the website', async () => {
  const { isDocument } = await import('../src/stages/02-assets/scan.js');
  assert.equal(isDocument({ ext: '.pdf', name: 'menu.pdf' }), true);
  assert.equal(isDocument({ ext: '.jpg', name: 'document-menu-page-1.jpg' }), true);
  assert.equal(isDocument({ ext: '.png', name: 'Document-Prices.PNG' }), true);
  assert.equal(isDocument({ ext: '.jpg', name: 'documents-in-the-shop.jpg' }), false, 'only the exact marker counts');
  assert.equal(isDocument({ ext: '.jpg', name: 'espresso.jpg' }), false);
});
