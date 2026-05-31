import { useStore } from '../store'

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export default function Hud() {
  const { points, currentIdx } = useStore()
  const p = points[currentIdx]
  if (!p) return null

  const spd = Math.round(p.speed)
  const brg = p.bearing
  const moving = spd > 1
  const dir = DIRS[Math.round(brg / 45) % 8]

  return (
    <div className="hud">
      <div className="hud-speed">
        <span className="hud-num">{spd}</span>
        <span className="hud-unit">km/h</span>
      </div>
      <div className="hud-divider" />
      <div className="hud-comp">
        <svg viewBox="0 0 64 64" className="compass">
          <circle cx="32" cy="32" r="29" className="comp-ring" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map(a => (
            <line
              key={a} x1="32" y1="5" x2="32" y2={a % 90 === 0 ? 11 : 9}
              className={a % 90 === 0 ? 'comp-tick comp-tick--major' : 'comp-tick'}
              transform={`rotate(${a} 32 32)`}
            />
          ))}
          <text x="32" y="15" className="comp-n">N</text>
          <g transform={`rotate(${brg} 32 32)`} className={moving ? '' : 'comp-still'}>
            <path d="M32,15 L37,36 L32,31 L27,36 Z" className="comp-needle" />
          </g>
        </svg>
        <div className="hud-dir mono">{dir}<span>{Math.round(brg)}°</span></div>
      </div>
    </div>
  )
}
