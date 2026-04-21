import type { Meta, StoryObj } from '@storybook/react-vite'

import { Card } from '@mydevtools/ui-kit'

const meta = {
  title: 'Foundation/Card',
  component: Card,
  args: {
    children: 'Panel content',
  },
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Base surface component for tool panels, result blocks, and future catalog items.',
      },
    },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Card>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: (args) => <Card {...args}>Default surface</Card>,
}

export const Variants: Story = {
  render: () => (
    <div className="mdt-showcase-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(260px, 1fr))' }}>
      <Card variant="default">Default card</Card>
      <Card variant="muted">Muted card</Card>
      <Card variant="raised">Raised card</Card>
      <Card variant="interactive">Interactive card</Card>
    </div>
  ),
}

export const PaddingScale: Story = {
  render: () => (
    <div className="mdt-showcase-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(260px, 1fr))' }}>
      <Card padding="sm">Compact padding</Card>
      <Card padding="md">Balanced padding</Card>
      <Card padding="lg">Relaxed padding</Card>
      <Card padding="none">
        <div style={{ padding: '20px' }}>No internal padding by default</div>
      </Card>
    </div>
  ),
}
