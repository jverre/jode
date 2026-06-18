// Shared Tailwind theme for the jode shell (shadcn/ui zinc + the extra
// --sidebar token). Consumed as a `preset` by both the desktop renderer and the
// web app so the rail/chrome render identically. Each consumer sets its own
// `content` globs (and MUST include this package's src so classes aren't purged):
//
//   const shell = require('@jode/shell/tailwind.preset.cjs')
//   module.exports = {
//     presets: [shell],
//     content: ['./index.html', './src/**/*.{ts,tsx}',
//               '../../packages/shell/src/**/*.{ts,tsx}'],
//   }
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  // No `content` here on purpose — presets don't merge content globs reliably;
  // each app declares its own (including this package's src).
  content: [],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        sidebar: 'hsl(var(--sidebar))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      }
    }
  },
  plugins: [require('tailwindcss-animate')]
}
