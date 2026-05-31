const ICONS: Record<string, JSX.Element> = {
  plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  x: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
  play: <polygon points="6 4 20 12 6 20 6 4" />,
  pause: <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>,
  rewind: <><polygon points="11 19 2 12 11 5 11 19" /><polygon points="22 19 13 12 22 5 22 19" /></>,
  forward: <><polygon points="13 19 22 12 13 5 13 19" /><polygon points="2 19 11 12 2 5 2 19" /></>,
  volume: <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></>,
  'volume-x': <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>,
  crosshair: <><circle cx="12" cy="12" r="9" /><line x1="21" y1="12" x2="18" y2="12" /><line x1="6" y1="12" x2="3" y2="12" /><line x1="12" y1="6" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="18" /><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" /></>,
  map: <><polygon points="2 6 2 21 8.5 18 15.5 21 22 18 22 3 15.5 6 8.5 3 2 6" /><line x1="8.5" y1="3" x2="8.5" y2="18" /><line x1="15.5" y1="6" x2="15.5" y2="21" /></>,
  film: <><rect x="2.5" y="3" width="19" height="18" rx="2" /><line x1="7.5" y1="3" x2="7.5" y2="21" /><line x1="16.5" y1="3" x2="16.5" y2="21" /><line x1="2.5" y1="12" x2="21.5" y2="12" /><line x1="2.5" y1="7.5" x2="7.5" y2="7.5" /><line x1="2.5" y1="16.5" x2="7.5" y2="16.5" /><line x1="16.5" y1="16.5" x2="21.5" y2="16.5" /><line x1="16.5" y1="7.5" x2="21.5" y2="7.5" /></>,
  route: <><circle cx="6" cy="19" r="2.6" /><path d="M8.6 19h7.9a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="2.6" /></>,
  layout: <><rect x="3" y="3" width="7" height="8.5" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="11.5" width="7" height="9.5" rx="1" /><rect x="3" y="14.5" width="7" height="6.5" rx="1" /></>,
  swap: <><polyline points="17 11 21 7 17 3" /><line x1="21" y1="7" x2="8" y2="7" /><polyline points="7 13 3 17 7 21" /><line x1="3" y1="17" x2="16" y2="17" /></>,
  fullscreen: <><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>,
  pip: <><path d="M21 9.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3.5" /><rect x="11.5" y="12.5" width="10" height="7.5" rx="1.5" /></>,
  split: <><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="12" y1="4" x2="12" y2="20" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>,
  navigation: <polygon points="3 11 22 2 13 21 11 13 3 11" />,
  'chevron-left': <polyline points="15 18 9 12 15 6" />,
  'chevron-right': <polyline points="9 18 15 12 9 6" />,
}

const FILLED = new Set(['play', 'pause', 'navigation'])

export default function Icon({ name, size = 16, className, style }: {
  name: string
  size?: number
  className?: string
  style?: React.CSSProperties
}) {
  const filled = FILLED.has(name)
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name] || null}
    </svg>
  )
}
