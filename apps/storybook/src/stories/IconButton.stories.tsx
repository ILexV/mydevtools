import type { Meta, StoryObj } from '@storybook/react-vite'

import { IconButton } from '@mydevtools/ui-kit'

const meta = {
  title: 'Foundation/IconButton',
  component: IconButton,
  args: {
    ariaLabel: 'Copy output',
    icon: <span aria-hidden="true">[]</span>,
  },
  tags: ['autodocs'],
} satisfies Meta<typeof IconButton>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Variants: Story = {
  render: () => (
    <div className="mdt-showcase-stack">
      <IconButton ariaLabel="Ghost" icon={<span>[]</span>} variant="ghost" />
      <IconButton ariaLabel="Outline" icon={<span>[]</span>} variant="outline" />
      <IconButton ariaLabel="Solid" icon={<span>[]</span>} variant="solid" />
      <IconButton ariaLabel="Danger" icon={<span>[]</span>} variant="danger" />
      <IconButton ariaLabel="Selected" icon={<span>[]</span>} selected variant="outline" />
    </div>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="mdt-showcase-stack">
      <IconButton ariaLabel="Small" icon={<span>[]</span>} size="sm" variant="solid" />
      <IconButton ariaLabel="Medium" icon={<span>[]</span>} size="md" variant="solid" />
      <IconButton ariaLabel="Large" icon={<span>[]</span>} size="lg" variant="solid" />
    </div>
  ),
}
