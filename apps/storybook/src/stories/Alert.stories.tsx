import type { Meta, StoryObj } from '@storybook/react-vite'

import { Alert } from '@mydevtools/ui-kit'

const meta = {
  title: 'Foundation/Alert',
  component: Alert,
  args: {
    icon: <span aria-hidden="true">i</span>,
    title: 'Status update',
    description: 'This area communicates validation, processing, and user feedback states.',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Alert>

export default meta

type Story = StoryObj<typeof meta>

export const Info: Story = {}

export const Variants: Story = {
  render: () => (
    <div className="mdt-showcase-grid" style={{ width: '560px' }}>
      <Alert icon={<span aria-hidden="true">i</span>} title="Info" description="Waiting for user input." variant="info" />
      <Alert icon={<span aria-hidden="true">+</span>} title="Success" description="Output copied to clipboard." variant="success" />
      <Alert icon={<span aria-hidden="true">!</span>} title="Warning" description="Large input may affect processing time." variant="warning" />
      <Alert icon={<span aria-hidden="true">x</span>} title="Danger" description="Unable to parse the provided content." variant="danger" />
    </div>
  ),
}
