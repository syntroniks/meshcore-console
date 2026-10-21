import type { ReactNode } from 'react'

export function Card({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {actions && <div className="card-actions">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

export interface Row {
  label: string
  value: ReactNode
  muted?: boolean
  action?: ReactNode
}

export function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="rows">
      {rows.map((r) => (
        <div className="row" key={r.label}>
          <dt>{r.label}</dt>
          <dd className={r.muted ? 'muted' : undefined}>{r.value}</dd>
          <div className="row-action">{r.action}</div>
        </div>
      ))}
    </dl>
  )
}

export function Button({ children, onClick, kind = 'plain', disabled, title }: {
  children: ReactNode
  onClick?: () => void
  kind?: 'plain' | 'primary' | 'small'
  disabled?: boolean
  title?: string
}) {
  return (
    <button className={`btn btn-${kind}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}
