import { useMemo, useRef, useEffect } from 'react'
import { useStore } from '../store'

export default function WaypointList() {
  const { points, currentIdx } = useStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolled = useRef(false)

  const items = useMemo(() => {
    if (!points.length) return []
    const N = points.length
    const step = Math.max(1, Math.floor(N / 140))
    const out: { i: number }[] = []
    for (let i = 0; i < N; i += step) out.push({ i })
    if (out[out.length - 1].i !== N - 1) out.push({ i: N - 1 })
    return out
  }, [points])

  const activeItem = useMemo(() => {
    let best = 0, bd = Infinity
    items.forEach((it, k) => { const d = Math.abs(it.i - currentIdx); if (d < bd) { bd = d; best = k } })
    return best
  }, [items, currentIdx])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let to: ReturnType<typeof setTimeout>
    const on = () => { userScrolled.current = true; clearTimeout(to); to = setTimeout(() => { userScrolled.current = false }, 2600) }
    el.addEventListener('wheel', on, { passive: true })
    el.addEventListener('touchmove', on, { passive: true })
    return () => { el.removeEventListener('wheel', on); el.removeEventListener('touchmove', on) }
  }, [])

  useEffect(() => {
    if (userScrolled.current) return
    const el = scrollRef.current
    if (!el) return
    const row = el.querySelector('.wp-row.active')
    if (row) el.scrollTo({ top: (row as HTMLElement).offsetTop - el.clientHeight / 2 + (row as HTMLElement).clientHeight / 2, behavior: 'smooth' })
  }, [activeItem])

  if (!points.length) return null

  const seekTo = (idx: number) => {
    userScrolled.current = false
    useStore.getState().setCurrentIdx(idx)
    window.dispatchEvent(new CustomEvent('dashtrack:seek', { detail: { idx } }))
  }

  return (
    <div className="tile wptile">
      <div className="tile-head">
        <span className="tile-title">Waypoints</span>
        <span className="tile-meta mono">{points.length}</span>
      </div>
      <div className="wp-scroll" ref={scrollRef}>
        {items.map((it, k) => {
          const active = k === activeItem
          const p = points[it.i]
          if (!p) return null
          return (
            <div key={it.i} className={`wp-row${active ? ' active' : ''}`} onClick={() => seekTo(it.i)}>
              <span className="wp-dot" />
              <span className="wp-time mono">
                {p.time ? p.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : `pt ${it.i}`}
              </span>
              <span className="wp-coord mono">{p.lat.toFixed(4)}, {p.lon.toFixed(4)}</span>
              <span className="wp-spd mono">{p.speed > 0 ? String(Math.round(p.speed)) : '·'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
