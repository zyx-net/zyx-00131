/** @type {import('tailwindcss').Config} */

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
    },
    extend: {
      colors: {
        deep: {
          950: "#060E1F",
          900: "#0B1F3A",
          800: "#102A4E",
          700: "#183A6B",
        },
        signal: {
          50: "#E6FCFF",
          100: "#B3F2FF",
          200: "#66E5FF",
          300: "#33DCFF",
          400: "#00D4FF",
          500: "#00B8DE",
          600: "#0090AC",
        },
        alert: {
          400: "#FF8A3D",
          500: "#FF6B1A",
        },
        fault: {
          400: "#FF4D6D",
          500: "#E91E63",
        },
        success: {
          400: "#36D399",
          500: "#10B981",
        },
        history: {
          400: "#FBBF24",
          500: "#F59E0B",
        },
      },
      fontFamily: {
        display: ['Orbitron', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        'glow-signal': '0 0 8px rgba(0, 212, 255, 0.25)',
        'card': '0 1px 0 rgba(255, 255, 255, 0.03), 0 2px 16px rgba(0, 0, 0, 0.4)',
      },
      backgroundImage: {
        'grid-dot':
          'radial-gradient(circle, rgba(0, 212, 255, 0.06) 1px, transparent 1px)',
        'deep-gradient':
          'linear-gradient(180deg, rgba(0, 212, 255, 0.04) 0%, rgba(11, 31, 58, 0.0) 100%)',
      },
      animation: {
        'pulse-signal': 'pulse-signal 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        'pulse-signal': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(0, 212, 255, 0.4)' },
          '50%': { boxShadow: '0 0 0 6px rgba(0, 212, 255, 0)' },
        },
      },
      gridTemplateColumns: {
        'stats': 'repeat(auto-fill, minmax(220px, 1fr))',
      },
    },
  },
  plugins: [],
};
