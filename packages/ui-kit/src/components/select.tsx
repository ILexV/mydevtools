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
  const hasPlaceholder = typeof placeholder === 'string' && placeholder.length > 0

  return (
    <div className={cn('mdt-select', invalid && 'mdt-select--invalid', disabled && 'mdt-select--disabled', className)}>
      {leadingIcon ? <span className="mdt-select__icon">{leadingIcon}</span> : null}
      <select aria-invalid={invalid || undefined} className="mdt-select__control" defaultValue={hasPlaceholder && props.value === undefined && props.defaultValue === undefined ? '' : props.defaultValue} disabled={disabled} {...props}>
        {hasPlaceholder ? (
          <option hidden value="">
            {placeholder}
          </option>
        ) : null}
        {children}
      </select>
      <span aria-hidden="true" className="mdt-select__chevron">
        <svg fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 6.5L8 10.5L12 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
        </svg>
      </span>
    </div>
  )
}
