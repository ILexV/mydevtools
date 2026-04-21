import type { Meta, StoryObj } from '@storybook/react-vite'

import { Field, Input, Select, Textarea } from '@mydevtools/ui-kit'

const meta = {
  title: 'Composed/Field',
  component: Field,
  tags: ['autodocs'],
} satisfies Meta<typeof Field>

export default meta

type Story = StoryObj<typeof meta>

export const InputField: Story = {
  render: () => (
    <div style={{ width: '420px' }}>
      <Field description="Shown above the control for setup context." hint="Supports letters, numbers, and dashes." label="Project slug" required>
        <Input placeholder="mydevtools-ui-kit" />
      </Field>
    </div>
  ),
}

export const ErrorState: Story = {
  render: () => (
    <div className="mdt-showcase-grid" style={{ width: '520px' }}>
      <Field error="Only lowercase characters are allowed." label="Slug">
        <Input defaultValue="Invalid Slug" invalid />
      </Field>
      <Field hint="Choose one environment." label="Environment">
        <Select defaultValue="preview">
          <option value="preview">Preview</option>
          <option value="production">Production</option>
        </Select>
      </Field>
      <Field description="Long-form tool input." label="Payload">
        <Textarea placeholder="Paste source content..." />
      </Field>
    </div>
  ),
}
