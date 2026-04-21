import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button, PanelCard } from '@mydevtools/ui-kit'

const meta = {
  title: 'Composed/PanelCard',
  component: PanelCard,
  tags: ['autodocs'],
} satisfies Meta<typeof PanelCard>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div style={{ width: '640px' }}>
      <PanelCard
        actions={<Button size="sm" variant="outline">Reset</Button>}
        description="Reusable shell for tool sections with consistent spacing and action placement."
        footer="Footer area can host helper text, secondary actions, or status details."
        title="Conversion settings"
      >
        <div className="mdt-showcase-grid">
          <div>Format options</div>
          <div>Compression level</div>
          <div>Whitespace behavior</div>
        </div>
      </PanelCard>
    </div>
  ),
}
