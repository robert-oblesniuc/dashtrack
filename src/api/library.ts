// In dev, the Vite proxy buffers responses and strips Content-Length / range
// headers, making <video> elements non-seekable. Point directly at the backend
// for footage URLs so the browser gets proper HTTP 206 Range responses.
export const FOOTAGE_BASE = import.meta.env.DEV ? 'http://localhost:8080' : ''

export interface DayEntry {
  date: string  // "YYYY-MM-DD"
  count: number
}

export interface LibraryClip {
  id: string
  filename: string
  channel: 'front' | 'rear' | 'unknown'
  session_id: string | null
  recorded_at: string | null
  duration_sec: number | null
  size_bytes: number
  lat_min: number | null
  lat_max: number | null
  lon_min: number | null
  lon_max: number | null
  max_speed_kmh: number | null
  point_count: number | null
  status: string
  peer_clip_id: string | null
}

export interface LibraryClipDetail extends LibraryClip {
  gpx: string | null
}

export async function fetchDays(
  offset = 0,
  limit = 100,
  dateFrom?: string,
  dateTo?: string,
): Promise<DayEntry[]> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  const res = await fetch(`/api/library/days?${params}`)
  if (!res.ok) throw new Error(`Days fetch failed: ${res.status}`)
  return res.json()
}

export async function fetchLibrary(
  offset = 0,
  limit = 100,
  dateFrom?: string,
  dateTo?: string,
): Promise<LibraryClip[]> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  const res = await fetch(`/api/library?${params}`)
  if (!res.ok) throw new Error(`Library fetch failed: ${res.status}`)
  return res.json()
}

export async function fetchClip(id: string): Promise<LibraryClipDetail> {
  const res = await fetch(`/api/library/${id}`)
  if (!res.ok) throw new Error(`Clip fetch failed: ${res.status}`)
  return res.json()
}

export async function fetchClipBatch(ids: string[]): Promise<LibraryClipDetail[]> {
  if (!ids.length) return []
  const res = await fetch('/api/library/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) throw new Error(`Batch fetch failed: ${res.status}`)
  return res.json()
}

export async function fetchSession(sessionId: string): Promise<LibraryClipDetail[]> {
  const res = await fetch(`/api/library/session/${sessionId}`)
  if (!res.ok) throw new Error(`Session fetch failed: ${res.status}`)
  return res.json()
}

export async function fetchMinitrack(clipId: string, points = 20): Promise<[number, number][]> {
  const res = await fetch(`/api/library/${clipId}/minitrack?points=${points}`)
  if (!res.ok) return []
  return res.json()
}
