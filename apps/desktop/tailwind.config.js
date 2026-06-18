// Theme comes from the shared @jode/shell preset so the rail/chrome match the
// web app exactly. We only declare `content` — and it MUST include the shell's
// source, or its classes get purged.
const shell = require('@jode/shell/tailwind.preset.cjs')

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [shell],
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{ts,tsx}',
    '../../packages/shell/src/**/*.{ts,tsx}'
  ]
}
