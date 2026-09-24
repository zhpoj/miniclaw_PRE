import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'tests/**/*.spec.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    ],
  },
})
