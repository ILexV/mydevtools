import type { ReactNode, SelectHTMLAttributes } from 'react'

import { cn } from '../lib/cn'

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean
  leadingIcon?: ReactNode
  placeholder?: string
}

export function Select({
  children,
  className,
  disabled,
  invalid = false,
  leadingIcon,
  placeholder,
  ...props
}: SelectProps) {
  return (
    <label className={cn('mdt-select', invalid && 'mdt-select--invalid', disabled && 'mdt-select--disabled', className)}>
      {leadingIcon ? <span className="mdt-select__icon">{leadingIcon}</span> : null}
      <select className="mdt-select__control" disabled={disabled} {...props}>
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {children}
      </select>
      <span aria-hidden="true" className="mdt-select__chevron">
        v
      </span>
    </label>
  )
}
