import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'

export type ToolPageLayoutProps = HTMLAttributes<HTMLDivElement> & {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  aside?: ReactNode
  hero?: ReactNode
}

export function ToolPageLayout({ actions, aside, children, className, description, hero, title, ...props }: ToolPageLayoutProps) {
  return (
    <div className={cn('mdt-tool-page', className)} {...props}>
      <header className="mdt-tool-page__header">
        <div className="mdt-tool-page__heading">
          <div className="mdt-tool-page__title">{title}</div>
          {description ? <div className="mdt-tool-page__description">{description}</div> : null}
        </div>
        {actions ? <div className="mdt-tool-page__actions">{actions}</div> : null}
      </header>
      {hero ? <div className="mdt-tool-page__hero">{hero}</div> : null}
      <div className={cn('mdt-tool-page__grid', aside && 'mdt-tool-page__grid--with-aside')}>
        <main className="mdt-tool-page__main">{children}</main>
        {aside ? <aside className="mdt-tool-page__aside">{aside}</aside> : null}
      </div>
    </div>
  )
}
