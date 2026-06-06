// Capture screenshots from a running Electron app via the Chrome DevTools
// Protocol. Launch the app first with: electron . --remote-debugging-port=9222
//
// Each agent pane is a separate WebContentsView (its own CDP target), so we
// capture the renderer "chrome" (sidebar + bordered frame + merged tab) and the
// active agent pane independently and write them as separate PNGs.
//
// Usage: node scripts/cdp-shot.mjs [port] [outDir]

const PORT = process.argv[2] ?? '9222'
const OUT = process.argv[3] ?? '/tmp'
const BASE = `http://127.0.0.1:${PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTargets() {
  const res = await fetch(`${BASE}/json`)
  return res.json()
}

function capture(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    const send = (method, params = {}) =>
      new Promise((res) => {
        const id = nextId++
        pending.set(id, res)
        ws.send(JSON.stringify({ id, method, params }))
      })

    ws.addEventListener('open', async () => {
      try {
        await send('Page.enable')
        const { data } = await send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false
        })
        ws.close()
        resolve(Buffer.from(data, 'base64'))
      } catch (e) {
        reject(e)
      }
    })
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result)
        pending.delete(msg.id)
      }
    })
    ws.addEventListener('error', reject)
  })
}

const fs = await import('node:fs/promises')

// Wait for an agent pane (data: URL target) to show up.
let targets = []
for (let i = 0; i < 20; i++) {
  targets = await getTargets()
  if (targets.some((t) => t.url.startsWith('data:'))) break
  await sleep(300)
}

const pages = targets.filter((t) => t.type === 'page')
console.log('targets:')
for (const t of pages) console.log(`  ${t.url.slice(0, 60)}`)

const chrome = pages.find((t) => t.url.includes('index.html'))
const pane = pages.find((t) => t.url.startsWith('data:'))

if (chrome) {
  await fs.writeFile(`${OUT}/jode-chrome.png`, await capture(chrome.webSocketDebuggerUrl))
  console.log(`wrote ${OUT}/jode-chrome.png`)
}
if (pane) {
  await fs.writeFile(`${OUT}/jode-pane.png`, await capture(pane.webSocketDebuggerUrl))
  console.log(`wrote ${OUT}/jode-pane.png`)
}
