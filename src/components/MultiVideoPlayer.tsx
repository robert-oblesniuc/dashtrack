import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import VideoChannel from './VideoChannel'
import Icon from './Icon'

export default function MultiVideoPlayer() {
  const {
    channels, primaryChannelId, setPrimaryChannelId, videoLayout, setVideoLayout,
    channelFilter,
    videoUrl, videoTime, playing, playbackRate, volume, muted, videoDuration,
    setActiveClipIndex,
    setVideoDuration, setVideoTime, setPlaying, setPlaybackRate,
    setVolume, setMuted, idxAtTime, setCurrentIdx,
  } = useStore()

  const playerRef    = useRef<HTMLDivElement>(null)
  const vidRefs      = useRef<Map<string, HTMLVideoElement>>(new Map())
  const refCallbacks = useRef(new Map<string, (el: HTMLVideoElement | null) => void>())
  const isSeeking    = useRef(false)
  const intendedSrcs = useRef<Map<HTMLVideoElement, string>>(new Map())
  const [videoAspectRatio, setVideoAspectRatio] = useState('16/9')

  const allChannels = channels.length > 0
    ? channels
    : videoUrl
      ? [{ id: 'upload', clipId: null as null, videoUrl, videoDuration, label: '' }]
      : []

  const displayChannels = channelFilter === 'all'
    ? allChannels
    : allChannels.filter(ch => ch.id === channelFilter || ch.id === 'upload')
  const hasBothChannels = allChannels.length > 1
  const isPip           = videoLayout === 'pip' && displayChannels.length > 1
  const isSideBySide    = videoLayout === 'side-by-side' && displayChannels.length > 1

  const switchSrc = (vid: HTMLVideoElement, url: string, seekTime?: number) => {
    if (intendedSrcs.current.get(vid) !== url) {
      intendedSrcs.current.set(vid, url)
      const t = seekTime ?? vid.currentTime
      const wasPlaying = !vid.paused
      vid.src = url
      vid.addEventListener('loadedmetadata', () => {
        if (intendedSrcs.current.get(vid) !== url) return
        vid.currentTime = t
        if (wasPlaying) vid.play().catch(() => {})
      }, { once: true })
    } else if (seekTime !== undefined) {
      programmaticSeek(vid, seekTime)
    }
  }

  const programmaticSeek = (vid: HTMLVideoElement, time: number) => {
    isSeeking.current = true
    vid.addEventListener('seeked', () => {
      isSeeking.current = false
      const t = vid.currentTime
      setVideoTime(t)
      const { multiSession: ms, activeClipIndex: aci } = useStore.getState()
      const globalT = ms && aci < ms.clips.length
        ? ms.clips[aci].videoOffset + (t - ms.clips[aci].trimStart)
        : t
      setCurrentIdx(idxAtTime(globalT))
      vidRefs.current.forEach((sv) => {
        if (sv !== vid) sv.currentTime = t
      })
    }, { once: true })
    vid.currentTime = time
  }

  const getPrimaryVid = (): HTMLVideoElement | undefined =>
    vidRefs.current.get(primaryChannelId)
    ?? vidRefs.current.values().next().value as HTMLVideoElement | undefined

  // Sync play/pause
  useEffect(() => {
    vidRefs.current.forEach(v => {
      if (playing) v.play().catch(() => {})
      else v.pause()
    })
  }, [playing])

  // Sync playback rate
  useEffect(() => {
    vidRefs.current.forEach(v => { v.playbackRate = playbackRate })
  }, [playbackRate])

  // Audio: only primary channel plays audio
  useEffect(() => {
    vidRefs.current.forEach((v, id) => {
      const isPrimary = id === primaryChannelId || vidRefs.current.size === 1
      v.volume = isPrimary ? volume : 0
      v.muted  = isPrimary ? muted  : true
    })
  }, [volume, muted, primaryChannelId])

  // Seek event handler
  useEffect(() => {
    const handler = (e: Event) => {
      const { idx } = (e as CustomEvent).detail
      const { points, multiSession } = useStore.getState()
      if (!points.length) return

      if (multiSession) {
        const { clips, clipPointOffsets } = multiSession
        let clipIdx = clips.length - 1
        for (let i = 0; i < clips.length; i++) {
          if (idx < (clipPointOffsets[i + 1] ?? Infinity)) { clipIdx = i; break }
        }
        const clip = clips[clipIdx]
        const localPoint = clip.gpxPoints[idx - clipPointOffsets[clipIdx]]
        if (!localPoint) return
        setActiveClipIndex(clipIdx)
        const vid = getPrimaryVid()
        if (vid) {
          switchSrc(vid, clip.videoUrl, localPoint.videoSec)
          if (useStore.getState().playing) vid.play().catch(() => {})
        }
        if (clip.peerVideoUrl) {
          const peerChannelId = clip.channel === 'front' ? 'rear' : 'front'
          const peerVid = vidRefs.current.get(peerChannelId)
          if (peerVid) switchSrc(peerVid, clip.peerVideoUrl, localPoint.videoSec)
        }
        return
      }

      const p = points[idx]
      if (!p) return
      const vid = getPrimaryVid()
      if (!vid) return
      const preciseSync = points.some(pt => pt.videoSec > 0)
      const seekTime = preciseSync ? p.videoSec : (idx / (points.length - 1)) * (vid.duration || 0)
      programmaticSeek(vid, seekTime)
    }

    window.addEventListener('dashtrack:seek', handler)
    return () => window.removeEventListener('dashtrack:seek', handler)
  }, [primaryChannelId, setActiveClipIndex])

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    if (v.dataset.channel !== 'primary') return
    if (isSeeking.current || v.seeking) return

    const t = v.currentTime
    setVideoTime(t)

    const { multiSession: ms, activeClipIndex: aci } = useStore.getState()
    const globalT = ms && aci < ms.clips.length
      ? ms.clips[aci].videoOffset + (t - ms.clips[aci].trimStart)
      : t
    setCurrentIdx(idxAtTime(globalT))

    const SYNC_THRESHOLD = 0.1
    vidRefs.current.forEach((sv, id) => {
      if (id === primaryChannelId) return
      if (Math.abs(sv.currentTime - t) > SYNC_THRESHOLD) sv.currentTime = t
    })

    if (ms) {
      const clip = ms.clips[aci]
      if (clip && t >= clip.trimEnd - 0.15) advanceClip()
    }
  }

  const advanceClip = () => {
    const { multiSession, activeClipIndex, playing } = useStore.getState()
    if (!multiSession) return
    const nextIdx = activeClipIndex + 1
    if (nextIdx >= multiSession.clips.length) { setPlaying(false); return }
    const nextClip = multiSession.clips[nextIdx]
    setActiveClipIndex(nextIdx)
    const vid = getPrimaryVid()
    if (vid) {
      switchSrc(vid, nextClip.videoUrl, nextClip.trimStart)
      if (playing) vid.play().catch(() => {})
    }
    if (nextClip.peerVideoUrl) {
      const peerChannelId = nextClip.channel === 'front' ? 'rear' : 'front'
      const peerVid = vidRefs.current.get(peerChannelId)
      if (peerVid) {
        switchSrc(peerVid, nextClip.peerVideoUrl, nextClip.trimStart)
        if (playing) peerVid.play().catch(() => {})
      }
    }
  }

  const setRef = useCallback((id: string) => {
    if (!refCallbacks.current.has(id)) {
      refCallbacks.current.set(id, (el: HTMLVideoElement | null) => {
        if (el) {
          vidRefs.current.set(id, el)
          const { primaryChannelId: pid } = useStore.getState()
          if (id !== pid) {
            const primaryVid = vidRefs.current.get(pid) ?? [...vidRefs.current.values()][0]
            if (primaryVid && primaryVid !== el) el.currentTime = primaryVid.currentTime
          }
        } else {
          vidRefs.current.delete(id)
        }
      })
    }
    return refCallbacks.current.get(id)!
  }, [])

  if (!displayChannels.length && !allChannels.length) return null

  const channelProps = (ch: typeof allChannels[0], i: number) => ({
    ref: setRef(ch.id),
    videoUrl: ch.videoUrl!,
    channelId: ch.id,
    isPrimary: ch.id === primaryChannelId || i === 0,
    label: hasBothChannels ? ch.label : undefined,
    aspectRatio: videoAspectRatio,
    onTimeUpdate: handleTimeUpdate,
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLVideoElement>) => {
      if (ch.id === primaryChannelId || i === 0) {
        const vid = e.currentTarget as HTMLVideoElement
        setVideoDuration(vid.duration)
        if (vid.videoWidth && vid.videoHeight)
          setVideoAspectRatio(`${vid.videoWidth}/${vid.videoHeight}`)
      }
    },
    onPlay:  () => { if (ch.id === primaryChannelId || i === 0) setPlaying(true)  },
    onPause: () => { if (ch.id === primaryChannelId || i === 0) setPlaying(false) },
    onEnded: () => { if (ch.id === primaryChannelId || i === 0) setPlaying(false) },
  })

  const channelContainerStyle = (ch: typeof allChannels[0], i: number): React.CSSProperties => {
    const visible = channelFilter === 'all' || ch.id === channelFilter || ch.id === 'upload'
    if (!visible) return { display: 'none' }
    const isPrimaryChannel = isPip ? ch.id === primaryChannelId : (ch.id === primaryChannelId || i === 0)
    if (isPip) {
      return isPrimaryChannel
        ? { position: 'absolute', inset: 0, flex: 'none' }
        : {
            position: 'absolute', bottom: 8, right: 8, width: '28%', zIndex: 10,
            border: '2px solid rgba(255,255,255,.25)', borderRadius: 5,
            overflow: 'hidden', boxShadow: '0 2px 12px rgba(0,0,0,.7)', flex: 'none',
          }
    }
    return isSideBySide ? { flex: '1 1 0', minHeight: 0 } : {}
  }

  const cycleLayout = () => {
    const next: Record<string, string> = { 'single': 'side-by-side', 'side-by-side': 'pip', 'pip': 'single' }
    setVideoLayout(next[videoLayout] as any)
  }

  return (
    <div
      ref={playerRef}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}
    >
      <div style={{
        display: 'flex',
        flexDirection: isSideBySide ? 'row' : 'column',
        flex: '1 1 0',
        minHeight: 0,
        background: '#000',
        position: 'relative',
      }}>
        {allChannels.map((ch, i) => (
          <VideoChannel
            key={ch.id} {...channelProps(ch, i)}
            fillHeight={isPip ? (ch.id === primaryChannelId || i === 0) : true}
            containerStyle={channelContainerStyle(ch, i)}
          />
        ))}

        {/* Overlay controls for channel layout */}
        {hasBothChannels && (
          <div className="vtile-ctl" onClick={e => e.stopPropagation()}>
            <div className="seg seg--mini">
              <button className={videoLayout === 'pip' ? 'on' : ''} onClick={() => setVideoLayout('pip')} title="PiP"><Icon name="pip" size={14} /></button>
              <button className={videoLayout === 'side-by-side' ? 'on' : ''} onClick={() => setVideoLayout('side-by-side')} title="Split"><Icon name="split" size={14} /></button>
            </div>
            {isPip && (
              <button className="vbtn" onClick={() => {
                const other = allChannels.find(c => c.id !== primaryChannelId)
                if (other) setPrimaryChannelId(other.id)
              }} title="Swap focus"><Icon name="swap" size={14} /></button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
