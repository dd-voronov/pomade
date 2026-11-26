import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// T-176 — pure-logic unit-test layer, separate from the Playwright e2e suite (electron.vite.*
// covers the app build; playwright.config.ts covers acceptance/behavior via a real Electron
// app). This config only ever needs plain Node: every target module is import-light pure logic
// (tree math, string parsing, format-preserving rewrites), so no jsdom/browser environment is
// configured — add one only if a future suite genuinely needs a DOM.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.unit.test.ts'],
    passWithNoTests: false
  }
})
