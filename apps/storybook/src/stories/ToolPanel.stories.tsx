import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button, ToolPanel } from '@mydevtools/ui-kit'

const meta = {
  title: 'Composed/ToolPanel',
  component: ToolPanel,
  tags: ['autodocs'],
} satisfies Meta<typeof ToolPanel>

export default meta

type Story = StoryObj<typeof meta>

export const Tones: Story = {
  render: () => (
    <div className="mdt-showcase-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(240px, 1fr))' }}>
      <ToolPanel title="Raw input" tone="input">Paste or upload source data.</ToolPanel>
      <ToolPanel title="Options" tone="settings">Choose formatting and validation settings.</ToolPanel>
      <ToolPanel actions={<Button size="sm">Copy</Button>} title="Result" tone="output">Rendered output appears here.</ToolPanel>
    </div>
  ),
}
