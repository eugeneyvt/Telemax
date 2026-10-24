import { spawn } from 'node:child_process';

/** No shell, files, or unbounded output: turn a MAX PNG preview into a Telegram static sticker. */
export function staticStickerWebp(source: Buffer): Promise<Buffer | null> {
  if (source.length > 20 * 1024 * 1024) return Promise.resolve(null);
  return new Promise(resolve => {
    const process = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba', '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '1', '-f', 'webp', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = []; let total = 0; let settled = false;
    const timer = setTimeout(() => { process.kill('SIGKILL'); finish(null); }, 20_000); timer.unref();
    function finish(value: Buffer | null) { if (settled) return; settled = true; clearTimeout(timer); resolve(value); }
    process.on('error', () => finish(null));
    process.stdout.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 512 * 1024) { process.kill('SIGKILL'); finish(null); } else chunks.push(chunk); });
    process.on('close', code => finish(code === 0 && total > 0 ? Buffer.concat(chunks) : null));
    process.stdin.on('error', () => {}); process.stdin.end(source);
  });
}
