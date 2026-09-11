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
        sans: ['var(--font-space-grotesk)', '-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Segoe UI', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
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
        bg: 'var(--bg)', surface: 'var(--surface)', panel: 'var(--panel)', 'panel-2': 'var(--panel-2)', sidebar: 'var(--sidebar-bg)', border: 'var(--border)', grid: 'var(--grid)',
        text: 'var(--text)', '2': 'var(--text-2)', '3': 'var(--text-3)', accent: { DEFAULT: 'var(--accent)', soft: 'var(--accent-soft)', foreground: 'var(--on-accent)' }, coral: 'var(--coral)', record: 'var(--record)', success: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)',
        background: 'var(--bg)', foreground: 'var(--text)', input: 'var(--border)', ring: 'var(--accent)',
        primary: { DEFAULT: 'var(--accent)', foreground: 'var(--on-accent)' },
        secondary: { DEFAULT: 'var(--surface)', foreground: 'var(--text)' }, tertiary: 'var(--text-2)',
        card: { DEFAULT: 'var(--surface)', foreground: 'var(--text)' }, popover: { DEFAULT: 'var(--surface)', foreground: 'var(--text)' }, muted: { DEFAULT: 'var(--panel-2)', foreground: 'var(--text-2)' }, destructive: { DEFAULT: 'var(--danger)', foreground: '#fff' },
      },
      borderRadius: { control: '10px', card: '16px', popover: '14px', sheet: '18px', lg: '16px', md: '12px', sm: '10px' },
      boxShadow: { popover: 'var(--shadow-horizon)', horizon: 'var(--shadow-horizon)' },
      transitionDuration: { 150: '150ms', 250: '250ms' },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: { 'accordion-down': 'accordion-down 0.2s ease-out', 'accordion-up': 'accordion-up 0.2s ease-out' },
    },
  },
  plugins: [require('tailwindcss-animate'), require('@tailwindcss/typography')],
};
