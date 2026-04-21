import type { HTMLAttributes, ReactNode } from 'react'
import { cloneElement, isValidElement, useId } from 'react'

import { cn } from '../lib/cn'

export type FieldProps = HTMLAttributes<HTMLDivElement> & {
  label?: ReactNode
  description?: ReactNode
  error?: ReactNode
  hint?: ReactNode
  required?: boolean
  htmlFor?: string
}

export function Field({ children, className, description, error, hint, htmlFor, label, required = false, ...props }: FieldProps) {
  const fallbackControlId = useId()
  const descriptionId = description ? `${fallbackControlId}-description` : undefined
  const hintId = !error && hint ? `${fallbackControlId}-hint` : undefined
  const errorId = error ? `${fallbackControlId}-error` : undefined

  let control = children
  let controlId = htmlFor

  if (isValidElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>(children)) {
    controlId = children.props.id ?? htmlFor ?? fallbackControlId
    const describedBy = [children.props['aria-describedby'], descriptionId, hintId, errorId].filter(Boolean).join(' ') || undefined

    control = cloneElement(children, {
      id: controlId,
      'aria-describedby': describedBy,
      'aria-invalid': children.props['aria-invalid'] ?? (error ? true : undefined),
    })
  }

  return (
    <div className={cn('mdt-field', className)} {...props}>
      {label || description ? (
        <div className="mdt-field__header">
          {label ? (
            <div className="mdt-field__label-row">
              {controlId ? (
                <label className="mdt-field__label" htmlFor={controlId}>
                  {label}
                </label>
              ) : (
                <div className="mdt-field__label">{label}</div>
              )}
              {required ? <span className="mdt-field__required">Required</span> : null}
            </div>
          ) : null}
          {description ? <div className="mdt-field__description" id={descriptionId}>{description}</div> : null}
        </div>
      ) : null}
      <div className="mdt-field__control">{control}</div>
      {error ? <div className="mdt-field__error" id={errorId}>{error}</div> : hint ? <div className="mdt-field__hint" id={hintId}>{hint}</div> : null}
    </div>
  )
}
