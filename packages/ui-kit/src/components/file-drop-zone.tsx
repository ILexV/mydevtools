import type { DragEvent, HTMLAttributes, ReactNode } from 'react'
import { useId, useState } from 'react'

import { cn } from '../lib/cn'

export type FileDropZoneProps = Omit<HTMLAttributes<HTMLLabelElement>, 'onChange'> & {
  accept?: string
  buttonLabel?: string
  description?: ReactNode
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
  const inputId = useId()

  const handleFiles = (files: FileList | null) => {
    if (files && files.length > 0) {
      onFilesSelect?.(files)
    }
  }

  const handleDragOver = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setIsDragging(true)
    onDragOver?.(event)
  }

  const handleDragLeave = (event: DragEvent<HTMLLabelElement>) => {
    setIsDragging(false)
    onDragLeave?.(event)
  }

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setIsDragging(false)
    handleFiles(event.dataTransfer.files)
    onDrop?.(event)
  }

  return (
    <label
      className={cn('mdt-file-drop-zone', isDragging && 'mdt-file-drop-zone--dragging', className)}
      htmlFor={inputId}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      {...props}
    >
      <input
        accept={accept}
        className="mdt-file-drop-zone__input"
        id={inputId}
        multiple={multiple}
        onChange={(event) => handleFiles(event.currentTarget.files)}
        type="file"
      />
      <div className="mdt-file-drop-zone__icon" aria-hidden="true">
        [ ]
      </div>
      <div className="mdt-file-drop-zone__title">{title}</div>
      <div className="mdt-file-drop-zone__description">{description}</div>
      <div className="mdt-file-drop-zone__button">{buttonLabel}</div>
      {hint ? <div className="mdt-file-drop-zone__hint">{hint}</div> : null}
    </label>
  )
}
