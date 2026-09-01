import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      all: true,
      include: ['src/**'],
      exclude: ['src/types.ts'],
      thresholds: { lines: 96 },
    },
  },
})

