import React from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from '@jode/shell'
import '@jode/shell/globals.css'
import { iframeHost } from './iframe-host'
import { Panes } from './Panes'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Shell host={iframeHost} renderPane={(active, agents) => <Panes active={active} agents={agents} />} />
  </React.StrictMode>
)
