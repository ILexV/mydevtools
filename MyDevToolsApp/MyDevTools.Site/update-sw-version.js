// update-sw-version.js
// This script automatically updates the service worker cache version with a timestamp
// This ensures cache is invalidated on every build
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const swPath = join(__dirname, 'wwwroot', 'sw.js');

// Read service worker file
let swContent = readFileSync(swPath, 'utf8');

// Generate version based on current timestamp
// Format: v1.0.0-{timestamp} or just v{timestamp}
const timestamp = Date.now();
const newVersion = `v1.0.0-${timestamp}`;

// Replace cache version
swContent = swContent.replace(
    /const CACHE_VERSION = ['"]v[\d.]+-?\d*['"];/,
    `const CACHE_VERSION = '${newVersion}';`
);

// Write updated service worker
writeFileSync(swPath, swContent, 'utf8');

console.log(`✅ Service worker cache version updated to ${newVersion}`);
console.log(`   Build timestamp: ${new Date(timestamp).toISOString()}`);
