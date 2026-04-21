import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'

type IconButtonVariant = 'ghost' | 'outline' | 'solid' | 'danger'
type IconButtonSize = 'sm' | 'md' | 'lg'

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  ariaLabel: string
  icon: ReactNode
  variant?: IconButtonVariant
  size?: IconButtonSize
  selected?: boolean
}

const variantClassNames: Record<IconButtonVariant, string> = {
  ghost: 'mdt-icon-button--ghost',
  outline: 'mdt-icon-button--outline',
  solid: 'mdt-icon-button--solid',
  danger: 'mdt-icon-button--danger',
}

const sizeClassNames: Record<IconButtonSize, string> = {
  sm: 'mdt-icon-button--sm',
  md: 'mdt-icon-button--md',
  lg: 'mdt-icon-button--lg',
}

export function IconButton({
  ariaLabel,
  className,
  icon,
  selected = false,
  size = 'md',
  type = 'button',
  variant = 'ghost',
  ...props
}: IconButtonProps) {
  return (
    <button
      aria-label={ariaLabel}
      aria-pressed={selected || undefined}
      className={cn('mdt-icon-button', variantClassNames[variant], sizeClassNames[size], selected && 'mdt-icon-button--selected', className)}
      type={type}
      {...props}
    >
      <span aria-hidden="true" className="mdt-icon-button__icon">
        {icon}
      </span>
    </button>
  )
}
