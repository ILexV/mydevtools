# DaisyUI Integration Guide

## Overview

DaisyUI has been integrated into the MyDevTools.app project as a component library built on top of Tailwind CSS v4.

## Installation

DaisyUI is already installed as a dev dependency:

```bash
npm install -D daisyui@latest
```

## Configuration

### 1. Tailwind Configuration (`tailwind.config.js`)

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './Components/**/*.razor',
    './Components/**/*.html',
    './wwwroot/**/*.html',
  ],
  plugins: [
    require('daisyui'),
  ],
  daisyui: {
    themes: ["light", "dark", "cupcake", "bumblebee", "emerald", "corporate", "synthwave", "retro", "cyberpunk", "valentine", "halloween", "garden", "forest", "aqua", "lofi", "pastel", "fantasy", "wireframe", "black", "luxury", "dracula"],
    darkTheme: "dark",
    base: true,
    styled: true,
    utils: true,
    prefix: "",
    logs: true,
  },
}
```

### 2. CSS Import (`Styles/app.css`)

```css
@import "tailwindcss";
@plugin "daisyui";
```

## Usage

### Basic Components

DaisyUI provides ready-to-use components using semantic class names:

#### Buttons
```html
<button class="btn">Button</button>
<button class="btn btn-primary">Primary</button>
<button class="btn btn-secondary">Secondary</button>
<button class="btn btn-accent">Accent</button>
```

#### Cards
```html
<div class="card bg-base-100 shadow-xl">
  <div class="card-body">
    <h2 class="card-title">Card Title</h2>
    <p>Card content goes here</p>
    <div class="card-actions justify-end">
      <button class="btn btn-primary">Action</button>
    </div>
  </div>
</div>
```

#### Forms
```html
<div class="form-control w-full max-w-xs">
  <label class="label">
    <span class="label-text">Email</span>
  </label>
  <input type="text" placeholder="Type here" class="input input-bordered w-full max-w-xs" />
</div>
```

#### Alerts
```html
<div class="alert alert-success">
  <span>Success message</span>
</div>
```

### Theme Switching

DaisyUI uses the `data-theme` attribute to switch themes:

```javascript
// Set theme on an element
document.getElementById('my-container').setAttribute('data-theme', 'dark');

// Available themes:
// light, dark, cupcake, bumblebee, emerald, corporate, synthwave, retro, 
// cyberpunk, valentine, halloween, garden, forest, aqua, lofi, pastel, 
// fantasy, wireframe, black, luxury, dracula
```

### Isolation from Main Site Theme

The DaisyUI demo page (`/daisyui-demo`) uses an isolated container to prevent conflicts with the main site's custom theme system:

```html
<div id="daisyui-demo-container" data-theme="light">
  <!-- DaisyUI components here -->
</div>
```

This approach allows:
- Independent theme switching for DaisyUI components
- No interference with the main site's `data-theme="dark"` attribute
- Easy testing of different DaisyUI themes

## Demo Page

Visit `/en/daisyui-demo` to see a comprehensive demonstration of DaisyUI components including:
- Theme selector (21 themes)
- Button variants
- Form controls
- Cards
- Alerts
- Modals
- Progress indicators
- Badges
- Tabs
- Statistics

## Building CSS

The CSS build process automatically includes DaisyUI:

```bash
# Development
npm run dev

# Production
npm run build
```

The build output is approximately 104 KB (18.96 KB gzipped).

## Resources

- [DaisyUI Documentation](https://daisyui.com/)
- [DaisyUI Components](https://daisyui.com/components/)
- [DaisyUI Themes](https://daisyui.com/docs/themes/)
- [Tailwind CSS v4](https://tailwindcss.com/)

## Notes

- DaisyUI is compatible with Tailwind CSS v4
- All DaisyUI classes are semantic and easy to remember
- Themes can be customized or new themes can be created
- The framework is fully accessible (ARIA compliant)
- Works seamlessly with Blazor SSR
