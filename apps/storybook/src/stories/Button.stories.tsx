import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button } from '@mydevtools/ui-kit'

const meta = {
  title: 'Foundation/Button',
  component: Button,
  args: {
    children: 'Generate output',
  },
  parameters: {
    docs: {
      description: {
        component: 'Primary action component for tool workflows such as generate, convert, validate, download, and copy.',
      },
    },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Button>

export default meta

type Story = StoryObj<typeof meta>

const TerminalGlyph = () => <span aria-hidden="true">&gt;_</span>

export const Primary: Story = {}

export const Variants: Story = {
  render: () => (
    <div className="mdt-showcase-stack">
      <Button variant="primary">Generate</Button>
      <Button variant="secondary">Format</Button>
      <Button variant="outline">Download</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="success">Copied</Button>
      <Button variant="danger">Delete</Button>
    </div>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="mdt-showcase-stack">
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
}

export const WithIcons: Story = {
  render: () => (
    <div className="mdt-showcase-stack">
      <Button leadingIcon={<TerminalGlyph />}>Run formatter</Button>
      <Button trailingIcon={<TerminalGlyph />} variant="outline">
        Open preview
      </Button>
    </div>
  ),
}

export const Loading: Story = {
  args: {
    loading: true,
    children: 'Processing file',
  },
}

export const Disabled: Story = {
  args: {
    disabled: true,
    children: 'Unavailable action',
  },
}
