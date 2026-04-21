import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'

export type FieldProps = HTMLAttributes<HTMLDivElement> & {
  label?: ReactNode
  description?: ReactNode
  error?: ReactNode
  hint?: ReactNode
  required?: boolean
}

export function Field({ children, className, description, error, hint, label, required = false, ...props }: FieldProps) {
  return (
    <div className={cn('mdt-field', className)} {...props}>
      {label || description ? (
        <div className="mdt-field__header">
          {label ? (
            <div className="mdt-field__label-row">
              <label className="mdt-field__label">{label}</label>
              {required ? <span className="mdt-field__required">Required</span> : null}
            </div>
          ) : null}
          {description ? <div className="mdt-field__description">{description}</div> : null}
        </div>
      ) : null}
      <div className="mdt-field__control">{children}</div>
      {error ? <div className="mdt-field__error">{error}</div> : hint ? <div className="mdt-field__hint">{hint}</div> : null}
    </div>
  )
}
