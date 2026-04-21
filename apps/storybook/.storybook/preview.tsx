import type { Preview } from '@storybook/react-vite'

import './preview.css'
import '../../../packages/ui-kit/src/styles.css'

const preview: Preview = {
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'Global UI theme',
      defaultValue: 'dark',
      toolbar: {
        icon: 'mirror',
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
        ],
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme ?? 'dark'

      return (
        <div
          data-theme={theme}
          style={{
            display: 'inline-block',
            padding: '32px',
            background: 'var(--mdt-color-bg)',
            borderRadius: '24px',
          }}
        >
          <Story />
        </div>
      )
    },
  ],
  parameters: {
    layout: 'centered',
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      disable: true,
    },
    a11y: {
      test: 'todo',
    },
  },
}

export default preview
