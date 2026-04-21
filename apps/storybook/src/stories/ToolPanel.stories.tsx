import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button, Field, Input, Select, ToolPanel } from '@mydevtools/ui-kit'

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
      <ToolPanel description="Paste, type, or drop a file." title="Raw input" tone="input">
        <Field label="Payload">
          <Input defaultValue={`{"name":"mydevtools","mode":"dev"}`} />
        </Field>
      </ToolPanel>
      <ToolPanel description="Tight controls for repeatable transforms." title="Options" tone="settings">
        <Field label="Sort keys">
          <Select defaultValue="enabled">
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
      </ToolPanel>
      <ToolPanel actions={<Button size="sm">Copy</Button>} description="Ready for export or clipboard." title="Result" tone="output">
        <pre style={{ margin: 0, color: 'var(--mdt-color-success)', fontFamily: 'var(--mdt-font-mono)', fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>
          {`{
  "name": "mydevtools",
  "mode": "dev"
}`}
        </pre>
      </ToolPanel>
    </div>
  ),
}
