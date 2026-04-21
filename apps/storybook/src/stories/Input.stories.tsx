import type { Meta, StoryObj } from '@storybook/react-vite'

import { Input } from '@mydevtools/ui-kit'

const meta = {
  title: 'Foundation/Input',
  component: Input,
  args: {
    placeholder: 'Enter value',
  },
  parameters: {
    docs: {
      description: {
        component: 'Single-line input for settings, identifiers, filters, and compact value entry in tool workflows.',
      },
    },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Input>

export default meta

type Story = StoryObj<typeof meta>

const TerminalGlyph = () => <span aria-hidden="true">$</span>

export const Default: Story = {}

export const Types: Story = {
  render: () => (
    <div className="mdt-showcase-grid" style={{ width: '420px' }}>
      <Input type="text" placeholder="Project name" />
      <Input type="number" placeholder="Threads" defaultValue="8" />
      <Input type="search" placeholder="Search tools" />
      <Input type="url" placeholder="https://example.dev" />
    </div>
  ),
}

export const WithIcons: Story = {
  render: () => (
    <div className="mdt-showcase-grid" style={{ width: '420px' }}>
      <Input leadingIcon={<TerminalGlyph />} placeholder="CLI argument" />
      <Input trailingIcon={<TerminalGlyph />} placeholder="Target endpoint" />
    </div>
  ),
}

export const Invalid: Story = {
  args: {
    invalid: true,
    defaultValue: 'invalid-json',
  },
}

export const Disabled: Story = {
  args: {
    disabled: true,
    defaultValue: 'Read from uploaded file',
  },
}

export const ReadOnly: Story = {
  args: {
    readOnly: true,
    defaultValue: 'Generated value',
  },
}
