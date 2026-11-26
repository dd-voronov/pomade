import React from 'react'
import { createRoot } from 'react-dom/client'

import './tokens.css'
import './global.css'
// T-153 — importing the font catalog at boot kicks off loading the bundled monos (JetBrains
// Mono, IBM Plex Mono) into `document.fonts`, so a bundled family is measured-ready before the
// first xterm grid measurement or CodeMirror layout.
import './font-catalog'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('Root container #root not found')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
