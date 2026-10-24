import { readFileSync } from 'node:fs';
try {
  const status = JSON.parse(readFileSync('/app/.data/health.json', 'utf8'));
  if (status.schema !== 1 || !status.ok || !Number.isSafeInteger(status.at) || Date.now() - status.at > 90_000 || status.at > Date.now() + 60_000) process.exitCode = 1;
} catch { process.exitCode = 1; }
