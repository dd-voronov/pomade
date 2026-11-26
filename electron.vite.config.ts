import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin, type MainViteConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Entry points are electron-vite's own defaults, except main's second one:
//   main    → src/main/index.ts     (CJS → out/main/index.js)
//             src/git-core/pomade-git.ts (CJS → out/main/pomade-git.js — the `pomade-git` command,
//             Electron-free; Pomade's command shim runs it with ELECTRON_RUN_AS_NODE)
//   preload → src/preload/index.ts  (findLibEntry, CJS → out/preload/index.js)
//   renderer→ src/renderer/index.html (auto-detected under `renderer.root`)
// package.json has no "type":"module", so main/preload build as CommonJS — the shape
// package.json#main (./out/main/index.js) and index.ts's ../preload, ../renderer loads depend on.
// electron-vite's main build type is written against a newer Vite than this repo's (its
// `BuildEnvironmentOptions` does not exist in Vite 5), so the options are cast; Vite 5 reads
// `lib.entry` as usual.
const mainBuild = {
  lib: {
    entry: {
      index: resolve(__dirname, 'src/main/index.ts'),
      'pomade-git': resolve(__dirname, 'src/git-core/pomade-git.ts')
    }
  }
} as NonNullable<MainViteConfig['build']>

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: mainBuild
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    },
    plugins: [react()]
  }
})
