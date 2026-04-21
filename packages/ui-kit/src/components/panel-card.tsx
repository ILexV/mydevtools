import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'
import { Card } from './card'

export type PanelCardProps = HTMLAttributes<HTMLDivElement> & {
  title: ReactNode
  eyebrow?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
}

export function PanelCard({ actions, children, className, description, eyebrow, footer, title, ...props }: PanelCardProps) {
  return (
    <Card className={cn('mdt-panel-card', className)} padding="lg" variant="raised" {...props}>
      <div className="mdt-panel-card__header">
        <div className="mdt-panel-card__heading">
          {eyebrow ? <div className="mdt-panel-card__eyebrow">{eyebrow}</div> : null}
          <div className="mdt-panel-card__title">{title}</div>
          {description ? <div className="mdt-panel-card__description">{description}</div> : null}
        </div>
        {actions ? <div className="mdt-panel-card__actions">{actions}</div> : null}
      </div>
      <div className="mdt-panel-card__body">{children}</div>
      {footer ? <div className="mdt-panel-card__footer">{footer}</div> : null}
    </Card>
  )
}
