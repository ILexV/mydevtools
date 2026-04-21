import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'

import { Alert, Button, Card, IconButton, Input } from '@mydevtools/ui-kit'

function SearchIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5L13.25 13.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M9.5 2.5C7.98122 3.13763 7 4.62549 7 6.25C7 8.48528 8.79274 10.25 11 10.25C11.5126 10.25 12.0026 10.1541 12.4532 9.97888C11.6961 11.7775 9.91758 13.05 7.84375 13.05C5.08458 13.05 2.85 10.8154 2.85 8.05625C2.85 5.1887 5.24654 2.86547 8.14334 2.97659C8.60348 2.99424 9.05849 3.07885 9.5 2.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.2" />
    </svg>
  )
}

const pageFrameStyle = {
  padding: '32px',
  display: 'grid',
  gap: '24px',
} satisfies CSSProperties

const shellStyle = {
  display: 'grid',
  gap: '18px',
} satisfies CSSProperties

const headerStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '16px 18px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '18px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const brandWrapStyle = {
  display: 'grid',
  gap: '4px',
} satisfies CSSProperties

const eyebrowStyle = {
  color: 'var(--mdt-color-primary)',
  fontSize: '0.78rem',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
} satisfies CSSProperties

const titleStyle = {
  color: 'var(--mdt-color-text)',
  fontSize: '1rem',
  fontWeight: 700,
} satisfies CSSProperties

const mutedStyle = {
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.9rem',
  lineHeight: 1.6,
} satisfies CSSProperties

const actionRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'center',
} satisfies CSSProperties

const searchButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '10px',
  minHeight: '40px',
  minWidth: '220px',
  padding: '0 14px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '12px',
  color: 'var(--mdt-color-text-muted)',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const keycapStyle = {
  marginLeft: 'auto',
  padding: '2px 6px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '8px',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.75rem',
  color: 'var(--mdt-color-text-muted)',
} satisfies CSSProperties

const breadcrumbsStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.85rem',
} satisfies CSSProperties

const toolShellStyle = {
  display: 'grid',
  gap: '18px',
  padding: '20px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '22px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const toolHeaderStyle = {
  display: 'grid',
  gap: '10px',
  justifyItems: 'center',
  textAlign: 'center',
} satisfies CSSProperties

const toolTitleStyle = {
  color: 'var(--mdt-color-text)',
  fontSize: '2rem',
  fontWeight: 800,
} satisfies CSSProperties

const heroTextStyle = {
  maxWidth: '66ch',
  color: 'var(--mdt-color-text-muted)',
  fontSize: '1rem',
  lineHeight: 1.7,
} satisfies CSSProperties

const contentPlaceholderStyle = {
  display: 'grid',
  gap: '12px',
  padding: '18px',
  border: '1px dashed rgba(102, 179, 255, 0.32)',
  borderRadius: '18px',
  background: 'rgba(102, 179, 255, 0.05)',
} satisfies CSSProperties

const seoGridStyle = {
  display: 'grid',
  gap: '16px',
} satisfies CSSProperties

const seoSectionStyle = {
  display: 'grid',
  gap: '10px',
} satisfies CSSProperties

const footerGridStyle = {
  display: 'grid',
  gap: '16px',
  gridTemplateColumns: '1.4fr 1fr 1fr',
} satisfies CSSProperties

const navListStyle = {
  display: 'grid',
  gap: '8px',
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.9rem',
} satisfies CSSProperties

const meta = {
  title: 'Patterns/Infrastructure Shell',
  component: Card,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof Card>

export default meta

type Story = StoryObj<typeof meta>

export const ToolChromeAndSeoShell: Story = {
  render: () => (
    <div style={pageFrameStyle}>
      <div style={shellStyle}>
        <div style={headerStyle}>
          <div style={brandWrapStyle}>
            <span style={eyebrowStyle}>Global chrome</span>
            <span style={titleStyle}>Header, search trigger, theme action, and persistent navigation shell</span>
          </div>

          <div style={actionRowStyle}>
            <button style={searchButtonStyle} type="button">
              <SearchIcon />
              <span>Search tools</span>
              <span style={keycapStyle}>Ctrl K</span>
            </button>
            <IconButton ariaLabel="Toggle theme" icon={<MoonIcon />} tooltip="Toggle theme" variant="ghost" />
            <Button variant="outline">EN</Button>
          </div>
        </div>

        <Card padding="lg" variant="raised">
          <div style={breadcrumbsStyle}>
            <span>Home</span>
            <span>/</span>
            <span>Structured data</span>
            <span>/</span>
            <span style={{ color: 'var(--mdt-color-text)' }}>JSON Beautifier</span>
          </div>

          <div style={toolShellStyle}>
            <div style={toolHeaderStyle}>
              <div style={eyebrowStyle}>Tool page wrapper</div>
              <div style={toolTitleStyle}>JSON Beautifier</div>
              <p style={heroTextStyle}>
                The migration shell around each tool should keep branding, route context, privacy reassurance, and long-form SEO content structurally consistent while the inner tool body remains free to vary.
              </p>
            </div>

            <Alert
              description="This mirrors the current privacy notice responsibility from ToolLayout, but keeps it visually integrated into the React shell instead of treating it as a separate afterthought block."
              title="Privacy-first wrapper"
            />

            <div style={contentPlaceholderStyle}>
              <span style={titleStyle}>Tool body insertion point</span>
              <span style={mutedStyle}>The actual editor, file flow, preview, or dashboard sits here. The infrastructure shell owns breadcrumbs, trust messaging, and lower-page informational content.</span>
            </div>
          </div>
        </Card>

        <Card padding="lg" variant="muted">
          <div style={seoGridStyle}>
            <div style={seoSectionStyle}>
              <div style={eyebrowStyle}>SEO and learning content</div>
              <div style={titleStyle}>Extended explanation blocks should feel like part of the product, not an unrelated blog appendix</div>
              <p style={mutedStyle}>
                The current site appends introduction, examples, and how-to sections below tools. The migration target should preserve that discoverability and SEO value, but in a more deliberate layout with clear reading hierarchy and calmer spacing.
              </p>
            </div>

            <Card padding="md" variant="raised">
              <div style={seoSectionStyle}>
                <div style={titleStyle}>What this tool does</div>
                <p style={mutedStyle}>
                  Describe the exact transformation, validate expectations, and help users decide whether they need formatting, validation, conversion, or generation before touching the input.
                </p>
              </div>
            </Card>

            <Card padding="md" variant="raised">
              <div style={seoSectionStyle}>
                <div style={titleStyle}>How to use it</div>
                <p style={mutedStyle}>
                  Keep the steps short, task-oriented, and close to the tool. This is especially useful for structured-data and security tools where people arrive from search with a single job to finish quickly.
                </p>
              </div>
            </Card>
          </div>
        </Card>

        <Card padding="lg" variant="muted">
          <div style={footerGridStyle}>
            <div style={seoSectionStyle}>
              <div style={eyebrowStyle}>Footer shell</div>
              <div style={titleStyle}>MyDevTools should close pages with trust, navigation, and lightweight product framing</div>
              <p style={mutedStyle}>
                The footer is part of the infrastructure map too: category links, privacy statements, and product identity should stay stable across tool routes and localized paths.
              </p>
            </div>

            <div style={seoSectionStyle}>
              <div style={titleStyle}>Explore</div>
              <div style={navListStyle}>
                <span>Structured data</span>
                <span>Encoding</span>
                <span>Security</span>
                <span>Images</span>
              </div>
            </div>

            <div style={seoSectionStyle}>
              <div style={titleStyle}>Trust</div>
              <div style={navListStyle}>
                <span>Runs locally in your browser</span>
                <span>No upload required for most tools</span>
                <span>Language-aware routes remain stable</span>
                <span>Command search available globally</span>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  ),
}

export const FooterAndRoutePersistence: Story = {
  render: () => (
    <div style={pageFrameStyle}>
      <Card padding="lg" variant="raised">
        <div style={seoGridStyle}>
          <div style={seoSectionStyle}>
            <div style={eyebrowStyle}>Localized route persistence</div>
            <div style={titleStyle}>Header and footer should preserve navigation context across language switches and deep tool routes</div>
          </div>

          <Input defaultValue="/en/tools/json-beautifier" readOnly />
          <Input defaultValue="/de/tools/json-beautifier" readOnly />

          <Alert
            description="This pattern complements the command-search shell: locale switching is not just a dropdown, it is a route-preserving infrastructure rule that keeps search, tool pages, and footer links coherent."
            title="Infrastructure rule"
            variant="success"
          />

          <div style={actionRowStyle}>
            <Button>Switch locale</Button>
            <Button variant="outline">Open home in current locale</Button>
            <Button variant="ghost">Open category anchor</Button>
          </div>
        </div>
      </Card>
    </div>
  ),
}
