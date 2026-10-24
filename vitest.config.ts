import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] }, // research contains historical, intentionally bug-observing probes
});
