import type { Meta, StoryObj } from '@storybook/react-vite'

import { Alert, Button, ToolPageLayout, ToolPanel } from '@mydevtools/ui-kit'

const meta = {
  title: 'Layout/ToolPageLayout',
  component: ToolPageLayout,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof ToolPageLayout>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div style={{ padding: '32px' }}>
      <ToolPageLayout
        actions={
          <>
            <Button variant="outline">Clear</Button>
            <Button>Generate</Button>
          </>
        }
        aside={
          <ToolPanel title="Quick tips" tone="settings">
            Use compact settings in the sidebar for dense tool workflows.
          </ToolPanel>
        }
        description="Shared page shell for future React-based tools with a clear header, action row, and content grid."
        hero={<Alert description="No data leaves the browser during processing." icon={<span aria-hidden="true">i</span>} title="Privacy-first by default" />}
        title="JSON Formatter"
      >
        <div className="mdt-showcase-grid">
          <ToolPanel title="Source input" tone="input">Paste unformatted JSON.</ToolPanel>
          <ToolPanel title="Formatted output" tone="output">Formatted content appears here.</ToolPanel>
        </div>
      </ToolPageLayout>
    </div>
  ),
}
