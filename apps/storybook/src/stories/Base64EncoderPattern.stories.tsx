import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'

import {
  Alert,
  Button,
  Field,
  FileDropZone,
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

function DownloadIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2.75V9.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M5.5 7.25L8 9.75L10.5 7.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
      <path d="M3.5 11.25C3.5 11.9404 4.05964 12.5 4.75 12.5H11.25C11.9404 12.5 12.5 11.9404 12.5 11.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

function SwapIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 3.5V12.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M3.25 5.25L5 3.5L6.75 5.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
      <path d="M11 12.5V3.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M9.25 10.75L11 12.5L12.75 10.75" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
    </svg>
  )
}

const pageFrameStyle = {
  padding: '32px',
} satisfies CSSProperties

const optionGridStyle = {
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
} satisfies CSSProperties

const actionGridStyle = {
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
} satisfies CSSProperties

const helperRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
} satisfies CSSProperties

const helperTextStyle = {
  color: 'var(--mdt-color-text-muted)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.8rem',
} satisfies CSSProperties

const previewShellStyle = {
  display: 'grid',
  gap: '16px',
} satisfies CSSProperties

const previewCardStyle = {
  display: 'grid',
  gap: '12px',
  padding: '16px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '18px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const previewBoxStyle = {
  minHeight: '180px',
  borderRadius: '16px',
  border: '1px solid rgba(102, 179, 255, 0.22)',
  background: 'linear-gradient(135deg, rgba(102, 179, 255, 0.16), rgba(168, 85, 247, 0.12))',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--mdt-color-text)',
  fontWeight: 700,
} satisfies CSSProperties

const statsGridStyle = {
  display: 'grid',
  gap: '10px',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
} satisfies CSSProperties

const statCardStyle = {
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
  title: 'Patterns/Base64 Encoder',
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
            <Button leadingIcon={<SwapIcon />} variant="outline">Swap panels</Button>
            <Button variant="secondary">Decode</Button>
            <Button>Encode</Button>
          </>
        }
        aside={
          <ToolPanel description="Encoding tools need a compact block for alphabets, padding, wrapping, and preview mode without bloating the main input area." title="Advanced settings" tone="settings">
            <div style={optionGridStyle}>
              <Field label="Charset">
                <Select defaultValue="utf-8">
                  <option value="utf-8">UTF-8</option>
                  <option value="utf-16le">UTF-16LE</option>
                  <option value="ascii">ASCII</option>
                </Select>
              </Field>
              <Field label="Alphabet">
                <Select defaultValue="standard">
                  <option value="standard">Standard</option>
                  <option value="urlsafe">URL-safe</option>
                </Select>
              </Field>
              <Field label="Padding">
                <Select defaultValue="required">
                  <option value="required">Required</option>
                  <option value="optional">Optional</option>
                  <option value="none">None</option>
                </Select>
              </Field>
              <Field label="Line wrap">
                <Select defaultValue="none">
                  <option value="none">None</option>
                  <option value="76">76 chars</option>
                </Select>
              </Field>
            </div>

            <Field hint="Choose whether decoded binary should show a preview or expose the full payload." label="Output mode">
              <Select defaultValue="preview">
                <option value="preview">Preview</option>
                <option value="full">Full output</option>
              </Select>
            </Field>

            <Alert description="Whitespace tolerance and binary preview behavior belong to the settings rail, not inside the primary text editor." title="Decode behavior" variant="info" />
          </ToolPanel>
        }
        eyebrow="Pilot tool pattern"
        description="Migration-oriented reference for dual-mode tools that accept either text or files, then branch into encode, decode, preview, copy, and download flows." 
        hero={<Alert description="This pilot focuses on the symmetry between input/output and the mixed text-file workflow unique to encoding tools." title="Base64 Encoder pilot" variant="success" />}
        title="Base64 Encoder"
      >
        <div className="mdt-showcase-grid">
          <ToolPanel description="The left side combines text input and file intake without forcing users into one path prematurely." title="Input and actions" tone="input">
            <Field description="Paste text directly for quick encoding, or use Base64 content here before decoding." label="Input text">
              <Textarea defaultValue="MyDevTools UI Kit pilot" rows={9} />
            </Field>

            <div style={helperRowStyle}>
              <span style={helperTextStyle}>chars: 24</span>
              <span style={helperTextStyle}>bytes: 24</span>
            </div>

            <FileDropZone
              accept="*/*"
              hint="Any local file can be converted without leaving the browser."
              title="Or drop a file to encode"
            />

            <div style={actionGridStyle}>
              <Button fullWidth>Encode</Button>
              <Button fullWidth variant="secondary">Decode</Button>
            </div>

            <div className="mdt-showcase-stack" style={{ justifyContent: 'space-between' }}>
              <Button leadingIcon={<SwapIcon />} variant="ghost">Swap input/output</Button>
              <Button variant="ghost">Clear</Button>
            </div>
          </ToolPanel>

          <ToolPanel
            actions={
              <div className="mdt-showcase-stack">
                <IconButton ariaLabel="Copy Base64 output" icon={<CopyIcon />} tooltip="Copy output" variant="outline" />
                <IconButton ariaLabel="Download output" icon={<DownloadIcon />} tooltip="Download output" variant="outline" />
              </div>
            }
            description="The result side must support plain text output, image preview, and download-oriented binary states without changing the overall shell." 
            title="Output and preview"
            tone="output"
          >
            <div style={previewShellStyle}>
              <Field description="The encoded or decoded payload remains accessible as text even when richer previews are available." label="Output text">
                <Textarea
                  defaultValue="TXlEZXZUb29scyBVSSBLaXQgcGlsb3Q="
                  rows={9}
                />
              </Field>

              <div style={previewCardStyle}>
                <div style={helperRowStyle}>
                  <span style={{ color: 'var(--mdt-color-text)', fontWeight: 700 }}>Preview state</span>
                  <span style={helperTextStyle}>image detected</span>
                </div>
                <div style={previewBoxStyle}>decoded-image-preview.png</div>
                <div style={statsGridStyle}>
                  <div style={statCardStyle}>
                    <span style={statLabelStyle}>Encoded</span>
                    <span style={statValueStyle}>32 chars</span>
                  </div>
                  <div style={statCardStyle}>
                    <span style={statLabelStyle}>Decoded</span>
                    <span style={statValueStyle}>24 bytes</span>
                  </div>
                  <div style={statCardStyle}>
                    <span style={statLabelStyle}>Ratio</span>
                    <span style={statValueStyle}>1.33x</span>
                  </div>
                </div>
              </div>
            </div>
          </ToolPanel>
        </div>
      </ToolPageLayout>
    </div>
  ),
}
