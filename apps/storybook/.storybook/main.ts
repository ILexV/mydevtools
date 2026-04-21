import type { StorybookConfig } from '@storybook/react-vite';

import path from 'node:path';
import { dirname } from "path"

import { fileURLToPath } from "url"

/**
* This function is used to resolve the absolute path of a package.
* It is needed in projects that use Yarn PnP or are set up within a monorepo.
*/
function getAbsolutePath(value: string) {
  return dirname(fileURLToPath(import.meta.resolve(`${value}/package.json`)))
}

const configDir = dirname(fileURLToPath(import.meta.url))

const config: StorybookConfig = {
  "stories": [
    "../src/**/*.mdx",
    "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"
  ],
  "addons": [
    getAbsolutePath('@storybook/addon-a11y'),
    getAbsolutePath('@storybook/addon-docs')
  ],
  "framework": getAbsolutePath('@storybook/react-vite'),
  async viteFinal(config) {
    config.resolve ??= {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      '@mydevtools/ui-kit': path.resolve(configDir, '../../../packages/ui-kit/src/index.ts'),
      '@mydevtools/ui-kit/styles.css': path.resolve(configDir, '../../../packages/ui-kit/src/styles.css'),
    };

    return config;
  }
};
export default config;
