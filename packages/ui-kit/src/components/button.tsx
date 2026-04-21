import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'success'
type ButtonSize = 'sm' | 'md' | 'lg'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  fullWidth?: boolean
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
}

const sizeClassNames: Record<ButtonSize, string> = {
  sm: 'mdt-button--sm',
  md: 'mdt-button--md',
  lg: 'mdt-button--lg',
}

const variantClassNames: Record<ButtonVariant, string> = {
  primary: 'mdt-button--primary',
  secondary: 'mdt-button--secondary',
  ghost: 'mdt-button--ghost',
  outline: 'mdt-button--outline',
  danger: 'mdt-button--danger',
  success: 'mdt-button--success',
}

export function Button({
  children,
  className,
  disabled,
  fullWidth = false,
  leadingIcon,
  loading = false,
  size = 'md',
  trailingIcon,
  type = 'button',
  variant = 'primary',
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'mdt-button',
        sizeClassNames[size],
        variantClassNames[variant],
        fullWidth && 'mdt-button--full-width',
        className,
      )}
      data-loading={loading ? 'true' : undefined}
      disabled={disabled || loading}
      type={type}
      {...props}
    >
      {loading ? <span aria-hidden="true" className="mdt-button__spinner" /> : leadingIcon ? <span className="mdt-button__icon">{leadingIcon}</span> : null}
      <span className="mdt-button__label">{children}</span>
      {!loading && trailingIcon ? <span className="mdt-button__icon">{trailingIcon}</span> : null}
    </button>
  )
}
