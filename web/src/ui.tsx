import type { ReactNode } from 'react'

const paths = {
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-4',
  attach: 'm8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3 M5 16l10-10',
  smile: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20 M8 8h.01 M16 8h.01 M7 14s1 4 5 4 5-4 5-4',
  sticker: 'M21 13V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8z M13 21v-6a2 2 0 0 1 2-2h6 M8 8h.01 M15 8h.01',
  send: 'm22 2-7 20-4-9L2 9z M22 2 11 13',
  more: 'M12 4h.01 M12 12h.01 M12 20h.01',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  phone: 'M7 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a14 14 0 0 1-7-7l2-2z',
  message: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0z M7 10h9 M7 14h6',
  numbers: 'M9 3 7 21 M17 3l-2 18 M3 9h18 M2 15h18',
  wallet: 'M20 8H5a2 2 0 0 1 0-4h14v4 M3 6v13a1 1 0 0 0 1 1h16V8 M20 12h-5v4h5 M16 14h1',
  check: 'm5 12 4 4L19 6',
  orders: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',
  arrow: 'M5 12h14 m-5-5 5 5-5 5',
  logout: 'M9 4H4v16h5 M9 12h12 m-4-4 4 4-4 4',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'm6 6 12 12 M18 6 6 18',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  plus: 'M12 4v16 M4 12h16',
  shield: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z m-4 10 3 3 5-5',
} as const
export type IconName = keyof typeof paths
export function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 4 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
export function PageHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <header className="page-heading"><div><h1>{title}</h1>{description ? <p>{description}</p> : null}</div>{children ? <div className="heading-actions">{children}</div> : null}</header>
}
export function EmptyState({ icon = 'message', title, children }: { icon?: IconName; title: string; children: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={25} /></span><h3>{title}</h3><p>{children}</p></div>
}
