import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { SessionClip } from '../store'
import { fetchLibrary, fetchDays, fetchClip, fetchClipBatch, fetchSession, fetchMinitrack, LibraryClip, DayEntry, FOOTAGE_BASE } from '../api/library'
import { parseGPX } from '../hooks/useGPX'
import Icon from './Icon'

type ChannelFilter = 'all' | 'front' | 'rear'
type DisplayItem = { primary: LibraryClip; peer?: LibraryClip }

interface Props {
  onClose: () => void
  initialTab?: 'library' | 'upload'
  checked: Set<string>
  setChecked: React.Dispatch<React.SetStateAction<Set<string>>>
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function Calendar({ month, setMonth, footage, selected, onSelect }: {
  month: Date; setMonth: (d: Date) => void
  footage: Set<string>; selected: string | null; onSelect: (d: string | null) => void
}) {
  const y = month.getFullYear(), m = month.getMonth()
  const startDow = (new Date(y, m, 1).getDay() + 6) % 7
  const numDays = new Date(y, m + 1, 0).getDate()
  const cells: (Date | null)[] = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= numDays; d++) cells.push(new Date(y, m, d))
  const key = (d: Date) => d.toISOString().slice(0, 10)

  return (
    <div className="cal">
      <div className="cal-head">
        <button className="cal-nav" onClick={() => setMonth(new Date(y, m - 1, 1))}><Icon name="chevron-left" size={15} /></button>
        <span className="cal-title">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button className="cal-nav" onClick={() => setMonth(new Date(y, m + 1, 1))}><Icon name="chevron-right" size={15} /></button>
      </div>
      <div className="cal-dow">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="cal-grid">
        {cells.map((d, i) => {
          if (!d) return <span key={i} className="cal-cell cal-cell--empty" />
          const k = key(d)
          const has = footage.has(k)
          const sel = selected === k
          return (
            <button key={i} className={`cal-cell ${has ? 'has' : ''} ${sel ? 'sel' : ''}`}
              onClick={() => onSelect(sel ? null : k)} disabled={!has}>
              {d.getDate()}{has && <span className="cal-dot" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Mini route thumbnail ──────────────────────────────────────────────────────
const minitrackCache = new Map<string, [number, number][]>()

function MiniRoute({ clipId }: { clipId: string }) {
  const [pts, setPts] = useState<[number, number][] | null>(
    minitrackCache.has(clipId) ? minitrackCache.get(clipId)! : null
  )

  useEffect(() => {
    if (minitrackCache.has(clipId)) { setPts(minitrackCache.get(clipId)!); return }
    let cancelled = false
    fetchMinitrack(clipId, 24).then(data => {
      if (!cancelled) { minitrackCache.set(clipId, data); setPts(data) }
    })
    return () => { cancelled = true }
  }, [clipId])

  const path = useMemo(() => {
    if (!pts || pts.length < 2) return null
    const w = 96, h = 60
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
    pts.forEach(([lat, lon]) => { minx = Math.min(minx, lon); miny = Math.min(miny, -lat); maxx = Math.max(maxx, lon); maxy = Math.max(maxy, -lat) })
    const bw = (maxx - minx) || 1, bh = (maxy - miny) || 1
    const s = Math.min((w - 16) / bw, (h - 16) / bh)
    const ox = (w - bw * s) / 2 - minx * s, oy = (h - bh * s) / 2 - miny * s
    return 'M' + pts.map(([lat, lon]) => `${(lon * s + ox).toFixed(1)},${(-lat * s + oy).toFixed(1)}`).join('L')
  }, [pts])

  return (
    <svg className="miniroute" viewBox="0 0 96 60" width={96} height={60}>
      {path
        ? <path d={path} className="miniroute-line" vectorEffect="non-scaling-stroke" fill="none" />
        : <g className="miniroute-rear"><rect x="6" y="6" width={84} height={48} rx="6" /><text x={48} y={34}>—</text></g>}
    </svg>
  )
}

// ── LibraryModal ──────────────────────────────────────────────────────────────
export default function LibraryModal({ onClose, initialTab = 'library', checked, setChecked }: Props) {
  const { loadLibraryClip, loadSession, buildMultiSession } = useStore()
  const [tab, setTab] = useState<'library' | 'upload'>(initialTab)

  // ── Pagination state ──
  const DAYS_PAGE = 30
  const CLIPS_PAGE = 50
  const [days, setDays] = useState<DayEntry[]>([])
  const [daysLoading, setDaysLoading] = useState(true)
  const [daysHasMore, setDaysHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const daysOffsetRef = useRef(0)

  // Per-day clips (lazy loaded on expand)
  const [dayClips, setDayClips] = useState<Record<string, LibraryClip[]>>({})
  const [dayLoading, setDayLoading] = useState<Record<string, boolean>>({})
  const [dayHasMore, setDayHasMore] = useState<Record<string, boolean>>({})
  const dayLoadingRef = useRef(new Set<string>())
  const dayOffsetRef = useRef<Record<string, number>>({})
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set())

  // Calendar dots (all dates, fetched once)
  const [recordingDates, setRecordingDates] = useState<Set<string>>(new Set())
  useEffect(() => {
    fetchDays(0, 10000).then(data => setRecordingDates(new Set(data.map(d => d.date)))).catch(() => {})
  }, [])

  // Sidebar filters
  const [calMonth, setCalMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [preset, setPreset] = useState<string>('all')
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all')
  const listRef = useRef<HTMLDivElement>(null)

  const dateRange = useMemo<{ from?: string; to?: string }>(() => {
    if (selectedDate) return { from: selectedDate, to: selectedDate }
    const now = new Date()
    const fmt = (d: Date) => d.toISOString().slice(0, 10)
    if (preset === 'today') return { from: fmt(now), to: fmt(now) }
    if (preset === '7') { const f = new Date(now); f.setDate(f.getDate() - 7); return { from: fmt(f), to: fmt(now) } }
    if (preset === '30') { const f = new Date(now); f.setDate(f.getDate() - 30); return { from: fmt(f), to: fmt(now) } }
    return {}
  }, [selectedDate, preset])

  // ── Fetch days (paginated) ──
  const fetchDaysPage = useCallback(async (reset: boolean) => {
    const offset = reset ? 0 : daysOffsetRef.current
    if (!reset && !daysHasMore) return
    setDaysLoading(true)
    try {
      const data = await fetchDays(offset, DAYS_PAGE, dateRange.from, dateRange.to)
      if (reset) {
        setDays(data)
        setDayClips({}); setDayHasMore({}); setExpandedDays(new Set())
        dayOffsetRef.current = {}
      } else {
        setDays(prev => [...prev, ...data])
      }
      setDaysHasMore(data.length === DAYS_PAGE)
      daysOffsetRef.current = offset + DAYS_PAGE
      setError(null)

      // Auto-expand first 3 days on initial load
      if (reset && data.length > 0) {
        const toExpand = data.slice(0, 3).map(d => d.date)
        setExpandedDays(new Set(toExpand))
        toExpand.forEach(date => fetchClipsPage(date, true))
      }
    } catch (e: any) { setError(e.message) }
    finally { setDaysLoading(false) }
  }, [dateRange.from, dateRange.to, daysHasMore])

  useEffect(() => { fetchDaysPage(true) }, [dateRange.from, dateRange.to])

  // ── Fetch clips for a day (paginated) ──
  const fetchClipsPage = useCallback(async (date: string, reset = false) => {
    if (dayLoadingRef.current.has(date)) return
    dayLoadingRef.current.add(date)
    setDayLoading(prev => ({ ...prev, [date]: true }))
    const offset = reset ? 0 : (dayOffsetRef.current[date] ?? 0)
    try {
      const data = await fetchLibrary(offset, CLIPS_PAGE, date, date)
      setDayClips(prev => ({ ...prev, [date]: reset ? data : [...(prev[date] ?? []), ...data] }))
      setDayHasMore(prev => ({ ...prev, [date]: data.length === CLIPS_PAGE }))
      dayOffsetRef.current[date] = offset + data.length
    } catch (e: any) { setError(e.message) }
    finally { dayLoadingRef.current.delete(date); setDayLoading(prev => { const n = { ...prev }; delete n[date]; return n }) }
  }, [])

  const toggleDay = (date: string) => {
    setExpandedDays(prev => {
      const n = new Set(prev)
      if (n.has(date)) { n.delete(date) } else { n.add(date); if (!dayClips[date]) fetchClipsPage(date, true) }
      return n
    })
  }

  // ── Infinite scroll ──
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      if (daysHasMore && !daysLoading) fetchDaysPage(false)
    }
  }, [daysHasMore, daysLoading, fetchDaysPage])

  // ── Display items (deduplicated, paired, filtered) ──
  const dayDisplayItems = useMemo<Record<string, DisplayItem[]>>(() => {
    const result: Record<string, DisplayItem[]> = {}
    for (const day of days) {
      const clips = dayClips[day.date] ?? []
      if (!clips.length) { result[day.date] = []; continue }
      const seen = new Set<string>(); const clipMap = new Map(clips.map(c => [c.id, c])); const items: DisplayItem[] = []
      for (const clip of clips) {
        if (seen.has(clip.id)) continue; seen.add(clip.id)
        if (clip.peer_clip_id && !seen.has(clip.peer_clip_id)) {
          const peer = clipMap.get(clip.peer_clip_id)
          if (peer) { seen.add(peer.id); items.push(clip.channel === 'front' ? { primary: clip, peer } : { primary: peer, peer: clip }); continue }
        }
        items.push({ primary: clip })
      }
      result[day.date] = channelFilter === 'front' ? items.filter(i => i.primary.channel === 'front')
        : channelFilter === 'rear' ? items.filter(i => i.primary.channel === 'rear' || !!i.peer)
        : items
    }
    return result
  }, [days, dayClips, channelFilter])

  const itemKey = (item: DisplayItem) => item.primary.session_id ?? item.primary.id
  const allDisplayItems = useMemo(() => days.flatMap(d => dayDisplayItems[d.date] ?? []), [days, dayDisplayItems])
  const checkedItems = useMemo(() => allDisplayItems.filter(item => checked.has(itemKey(item))), [checked, allDisplayItems])

  const toggleCheck = (item: DisplayItem) => {
    const key = itemKey(item)
    setChecked(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  // ── Select day / select all ──
  const selectDay = (date: string) => {
    const items = dayDisplayItems[date] ?? []
    const keys = items.map(itemKey)
    const allChecked = keys.every(k => checked.has(k))
    setChecked(prev => {
      const n = new Set(prev)
      if (allChecked) keys.forEach(k => n.delete(k))
      else keys.forEach(k => n.add(k))
      return n
    })
  }

  const selectAll = () => {
    const allKeys = allDisplayItems.map(itemKey)
    const allChecked = allKeys.every(k => checked.has(k))
    setChecked(allChecked ? new Set() : new Set(allKeys))
  }

  // ── Load handlers ──
  const loadSingle = async (clip: LibraryClip) => {
    setLoadingId(clip.id)
    try { const detail = await fetchClip(clip.id); loadLibraryClip(detail); onClose() }
    catch (e: any) { setError(e.message) } finally { setLoadingId(null) }
  }

  const loadBoth = async (item: DisplayItem) => {
    if (!item.peer || !item.primary.session_id) { loadSingle(item.primary); return }
    setLoadingId(item.primary.id)
    try { const sc = await fetchSession(item.primary.session_id); loadSession(sc); onClose() }
    catch (e: any) { setError(e.message) } finally { setLoadingId(null) }
  }

  const handleMultiLoad = async () => {
    if (checkedItems.length === 1) { loadBoth(checkedItems[0]); return }
    const sorted = [...checkedItems].sort((a, b) => (a.primary.recorded_at ?? '').localeCompare(b.primary.recorded_at ?? ''))
    setLoadingId('multi')
    try {
      const primaryIds = sorted.map(item => item.primary.id)
      const details = await fetchClipBatch(primaryIds); const detailMap = new Map(details.map(d => [d.id, d]))
      const sessionClips: SessionClip[] = []
      for (const item of sorted) {
        const detail = detailMap.get(item.primary.id); if (!detail) continue
        const dur = detail.duration_sec ?? 0
        sessionClips.push({
          clipId: item.primary.id, channel: item.primary.channel, trimStart: 0, trimEnd: dur,
          videoUrl: `${FOOTAGE_BASE}/api/footage/${item.primary.id}`,
          peerVideoUrl: item.peer ? `${FOOTAGE_BASE}/api/footage/${item.peer.id}` : undefined,
          gpxPoints: detail.gpx ? parseGPX(detail.gpx) : [], videoOffset: 0, color: '',
          filename: item.primary.filename, recordedAt: item.primary.recorded_at,
        })
      }
      buildMultiSession(sessionClips); onClose()
    } catch (e: any) { setError(e.message) } finally { setLoadingId(null) }
  }

  // Upload handler
  const handleUploadFile = (file: File) => {
    const { setVideoFile, setExtractionStatus, setExtractionProgress, setExtractionError, setPoints } = useStore.getState()
    setVideoFile(file); setExtractionError(null); setExtractionStatus('uploading'); setExtractionProgress(0)
    const form = new FormData(); form.append('file', file)
    fetch('/api/extract/start', { method: 'POST', body: form })
      .then(res => { if (!res.ok) throw new Error('Upload failed'); return res.json() })
      .then(({ job_id }) => {
        setExtractionStatus('extracting')
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/extract/${job_id}`)
        ws.onmessage = ev => {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'progress') setExtractionProgress(msg.points)
          else if (msg.type === 'done') { setPoints(parseGPX(msg.gpx)); setExtractionStatus('done'); setExtractionProgress(msg.stats.points); ws.close(); onClose() }
          else if (msg.type === 'error') { setExtractionError(msg.message); setExtractionStatus('error'); ws.close() }
        }
        ws.onerror = () => { setExtractionError('Connection error'); setExtractionStatus('error') }
      })
      .catch(err => { setExtractionError(err.message); setExtractionStatus('error') })
  }

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])

  // ── Render ──
  return (
    <div className="modal-scrim" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal lib" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="lib-top">
          <div className="seg lib-tabs">
            <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>Library</button>
            <button className={tab === 'upload' ? 'on' : ''} onClick={() => setTab('upload')}>Add video</button>
          </div>
          <div className="lib-spacer" />
          {tab === 'library' && allDisplayItems.length > 0 && (
            <button className="chipbtn" onClick={selectAll} style={{ fontSize: 11, padding: '4px 10px' }}>
              {allDisplayItems.every(item => checked.has(itemKey(item))) ? 'Deselect all' : 'Select all'}
            </button>
          )}
          <button className="iconbtn" onClick={onClose} title="Close"><Icon name="x" size={15} /></button>
        </div>

        {/* Library tab */}
        {tab === 'library' ? (
          <div className="lib-body">
            <aside className="lib-side">
              <Calendar month={calMonth} setMonth={setCalMonth} footage={recordingDates}
                selected={selectedDate} onSelect={d => { setSelectedDate(d); setPreset('custom') }} />
              <div className="lib-group-label">Quick ranges</div>
              <div className="lib-presets">
                {[['all', 'All'], ['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days']].map(([k, l]) => (
                  <button key={k} className={`chipbtn ${preset === k && !selectedDate ? 'on' : ''}`}
                    onClick={() => { setPreset(k); setSelectedDate(null) }}>{l}</button>
                ))}
              </div>
              <div className="lib-group-label">Channel</div>
              <div className="seg">
                {([['all', 'All'], ['front', 'Front'], ['rear', 'Rear']] as const).map(([k, l]) => (
                  <button key={k} className={channelFilter === k ? 'on' : ''} onClick={() => setChannelFilter(k as ChannelFilter)}>{l}</button>
                ))}
              </div>
            </aside>

            <div className="lib-results" ref={listRef} onScroll={handleScroll}>
              {daysLoading && days.length === 0 && <div className="lib-empty">Loading library…</div>}
              {error && !daysLoading && (
                <div style={{ padding: 20, color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.9 }}>
                  ✗ {error}<br />
                  <span style={{ color: 'var(--txt3)', fontSize: 10 }}>Make sure footage is mounted:<br /><code style={{ color: 'var(--txt2)' }}>-v /your/footage:/footage</code></span>
                </div>
              )}
              {!daysLoading && !error && days.length === 0 && (
                <div className="lib-empty">No footage for this filter.</div>
              )}

              {days.map(day => {
                const items = dayDisplayItems[day.date] ?? []
                const isExpanded = expandedDays.has(day.date)
                const isLoading = !!dayLoading[day.date]
                const hasMore = !!dayHasMore[day.date]
                const dayKeys = items.map(itemKey)
                const dayCheckedCount = dayKeys.filter(k => checked.has(k)).length
                const dayAllChecked = dayKeys.length > 0 && dayCheckedCount === dayKeys.length

                return (
                  <div className="lib-day" key={day.date}>
                    <div className="lib-day-head" style={{ cursor: 'pointer', alignItems: 'center' }} onClick={() => toggleDay(day.date)}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon name={isExpanded ? 'chevron-left' : 'chevron-right'} size={13}
                          style={{ transform: isExpanded ? 'rotate(-90deg)' : 'none', transition: '.15s', color: 'var(--txt3)' }} />
                        {formatDate(day.date)}
                      </span>
                      <span className="lib-day-count mono" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {day.count} clip{day.count !== 1 ? 's' : ''}
                        {isExpanded && items.length > 0 && (
                          <button className="chipbtn" onClick={e => { e.stopPropagation(); selectDay(day.date) }}
                            style={{ fontSize: 9, padding: '2px 7px' }}>
                            {dayAllChecked ? 'Deselect' : 'Select day'}
                          </button>
                        )}
                      </span>
                    </div>

                    {isExpanded && (
                      <div className="lib-cards">
                        {isLoading && items.length === 0 && (
                          <div style={{ padding: 14, color: 'var(--txt3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>Loading…</div>
                        )}
                        {items.map(item => {
                          const key = itemKey(item)
                          const isChecked = checked.has(key)
                          return (
                            <div key={key} className={`clipcard ${isChecked ? 'checked' : ''}`} onClick={() => loadBoth(item)}>
                              <label className="clip-check" onClick={e => e.stopPropagation()}>
                                <input type="checkbox" checked={isChecked} onChange={() => toggleCheck(item)} />
                              </label>
                              <div className="clip-thumb">
                                <MiniRoute clipId={item.primary.id} />
                              </div>
                              <div className="clip-meta">
                                <div className="clip-time mono">
                                  {item.primary.recorded_at
                                    ? new Date(item.primary.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
                                    : '—'}
                                </div>
                                <div className="clip-badges">
                                  <span className="badge badge--f">FRONT</span>
                                  {item.peer && <span className="badge badge--r">REAR</span>}
                                </div>
                                <div className="clip-stats mono">
                                  {item.primary.max_speed_kmh != null && `${Math.round(item.primary.max_speed_kmh)} km/h`}
                                  {item.primary.duration_sec != null && ` · ${fmtDur(item.primary.duration_sec)}`}
                                </div>
                              </div>
                              <div className="clip-load">Load <Icon name="chevron-right" size={13} /></div>
                            </div>
                          )
                        })}
                        {hasMore && (
                          <button className="chipbtn" onClick={e => { e.stopPropagation(); fetchClipsPage(day.date) }}
                            disabled={isLoading} style={{ margin: '4px 0', textAlign: 'center' }}>
                            {isLoading ? 'Loading…' : 'Load more clips'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}

              {daysLoading && days.length > 0 && (
                <div style={{ padding: 14, textAlign: 'center', color: 'var(--txt3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>Loading more days…</div>
              )}
            </div>
          </div>
        ) : (
          /* Upload tab */
          <div className="lib-upload">
            <div className="uz"
              onClick={() => document.getElementById('lib-file-input')?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('drag') }}
              onDragLeave={e => e.currentTarget.classList.remove('drag')}
              onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) handleUploadFile(f) }}
            >
              <div className="uz-ic"><Icon name="upload" size={36} /></div>
              <div className="uz-title">Drop a Viofo <b>.MP4</b> here</div>
              <div className="uz-sub mono">GPS is extracted automatically from the file</div>
            </div>
            <div className="uz-note mono">freeGPS blocks · NT96660 · no FFmpeg required</div>
            <input id="lib-file-input" type="file" accept="video/*" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadFile(f) }} />
          </div>
        )}

        {/* Footer — multi-select */}
        {checkedItems.length > 0 && (
          <div className="lib-foot">
            <span className="mono">{checkedItems.length} selected</span>
            <button className="ghostbtn" onClick={() => setChecked(new Set())}>Clear</button>
            <div className="lib-spacer" />
            <button className="primarybtn" onClick={handleMultiLoad}>
              Build route <Icon name="route" size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Helpers ──
function fmtDur(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}` }
function formatDate(dateStr: string) {
  if (dateStr === 'Unknown') return 'Unknown date'
  try { const d = new Date(dateStr + 'T00:00:00'); return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) }
  catch { return dateStr }
}
