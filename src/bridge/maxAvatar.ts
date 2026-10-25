import { createHash } from 'node:crypto';
import sharp from 'sharp';

// White MAX symbol from https://go.max.ru/brandbook (max-white.zip, Max white.svg).
const symbol = 'M50.7571 0.261719C78.2929 0.261719 99.8857 22.5974 99.8857 50.1474C99.8857 77.6974 77.6071 99.4903 51.0214 99.4903C41.5857 99.4903 37.0143 98.1617 29.65 92.9474C29.1429 92.5903 28.45 92.6831 28.0214 93.1403C22.3571 99.1831 7.85 103.426 7.18571 95.176C7.18571 80.7903 0 71.4474 0 49.876C0 21.5546 23.2214 0.261719 50.7571 0.261719ZM51.5286 24.8117C38.4643 24.126 28.2643 33.1974 26.0143 47.3831C24.15 59.1332 27.45 73.4546 30.2786 74.176C31.4786 74.4832 34.3571 72.276 36.4571 70.2974C36.85 69.926 37.45 69.8617 37.9071 70.1474C41.1786 72.1474 44.8786 73.6474 48.9571 73.8617C62.3714 74.5617 74.2571 64.0617 74.9643 50.6474C75.6643 37.2331 64.9429 25.5046 51.5286 24.8046V24.8117Z';
const version = 'max-badge-v1';
const size = 512;
// The complete badge sits inside Telegram's circular crop: hypot(128,128) + 67 < 256.
export const maxAvatarBadge = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><linearGradient id="max" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#00BFFF"/><stop offset=".5" stop-color="#471AFF"/><stop offset="1" stop-color="#9500FF"/></linearGradient></defs>
<circle cx="384" cy="384" r="67" fill="white"/><circle cx="384" cy="384" r="61" fill="url(#max)"/>
<path transform="translate(341 341) scale(.86)" d="${symbol}" fill="white"/></svg>`);

export function maxAvatarKey(photo: { photoId?: unknown; url?: string }, title: string): string {
  return createHash('sha256').update(JSON.stringify([version, photo.url ? String(photo.photoId ?? photo.url) : ['initials', title]])).digest('hex');
}

/** Local composition only: contact photos are never sent to a third-party image service. */
export async function composeMaxAvatar(source: Buffer | undefined, title: string): Promise<Buffer> {
  const initials = [...title.trim()].slice(0, 2).join('').toLocaleUpperCase().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
  const placeholder = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#6979AA"/><text x="256" y="267" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="190" fill="white">${initials || 'M'}</text></svg>`);
  return sharp(source ?? placeholder, { limitInputPixels: 40_000_000, failOn: 'error' })
    .rotate().resize(size, size, { fit: 'cover', position: 'centre' }).flatten({ background: '#ffffff' })
    .composite([{ input: maxAvatarBadge }]).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
}
