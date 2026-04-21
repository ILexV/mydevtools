import type { Meta, StoryObj } from '@storybook/react-vite'

import { IconButton } from '@mydevtools/ui-kit'

function CopyIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <rect height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" width="7.5" x="5.25" y="3.25" />
      <path d="M3.75 9.75H3.25C2.69772 9.75 2.25 9.30228 2.25 8.75V3.25C2.25 2.69772 2.69772 2.25 3.25 2.25H8.75C9.30228 2.25 9.75 2.69772 9.75 3.25V3.75" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

const meta = {
  title: 'Foundation/IconButton',
  component: IconButton,
  args: {
    ariaLabel: 'Copy output',
    icon: <CopyIcon />,
  },
  tags: ['autodocs'],
} satisfies Meta<typeof IconButton>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Variants: Story = {
  render: () => (
    <div className="mdt-showcase-stack">
      <IconButton ariaLabel="Ghost" icon={<CopyIcon />} variant="ghost" />
      <IconButton ariaLabel="Outline" icon={<CopyIcon />} variant="outline" />
      <IconButton ariaLabel="Solid" icon={<CopyIcon />} variant="solid" />
      <IconButton ariaLabel="Danger" icon={<CopyIcon />} variant="danger" />
      <IconButton ariaLabel="Selected" icon={<CopyIcon />} selected variant="outline" />
    </div>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="mdt-showcase-stack">
      <IconButton ariaLabel="Small" icon={<CopyIcon />} size="sm" variant="solid" />
      <IconButton ariaLabel="Medium" icon={<CopyIcon />} size="md" variant="solid" />
      <IconButton ariaLabel="Large" icon={<CopyIcon />} size="lg" variant="solid" />
    </div>
  ),
}
