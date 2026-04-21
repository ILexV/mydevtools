import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'

import { FileDropZone } from '@mydevtools/ui-kit'

const meta = {
  title: 'Composed/FileDropZone',
  component: FileDropZone,
  tags: ['autodocs'],
} satisfies Meta<typeof FileDropZone>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => {
    const Demo = () => {
      const [fileName, setFileName] = useState<string | null>(null)

      return (
        <div className="mdt-showcase-grid" style={{ width: '560px' }}>
          <FileDropZone
            accept=".json,.txt"
            hint={fileName ? `Selected: ${fileName}` : 'Accepts .json and .txt files'}
            onFilesSelect={(files) => setFileName(files[0]?.name ?? null)}
            title="Drop source file"
          />
        </div>
      )
    }

    return <Demo />
  },
}
