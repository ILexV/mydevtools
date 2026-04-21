import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'

import {
  Alert,
  Button,
  Field,
  IconButton,
  Select,
  Textarea,
  ToolPageLayout,
  ToolPanel,
} from '@mydevtools/ui-kit'

function CopyIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <rect height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" width="7.5" x="5.25" y="3.25" />
      <path d="M3.75 9.75H3.25C2.69772 9.75 2.25 9.30228 2.25 8.75V3.25C2.25 2.69772 2.69772 2.25 3.25 2.25H8.75C9.30228 2.25 9.75 2.69772 9.75 3.25V3.75" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 10.75V3.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M5.5 6L8 3.5L10.5 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
      <path d="M3.5 11.25V11.75C3.5 12.1642 3.83579 12.5 4.25 12.5H11.75C12.1642 12.5 12.5 12.1642 12.5 11.75V11.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

function SaveIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 2.75H10.6893C10.8882 2.75 11.079 2.82902 11.2197 2.96967L12.7803 4.53033C12.921 4.67098 13 4.8618 13 5.06066V12C13 12.4142 12.6642 12.75 12.25 12.75H4.75C4.33579 12.75 4 12.4142 4 12V2.75Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 2.75H10V5.5H6V2.75Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 9.25H10.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.75 4.5H12.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M6.25 6.75V10.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M9.75 6.75V10.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M5 4.5L5.34052 11.3087C5.36139 11.7261 5.70593 12.0556 6.12384 12.0556H9.87616C10.2941 12.0556 10.6386 11.7261 10.6595 11.3087L11 4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.5 4.5V3.75C6.5 3.33579 6.83579 3 7.25 3H8.75C9.16421 3 9.5 3.33579 9.5 3.75V4.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

const pageFrameStyle = {
  padding: '32px',
} satisfies CSSProperties

const toolbarStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
} satisfies CSSProperties

const toolbarGroupStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '12px',
} satisfies CSSProperties

const toggleRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '18px',
  alignItems: 'center',
} satisfies CSSProperties

const toggleStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.9rem',
} satisfies CSSProperties

const dotStyle = {
  width: '10px',
  height: '10px',
  borderRadius: '999px',
  background: 'var(--mdt-color-primary)',
  boxShadow: '0 0 0 4px rgba(102, 179, 255, 0.12)',
} satisfies CSSProperties

const editorShellStyle = {
  display: 'grid',
  gap: '16px',
  padding: '18px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '20px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const resultMetaStyle = {
  display: 'grid',
  gap: '8px',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
} satisfies CSSProperties

const resultStatStyle = {
  display: 'grid',
  gap: '6px',
  padding: '12px 14px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '14px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const statLabelStyle = {
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
} satisfies CSSProperties

const statValueStyle = {
  color: 'var(--mdt-color-text)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.88rem',
} satisfies CSSProperties

const meta = {
  title: 'Patterns/Json Beautifier',
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
    <div style={pageFrameStyle}>
      <ToolPageLayout
        actions={
          <>
            <Button leadingIcon={<UploadIcon />} variant="secondary">Open file</Button>
            <Button leadingIcon={<SaveIcon />} variant="outline">Save output</Button>
            <Button>Format JSON</Button>
          </>
        }
        aside={
          <ToolPanel description="Quick options stay close to the editor, but off the primary typing path." title="Formatting settings" tone="settings">
            <Field label="Indentation">
              <Select defaultValue="4">
                <option value="2">2 spaces</option>
                <option value="4">4 spaces</option>
                <option value="tab">Tabs</option>
              </Select>
            </Field>
            <div style={toggleRowStyle}>
              <div style={toggleStyle}>
                <span style={dotStyle} />
                <span>Sort keys</span>
              </div>
              <div style={toggleStyle}>
                <span style={{ ...dotStyle, background: 'var(--mdt-color-secondary)', boxShadow: '0 0 0 4px rgba(168, 85, 247, 0.12)' }} />
                <span>Compact mode</span>
              </div>
            </div>
            <Alert description="Invalid JSON should surface as inline feedback near the editor, not as a detached page-level state." title="Validation model" variant="warning" />
          </ToolPanel>
        }
        eyebrow="Pilot tool pattern"
        description="Migration-oriented reference for editor-first tools with dense toolbar actions, fast formatting options, and a large result surface."
        hero={<Alert description="This pilot focuses on the toolbar and editor workflow, which differs structurally from the hash/file dashboards." title="JSON Beautifier pilot" />}
        title="JSON Beautifier"
      >
        <ToolPanel description="The main panel behaves like a compact workstation: toolbar first, editor second, output clarity always visible." title="Editor workspace" tone="input">
          <div style={editorShellStyle}>
            <div style={toolbarStyle}>
              <div style={toolbarGroupStyle}>
                <Button leadingIcon={<UploadIcon />} size="sm" variant="secondary">Open</Button>
                <Button leadingIcon={<SaveIcon />} size="sm" variant="secondary">Save</Button>
                <Select defaultValue="4" style={{ minWidth: '150px' }}>
                  <option value="2">2 spaces</option>
                  <option value="4">4 spaces</option>
                  <option value="tab">Tabs</option>
                </Select>
              </div>
              <div style={toolbarGroupStyle}>
                <Button size="sm">Format</Button>
                <IconButton ariaLabel="Copy formatted output" icon={<CopyIcon />} tooltip="Copy output" variant="outline" />
                <IconButton ariaLabel="Clear editor" icon={<ClearIcon />} tooltip="Clear editor" variant="danger" />
              </div>
            </div>

            <Field description="Paste raw JSON from an API response, log file, or local export." label="Source JSON">
              <Textarea
                defaultValue={`{"project":"mydevtools","release":{"version":"0.1.0","stable":false},"features":["storybook","ui-kit","migration-pilots"],"metrics":{"tools":128,"languages":10}}`}
                rows={11}
              />
            </Field>

            <Alert description="Last format completed successfully. Keys sorted, indentation set to 4 spaces." title="Ready to copy or save" variant="success" />

            <Field description="The output remains readable, diff-friendly, and clearly separated from the editable source." label="Formatted output">
              <Textarea
                defaultValue={`{
  "features": [
    "storybook",
    "ui-kit",
    "migration-pilots"
  ],
  "metrics": {
    "languages": 10,
    "tools": 128
  },
  "project": "mydevtools",
  "release": {
    "stable": false,
    "version": "0.1.0"
  }
}`}
                rows={14}
              />
            </Field>

            <div style={resultMetaStyle}>
              <div style={resultStatStyle}>
                <span style={statLabelStyle}>Input chars</span>
                <span style={statValueStyle}>186</span>
              </div>
              <div style={resultStatStyle}>
                <span style={statLabelStyle}>Output lines</span>
                <span style={statValueStyle}>15</span>
              </div>
              <div style={resultStatStyle}>
                <span style={statLabelStyle}>Indentation</span>
                <span style={statValueStyle}>4 spaces</span>
              </div>
            </div>
          </div>
        </ToolPanel>
      </ToolPageLayout>
    </div>
  ),
}
