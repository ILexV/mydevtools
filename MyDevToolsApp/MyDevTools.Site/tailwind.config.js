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
    require('daisyui'),
  ],
  daisyui: {
    themes: true, // Enable ALL DaisyUI themes (v4 syntax)
  },
}
