import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'

import {
  Alert,
  Button,
  Field,
  FileDropZone,
  Input,
  Select,
  ToolPageLayout,
  ToolPanel,
} from '@mydevtools/ui-kit'

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

const settingsGridStyle = {
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
} satisfies CSSProperties

const infoRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  padding: '12px 14px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '14px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const infoLabelStyle = {
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
} satisfies CSSProperties

const infoValueStyle = {
  color: 'var(--mdt-color-text)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.88rem',
} satisfies CSSProperties

const previewGridStyle = {
  display: 'grid',
  gap: '14px',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
} satisfies CSSProperties

const previewCardStyle = {
  display: 'grid',
  gap: '12px',
  padding: '16px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '18px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const imageStageStyle = {
  minHeight: '220px',
  borderRadius: '16px',
  border: '1px dashed var(--mdt-color-border-strong)',
  background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01))',
  display: 'grid',
  placeItems: 'center',
  overflow: 'hidden',
} satisfies CSSProperties

const sampleImageStyle = {
  width: '78%',
  aspectRatio: '16 / 10',
  borderRadius: '16px',
  background: 'linear-gradient(135deg, rgba(102, 179, 255, 0.85), rgba(168, 85, 247, 0.75), rgba(52, 211, 153, 0.8))',
  boxShadow: '0 18px 36px rgba(0, 0, 0, 0.18)',
  position: 'relative',
} satisfies CSSProperties

const resizedImageStyle = {
  ...sampleImageStyle,
  width: '62%',
}

const statGridStyle = {
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
  title: 'Patterns/Image Resizer',
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
            <Button variant="outline">Reset</Button>
            <Button>Resize image</Button>
          </>
        }
        aside={
          <ToolPanel
            actions={<Button leadingIcon={<DownloadIcon />} variant="success">Download</Button>}
            description="The output side should show visual confirmation, resulting dimensions, and a direct download path without forcing the user back into the settings column."
            title="Preview and result"
            tone="output"
          >
            <div style={previewGridStyle}>
              <div style={previewCardStyle}>
                <span style={{ color: 'var(--mdt-color-text)', fontWeight: 700 }}>Original</span>
                <div style={imageStageStyle}>
                  <div style={sampleImageStyle} />
                </div>
                <div style={infoRowStyle}>
                  <span style={infoLabelStyle}>Source</span>
                  <span style={infoValueStyle}>2400x1500 JPG</span>
                </div>
              </div>

              <div style={previewCardStyle}>
                <span style={{ color: 'var(--mdt-color-text)', fontWeight: 700 }}>Resized</span>
                <div style={imageStageStyle}>
                  <div style={resizedImageStyle} />
                </div>
                <div style={infoRowStyle}>
                  <span style={infoLabelStyle}>Output</span>
                  <span style={infoValueStyle}>1280x800 WEBP</span>
                </div>
              </div>
            </div>

            <Alert description="Media tools need a visible before/after relationship so users can trust size and dimension changes at a glance." title="Resize completed" variant="success" />

            <div style={statGridStyle}>
              <div style={statCardStyle}>
                <span style={statLabelStyle}>Saved</span>
                <span style={statValueStyle}>1.4 MB</span>
              </div>
              <div style={statCardStyle}>
                <span style={statLabelStyle}>Format</span>
                <span style={statValueStyle}>WEBP</span>
              </div>
              <div style={statCardStyle}>
                <span style={statLabelStyle}>Scale</span>
                <span style={statValueStyle}>53%</span>
              </div>
            </div>
          </ToolPanel>
        }
        eyebrow="Pilot tool pattern"
        description="Migration-oriented reference for image tools where file intake, resize strategy, and visual output comparison matter more than text manipulation."
        hero={<Alert description="This pilot covers the media workflow where the file is primary, settings are numeric, and the result must be visually validated." title="Image Resizer pilot" />}
        title="Image Resizer"
      >
        <div className="mdt-showcase-grid">
          <ToolPanel description="The left side behaves like an intake and control rail for one-off local image transformations." title="Input and resize settings" tone="input">
            <FileDropZone
              accept="image/*"
              hint="Supports JPG, PNG, and WEBP. Local processing only."
              title="Drop an image to resize"
            />

            <div style={infoRowStyle}>
              <span style={infoLabelStyle}>Original image</span>
              <span style={infoValueStyle}>hero-banner.jpg · 2400x1500</span>
            </div>

            <div style={settingsGridStyle}>
              <Field label="Width">
                <Input defaultValue="1280" inputMode="numeric" />
              </Field>
              <Field label="Height">
                <Input defaultValue="800" inputMode="numeric" />
              </Field>
            </div>

            <Field hint="Locking ratio should be the safe default for quick resize flows." label="Aspect ratio">
              <Select defaultValue="locked">
                <option value="locked">Locked</option>
                <option value="unlocked">Unlocked</option>
              </Select>
            </Field>

            <Field label="Target format">
              <Select defaultValue="webp">
                <option value="jpeg">JPEG</option>
                <option value="png">PNG</option>
                <option value="webp">WEBP</option>
              </Select>
            </Field>
          </ToolPanel>
        </div>
      </ToolPageLayout>
    </div>
  ),
}
