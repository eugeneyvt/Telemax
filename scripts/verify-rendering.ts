/** Offline acceptance of the optional sticker runtime, without any account or message data. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { staticStickerWebp } from '../src/bridge/stickers.js';
import { renderTgsToWebm, canRenderAnimatedStickers } from '../src/bridge/lottie.js';
const exec = promisify(execFile);
const { stdout: png } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:d=1', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
const webp = await staticStickerWebp(png);
if (!webp || webp.subarray(0, 4).toString() !== 'RIFF') throw new Error('Static sticker encoding failed.');
if (!canRenderAnimatedStickers()) throw new Error('Animated sticker renderer is unavailable.');
const animation = { v: '5.7.4', fr: 6, ip: 0, op: 6, w: 64, h: 64, nm: 'Fixture', ddd: 0, assets: [], layers: [{ ddd: 0, ind: 1, ty: 4, nm: 'Shape', sr: 1, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [32, 32, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } }, ao: 0, shapes: [{ ty: 'rc', d: 1, s: { a: 0, k: [32, 32] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 }, nm: 'Rectangle' }, { ty: 'fl', c: { a: 0, k: [0, 0.4, 1, 1] }, o: { a: 0, k: 100 }, r: 1, nm: 'Fill' }], ip: 0, op: 6, st: 0, bm: 0 }] };
const video = await renderTgsToWebm(Buffer.from(JSON.stringify(animation)));
if (video.subarray(0, 4).toString('hex') !== '1a45dfa3') throw new Error('Animated sticker WebM encoding failed.');
console.log(JSON.stringify({ staticSticker: true, animatedSticker: true, node: process.versions.node, webpBytes: webp.length, webmBytes: video.length }));
