import type { Meta, StoryObj } from '@storybook/react-vite'

import { Textarea } from '@mydevtools/ui-kit'

const meta = {
  title: 'Foundation/Textarea',
  component: Textarea,
  args: {
    placeholder: 'Paste JSON, markdown, or source text...',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Textarea>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithVisual: Story = {
  render: () => <Textarea leadingVisual={<span aria-hidden="true">{`{}`}</span>} placeholder="Structured input" />,
}

export const Invalid: Story = {
  args: {
    invalid: true,
    defaultValue: '{ invalid: true, }',
  },
}
