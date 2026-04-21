import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'
import { PanelCard } from './panel-card'

type ToolPanelTone = 'input' | 'settings' | 'output'

export type ToolPanelProps = HTMLAttributes<HTMLDivElement> & {
  title: ReactNode
  description?: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  tone?: ToolPanelTone
}

const toneEyebrows: Record<ToolPanelTone, string> = {
  input: 'Input',
  settings: 'Settings',
  output: 'Output',
}

export function ToolPanel({ actions, children, className, description, eyebrow, footer, title, tone = 'input', ...props }: ToolPanelProps) {
  return (
    <PanelCard
      actions={actions}
      className={cn('mdt-tool-panel', `mdt-tool-panel--${tone}`, className)}
      description={description}
      eyebrow={eyebrow ?? toneEyebrows[tone]}
      footer={footer}
      title={
        <div className="mdt-tool-panel__title-wrap">
          <span>{title}</span>
        </div>
      }
      {...props}
    >
      {children}
    </PanelCard>
  )
}
