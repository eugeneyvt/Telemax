/** Telegraf 4's multipart stream stalls on Node 26; JSON-only smoke tests miss it. */
export function assertSupportedRuntime(version = process.versions.node): void {
  const [major, minor] = version.split('.').map(Number);
  if ((major === 22 && minor! >= 19) || major === 24) return;
  throw new Error(`Для Telemax нужен Node.js 22.19+ (ветка 22) или 24 LTS. Текущий ${version}: передача вложений на Node.js 26 зависает.`);
}
