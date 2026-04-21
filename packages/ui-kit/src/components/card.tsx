import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'

type CardVariant = 'default' | 'muted' | 'raised' | 'interactive'
type CardPadding = 'none' | 'sm' | 'md' | 'lg'

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant
  padding?: CardPadding
  bordered?: boolean
  children: ReactNode
}

const variantClassNames: Record<CardVariant, string> = {
  default: 'mdt-card--default',
  muted: 'mdt-card--muted',
  raised: 'mdt-card--raised',
  interactive: 'mdt-card--interactive',
}

const paddingClassNames: Record<CardPadding, string> = {
  none: 'mdt-card--padding-none',
  sm: 'mdt-card--padding-sm',
  md: 'mdt-card--padding-md',
  lg: 'mdt-card--padding-lg',
}

export function Card({
  bordered = true,
  children,
  className,
  padding = 'md',
  variant = 'default',
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        'mdt-card',
        bordered && 'mdt-card--bordered',
        variantClassNames[variant],
        paddingClassNames[padding],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}
