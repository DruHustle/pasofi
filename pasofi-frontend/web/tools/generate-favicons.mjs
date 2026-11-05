// Regenerate the checked-in browser icons from the authored SVG. No service,
// customer data, remote resource or image-generation provider is contacted.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../public/favicon.svg', import.meta.url);
const svg = await readFile(source, 'utf8');
const browser = await chromium.launch({ executablePath: process.env.PAMOFI_CHROME_PATH });
try {
  const page = await browser.newPage();
  const render = async (size, opaque = false) => Buffer.from(await page.evaluate(async ({ svg, size, opaque }) => {
    const image = new Image();
    image.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (opaque) { context.fillStyle = '#075cf5'; context.fillRect(0, 0, size, size); }
    context.drawImage(image, 0, 0, size, size);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { svg, size, opaque }), 'base64');
  const sizes = [16, 32, 48], frames = [];
  for (const size of sizes) frames.push(await render(size));
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index];
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  const ico = Buffer.concat([header, ...frames]), touch = await render(180, true);
  for (const directory of ['../public/', '../../mobile/public/']) {
    await writeFile(new URL(directory + 'favicon.svg', import.meta.url), svg);
    await writeFile(new URL(directory + 'favicon.ico', import.meta.url), ico);
    await writeFile(new URL(directory + 'apple-touch-icon.png', import.meta.url), touch);
  }
  console.log('PasoFi SVG, 16/32/48px ICO and opaque 180px touch icons generated for web and mobile.');
} finally { await browser.close(); }
