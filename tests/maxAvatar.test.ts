import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { composeMaxAvatar, maxAvatarBadge, maxAvatarKey } from '../src/bridge/maxAvatar.js';

describe('MAX avatar badge', () => {
  it('converts portrait WebP to a Telegram JPEG while preserving the photo outside the badge', async () => {
    const input = await sharp({ create: { width: 200, height: 400, channels: 3, background: '#dc2828' } }).webp().toBuffer();
    const result = await composeMaxAvatar(input, 'Имя');
    expect(await sharp(result).metadata()).toMatchObject({ format: 'jpeg', width: 512, height: 512, hasAlpha: false });
    const pixel = await sharp(result).extract({ left: 128, top: 128, width: 1, height: 1 }).raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(210); expect(pixel[1]).toBeLessThan(50);
    const badge = await sharp(result).extract({ left: 384, top: 384, width: 1, height: 1 }).raw().toBuffer();
    expect(badge[2]).toBeGreaterThan(200);
  });
  it('keeps every visible badge pixel inside the Telegram circular crop', async () => {
    const { data, info } = await sharp(maxAvatarBadge).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]) expect(Math.hypot(x + .5 - 256, y + .5 - 256)).toBeLessThan(256);
    }
  });
  it('renders initials safely when there is no MAX photo', async () => {
    expect(await sharp(await composeMaxAvatar(undefined, '<& "Контакт')).metadata()).toMatchObject({ format: 'jpeg', width: 512 });
  });
  it('replaces old unbadged identity keys and updates missing-photo initials after a rename', () => {
    expect(maxAvatarKey({}, 'А')).not.toBe(maxAvatarKey({}, 'Б'));
    expect(maxAvatarKey({ photoId: 1, url: 'https://photo/one' }, 'А')).toBe(maxAvatarKey({ photoId: 1, url: 'https://photo/two' }, 'Б'));
  });
  it('rejects damaged photos instead of silently replacing them with initials', async () => {
    await expect(composeMaxAvatar(Buffer.from('not an image'), 'А')).rejects.toThrow();
  });
});
