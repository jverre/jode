// ─────────────────────────────────────────────────────────────────────────────
// gen-icon.mjs — render the jode app icon from code (no design tools, no deps).
//
// The mark is an abstract "orbit": an open ring (3/4 arc, rounded caps) cradling
// a separate dot that nests in the ring's opening — many agents held in one home.
// Two cleanly separated elements (no overlap), reads as a glyph, not a letter.
// Flat by design — no gradients, no glow — on a superellipse "squircle" plate,
// with 4×4 supersampled anti-aliasing. Hand-rolls a PNG via zlib.
//
//   node scripts/gen-icon.mjs                          # build/icon.png (mono)
//   ICON_VARIANT=accent node scripts/gen-icon.mjs      # mono + indigo tittle
//   ICON_VARIANT=paper|slate|ink|accent ...
//   ICON_PREVIEW_DIR=/tmp/x node scripts/gen-icon.mjs  # also dump all variants
//
// Tweakables: STROKE (weight), RING_R, OPEN_A/OPEN_B (opening), DOT_R, palettes.
// ─────────────────────────────────────────────────────────────────────────────
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'build', 'icon.png')
const PREVIEW_DIR = process.env.ICON_PREVIEW_DIR || ''
const VARIANT = process.env.ICON_VARIANT || 'ink'

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

// Flat palettes: { plate, ink (stroke), dot (tittle) }
const PALETTES = {
  ink:    { plate: hex('#0E1116'), ink: hex('#F5F5F4'), dot: hex('#F5F5F4') }, // mono, near-black (default)
  accent: { plate: hex('#0E1116'), ink: hex('#F5F5F4'), dot: hex('#818CF8') }, // mono + one restrained accent
  paper:  { plate: hex('#F4F4F5'), ink: hex('#111317'), dot: hex('#111317') }, // light, inverts cleanly
  slate:  { plate: hex('#1B2230'), ink: hex('#E8EDF4'), dot: hex('#E8EDF4') }, // cool desaturated blue-grey
}

const S = 1024, SS = 4, C = S / 2
const PLATE_A = 440, PLATE_N = 4.3 // superellipse half-extent + exponent (~Apple squircle)

// ── the orbit mark ────────────────────────────────────────────────────────────
const STROKE = 42               // ring stroke half-width
const RING_R = 168              // ring radius
const OPEN_A = 15, OPEN_B = 295 // KEPT arc range (deg) → opening spans 295°→375°(=15°), upper-right
const DOT_R = 48                // the nested dot
const rad = (d) => d * Math.PI / 180
// dot nests on the ring circle, centred in the opening
const DOT_ANG = -25
const DOT_C = [C + RING_R * Math.cos(rad(DOT_ANG)), C + RING_R * Math.sin(rad(DOT_ANG))]
const CAP_A = [C + RING_R * Math.cos(rad(OPEN_A)), C + RING_R * Math.sin(rad(OPEN_A))]
const CAP_B = [C + RING_R * Math.cos(rad(OPEN_B)), C + RING_R * Math.sin(rad(OPEN_B))]

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r

const insideSuperellipse = (x, y) =>
  Math.pow(Math.abs(x - C) / PLATE_A, PLATE_N) + Math.pow(Math.abs(y - C) / PLATE_A, PLATE_N) <= 1

function inStroke(x, y) {
  // open ring: arc kept within [OPEN_A, OPEN_B], rounded caps at both ends
  if (Math.abs(Math.hypot(x - C, y - C) - RING_R) <= STROKE) {
    let a = Math.atan2(y - C, x - C) * 180 / Math.PI
    while (a < OPEN_A) a += 360
    if (a <= OPEN_B) return true
  }
  if (sdCircle(x, y, CAP_A[0], CAP_A[1], STROKE) <= 0) return true
  if (sdCircle(x, y, CAP_B[0], CAP_B[1], STROKE) <= 0) return true
  return false
}
const inDot = (x, y) => sdCircle(x, y, DOT_C[0], DOT_C[1], DOT_R) <= 0

function colorAt(x, y, pal) {
  if (inDot(x, y)) return pal.dot
  if (inStroke(x, y)) return pal.ink
  return pal.plate
}

// ── render (transparent outside the plate) ────────────────────────────────────
function render(width, pal) {
  const raw = Buffer.alloc(width * (1 + width * 4))
  const scale = S / width, step = 1 / SS, inv = 1 / (SS * SS)
  for (let py = 0; py < width; py++) {
    const rs = py * (1 + width * 4); raw[rs] = 0
    for (let px = 0; px < width; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) * step) * scale, y = (py + (sy + 0.5) * step) * scale
        if (!insideSuperellipse(x, y)) continue
        a += 255; const c = colorAt(x, y, pal); r += c[0]; g += c[1]; b += c[2]
      }
      const cov = a / 255, o = rs + 1 + px * 4
      if (cov > 0) { raw[o] = Math.round(r / cov); raw[o + 1] = Math.round(g / cov); raw[o + 2] = Math.round(b / cov) }
      raw[o + 3] = Math.round(a * inv)
    }
  }
  return encodePNG(width, raw)
}

// ── minimal PNG encoder ───────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
})()
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td), 0)
  return Buffer.concat([len, td, crc])
}
function encodePNG(width, raw) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(width, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── outputs ───────────────────────────────────────────────────────────────────
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, render(S, PALETTES[VARIANT] || PALETTES.ink))
console.log(`wrote ${OUT} (${S}×${S}, variant=${VARIANT})`)
if (PREVIEW_DIR) {
  mkdirSync(PREVIEW_DIR, { recursive: true })
  for (const [name, pal] of Object.entries(PALETTES)) {
    writeFileSync(join(PREVIEW_DIR, `icon-${name}.png`), render(512, pal))
    console.log(`preview icon-${name}.png`)
  }
}
