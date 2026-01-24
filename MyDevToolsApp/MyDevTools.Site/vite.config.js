import { defineConfig } from 'vite';

export default defineConfig({
  css: {
    postcss: './postcss.config.js',
  },
  build: {
    // Write output to wwwroot
    outDir: 'wwwroot',
    emptyOutDir: false, // Important: don't wipe wwwroot!
    assetsDir: '.', // Put assets directly in outDir, not assets/
    rollupOptions: {
      input: 'Styles/app.css',
      output: {
        // Force the output filename to be app.css (no hash)
        assetFileNames: (assetInfo) => {
          if (assetInfo.names && assetInfo.names.includes('app.css')) {
            return 'app.css';
          }
          return '[name][extname]';
        }
      }
    }
  }
});
