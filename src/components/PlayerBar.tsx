import { useRef, useState, useCallback } from 'react'
import { useStore } from '../store'
import { fmtTime } from '../hooks/useGPX'
import Icon from './Icon'

function getPrimaryVideo(): HTMLVideoElement | null {
  return document.querySelector('video[data-channel="primary"]')
    ?? document.querySelector('video')
}

export default function PlayerBar() {
  const {
    videoTime, videoDuration, playing, playbackRate, muted,
    setPlaying, setPlaybackRate, setMuted, setVolume,
    multiSession, activeClipIndex,
  } = useStore()

  const trackRef = useRef<HTMLDivElement>(null)
  const [rate, setRate] = useState(playbackRate)

  const globalTime = (() => {
    if (!multiSession) return videoTime
    const clip = multiSession.clips[activeClipIndex]
    if (!clip) return videoTime
    return clip.videoOffset + (videoTime - clip.trimStart)
  })()

  const totalDuration = multiSession ? multiSession.totalDuration : videoDuration
  const pct = totalDuration ? (globalTime / totalDuration) * 100 : 0

  const toggle = () => {
    const vid = getPrimaryVideo()
    if (vid) {
      if (vid.paused) vid.play().catch(() => {})
      else vid.pause()
    }
    setPlaying(!playing)
  }

  const skip = (sec: number) => {
    const vid = getPrimaryVideo()
    if (vid) vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + sec))
  }

  const cycleRate = () => {
    const rates = [0.5, 1, 2, 4]
    const i = rates.indexOf(rate)
    const nr = rates[(i + 1) % rates.length]
    setRate(nr)
    setPlaybackRate(nr)
  }

  const seekFromPointer = useCallback((clientX: number) => {
    if (!trackRef.current) return
    const r = trackRef.current.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width))

    if (multiSession) {
      const targetT = frac * multiSession.totalDuration
      const { points, idxAtTime } = useStore.getState()
      if (points.length) {
        const idx = idxAtTime(targetT)
        useStore.getState().setCurrentIdx(idx)
        window.dispatchEvent(new CustomEvent('dashtrack:seek', { detail: { idx } }))
      }
    } else {
      const vid = getPrimaryVideo()
      if (vid && vid.duration) vid.currentTime = frac * vid.duration
    }
  }, [multiSession])

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    seekFromPointer(e.clientX)
    const move = (ev: PointerEvent) => seekFromPointer(ev.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="pbar">
      <button className="pbtn pbtn--ghost" onClick={() => skip(-10)} title="Back 10s">
        <Icon name="rewind" size={15} />
      </button>
      <button className="pbtn pbtn--play" onClick={toggle} title="Play/Pause (Space)">
        <Icon name={playing ? 'pause' : 'play'} size={17} style={{ color: '#160f02', marginLeft: playing ? 0 : 2 }} />
      </button>
      <button className="pbtn pbtn--ghost" onClick={() => skip(10)} title="Forward 10s">
        <Icon name="forward" size={15} />
      </button>

      <div className="pbar-time mono">{fmtTime(globalTime)}</div>

      <div className="ptrack" ref={trackRef} onPointerDown={startDrag}>
        <div className="ptrack-fill" style={{ width: pct + '%' }} />
        <div className="ptrack-knob" style={{ left: pct + '%' }} />
      </div>

      <div className="pbar-time mono pbar-dur">{fmtTime(totalDuration)}</div>
      <button className="pbtn pbtn--rate mono" onClick={cycleRate} title="Playback speed">{rate}×</button>
      <button className="pbtn pbtn--ghost" onClick={() => setMuted(!muted)} title="Mute (M)">
        <Icon name={muted ? 'volume-x' : 'volume'} size={15} />
      </button>
    </div>
  )
}
