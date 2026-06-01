import { useMemo } from 'react'
import { useStore } from '../store'
import { totalDistance, fmtDuration } from '../hooks/useGPX'

export default function StatsTile() {
  const { points, currentIdx, multiSession, videoDuration } = useStore()

  const stats = useMemo(() => {
    if (!points.length) return null
    const dist = totalDistance(points)
    const speeds = points.map(p => p.speed).filter(s => s > 0)
    const maxSpd = speeds.length ? Math.round(Math.max(...speeds)) : 0
    const avgSpd = speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : 0
    const first = points[0], last = points[points.length - 1]
    // Mirror the player bar's timeline (store.videoDuration) so the two
    // always agree. GPX from the extractor has no <time>, only <video_sec>,
    // so fall back to the GPS span only when no video duration is known.
    const dur = multiSession ? multiSession.totalDuration
      : videoDuration > 0 ? videoDuration
      : first.time && last.time ? (last.time.getTime() - first.time.getTime()) / 1000
      : last.videoSec - first.videoSec
    return { dist, maxSpd, avgSpd, dur, pts: points.length, fixRate: Math.round((speeds.length / points.length) * 100) }
  }, [points, multiSession, videoDuration])

  if (!stats) return null

  const frac = points.length > 1 ? currentIdx / (points.length - 1) : 0
  const covered = stats.dist * frac
  const fmtDist = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
  const fmtDistParts = (m: number): [string, string] => m >= 1000 ? [(m / 1000).toFixed(1), 'km'] : [String(Math.round(m)), 'm']
  const fmtDur = (s: number) => {
    if (s <= 0) return '—'
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
  }

  const [distVal, distUnit] = fmtDistParts(stats.dist)
  const cells: [string, string, string][] = [
    ['Distance', distVal, distUnit],
    ['Max', String(stats.maxSpd), 'km/h'],
    ['Average', String(stats.avgSpd), 'km/h'],
    ['Duration', stats.dur > 0 ? fmtDur(stats.dur) : (fmtDuration(0) || '—'), ''],
    ['GPS fix', String(stats.fixRate), '%'],
    ['Points', String(stats.pts), ''],
  ]

  return (
    <div className="tile statstile">
      <div className="tile-head"><span className="tile-title">Trip stats</span></div>
      <div className="stat-grid">
        {cells.map(([label, val, unit]) => (
          <div className="stat-cell" key={label}>
            <div className="stat-val mono">{val}{unit && <span className="stat-unit"> {unit}</span>}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>
      <div className="prog-row">
        <div className="prog-bar"><div className="prog-fill" style={{ width: (frac * 100).toFixed(1) + '%' }} /></div>
        <div className="prog-text mono">{Math.round(frac * 100)}% · {fmtDist(covered)}</div>
      </div>
    </div>
  )
}
