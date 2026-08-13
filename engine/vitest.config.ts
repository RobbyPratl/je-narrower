import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    env: process.env.LIVE_SMOKE === '1'
      ? { AGENT_PROVIDER: process.env.AGENT_PROVIDER ?? 'ollama' }
      : { AGENT_PROVIDER: 'mock' },
    hookTimeout: 60_000,
    testTimeout: 90_000,
  },
});
