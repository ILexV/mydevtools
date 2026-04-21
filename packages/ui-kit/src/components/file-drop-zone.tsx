import type { DragEvent, HTMLAttributes, KeyboardEvent, ReactNode } from 'react'
import { useId, useRef, useState } from 'react'

import { cn } from '../lib/cn'

export type FileDropZoneProps = Omit<HTMLAttributes<HTMLLabelElement>, 'onChange'> & {
  accept?: string
  buttonLabel?: string
  description?: ReactNode
  disabled?: boolean
  hint?: ReactNode
  multiple?: boolean
  onFilesSelect?: (files: FileList) => void
  title?: ReactNode
}

export function FileDropZone({
  accept,
  buttonLabel = 'Choose files',
  className,
  description = 'Drop files here or browse from your device.',
  disabled = false,
  hint,
  multiple = false,
  onFilesSelect,
  title = 'Upload files',
  onDragLeave,
  onDragOver,
  onDrop,
  ...props
}: FileDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [fileSummary, setFileSummary] = useState<string | null>(null)
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = (files: FileList | null) => {
    if (files && files.length > 0) {
      setFileSummary(files.length === 1 ? files[0].name : `${files.length} files selected`)
      onFilesSelect?.(files)
    }
  }

  const handleDragOver = (event: DragEvent<HTMLLabelElement>) => {
    if (disabled) {
      return
    }

    event.preventDefault()
    setIsDragging(true)
    onDragOver?.(event)
  }

  const handleDragLeave = (event: DragEvent<HTMLLabelElement>) => {
    if (disabled) {
      return
    }

    setIsDragging(false)
    onDragLeave?.(event)
  }

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    if (disabled) {
      return
    }

    event.preventDefault()
    setIsDragging(false)
    handleFiles(event.dataTransfer.files)
    onDrop?.(event)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLLabelElement>) => {
    if (disabled) {
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      inputRef.current?.click()
    }
  }

  return (
    <label
      aria-disabled={disabled || undefined}
      className={cn('mdt-file-drop-zone', isDragging && 'mdt-file-drop-zone--dragging', disabled && 'mdt-file-drop-zone--disabled', fileSummary && 'mdt-file-drop-zone--selected', className)}
      htmlFor={inputId}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={disabled ? -1 : 0}
      {...props}
    >
      <input
        accept={accept}
        className="mdt-file-drop-zone__input"
        disabled={disabled}
        id={inputId}
        multiple={multiple}
        onChange={(event) => handleFiles(event.currentTarget.files)}
        ref={inputRef}
        type="file"
      />
      <div className="mdt-file-drop-zone__icon" aria-hidden="true">
        <svg fill="none" height="20" viewBox="0 0 20 20" width="20" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 13.5V4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
          <path d="M6.75 7.75L10 4.5L13.25 7.75" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
          <path d="M4.5 14.5C4.5 15.6046 5.39543 16.5 6.5 16.5H13.5C14.6046 16.5 15.5 15.6046 15.5 14.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="mdt-file-drop-zone__title">{title}</div>
      <div className="mdt-file-drop-zone__description">{description}</div>
      <div className="mdt-file-drop-zone__footer">
        <div className="mdt-file-drop-zone__button">{buttonLabel}</div>
        {fileSummary ? <div className="mdt-file-drop-zone__status">{fileSummary}</div> : null}
      </div>
      {hint ? <div className="mdt-file-drop-zone__hint">{hint}</div> : null}
    </label>
  )
}
