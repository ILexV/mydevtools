import type { Meta, StoryObj } from '@storybook/react-vite'

import { Select } from '@mydevtools/ui-kit'

const meta = {
  title: 'Foundation/Select',
  component: Select,
  args: {
    defaultValue: 'sha256',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Select>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: (args) => (
    <div style={{ width: '320px' }}>
      <Select {...args}>
        <option value="md5">MD5</option>
        <option value="sha1">SHA-1</option>
        <option value="sha256">SHA-256</option>
        <option value="sha512">SHA-512</option>
      </Select>
    </div>
  ),
}

export const Placeholder: Story = {
  render: () => (
    <div style={{ width: '320px' }}>
      <Select defaultValue="" placeholder="Choose algorithm">
        <option value="hash">Hash</option>
        <option value="encode">Encode</option>
      </Select>
    </div>
  ),
}

export const Invalid: Story = {
  render: () => (
    <div style={{ width: '320px' }}>
      <Select defaultValue="" invalid placeholder="Resolve validation issue">
        <option value="strict">Strict</option>
      </Select>
    </div>
  ),
}
