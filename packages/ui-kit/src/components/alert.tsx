import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'

type AlertVariant = 'info' | 'success' | 'warning' | 'danger'

export type AlertProps = HTMLAttributes<HTMLDivElement> & {
  title?: ReactNode
  description?: ReactNode
  icon?: ReactNode
  variant?: AlertVariant
}

const variantClassNames: Record<AlertVariant, string> = {
  info: 'mdt-alert--info',
  success: 'mdt-alert--success',
  warning: 'mdt-alert--warning',
  danger: 'mdt-alert--danger',
}

export function Alert({ className, description, icon, title, variant = 'info', children, ...props }: AlertProps) {
  return (
    <div className={cn('mdt-alert', variantClassNames[variant], className)} role="alert" {...props}>
      {icon ? <div className="mdt-alert__icon">{icon}</div> : null}
      <div className="mdt-alert__content">
        {title ? <div className="mdt-alert__title">{title}</div> : null}
        {description ? <div className="mdt-alert__description">{description}</div> : null}
        {children}
      </div>
    </div>
  )
}
