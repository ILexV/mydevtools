import type { Meta, StoryObj } from '@storybook/react-vite'

import { Alert } from '@mydevtools/ui-kit'

const meta = {
  title: 'Foundation/Alert',
  component: Alert,
  args: {
    title: 'Ready for transformation',
    description: 'Paste content or upload a file to start processing in the browser.',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Alert>

export default meta

type Story = StoryObj<typeof meta>

export const Info: Story = {}

export const Variants: Story = {
  render: () => (
    <div className="mdt-showcase-grid" style={{ width: '560px' }}>
      <Alert title="Idle" description="Waiting for input before formatting begins." variant="info" />
      <Alert title="Copied" description="The generated output is now in the clipboard." variant="success" />
      <Alert title="Large payload" description="Processing may take longer for files above 10 MB." variant="warning" />
      <Alert title="Parse failed" description="The current payload contains invalid JSON near line 24." variant="danger" />
    </div>
  ),
}
