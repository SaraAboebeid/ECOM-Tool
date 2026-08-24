import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initRangeFill } from './utils/rangeFill'

// Dark mode is now handled by the script in index.html
// to prevent flash of incorrect theme

// Paints the filled portion of every slider; see utils/rangeFill.ts.
initRangeFill()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
