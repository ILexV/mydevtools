import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button, Field, Input, PanelCard, Select } from '@mydevtools/ui-kit'

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
        description="Reusable shell for dense tool configuration with room for controls, helper text, and compact actions."
        eyebrow="Formatting profile"
        footer="Changes apply locally and never leave the browser session."
        title="Conversion settings"
      >
        <div className="mdt-showcase-grid">
          <Field hint="Used for exported presets." label="Preset name">
            <Input defaultValue="API response cleanup" />
          </Field>
          <Field hint="Affects output density." label="Indentation">
            <Select defaultValue="2">
              <option value="2">2 spaces</option>
              <option value="4">4 spaces</option>
              <option value="tab">Tabs</option>
            </Select>
          </Field>
        </div>
      </PanelCard>
    </div>
  ),
}
