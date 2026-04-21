import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'

import { Alert, Button, Card, IconButton, Input } from '@mydevtools/ui-kit'

function SearchIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5L13.75 13.75" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

function StarIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2.2L9.73 5.72L13.62 6.29L10.81 9.03L11.47 12.9L8 11.08L4.53 12.9L5.19 9.03L2.38 6.29L6.27 5.72L8 2.2Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.3" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.75V8.25L10.5 9.75" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
    </svg>
  )
}

const pageFrameStyle = {
  padding: '32px',
  display: 'grid',
  gap: '28px',
} satisfies CSSProperties

const navStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '16px 20px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '22px',
  background: 'rgba(10, 15, 30, 0.72)',
  backdropFilter: 'blur(14px)',
} satisfies CSSProperties

const brandStyle = {
  display: 'grid',
  gap: '4px',
} satisfies CSSProperties

const brandEyebrowStyle = {
  color: 'var(--mdt-color-primary)',
  fontSize: '0.78rem',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
} satisfies CSSProperties

const brandTitleStyle = {
  color: 'var(--mdt-color-text)',
  fontSize: '1rem',
  fontWeight: 700,
} satisfies CSSProperties

const actionRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '12px',
  alignItems: 'center',
} satisfies CSSProperties

const heroGridStyle = {
  display: 'grid',
  gap: '18px',
  gridTemplateColumns: 'minmax(0, 1.4fr) minmax(320px, 0.9fr)',
} satisfies CSSProperties

const heroSurfaceStyle = {
  display: 'grid',
  gap: '22px',
  padding: '30px',
  border: '1px solid rgba(102, 179, 255, 0.18)',
  borderRadius: '28px',
  background: 'radial-gradient(circle at top left, rgba(102, 179, 255, 0.18), transparent 36%), linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.015))',
} satisfies CSSProperties

const heroBadgeRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
} satisfies CSSProperties

const badgeStyle = {
  minHeight: '32px',
  padding: '0 12px',
  borderRadius: '999px',
  border: '1px solid rgba(102, 179, 255, 0.18)',
  background: 'rgba(102, 179, 255, 0.08)',
  color: 'var(--mdt-color-text)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '0.84rem',
} satisfies CSSProperties

const heroTitleStyle = {
  margin: 0,
  color: 'var(--mdt-color-text)',
  fontSize: 'clamp(2.6rem, 4vw, 4.6rem)',
  lineHeight: 1.02,
  fontWeight: 800,
} satisfies CSSProperties

const gradientTextStyle = {
  background: 'linear-gradient(90deg, #66b3ff, #a855f7, #34d399)',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  color: 'transparent',
} satisfies CSSProperties

const heroTextStyle = {
  margin: 0,
  color: 'var(--mdt-color-text-muted)',
  fontSize: '1.04rem',
  lineHeight: 1.7,
  maxWidth: '64ch',
} satisfies CSSProperties

const statGridStyle = {
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
} satisfies CSSProperties

const statCardStyle = {
  display: 'grid',
  gap: '6px',
  padding: '14px 16px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '18px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const statValueStyle = {
  color: 'var(--mdt-color-text)',
  fontSize: '1.2rem',
  fontWeight: 800,
} satisfies CSSProperties

const statLabelStyle = {
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.8rem',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
} satisfies CSSProperties

const panelStackStyle = {
  display: 'grid',
  gap: '16px',
} satisfies CSSProperties

const categoryHeaderStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '12px',
  marginBottom: '14px',
} satisfies CSSProperties

const categoryLineStyle = {
  flex: '1 1 auto',
  minWidth: '80px',
  height: '1px',
  background: 'var(--mdt-color-border)',
} satisfies CSSProperties

const toolGridStyle = {
  display: 'grid',
  gap: '14px',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
} satisfies CSSProperties

const toolCardStyle = {
  display: 'grid',
  gap: '14px',
  minHeight: '190px',
} satisfies CSSProperties

const toolIconShellStyle = {
  width: '48px',
  height: '48px',
  borderRadius: '16px',
  display: 'grid',
  placeItems: 'center',
  background: 'rgba(255, 255, 255, 0.04)',
  fontSize: '1.4rem',
} satisfies CSSProperties

const toolTitleStyle = {
  color: 'var(--mdt-color-text)',
  fontWeight: 700,
} satisfies CSSProperties

const toolDescriptionStyle = {
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.92rem',
  lineHeight: 1.55,
} satisfies CSSProperties

const sectionHeaderStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
} satisfies CSSProperties

const tabsStyle = {
  display: 'flex',
  gap: '10px',
  alignItems: 'center',
  flexWrap: 'wrap',
} satisfies CSSProperties

const miniGridStyle = {
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
} satisfies CSSProperties

const miniToolStyle = {
  display: 'grid',
  gap: '10px',
  alignContent: 'start',
  minHeight: '132px',
} satisfies CSSProperties

const searchLayoutStyle = {
  display: 'grid',
  gap: '18px',
  gridTemplateColumns: '280px minmax(0, 1fr)',
} satisfies CSSProperties

const filterListStyle = {
  display: 'grid',
  gap: '10px',
} satisfies CSSProperties

const filterChipStyle = {
  minHeight: '36px',
  padding: '0 12px',
  borderRadius: '999px',
  border: '1px solid var(--mdt-color-border)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.84rem',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const activeFilterChipStyle = {
  ...filterChipStyle,
  borderColor: 'rgba(102, 179, 255, 0.35)',
  background: 'rgba(102, 179, 255, 0.14)',
  color: 'var(--mdt-color-primary)',
} satisfies CSSProperties

const meta = {
  title: 'Patterns/App Shell',
  component: Card,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof Card>

export default meta

type Story = StoryObj<typeof meta>

const sampleTools = [
  { icon: '✨', title: 'JSON Beautifier', description: 'Format, validate, and normalize structured payloads.', favorite: true },
  { icon: '🧬', title: 'Base64 Encoder', description: 'Encode and decode text or files with preview states.', favorite: true },
  { icon: '🔐', title: 'Hash Calculator', description: 'Generate multiple hashes from text or local files.' },
  { icon: '📱', title: 'QR Code Generator', description: 'Create styled QR codes with export-ready previews.' },
  { icon: '📏', title: 'Image Resizer', description: 'Resize images with format conversion and before/after preview.' },
  { icon: '📄', title: 'Markdown Preview', description: 'Write and preview rendered markdown side by side.' },
  { icon: '🎨', title: 'Color Converter', description: 'Move between HEX, RGB, HSL, and CSS formats.' },
  { icon: '📊', title: 'Text Diff Viewer', description: 'Compare before/after text with quick copy workflows.' },
] as const

const favorites = sampleTools.slice(0, 3)
const recent = [sampleTools[3], sampleTools[4], sampleTools[1]]

export const HomeAndCatalog: Story = {
  render: () => (
    <div style={pageFrameStyle}>
      <div style={navStyle}>
        <div style={brandStyle}>
          <span style={brandEyebrowStyle}>Developer tools</span>
          <span style={brandTitleStyle}>MyDevTools React shell target</span>
        </div>
        <div style={actionRowStyle}>
          <Input leadingIcon={<SearchIcon />} placeholder="Search tools, categories, or workflows" style={{ minWidth: '320px' }} />
          <Button variant="outline">Favorites</Button>
          <Button>Open command palette</Button>
        </div>
      </div>

      <div style={heroGridStyle}>
        <div style={heroSurfaceStyle}>
          <div style={heroBadgeRowStyle}>
            <span style={badgeStyle}>Private by default</span>
            <span style={badgeStyle}>WASM-powered workflows</span>
            <span style={badgeStyle}>Migration-ready React shell</span>
          </div>

          <div style={panelStackStyle}>
            <h1 style={heroTitleStyle}>
              Local developer utilities
              <br />
              <span style={gradientTextStyle}>with a clearer system layer</span>
            </h1>
            <p style={heroTextStyle}>
              This pattern captures the future home surface: strong search entry, category-driven discovery,
              visible favorites/recent workflows, and a cleaner product shell than the current Razor site.
            </p>
          </div>

          <div style={actionRowStyle}>
            <Button>Browse tools</Button>
            <Button variant="outline">Install PWA</Button>
          </div>

          <div style={statGridStyle}>
            <div style={statCardStyle}>
              <span style={statValueStyle}>50+</span>
              <span style={statLabelStyle}>Local tools</span>
            </div>
            <div style={statCardStyle}>
              <span style={statValueStyle}>0</span>
              <span style={statLabelStyle}>Server roundtrips</span>
            </div>
            <div style={statCardStyle}>
              <span style={statValueStyle}>10</span>
              <span style={statLabelStyle}>Languages today</span>
            </div>
          </div>
        </div>

        <div style={panelStackStyle}>
          <Card variant="raised" padding="lg">
            <div style={sectionHeaderStyle}>
              <div>
                <div style={brandEyebrowStyle}>Pinned workflows</div>
                <div style={toolTitleStyle}>Favorites and recent</div>
              </div>
              <div style={tabsStyle}>
                <Button size="sm">Favorites</Button>
                <Button size="sm" variant="ghost">Recent</Button>
              </div>
            </div>
            <div style={miniGridStyle}>
              {favorites.map((tool) => (
                <Card key={tool.title} padding="md" variant="interactive">
                  <div style={miniToolStyle}>
                    <div style={toolIconShellStyle}>{tool.icon}</div>
                    <div style={toolTitleStyle}>{tool.title}</div>
                    <div style={toolDescriptionStyle}>{tool.description}</div>
                  </div>
                </Card>
              ))}
            </div>
          </Card>

          <Alert
            description="App-level migration is not just about prettier tool pages. Search, favorites, and category browsing need their own stable patterns."
            title="Shell-level pattern"
          />
        </div>
      </div>

      <Card variant="muted" padding="lg">
        <div style={sectionHeaderStyle}>
          <div>
            <div style={brandEyebrowStyle}>Catalog</div>
            <div style={toolTitleStyle}>Popular categories and tool cards</div>
          </div>
          <Button variant="ghost">View all categories</Button>
        </div>

        <div style={panelStackStyle}>
          <div>
            <div style={categoryHeaderStyle}>
              <div style={{ ...toolIconShellStyle, width: '40px', height: '40px', borderRadius: '14px' }}>🧰</div>
              <div style={toolTitleStyle}>Structured data</div>
              <div style={categoryLineStyle} />
              <div style={statLabelStyle}>6 tools</div>
            </div>
            <div style={toolGridStyle}>
              {sampleTools.slice(0, 4).map((tool) => (
                <Card key={tool.title} padding="lg" variant="interactive">
                  <div style={toolCardStyle}>
                    <div style={sectionHeaderStyle}>
                      <div style={toolIconShellStyle}>{tool.icon}</div>
                      <IconButton ariaLabel={`Toggle favorite for ${tool.title}`} icon={<StarIcon />} tooltip="Toggle favorite" variant={tool.favorite ? 'primary' : 'ghost'} />
                    </div>
                    <div style={toolTitleStyle}>{tool.title}</div>
                    <div style={toolDescriptionStyle}>{tool.description}</div>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          <div>
            <div style={categoryHeaderStyle}>
              <div style={{ ...toolIconShellStyle, width: '40px', height: '40px', borderRadius: '14px' }}>🖼️</div>
              <div style={toolTitleStyle}>Images and preview tools</div>
              <div style={categoryLineStyle} />
              <div style={statLabelStyle}>5 tools</div>
            </div>
            <div style={toolGridStyle}>
              {sampleTools.slice(4, 8).map((tool) => (
                <Card key={tool.title} padding="lg" variant="interactive">
                  <div style={toolCardStyle}>
                    <div style={sectionHeaderStyle}>
                      <div style={toolIconShellStyle}>{tool.icon}</div>
                      <IconButton ariaLabel={`Toggle favorite for ${tool.title}`} icon={<StarIcon />} tooltip="Toggle favorite" variant="ghost" />
                    </div>
                    <div style={toolTitleStyle}>{tool.title}</div>
                    <div style={toolDescriptionStyle}>{tool.description}</div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  ),
}

export const SearchAndFavoritesView: Story = {
  render: () => (
    <div style={pageFrameStyle}>
      <div style={navStyle}>
        <div style={brandStyle}>
          <span style={brandEyebrowStyle}>Discovery view</span>
          <span style={brandTitleStyle}>Search, favorites, recent</span>
        </div>
        <div style={actionRowStyle}>
          <Input leadingIcon={<SearchIcon />} placeholder="json, image, encode, qr..." style={{ minWidth: '320px' }} />
          <Button variant="outline">Filters</Button>
        </div>
      </div>

      <div style={searchLayoutStyle}>
        <Card variant="muted" padding="lg">
          <div style={panelStackStyle}>
            <div>
              <div style={brandEyebrowStyle}>Search scope</div>
              <div style={toolTitleStyle}>Filter the catalog</div>
            </div>

            <div style={filterListStyle}>
              <span style={activeFilterChipStyle}>Structured data</span>
              <span style={filterChipStyle}>Images</span>
              <span style={filterChipStyle}>Encoding</span>
              <span style={filterChipStyle}>Security</span>
              <span style={filterChipStyle}>Text tools</span>
            </div>

            <Alert
              description="Search should narrow the catalog immediately while keeping favorites and recent tools reachable as separate user-memory surfaces."
              title="Discovery rule"
            />
          </div>
        </Card>

        <div style={panelStackStyle}>
          <Card variant="raised" padding="lg">
            <div style={sectionHeaderStyle}>
              <div>
                <div style={brandEyebrowStyle}>Results</div>
                <div style={toolTitleStyle}>4 matching tools for “json”</div>
              </div>
              <div style={statLabelStyle}>Sorted by relevance</div>
            </div>
            <div style={toolGridStyle}>
              {sampleTools.slice(0, 4).map((tool) => (
                <Card key={tool.title} padding="lg" variant="interactive">
                  <div style={toolCardStyle}>
                    <div style={sectionHeaderStyle}>
                      <div style={toolIconShellStyle}>{tool.icon}</div>
                      <IconButton ariaLabel={`Toggle favorite for ${tool.title}`} icon={<StarIcon />} tooltip="Toggle favorite" variant={tool.favorite ? 'primary' : 'ghost'} />
                    </div>
                    <div style={toolTitleStyle}>{tool.title}</div>
                    <div style={toolDescriptionStyle}>{tool.description}</div>
                  </div>
                </Card>
              ))}
            </div>
          </Card>

          <Card variant="muted" padding="lg">
            <div style={sectionHeaderStyle}>
              <div>
                <div style={brandEyebrowStyle}>User memory</div>
                <div style={toolTitleStyle}>Favorites and recent should stay visible</div>
              </div>
              <div style={tabsStyle}>
                <Button size="sm">Favorites</Button>
                <Button size="sm" variant="ghost" leadingIcon={<ClockIcon />}>Recent</Button>
              </div>
            </div>

            <div style={miniGridStyle}>
              {recent.map((tool) => (
                <Card key={tool.title} padding="md" variant="interactive">
                  <div style={miniToolStyle}>
                    <div style={toolIconShellStyle}>{tool.icon}</div>
                    <div style={toolTitleStyle}>{tool.title}</div>
                    <div style={toolDescriptionStyle}>{tool.description}</div>
                  </div>
                </Card>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  ),
}
