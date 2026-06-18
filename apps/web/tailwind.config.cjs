// Theme from the shared @jode/shell preset so the rail/chrome match the desktop
// app exactly. Content MUST include the shell's source or its classes get purged.
const shell = require('@jode/shell/tailwind.preset.cjs')

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [shell],
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/shell/src/**/*.{ts,tsx}']
}
