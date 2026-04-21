import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'

import {
  Alert,
  Button,
  Field,
  FileDropZone,
  IconButton,
  Input,
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

const pageFrameStyle = {
  padding: '32px',
} satisfies CSSProperties

const chipWrapStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
} satisfies CSSProperties

const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: '32px',
  padding: '0 12px',
  borderRadius: '999px',
  border: '1px solid var(--mdt-color-border)',
  background: 'rgba(255, 255, 255, 0.03)',
  color: 'var(--mdt-color-text)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.82rem',
} satisfies CSSProperties

const selectedChipStyle = {
  ...chipStyle,
  borderColor: 'rgba(102, 179, 255, 0.3)',
  background: 'rgba(102, 179, 255, 0.12)',
  color: 'var(--mdt-color-primary)',
} satisfies CSSProperties

const hashListStyle = {
  display: 'grid',
  gap: '12px',
} satisfies CSSProperties

const hashRowStyle = {
  display: 'grid',
  gap: '8px',
  padding: '14px 16px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '16px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const hashHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
} satisfies CSSProperties

const hashLabelStyle = {
  color: 'var(--mdt-color-text)',
  fontWeight: 700,
} satisfies CSSProperties

const hashValueStyle = {
  margin: 0,
  color: 'var(--mdt-color-success)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.84rem',
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
} satisfies CSSProperties

const meta = {
  title: 'Patterns/Hash Calculator',
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
            <Button variant="outline">Clear</Button>
            <Button>Calculate hashes</Button>
          </>
        }
        aside={
          <ToolPanel
            actions={<Button size="sm" variant="ghost">Reset</Button>}
            description="The sidebar keeps algorithm selection searchable and compact instead of mixing it into the main editor flow."
            title="Algorithms"
            tone="settings"
          >
            <Field label="Search algorithms">
              <Input placeholder="sha, blake, crc..." type="search" />
            </Field>
            <div className="mdt-showcase-grid">
              <div className="mdt-showcase-grid" style={{ gap: '10px' }}>
                <div style={{ color: 'var(--mdt-color-text-muted)', fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Selected algorithms
                </div>
                <div style={chipWrapStyle}>
                  <span style={selectedChipStyle}>SHA-256</span>
                  <span style={selectedChipStyle}>SHA-512</span>
                  <span style={selectedChipStyle}>BLAKE3</span>
                </div>
              </div>
              <div className="mdt-showcase-grid" style={{ gap: '10px' }}>
                <div style={{ color: 'var(--mdt-color-text-muted)', fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Available algorithms
                </div>
                <div style={chipWrapStyle}>
                  <span style={chipStyle}>MD5</span>
                  <span style={chipStyle}>SHA-1</span>
                  <span style={chipStyle}>CRC32</span>
                  <span style={chipStyle}>xxh64</span>
                  <span style={chipStyle}>RIPEMD-160</span>
                </div>
              </div>
            </div>
          </ToolPanel>
        }
        eyebrow="Pilot tool pattern"
        description="Migration-oriented reference for a real multi-result tool with text input, file input, dense algorithm controls, and structured output rows."
        hero={<Alert description="This is the first concrete tool page built from the new UI kit rather than from a generic pattern only." title="Hash Calculator pilot" variant="success" />}
        title="Hash Calculator"
      >
        <div className="mdt-showcase-grid">
          <ToolPanel description="Text input remains primary, while file input stays available as an equivalent alternative path." title="Source input" tone="input">
            <Field description="Paste the payload to hash or switch to a local file below." label="Input text">
              <Textarea defaultValue="mydevtools-ui-kit-pilot" rows={8} />
            </Field>
            <FileDropZone
              accept="*/*"
              hint="Any local file can be hashed without uploading it anywhere."
              title="Or drop a file to hash"
            />
            <div className="mdt-showcase-stack">
              <Button>Calculate hashes</Button>
              <Button variant="secondary">Hash file</Button>
              <Button variant="ghost">Clear</Button>
            </div>
          </ToolPanel>

          <ToolPanel description="Results are displayed as scan-friendly rows, each with its own copy action." title="Hash results" tone="output">
            <div style={hashListStyle}>
              <div style={hashRowStyle}>
                <div style={hashHeaderStyle}>
                  <span style={hashLabelStyle}>SHA-256</span>
                  <IconButton ariaLabel="Copy SHA-256 hash" icon={<CopyIcon />} tooltip="Copy SHA-256 hash" variant="outline" />
                </div>
                <pre style={hashValueStyle}>79fdfc6d9d1f0a3b59571bb1f5f6b3d4b2bcb54b2f7e8fa42adf7f6af0d905f8</pre>
              </div>

              <div style={hashRowStyle}>
                <div style={hashHeaderStyle}>
                  <span style={hashLabelStyle}>SHA-512</span>
                  <IconButton ariaLabel="Copy SHA-512 hash" icon={<CopyIcon />} tooltip="Copy SHA-512 hash" variant="outline" />
                </div>
                <pre style={hashValueStyle}>52e7e5df5d2a5f8ae38b4ec203f1e7b3e9dfcc3f32926e8f5f09ef8de13f3ab295a2ea57d7d98a9c5d5edb3cbf8f540814f9cbf58c9fd5debe5cf8d77ff0ae14</pre>
              </div>

              <div style={hashRowStyle}>
                <div style={hashHeaderStyle}>
                  <span style={hashLabelStyle}>BLAKE3</span>
                  <IconButton ariaLabel="Copy BLAKE3 hash" icon={<CopyIcon />} tooltip="Copy BLAKE3 hash" variant="outline" />
                </div>
                <pre style={hashValueStyle}>fdc3f1bd39a694d72b1ddfe64f59e67e9dc1d8085142b740d2f3f80ad8f6bb88</pre>
              </div>
            </div>
          </ToolPanel>
        </div>
      </ToolPageLayout>
    </div>
  ),
}
