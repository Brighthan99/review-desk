// Builds media/review-desk-icons.woff from media/logo.svg, so the logo can be used as a
// product icon ($(review-desk-logo)) in the status bar, CodeLens, hovers and menus.
// Run with `npm run icons` after changing the logo.
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import svg2ttf from 'svg2ttf';
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont';
import ttf2woff from 'ttf2woff';

const fontStream = new SVGIcons2SVGFontStream({
  fontName: 'review-desk-icons',
  fontHeight: 1000,
  normalize: true,
  log: () => {},
});
const chunks = [];
fontStream.on('data', (d) => chunks.push(d));
const done = new Promise((resolve) => fontStream.on('end', resolve));

const glyph = Readable.from([fs.readFileSync('media/logo.svg')]);
glyph.metadata = { unicode: [''], name: 'review-desk-logo' };
fontStream.write(glyph);
fontStream.end();
await done;

const ttf = svg2ttf(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(), {});
const woff = ttf2woff(new Uint8Array(ttf.buffer));
fs.writeFileSync('media/review-desk-icons.woff', Buffer.from(woff.buffer ?? woff));
console.log('media/review-desk-icons.woff');
