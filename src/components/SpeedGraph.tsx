import { useMemo } from 'react'
import { useStore } from '../store'

export default function SpeedGraph() {
  const { points, currentIdx } = useStore()

  const geom = useMemo(() => {
    if (!points.length) return null
    const N = points.length
    const maxS = Math.max(1, ...points.map(p => Math.round(p.speed)))
    const step = Math.max(1, Math.floor(N / 180))
    const pts: [number, number][] = []
    for (let i = 0; i < N; i += step) {
      pts.push([(i / (N - 1)) * 100, 100 - (points[i].speed / maxS) * 92 - 4])
    }
    if (pts[pts.length - 1][0] < 100) {
      pts.push([100, 100 - (points[N - 1].speed / maxS) * 92 - 4])
    }
    const line = pts.map(q => q.join(',')).join(' ')
    const area = `0,100 ${line} 100,100`
    return { line, area, maxS }
  }, [points])

  if (!geom || !points.length) return null

  const frac = points.length > 1 ? currentIdx / (points.length - 1) : 0
  const px = frac * 100
  const curS = points[currentIdx]?.speed ?? 0
  const py = 100 - (curS / geom.maxS) * 92 - 4

  const seek = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const clickFrac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    const targetIdx = Math.round(clickFrac * (points.length - 1))
    useStore.getState().setCurrentIdx(targetIdx)
    window.dispatchEvent(new CustomEvent('dashtrack:seek', { detail: { idx: targetIdx } }))
  }

  return (
    <div className="tile graphtile">
      <div className="tile-head">
        <span className="tile-title">Speed</span>
        <span className="tile-meta mono">{Math.round(curS)} km/h</span>
      </div>
      <div className="graph-wrap">
        <div className="graph-axis mono">
          <span>{geom.maxS}</span>
          <span>{Math.round(geom.maxS / 2)}</span>
          <span>0</span>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="spdsvg" onClick={seek}>
          <line x1="0" y1="50" x2="100" y2="50" className="spd-grid" vectorEffect="non-scaling-stroke" />
          <polygon points={geom.area} className="spd-area" />
          <polyline points={geom.line} className="spd-line" vectorEffect="non-scaling-stroke" />
          <line x1={px} y1="0" x2={px} y2="100" className="spd-head" vectorEffect="non-scaling-stroke" />
          <circle cx={px} cy={py} r="2.4" className="spd-dot" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    </div>
  )
}
