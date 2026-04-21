import type { ReactNode, TextareaHTMLAttributes } from 'react'

import { cn } from '../lib/cn'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean
  leadingVisual?: ReactNode
}

export function Textarea({
  className,
  disabled,
  invalid = false,
  leadingVisual,
  rows = 8,
  ...props
}: TextareaProps) {
  return (
    <div className={cn('mdt-textarea', invalid && 'mdt-textarea--invalid', disabled && 'mdt-textarea--disabled', className)}>
      {leadingVisual ? <div className="mdt-textarea__visual">{leadingVisual}</div> : null}
      <textarea className="mdt-textarea__control" disabled={disabled} rows={rows} {...props} />
    </div>
  )
}
