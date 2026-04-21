import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'

import { Alert, Button, Card, IconButton, Input, Select } from '@mydevtools/ui-kit'

function SearchIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5L13.75 13.75" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.75 8H13.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.25C9.31371 3.66384 10.0602 5.51253 10.1 7.44231C10.1398 9.37209 9.47039 11.2498 8.21667 12.7167" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M8 2.25C6.68629 3.66384 5.93984 5.51253 5.90002 7.44231C5.8602 9.37209 6.52961 11.2498 7.78333 12.7167" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M10.9958 2.88553C9.59465 2.62473 8.14869 2.90213 6.94286 3.66679C5.73703 4.43145 4.85881 5.62739 4.48411 7.01263C4.10942 8.39786 4.26521 9.87321 4.92061 11.1491C5.576 12.425 6.68331 13.4093 8.02383 13.9068C9.36435 14.4044 10.8431 14.3797 12.1664 13.8374C13.4897 13.2952 14.5636 12.2745 15.1758 10.9776C13.9641 11.3308 12.6698 11.2506 11.5116 10.751C10.3534 10.2515 9.40916 9.36355 8.84052 8.24064C8.27188 7.11773 8.11373 5.8317 8.39269 4.60417C8.67166 3.37664 9.37052 2.28494 10.3749 1.51459L10.9958 2.88553Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.2" />
    </svg>
  )
}

const pageFrameStyle = {
  padding: '32px',
  display: 'grid',
  gap: '28px',
} satisfies CSSProperties

const appShellStyle = {
  display: 'grid',
  gap: '20px',
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

const mutedTextStyle = {
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.92rem',
  lineHeight: 1.6,
} satisfies CSSProperties

const actionRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'center',
} satisfies CSSProperties

const searchTriggerStyle = {
  minWidth: '320px',
  justifyContent: 'space-between',
} satisfies CSSProperties

const contentGridStyle = {
  display: 'grid',
  gap: '20px',
  gridTemplateColumns: 'minmax(0, 1.4fr) minmax(320px, 0.9fr)',
} satisfies CSSProperties

const modalShellStyle = {
  display: 'grid',
  gap: '16px',
  padding: '18px',
  border: '1px solid rgba(102, 179, 255, 0.22)',
  borderRadius: '24px',
  background: 'rgba(8, 12, 26, 0.9)',
  boxShadow: '0 24px 80px rgba(0, 0, 0, 0.45)',
} satisfies CSSProperties

const paletteSearchRowStyle = {
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'center',
} satisfies CSSProperties

const sectionStackStyle = {
  display: 'grid',
  gap: '14px',
} satisfies CSSProperties

const sectionHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
} satisfies CSSProperties

const listStyle = {
  display: 'grid',
  gap: '10px',
} satisfies CSSProperties

const itemStyle = {
  display: 'grid',
  gap: '8px',
  padding: '14px 16px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '16px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const itemHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
} satisfies CSSProperties

const keycapStyle = {
  minHeight: '24px',
  padding: '0 8px',
  borderRadius: '999px',
  border: '1px solid var(--mdt-color-border)',
  display: 'inline-flex',
  alignItems: 'center',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.76rem',
  color: 'var(--mdt-color-text-muted)',
} satisfies CSSProperties

const languageGridStyle = {
  display: 'grid',
  gap: '14px',
} satisfies CSSProperties

const routePreviewStyle = {
  display: 'grid',
  gap: '10px',
  padding: '14px 16px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '16px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const routePathStyle = {
  color: 'var(--mdt-color-primary)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.86rem',
} satisfies CSSProperties

const localeGridStyle = {
  display: 'grid',
  gap: '10px',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
} satisfies CSSProperties

const localeChipStyle = {
  display: 'grid',
  gap: '6px',
  padding: '12px 14px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '14px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const activeLocaleChipStyle = {
  ...localeChipStyle,
  borderColor: 'rgba(102, 179, 255, 0.36)',
  background: 'rgba(102, 179, 255, 0.12)',
} satisfies CSSProperties

const meta = {
  title: 'Patterns/Command Search Shell',
  component: Card,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof Card>

export default meta

type Story = StoryObj<typeof meta>

export const HeaderAndPalette: Story = {
  render: () => (
    <div style={pageFrameStyle}>
      <div style={appShellStyle}>
        <div style={navStyle}>
          <div style={brandStyle}>
            <div style={eyebrowStyle}>Global app shell</div>
            <div style={titleStyle}>Search-first navigation and quick tool switching</div>
          </div>
          <div style={actionRowStyle}>
            <Button leadingIcon={<SearchIcon />} style={searchTriggerStyle} variant="secondary">
              <span>Search tools, actions, or recent pages</span>
              <span style={keycapStyle}>Ctrl K</span>
            </Button>
            <IconButton ariaLabel="Switch theme" icon={<MoonIcon />} tooltip="Switch theme" variant="outline" />
            <Select aria-label="Select language" defaultValue="en" leadingIcon={<GlobeIcon />} style={{ minWidth: '100px' }}>
              <option value="en">EN</option>
              <option value="ru">RU</option>
              <option value="de">DE</option>
              <option value="ja">JA</option>
            </Select>
          </div>
        </div>

        <div style={contentGridStyle}>
          <Card padding="lg" variant="raised">
            <div style={sectionStackStyle}>
              <div>
                <div style={eyebrowStyle}>Command palette reference</div>
                <div style={titleStyle}>Search, recent tools, favorites, and direct keyboard hints</div>
              </div>
              <Alert
                description="This layer is distinct from home/catalog because it must feel instant, keyboard-first, and stable across every route."
                title="Why this pattern matters"
              />
              <div style={modalShellStyle}>
                <div style={paletteSearchRowStyle}>
                  <Input leadingIcon={<SearchIcon />} placeholder="Search tools, categories, and recent pages" value="json" readOnly />
                  <Button variant="ghost">ESC</Button>
                </div>

                <div style={sectionStackStyle}>
                  <div style={sectionHeaderStyle}>
                    <span style={titleStyle}>Recent</span>
                    <span style={keycapStyle}>2 items</span>
                  </div>
                  <div style={listStyle}>
                    {[
                      ['JSON Beautifier', 'Structured data', 'Enter'],
                      ['Hash Calculator', 'Hashing and security', 'Shift Enter'],
                    ].map(([name, category, key]) => (
                      <div key={name} style={itemStyle}>
                        <div style={itemHeaderStyle}>
                          <span style={titleStyle}>{name}</span>
                          <span style={keycapStyle}>{key}</span>
                        </div>
                        <span style={mutedTextStyle}>{category}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={sectionStackStyle}>
                  <div style={sectionHeaderStyle}>
                    <span style={titleStyle}>Favorites</span>
                    <span style={keycapStyle}>Pinned</span>
                  </div>
                  <div style={listStyle}>
                    {[
                      ['Base64 Encoder', 'Encoding and file workflows', 'Alt 1'],
                      ['Regex Tester', 'Match explorer and saved patterns', 'Alt 2'],
                    ].map(([name, description, key]) => (
                      <div key={name} style={itemStyle}>
                        <div style={itemHeaderStyle}>
                          <span style={titleStyle}>{name}</span>
                          <span style={keycapStyle}>{key}</span>
                        </div>
                        <span style={mutedTextStyle}>{description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card padding="lg" variant="muted">
            <div style={languageGridStyle}>
              <div>
                <div style={eyebrowStyle}>Route-aware locale switching</div>
                <div style={titleStyle}>Language changes preserve location and search context</div>
              </div>
              <div style={routePreviewStyle}>
                <span style={mutedTextStyle}>Current route</span>
                <span style={routePathStyle}>/en/tools/json-beautifier</span>
              </div>
              <div style={routePreviewStyle}>
                <span style={mutedTextStyle}>After switching to Russian</span>
                <span style={routePathStyle}>/ru/tools/json-beautifier</span>
              </div>
              <div style={localeGridStyle}>
                <div style={activeLocaleChipStyle}>
                  <span style={titleStyle}>EN</span>
                  <span style={mutedTextStyle}>active</span>
                </div>
                <div style={localeChipStyle}>
                  <span style={titleStyle}>RU</span>
                  <span style={mutedTextStyle}>available</span>
                </div>
                <div style={localeChipStyle}>
                  <span style={titleStyle}>DE</span>
                  <span style={mutedTextStyle}>available</span>
                </div>
                <div style={localeChipStyle}>
                  <span style={titleStyle}>JA</span>
                  <span style={mutedTextStyle}>available</span>
                </div>
              </div>
              <Alert
                description="The React migration should keep locale in the route, not bury it in client-only state, so deep links and SEO stay deterministic."
                title="i18n shell rule"
                variant="success"
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  ),
}

export const MobileSearchAndLocale: Story = {
  render: () => (
    <div style={{ ...pageFrameStyle, maxWidth: '520px' }}>
      <Card padding="lg" variant="raised">
        <div style={sectionStackStyle}>
          <div style={sectionHeaderStyle}>
            <div>
              <div style={eyebrowStyle}>Mobile shell</div>
              <div style={titleStyle}>Compact search trigger and language actions</div>
            </div>
            <IconButton ariaLabel="Open search" icon={<SearchIcon />} tooltip="Open search" variant="outline" />
          </div>

          <Button leadingIcon={<SearchIcon />} variant="secondary">
            Search tools, recent actions, and categories
          </Button>

          <Select aria-label="Select language" defaultValue="ru" leadingIcon={<GlobeIcon />}>
            <option value="en">EN</option>
            <option value="ru">RU</option>
            <option value="de">DE</option>
            <option value="ja">JA</option>
          </Select>

          <div style={listStyle}>
            {[
              ['Recent', 'Word Counter', '/ru/tools/word-counter'],
              ['Favorite', 'Hash Calculator', '/ru/tools/hash-calculator'],
              ['Popular', 'QR Code Generator', '/ru/tools/qr-code-generator'],
            ].map(([group, title, path]) => (
              <div key={path} style={itemStyle}>
                <div style={itemHeaderStyle}>
                  <span style={titleStyle}>{title}</span>
                  <span style={keycapStyle}>{group}</span>
                </div>
                <span style={routePathStyle}>{path}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  ),
}
