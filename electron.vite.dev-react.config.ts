// Dev-React build config — e2e verification harness ONLY (not shipped, not `npm run dev`).
//
// StrictMode bug repro regime. `npm run dev` runs a live React DEVELOPMENT bundle, where
// React.StrictMode double-invokes every mount effect (mount → simulated unmount → remount).
// The normal e2e build (`electron-vite build`) is a PRODUCTION React bundle where StrictMode
// does NOT double-invoke, so a bug that only manifests under the doubled mount is invisible to
// the suite. `electron-vite build --mode development` unminifies but Vite still pins
// `process.env.NODE_ENV` to "production", so React stays production. This config forces
// `process.env.NODE_ENV = "development"` in the RENDERER bundle so React double-invokes,
// giving Playwright a bundle that reproduces the Owner's dev-only symptom.
//
// Used by the `strictmode-caret-swallow` spec via `electron-vite build -c electron.vite.dev-react.config.ts`.
import baseConfig from './electron.vite.config'

type MutableConfig = {
  renderer?: { define?: Record<string, string>; [k: string]: unknown }
  [k: string]: unknown
}

const config = baseConfig as unknown as MutableConfig
config.renderer = {
  ...(config.renderer ?? {}),
  define: {
    ...((config.renderer?.define as Record<string, string> | undefined) ?? {}),
    'process.env.NODE_ENV': JSON.stringify('development')
  }
}

export default config
