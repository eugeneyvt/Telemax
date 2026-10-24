import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(root, '.data/server-active.json')) && process.env.TELEMAX_ALLOW_LOCAL_RECOVERY !== '1') {
  throw new Error('Мост перенесён на сервер или перенос уже начат. Одновременный локальный запуск запрещён; для восстановления сначала остановите сервер и перенесите актуальное состояние обратно.');
}
const configFile = process.env.DOTENV_CONFIG_PATH
  ? path.resolve(root, process.env.DOTENV_CONFIG_PATH)
  : path.join(root, existsSync(path.join(root, '.data/runtime-secret.env')) ? '.data/runtime-secret.env' : '.env');
const settings = dotenv.parse(readFileSync(configFile));
if (!settings.TELEGRAM_BOT_TOKEN?.trim() || !settings.TELEGRAM_OWNER_ID?.trim()) {
  throw new Error('В выбранном файле настроек не заполнены токен бота и ID владельца.');
}
const candidates = [...new Set([process.execPath, '/opt/homebrew/opt/node@24/bin/node', path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node')])];
let runtime, version;
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ['-p', 'process.versions.node'], { encoding: 'utf8' });
  const value = probe.status === 0 ? probe.stdout.trim() : '';
  const [major, minor] = value.split('.').map(Number);
  if (major === 24 || (major === 22 && minor >= 19)) { runtime = candidate; version = value; break; }
}
if (!runtime) throw new Error('Не найден Node.js 24 LTS или 22.19+. Node.js 26 не подходит для загрузки вложений.');
const data = path.join(root, '.data'); mkdirSync(data, { recursive: true, mode: 0o700 });
const log = openSync(path.join(data, 'local-bridge.log'), 'a', 0o600);
const child = spawn(runtime, ['dist/server.mjs'], { cwd: root, env: { ...process.env, DOTENV_CONFIG_PATH: configFile }, stdio: ['ignore', log, log] });
writeFileSync(path.join(data, 'local-bridge-process.json'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), runtime: version, config: path.relative(root, configFile), mode: settings.TELEGRAM_CHAT_MODE ?? 'private' }), { mode: 0o600 });
console.log(`Мост запущен на Node.js ${version}. Журнал: .data/local-bridge.log`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
child.on('error', () => { console.error('Не удалось запустить мост.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
