import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'

import {
  Alert,
  Button,
  Field,
  FileDropZone,
  IconButton,
  Input,
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

function DownloadIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2.75V9.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M5.5 7.25L8 9.75L10.5 7.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
      <path d="M3.5 11.25C3.5 11.9404 4.05964 12.5 4.75 12.5H11.25C11.9404 12.5 12.5 11.9404 12.5 11.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

const pageFrameStyle = {
  padding: '32px',
} satisfies CSSProperties

const codeBlockStyle = {
  margin: 0,
  padding: '16px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '16px',
  background: 'rgba(255, 255, 255, 0.02)',
  color: 'var(--mdt-color-text)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.88rem',
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
} satisfies CSSProperties

const metricGridStyle = {
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
} satisfies CSSProperties

const metricCardStyle = {
  padding: '14px 16px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '16px',
  background: 'rgba(255, 255, 255, 0.02)',
  display: 'grid',
  gap: '6px',
} satisfies CSSProperties

const metricLabelStyle = {
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.8rem',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
} satisfies CSSProperties

const metricValueStyle = {
  color: 'var(--mdt-color-text)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.95rem',
} satisfies CSSProperties

const meta = {
  title: 'Patterns/Tool Pages',
  component: ToolPageLayout,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof ToolPageLayout>

export default meta

type Story = StoryObj<typeof meta>

export const TextTransformer: Story = {
  render: () => (
    <div style={pageFrameStyle}>
      <ToolPageLayout
        actions={
          <>
            <IconButton ariaLabel="Copy output" icon={<CopyIcon />} tooltip="Copy output" variant="outline" />
            <Button variant="outline">Clear</Button>
            <Button>Format JSON</Button>
          </>
        }
        aside={
          <div className="mdt-showcase-grid">
            <ToolPanel description="Compact controls that shape output semantics." title="Formatting rules" tone="settings">
              <Field label="Indentation">
                <Select defaultValue="2">
                  <option value="2">2 spaces</option>
                  <option value="4">4 spaces</option>
                  <option value="tab">Tabs</option>
                </Select>
              </Field>
              <Field label="Sort keys">
                <Select defaultValue="enabled">
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </Select>
              </Field>
            </ToolPanel>
            <ToolPanel description="Useful for previewing transformation impact." title="Session stats" tone="output">
              <div style={metricGridStyle}>
                <div style={metricCardStyle}>
                  <span style={metricLabelStyle}>Input size</span>
                  <span style={metricValueStyle}>12.4 KB</span>
                </div>
                <div style={metricCardStyle}>
                  <span style={metricLabelStyle}>Output lines</span>
                  <span style={metricValueStyle}>184</span>
                </div>
              </div>
            </ToolPanel>
          </div>
        }
        eyebrow="Migration pattern"
        description="Reference shell for text-heavy tools such as JSON formatting, Base64 transforms, hashing inputs, and regex workflows."
        hero={<Alert description="This pattern prioritizes dense keyboard workflows and keeps settings secondary to source/result panels." title="Text transformer layout" />}
        title="JSON Formatter"
      >
        <div className="mdt-showcase-grid">
          <ToolPanel description="Primary authoring surface for raw or pasted content." title="Source input" tone="input">
            <Field description="Paste unformatted JSON directly from an API response or local file." label="Payload">
              <Textarea
                defaultValue={`{"project":"mydevtools","features":["storybook","ui-kit"],"darkMode":true,"updatedAt":"2026-04-21T08:15:00Z"}`}
                rows={12}
              />
            </Field>
          </ToolPanel>
          <ToolPanel
            actions={<IconButton ariaLabel="Copy formatted output" icon={<CopyIcon />} tooltip="Copy formatted output" variant="solid" />}
            description="Formatted output remains visually distinct and easy to scan or copy."
            title="Formatted output"
            tone="output"
          >
            <pre style={codeBlockStyle}>{`{
  "project": "mydevtools",
  "features": [
    "storybook",
    "ui-kit"
  ],
  "darkMode": true,
  "updatedAt": "2026-04-21T08:15:00Z"
}`}</pre>
          </ToolPanel>
        </div>
      </ToolPageLayout>
    </div>
  ),
}

export const FileConversionDashboard: Story = {
  render: () => (
    <div style={pageFrameStyle}>
      <ToolPageLayout
        actions={
          <>
            <Button variant="outline">Reset</Button>
            <Button leadingIcon={<DownloadIcon />} variant="success">
              Download ZIP
            </Button>
          </>
        }
        aside={
          <div className="mdt-showcase-grid">
            <ToolPanel description="Settings tend to be narrow and option-heavy for file workflows." title="Conversion options" tone="settings">
              <Field label="Target format">
                <Select defaultValue="webp">
                  <option value="webp">WEBP</option>
                  <option value="png">PNG</option>
                  <option value="jpeg">JPEG</option>
                </Select>
              </Field>
              <Field hint="Applied before export." label="Output width">
                <Input defaultValue="1600" inputMode="numeric" />
              </Field>
            </ToolPanel>
            <ToolPanel description="Result metadata should stay glanceable while processing multiple assets." title="Queue status" tone="output">
              <div style={metricGridStyle}>
                <div style={metricCardStyle}>
                  <span style={metricLabelStyle}>Files</span>
                  <span style={metricValueStyle}>4 selected</span>
                </div>
                <div style={metricCardStyle}>
                  <span style={metricLabelStyle}>Estimated size</span>
                  <span style={metricValueStyle}>8.1 MB</span>
                </div>
              </div>
            </ToolPanel>
          </div>
        }
        eyebrow="Migration pattern"
        description="Reference shell for image, archive, and document tools that combine upload, option tuning, preview, and downloadable output."
        hero={<Alert description="This pattern gives file intake and preview equal visual weight instead of collapsing everything into one oversized form." title="File workflow layout" variant="success" />}
        title="Image Converter"
      >
        <div className="mdt-showcase-grid">
          <ToolPanel description="The upload surface should remain prominent and actionable even before any file is selected." title="Source files" tone="input">
            <FileDropZone
              accept=".png,.jpg,.jpeg,.webp"
              hint="Accepts PNG, JPEG, and WEBP. Up to 10 files in one batch."
              multiple
              title="Drop images to convert"
            />
          </ToolPanel>
          <ToolPanel
            actions={<IconButton ariaLabel="Download preview" icon={<DownloadIcon />} tooltip="Download preview" variant="outline" />}
            description="Result surfaces can mix preview, metadata, and export affordances without looking like a generic card grid."
            title="Output preview"
            tone="output"
          >
            <div style={{ ...codeBlockStyle, display: 'grid', gap: '10px' }}>
              <span>hero-banner.webp</span>
              <span style={{ color: 'var(--mdt-color-text-muted)' }}>1600x900 to 1600x900</span>
              <span style={{ color: 'var(--mdt-color-success)' }}>1.9 MB to 642 KB</span>
            </div>
          </ToolPanel>
        </div>
      </ToolPageLayout>
    </div>
  ),
}
