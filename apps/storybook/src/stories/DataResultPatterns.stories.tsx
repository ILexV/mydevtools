import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'

import { Alert, Button, Card, IconButton, Input } from '@mydevtools/ui-kit'

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
  display: 'grid',
  gap: '24px',
} satisfies CSSProperties

const sectionHeaderStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '14px',
  marginBottom: '16px',
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
  fontSize: '1.06rem',
  fontWeight: 700,
} satisfies CSSProperties

const bodyTextStyle = {
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

const statGridStyle = {
  display: 'grid',
  gap: '10px',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
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
  fontSize: '0.9rem',
} satisfies CSSProperties

const resultListStyle = {
  display: 'grid',
  gap: '10px',
} satisfies CSSProperties

const resultRowStyle = {
  display: 'grid',
  gap: '10px',
  padding: '14px 16px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '16px',
  background: 'rgba(255, 255, 255, 0.02)',
} satisfies CSSProperties

const resultHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
} satisfies CSSProperties

const monoValueStyle = {
  margin: 0,
  color: 'var(--mdt-color-text)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.85rem',
  lineHeight: 1.6,
  wordBreak: 'break-all',
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

const activeChipStyle = {
  ...chipStyle,
  borderColor: 'rgba(102, 179, 255, 0.35)',
  background: 'rgba(102, 179, 255, 0.14)',
  color: 'var(--mdt-color-primary)',
} satisfies CSSProperties

const matchGridStyle = {
  display: 'grid',
  gap: '12px',
} satisfies CSSProperties

const matchCardStyle = {
  display: 'grid',
  gap: '10px',
  padding: '14px 16px',
  border: '1px solid var(--mdt-color-border)',
  borderRadius: '16px',
  background: 'rgba(255, 255, 255, 0.02)',
  fontFamily: 'var(--mdt-font-mono)',
  fontSize: '0.86rem',
} satisfies CSSProperties

const matchHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  color: 'var(--mdt-color-text-muted)',
} satisfies CSSProperties

const groupRowStyle = {
  display: 'grid',
  gap: '6px',
  paddingLeft: '12px',
  borderLeft: '2px solid rgba(102, 179, 255, 0.24)',
} satisfies CSSProperties

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.9rem',
} satisfies CSSProperties

const thStyle = {
  padding: '10px 12px',
  textAlign: 'left',
  borderBottom: '1px solid var(--mdt-color-border)',
  color: 'var(--mdt-color-text-muted)',
  fontSize: '0.78rem',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
} satisfies CSSProperties

const tdStyle = {
  padding: '12px',
  borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  color: 'var(--mdt-color-text)',
} satisfies CSSProperties

const meta = {
  title: 'Patterns/Data Results',
  component: Card,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof Card>

export default meta

type Story = StoryObj<typeof meta>

export const HistoryAndResultRows: Story = {
  render: () => (
    <div style={pageFrameStyle}>
      <Card variant="raised" padding="lg">
        <div style={sectionHeaderStyle}>
          <div>
            <div style={eyebrowStyle}>UUID and hash outputs</div>
            <div style={titleStyle}>History lists, bulk actions, and result rows</div>
          </div>
          <div style={actionRowStyle}>
            <Button leadingIcon={<DownloadIcon />} variant="outline">Download all</Button>
            <Button variant="ghost">Clear list</Button>
          </div>
        </div>

        <div style={statGridStyle}>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>Generated</span>
            <span style={statValueStyle}>24 UUIDs</span>
          </div>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>Format</span>
            <span style={statValueStyle}>Hyphenated</span>
          </div>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>Case</span>
            <span style={statValueStyle}>Lowercase</span>
          </div>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>Version</span>
            <span style={statValueStyle}>v7</span>
          </div>
        </div>

        <div style={resultListStyle}>
          {[
            '018f5f4d-04bb-7ec7-88fd-3c1e21d4d991',
            '018f5f4d-04bc-7a8a-974f-b60e7749255c',
            '018f5f4d-04bd-7d43-a03a-9f4707a24a88',
          ].map((value, index) => (
            <div key={value} style={resultRowStyle}>
              <div style={resultHeaderStyle}>
                <span style={titleStyle}>Result #{index + 1}</span>
                <IconButton ariaLabel={`Copy result ${index + 1}`} icon={<CopyIcon />} tooltip="Copy result" variant="outline" />
              </div>
              <pre style={monoValueStyle}>{value}</pre>
            </div>
          ))}
        </div>
      </Card>

      <Card variant="muted" padding="lg">
        <div style={sectionHeaderStyle}>
          <div>
            <div style={eyebrowStyle}>Compact table pattern</div>
            <div style={titleStyle}>Saved items, quick examples, and narrow action cells</div>
          </div>
          <Input placeholder="Search saved patterns" style={{ minWidth: '260px' }} />
        </div>

        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Pattern</th>
              <th style={thStyle}>Action</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Email validator', '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'],
              ['UUID v4', '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'],
              ['Hex color', '^#(?:[0-9a-fA-F]{3}){1,2}$'],
            ].map(([name, pattern]) => (
              <tr key={name}>
                <td style={tdStyle}>{name}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--mdt-font-mono)', fontSize: '0.84rem' }}>{pattern}</td>
                <td style={tdStyle}>
                  <IconButton ariaLabel={`Use ${name}`} icon={<CopyIcon />} tooltip="Use pattern" variant="ghost" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  ),
}

export const MatchExplorerAndChips: Story = {
  render: () => (
    <div style={pageFrameStyle}>
      <Card variant="raised" padding="lg">
        <div style={sectionHeaderStyle}>
          <div>
            <div style={eyebrowStyle}>Regex and filter patterns</div>
            <div style={titleStyle}>Flag chips, match cards, and nested group rows</div>
          </div>
          <div style={chipWrapStyle}>
            <span style={activeChipStyle}>g</span>
            <span style={chipStyle}>i</span>
            <span style={chipStyle}>m</span>
            <span style={activeChipStyle}>u</span>
          </div>
        </div>

        <Alert
          description="These result structures recur across regex, parsers, validators, and generators where multiple compact findings need scanning instead of full-page reading."
          title="Dense result rule"
        />

        <div style={matchGridStyle}>
          <div style={matchCardStyle}>
            <div style={matchHeaderStyle}>
              <span>Match #1</span>
              <span>index 14-37</span>
            </div>
            <pre style={monoValueStyle}>support@mydevtools.app</pre>
            <div style={groupRowStyle}>
              <span style={bodyTextStyle}>group: local</span>
              <pre style={monoValueStyle}>support</pre>
            </div>
            <div style={groupRowStyle}>
              <span style={bodyTextStyle}>group: domain</span>
              <pre style={monoValueStyle}>mydevtools.app</pre>
            </div>
          </div>

          <div style={matchCardStyle}>
            <div style={matchHeaderStyle}>
              <span>Match #2</span>
              <span>index 41-61</span>
            </div>
            <pre style={monoValueStyle}>team@mydevtools.dev</pre>
            <div style={groupRowStyle}>
              <span style={bodyTextStyle}>group: local</span>
              <pre style={monoValueStyle}>team</pre>
            </div>
            <div style={groupRowStyle}>
              <span style={bodyTextStyle}>group: domain</span>
              <pre style={monoValueStyle}>mydevtools.dev</pre>
            </div>
          </div>
        </div>
      </Card>
    </div>
  ),
}
