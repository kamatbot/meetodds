/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'Segoe UI',
          'var(--font-source-sans-3)',
          'sans-serif',
        ],
      },
      fontSize: {
        display: ['22px', { lineHeight: '28px', fontWeight: '600' }],
        title: ['17px', { lineHeight: '22px', fontWeight: '600' }],
        body: ['14px', { lineHeight: '20px', fontWeight: '400' }],
        editor: ['15px', { lineHeight: '24px', fontWeight: '400' }],
        ui: ['13px', { lineHeight: '18px', fontWeight: '400' }],
        caption: ['12px', { lineHeight: '16px', fontWeight: '400' }],
        mono: ['12px', { lineHeight: '16px', fontWeight: '400' }],
      },
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        sidebar: 'var(--sidebar-bg)',
        border: 'var(--border)',
        text: 'var(--text)',
        '2': 'var(--text-2)',
        '3': 'var(--text-3)',
        accent: {
          DEFAULT: 'var(--accent)',
          soft: 'var(--accent-soft)',
          foreground: 'var(--surface)',
        },
        record: 'var(--record)',
        success: 'var(--success)',
        warn: 'var(--warn)',
        danger: 'var(--danger)',

        // Compatibility aliases for existing primitives while redesigned surfaces migrate.
        background: 'var(--bg)',
        foreground: 'var(--text)',
        input: 'var(--border)',
        ring: 'var(--accent)',
        primary: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--surface)',
        },
        secondary: {
          DEFAULT: 'var(--surface)',
          foreground: 'var(--text)',
        },
        tertiary: 'var(--text-2)',
        card: {
          DEFAULT: 'var(--surface)',
          foreground: 'var(--text)',
        },
        popover: {
          DEFAULT: 'var(--surface)',
          foreground: 'var(--text)',
        },
        muted: {
          DEFAULT: 'var(--surface)',
          foreground: 'var(--text-2)',
        },
        destructive: {
          DEFAULT: 'var(--danger)',
          foreground: 'var(--surface)',
        },
      },
      borderRadius: {
        control: '6px',
        card: '10px',
        popover: '12px',
        sheet: '14px',
        lg: '10px',
        md: '8px',
        sm: '6px',
      },
      boxShadow: {
        popover: '0 0 0 0.5px rgb(0 0 0 / 0.08), 0 8px 24px rgb(0 0 0 / 0.12)',
      },
      transitionDuration: {
        150: '150ms',
        250: '250ms',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate'), require('@tailwindcss/typography')],
};
