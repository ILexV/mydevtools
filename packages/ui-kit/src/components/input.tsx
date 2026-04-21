import type { InputHTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  invalid?: boolean
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
}

export function Input({
  className,
  disabled,
  invalid = false,
  leadingIcon,
  trailingIcon,
  type = 'text',
  ...props
}: InputProps) {
  return (
    <div className={cn('mdt-input', invalid && 'mdt-input--invalid', disabled && 'mdt-input--disabled', className)}>
      {leadingIcon ? <span className="mdt-input__icon">{leadingIcon}</span> : null}
      <input aria-invalid={invalid || undefined} className="mdt-input__control" disabled={disabled} type={type} {...props} />
      {trailingIcon ? <span className="mdt-input__icon">{trailingIcon}</span> : null}
    </div>
  )
}
