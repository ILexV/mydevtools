/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './Components/**/*.{razor,html}',
    './wwwroot/**/*.html',
  ],
  theme: {
    extend: {},
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('daisyui'),
  ],
  daisyui: {
    themes: ["light", "dark"], // ТОЛЬКО light и dark темы для минимального размера бандла
  },
}
