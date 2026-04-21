import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'

type AlertVariant = 'info' | 'success' | 'warning' | 'danger'
type AlertRole = 'status' | 'alert'

export type AlertProps = HTMLAttributes<HTMLDivElement> & {
  title?: ReactNode
  description?: ReactNode
  icon?: ReactNode
  variant?: AlertVariant
  role?: AlertRole
}

const variantClassNames: Record<AlertVariant, string> = {
  info: 'mdt-alert--info',
  success: 'mdt-alert--success',
  warning: 'mdt-alert--warning',
  danger: 'mdt-alert--danger',
}

const defaultIcons: Record<AlertVariant, ReactNode> = {
  info: (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 4.75V4.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <path d="M8 7V11.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  success: (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M4.75 8.25L6.75 10.25L11.25 5.75" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  warning: (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 5.25V8.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <path d="M8 11.25H8.01" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <path d="M7.114 3.672C7.502 2.976 8.498 2.976 8.886 3.672L12.967 10.995C13.344 11.672 12.855 12.5 12.08 12.5H3.92C3.145 12.5 2.656 11.672 3.033 10.995L7.114 3.672Z" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  danger: (
    <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path d="M5.25 5.25L10.75 10.75" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <path d="M10.75 5.25L5.25 10.75" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
}

export function Alert({ children, className, description, icon, role, title, variant = 'info', ...props }: AlertProps) {
  const resolvedRole = role ?? (variant === 'warning' || variant === 'danger' ? 'alert' : 'status')

  return (
    <div aria-live={resolvedRole === 'alert' ? 'assertive' : 'polite'} className={cn('mdt-alert', variantClassNames[variant], className)} role={resolvedRole} {...props}>
      <div className="mdt-alert__icon">{icon ?? defaultIcons[variant]}</div>
      <div className="mdt-alert__content">
        {title ? <div className="mdt-alert__title">{title}</div> : null}
        {description ? <div className="mdt-alert__description">{description}</div> : null}
        {children}
      </div>
    </div>
  )
}
