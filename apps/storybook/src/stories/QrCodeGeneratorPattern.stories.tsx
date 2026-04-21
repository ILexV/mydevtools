import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'

import {
  Alert,
  Button,
  Field,
  FileDropZone,
  Input,
  Select,
  Textarea,
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

const colorGridStyle = {
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
} satisfies CSSProperties

const colorInputShellStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
} satisfies CSSProperties

const swatchStyle = {
  width: '40px',
  height: '40px',
  borderRadius: '12px',
  border: '1px solid var(--mdt-color-border)',
  flex: '0 0 auto',
} satisfies CSSProperties

const styleChipRowStyle = {
  display: 'grid',
  gap: '10px',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
} satisfies CSSProperties

const chipStyle = {
  minHeight: '38px',
  borderRadius: '999px',
  border: '1px solid var(--mdt-color-border)',
  background: 'rgba(255, 255, 255, 0.02)',
  color: 'var(--mdt-color-text)',
  fontSize: '0.86rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 12px',
} satisfies CSSProperties

const activeChipStyle = {
  ...chipStyle,
  borderColor: 'rgba(102, 179, 255, 0.35)',
  background: 'rgba(102, 179, 255, 0.14)',
  color: 'var(--mdt-color-primary)',
} satisfies CSSProperties

const previewShellStyle = {
  display: 'grid',
  gap: '16px',
} satisfies CSSProperties

const previewBoxStyle = {
  display: 'grid',
  placeItems: 'center',
  minHeight: '360px',
  padding: '24px',
  border: '2px dashed var(--mdt-color-border-strong)',
  borderRadius: '24px',
  background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01))',
} satisfies CSSProperties

const qrCanvasStyle = {
  width: '280px',
  height: '280px',
  borderRadius: '20px',
  background: '#ffffff',
  padding: '18px',
  boxShadow: '0 18px 40px rgba(0, 0, 0, 0.22)',
  position: 'relative',
  display: 'grid',
  placeItems: 'center',
} satisfies CSSProperties

const qrPatternStyle = {
  position: 'absolute',
  inset: '18px',
  borderRadius: '14px',
  backgroundImage: 'radial-gradient(#111827 1.8px, transparent 1.8px)',
  backgroundSize: '14px 14px',
  backgroundPosition: '0 0',
} satisfies CSSProperties

const qrLogoStyle = {
  position: 'relative',
  width: '64px',
  height: '64px',
  borderRadius: '18px',
  background: 'linear-gradient(135deg, #66b3ff, #a855f7)',
  boxShadow: '0 0 0 8px #ffffff',
  zIndex: 1,
} satisfies CSSProperties

const metricGridStyle = {
  display: 'grid',
  gap: '10px',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
} satisfies CSSProperties

const metricCardStyle = {
  display: 'grid',
  gap: '6px',
  padding: '12px 14px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '14px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const metricLabelStyle = {
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
} satisfies CSSProperties

const metricValueStyle = {
  color: 'var(--mdt-color-text)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.88rem',
} satisfies CSSProperties

const meta = {
  title: 'Patterns/QR Code Generator',
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
            <Button leadingIcon={<DownloadIcon />} variant="outline">PNG</Button>
            <Button leadingIcon={<DownloadIcon />} variant="outline">SVG</Button>
            <Button>Generate QR</Button>
          </>
        }
        aside={
          <ToolPanel description="The preview panel stays sticky and export-oriented, while the left side remains a compact control workstation." title="Preview and export" tone="output">
            <div style={previewShellStyle}>
              <div style={previewBoxStyle}>
                <div style={qrCanvasStyle}>
                  <div style={qrPatternStyle} />
                  <div style={qrLogoStyle} />
                </div>
              </div>

              <Alert description="Export actions should stay adjacent to the rendered code instead of being buried under the settings form." title="Preview ready" variant="success" />

              <div style={metricGridStyle}>
                <div style={metricCardStyle}>
                  <span style={metricLabelStyle}>Size</span>
                  <span style={metricValueStyle}>512x512</span>
                </div>
                <div style={metricCardStyle}>
                  <span style={metricLabelStyle}>Error correction</span>
                  <span style={metricValueStyle}>M</span>
                </div>
                <div style={metricCardStyle}>
                  <span style={metricLabelStyle}>Style</span>
                  <span style={metricValueStyle}>Dots</span>
                </div>
              </div>
            </div>
          </ToolPanel>
        }
        eyebrow="Pilot tool pattern"
        description="Migration-oriented reference for preview-heavy visual generators with compact settings, branded output, and immediate export actions."
        hero={<Alert description="This pilot represents tools where the preview is the product, not just a secondary result field." title="QR Code Generator pilot" />}
        title="QR Code Generator"
      >
        <div className="mdt-showcase-grid">
          <ToolPanel description="The content field stays primary, while visual options remain structured into compact blocks instead of one long settings form." title="Content and appearance" tone="input">
            <Field description="URLs, app links, Wi-Fi payloads, or short text should all fit the same primary entry point." label="Encoded content">
              <Textarea defaultValue="https://mydevtools.app/tools/qr-code-generator?ref=storybook-pilot" rows={5} />
            </Field>

            <div style={colorGridStyle}>
              <Field label="Foreground color">
                <div style={colorInputShellStyle}>
                  <span style={{ ...swatchStyle, background: '#111827' }} />
                  <Input defaultValue="#111827" />
                </div>
              </Field>
              <Field label="Background color">
                <div style={colorInputShellStyle}>
                  <span style={{ ...swatchStyle, background: '#ffffff' }} />
                  <Input defaultValue="#FFFFFF" />
                </div>
              </Field>
            </div>

            <Field label="Visual style">
              <div style={styleChipRowStyle}>
                <span style={chipStyle}>Square</span>
                <span style={activeChipStyle}>Dots</span>
                <span style={chipStyle}>Rounded</span>
              </div>
            </Field>

            <div style={colorGridStyle}>
              <Field label="Error correction">
                <Select defaultValue="M">
                  <option value="L">L - 7%</option>
                  <option value="M">M - 15%</option>
                  <option value="Q">Q - 25%</option>
                  <option value="H">H - 30%</option>
                </Select>
              </Field>
              <Field label="Output size">
                <Select defaultValue="512">
                  <option value="256">256 x 256</option>
                  <option value="512">512 x 512</option>
                  <option value="1024">1024 x 1024</option>
                </Select>
              </Field>
            </div>

            <FileDropZone
              accept="image/png,image/jpeg,image/webp"
              hint="Optional logo overlay for brand-heavy QR flows."
              title="Drop a logo image"
            />
          </ToolPanel>
        </div>
      </ToolPageLayout>
    </div>
  ),
}
