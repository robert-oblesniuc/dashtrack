import { useEffect, useRef, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { useStore, GPSPoint } from '../store'
import { haversine } from '../hooks/useGPX'
import type { MultiSegmentSession } from '../store'

// Token set at runtime via /api/config — see initToken() below
let tokenReady: Promise<void> | null = null

function initToken() {
  if (tokenReady) return tokenReady
  // Use build-time env var if available (dev mode), otherwise fetch from backend
  const buildToken = import.meta.env.VITE_MAPBOX_TOKEN
  if (buildToken) {
    mapboxgl.accessToken = buildToken
    tokenReady = Promise.resolve()
  } else {
    tokenReady = fetch('/api/config')
      .then(r => r.json())
      .then(cfg => { mapboxgl.accessToken = cfg.mapboxToken || '' })
      .catch(() => { mapboxgl.accessToken = '' })
  }
  return tokenReady
}

const GAP_THRESHOLD_M = 500
const GAP_THRESHOLD_S = 120
const MAX_ROUTE_PTS = 2000
const SEGMENT_COLORS = ['#f5c542', '#00e5a0', '#4da6ff', '#ff6b6b', '#c084fc', '#fb923c']

/** Uniform-sample coords down to maxPts. Always includes the last point. */
function decimateCoords(coords: number[][], maxPts: number): number[][] {
  if (coords.length <= maxPts) return coords
  const result: number[][] = new Array(maxPts)
  const step = (coords.length - 1) / (maxPts - 1)
  for (let i = 0; i < maxPts; i++) result[i] = coords[Math.round(i * step)]
  result[maxPts - 1] = coords[coords.length - 1]
  return result
}

// ── Visual segment ─────────────────────────────────────────────────────────
// Groups consecutive SessionClips that are geographically/temporally
// contiguous into a single map object. Only creates a new visual segment
// when there is a real gap between clips.

interface VisualSegment {
  idx: number              // visual segment index (used for layer IDs)
  pointOffset: number      // start index in flat points[]
  pointEnd: number         // end index (exclusive) in flat points[]
  coords: number[][]       // decimated coords for background route source
  color: string
}

function buildVisualSegments(ms: MultiSegmentSession, totalPoints: number): VisualSegment[] {
  const { clips, clipPointOffsets } = ms
  const vsegs: VisualSegment[] = []
  let segStart = 0

  const flush = (segEnd: number) => {
    const rawCoords: number[][] = []
    for (let j = segStart; j <= segEnd; j++) {
      for (const p of clips[j].gpxPoints) rawCoords.push([p.lon, p.lat])
    }
    if (!rawCoords.length) { segStart = segEnd + 1; return }
    vsegs.push({
      idx: vsegs.length,
      pointOffset: clipPointOffsets[segStart],
      pointEnd: clipPointOffsets[segEnd + 1] ?? totalPoints,
      coords: decimateCoords(rawCoords, MAX_ROUTE_PTS),
      color: SEGMENT_COLORS[vsegs.length % SEGMENT_COLORS.length],
    })
    segStart = segEnd + 1
  }

  for (let i = 0; i < clips.length - 1; i++) {
    const a = clips[i]
    const b = clips[i + 1]
    const lastA = a.gpxPoints[a.gpxPoints.length - 1]
    const firstB = b.gpxPoints[0]
    if (!lastA || !firstB) { flush(i); continue }
    const dist = haversine(lastA, firstB)
    const timeDiff = Math.abs(a.videoOffset + (a.trimEnd - a.trimStart) - b.videoOffset)
    if (dist > GAP_THRESHOLD_M || timeDiff > GAP_THRESHOLD_S) flush(i)
  }
  flush(clips.length - 1)
  return vsegs
}

// ── Component ──────────────────────────────────────────────────────────────

export default function MapView() {
  const {
    points, currentIdx, followCar, mapStyle, multiSession,
    setCurrentIdx,
  } = useStore()

  const containerRef     = useRef<HTMLDivElement>(null)
  const mapRef           = useRef<mapboxgl.Map | null>(null)
  const carMarkerRef     = useRef<mapboxgl.Marker | null>(null)
  const staticMarkersRef = useRef<mapboxgl.Marker[]>([])
  const gapMarkersRef    = useRef<mapboxgl.Marker[]>([])
  const prevIdx          = useRef(-1)
  const styleFirstRun    = useRef(true)
  const visualSegsRef    = useRef<VisualSegment[]>([])

  // Init map once (after token is ready)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    let cancelled = false
    let ro: ResizeObserver | null = null
    initToken().then(() => {
      if (cancelled || !containerRef.current || mapRef.current) return
      const m = new mapboxgl.Map({
        container: containerRef.current!,
        style: `mapbox://styles/mapbox/${mapStyle}`,
        center: [25.6, 45.65],
        zoom: 13,
        attributionControl: false,
      })
      m.addControl(new mapboxgl.NavigationControl(), 'bottom-right')
      mapRef.current = m
      ro = new ResizeObserver(() => m.resize())
      ro.observe(containerRef.current!)
    })
    return () => { cancelled = true; ro?.disconnect(); if (mapRef.current) { mapRef.current.remove(); mapRef.current = null } }
  }, [])

  // Helper: clear all route layers/sources and markers
  const clearRoute = useCallback((m: mapboxgl.Map) => {
    staticMarkersRef.current.forEach(mk => mk.remove())
    staticMarkersRef.current = []
    gapMarkersRef.current.forEach(mk => mk.remove())
    gapMarkersRef.current = []
    if (carMarkerRef.current) { carMarkerRef.current.remove(); carMarkerRef.current = null }

    // Single-route layers/sources
    ;['route-click', 'route-passed', 'route-full'].forEach(id => {
      try { if (m.getLayer(id)) m.removeLayer(id) } catch { /* */ }
    })
    ;['route', 'route-passed'].forEach(id => {
      try { if (m.getSource(id)) m.removeSource(id) } catch { /* */ }
    })

    // Visual segment layers/sources — clear as many as were rendered
    const count = Math.max(visualSegsRef.current.length, 50)
    for (let i = 0; i < count; i++) {
      ;[`vseg-full-${i}`, `vseg-passed-${i}`, `vseg-click-${i}`].forEach(id => {
        try { if (m.getLayer(id)) m.removeLayer(id) } catch { /* */ }
      })
      ;[`vseg-${i}`, `vseg-passed-${i}`].forEach(id => {
        try { if (m.getSource(id)) m.removeSource(id) } catch { /* */ }
      })
    }
    visualSegsRef.current = []
  }, [])

  const mkMarker = useCallback((color: string, pos: [number, number], m: mapboxgl.Map) => {
    const mk = new mapboxgl.Marker({ color }).setLngLat(pos).addTo(m)
    staticMarkersRef.current.push(mk)
  }, [])

  const mkCarMarker = useCallback((pos: [number, number], m: mapboxgl.Map) => {
    const el = document.createElement('div')
    el.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="9" fill="#f5c542" fill-opacity=".25"/><circle cx="11" cy="11" r="5" fill="#f5c542"/><circle cx="11" cy="11" r="2" fill="#fff"/></svg>`
    carMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat(pos).addTo(m)
  }, [])

  const seekToIdx = useCallback((idx: number) => {
    const { videoUrl, channels } = useStore.getState()
    if (!videoUrl && !channels.length) return
    setCurrentIdx(idx)
    window.dispatchEvent(new CustomEvent('dashtrack:seek', { detail: { idx } }))
  }, [setCurrentIdx])

  // Add visual segments to map (reusable between buildRoute and style rebuild)
  const addVisualSegments = useCallback((
    m: mapboxgl.Map,
    vsegs: VisualSegment[],
    pts: GPSPoint[],
    currentIdx: number,
  ) => {
    vsegs.forEach(vseg => {
      const { idx, coords, color, pointOffset, pointEnd } = vseg
      const passed = pts.slice(pointOffset, currentIdx + 1).map(q => [q.lon, q.lat])

      m.addSource(`vseg-${idx}`,        { type: 'geojson', data: mkLine(coords) })
      m.addSource(`vseg-passed-${idx}`, { type: 'geojson', data: mkLine(passed.length >= 2 ? passed : [coords[0], coords[0]]) })

      m.addLayer({ id: `vseg-full-${idx}`,   type: 'line', source: `vseg-${idx}`,        paint: { 'line-color': color, 'line-width': 2.5, 'line-opacity': 0.3 } })
      m.addLayer({ id: `vseg-passed-${idx}`, type: 'line', source: `vseg-passed-${idx}`, paint: { 'line-color': color, 'line-width': 3,   'line-opacity': 1   } })
      m.addLayer({ id: `vseg-click-${idx}`,  type: 'line', source: `vseg-${idx}`,        paint: { 'line-color': 'transparent', 'line-width': 20, 'line-opacity': 0 } })

      m.on('click', `vseg-click-${idx}`, (e: mapboxgl.MapMouseEvent) => {
        const ll = e.lngLat
        let best = pointOffset, bestD = Infinity
        for (let j = pointOffset; j < pointEnd; j++) {
          const p = pts[j]
          const d = Math.hypot(p.lat - ll.lat, p.lon - ll.lng)
          if (d < bestD) { bestD = d; best = j }
        }
        seekToIdx(best)
      })
      m.on('mouseenter', `vseg-click-${idx}`, () => m.getCanvas().style.cursor = 'pointer')
      m.on('mouseleave', `vseg-click-${idx}`, () => m.getCanvas().style.cursor = '')
    })
  }, [seekToIdx])

  // Add route when points change
  useEffect(() => {
    const m = mapRef.current
    if (!m || !points.length) return

    const buildRoute = () => {
      clearRoute(m)
      const { multiSession: ms, points: pts, currentIdx: idx } = useStore.getState()

      if (ms) {
        // ── Multi-segment: merge contiguous clips into visual segments ─────
        const vsegs = buildVisualSegments(ms, pts.length)
        visualSegsRef.current = vsegs

        addVisualSegments(m, vsegs, pts, idx)

        // Start marker per visual segment, end marker on last
        vsegs.forEach((vseg, vi) => {
          mkMarker(vseg.color, vseg.coords[0] as [number, number], m)
          // End marker only on last visual segment
          if (vi === vsegs.length - 1) {
            const last = vseg.coords[vseg.coords.length - 1]
            mkMarker('#ff4d6d', last as [number, number], m)
          }
        })

        // Gap markers between visual segments
        for (let vi = 0; vi < vsegs.length - 1; vi++) {
          const a = vsegs[vi]
          const b = vsegs[vi + 1]
          const lastPt = pts[a.pointEnd - 1]
          const firstPt = pts[b.pointOffset]
          if (!lastPt || !firstPt) continue
          const el = document.createElement('div')
          el.title = 'Gap — click to jump to next segment'
          el.innerHTML = `<div style="width:20px;height:20px;border-radius:50%;background:#09090c;border:2px solid ${b.color};display:flex;align-items:center;justify-content:center;cursor:pointer;"><svg width="9" height="10" viewBox="0 0 9 10" fill="${b.color}"><polygon points="1,1 8,5 1,9"/></svg></div>`
          el.addEventListener('click', () => seekToIdx(b.pointOffset))
          const mk = new mapboxgl.Marker({ element: el, anchor: 'center' })
            .setLngLat([(lastPt.lon + firstPt.lon) / 2, (lastPt.lat + firstPt.lat) / 2])
            .addTo(m)
          gapMarkersRef.current.push(mk)
        }

        if (pts[0]) mkCarMarker([pts[0].lon, pts[0].lat], m)
        fitBounds(m, pts)

      } else {
        // ── Single route ──────────────────────────────────────────────────
        const rawCoords = pts.map((p: GPSPoint) => [p.lon, p.lat])
        const coords = decimateCoords(rawCoords, MAX_ROUTE_PTS)
        const passed = pts.slice(0, idx + 1).map((p: GPSPoint) => [p.lon, p.lat])

        m.addSource('route',        { type: 'geojson', data: mkLine(coords) })
        m.addSource('route-passed', { type: 'geojson', data: mkLine(passed.length >= 2 ? passed : [coords[0], coords[0]]) })

        m.addLayer({ id: 'route-full',   type: 'line', source: 'route',        paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-opacity': 0.2 } })
        m.addLayer({ id: 'route-passed', type: 'line', source: 'route-passed', paint: { 'line-color': '#f5c542', 'line-width': 3,   'line-opacity': 1   } })
        m.addLayer({ id: 'route-click',  type: 'line', source: 'route',        paint: { 'line-color': 'transparent', 'line-width': 20, 'line-opacity': 0 } })

        m.on('click', 'route-click', (e: mapboxgl.MapMouseEvent) => {
          const ll = e.lngLat
          let best = 0, bestD = Infinity
          pts.forEach((p: GPSPoint, i: number) => {
            const d = Math.hypot(p.lat - ll.lat, p.lon - ll.lng)
            if (d < bestD) { bestD = d; best = i }
          })
          seekToIdx(best)
        })
        m.on('mouseenter', 'route-click', () => m.getCanvas().style.cursor = 'pointer')
        m.on('mouseleave', 'route-click', () => m.getCanvas().style.cursor = '')

        mkMarker('#00e5a0', coords[0] as [number, number], m)
        mkMarker('#ff4d6d', coords[coords.length - 1] as [number, number], m)
        mkCarMarker(coords[Math.min(idx, coords.length - 1)] as [number, number], m)
        fitBounds(m, pts)
      }
    }

    if (m.isStyleLoaded()) buildRoute()
    else m.once('style.load', buildRoute)
  }, [points, multiSession, clearRoute, mkMarker, mkCarMarker, seekToIdx, addVisualSegments])

  // Update car marker + passed path on index change
  useEffect(() => {
    const m = mapRef.current
    if (!m || !points.length || currentIdx === prevIdx.current) return
    const oldIdx = prevIdx.current
    prevIdx.current = currentIdx
    const p = points[currentIdx]
    if (!p) return

    carMarkerRef.current?.setLngLat([p.lon, p.lat])
    if (followCar) m.easeTo({ center: [p.lon, p.lat], duration: 200 })

    if (multiSession) {
      // Only update visual segments whose range intersects the tick transition
      visualSegsRef.current.forEach(vseg => {
        const { idx, pointOffset, pointEnd, coords } = vseg
        if (oldIdx < pointOffset && currentIdx < pointOffset) return  // both before
        if (oldIdx >= pointEnd   && currentIdx >= pointEnd)   return  // both after

        const src = m.getSource(`vseg-passed-${idx}`) as mapboxgl.GeoJSONSource | undefined
        if (!src) return

        if (currentIdx < pointOffset) {
          src.setData(mkLine([coords[0], coords[0]]))
        } else if (currentIdx >= pointEnd) {
          src.setData(mkLine(coords))  // already decimated
        } else {
          const passed = points.slice(pointOffset, currentIdx + 1).map(q => [q.lon, q.lat])
          src.setData(mkLine(passed.length >= 2 ? passed : [passed[0] ?? [0, 0], passed[0] ?? [0, 0]]))
        }
      })
    } else {
      const src = m.getSource('route-passed') as mapboxgl.GeoJSONSource | undefined
      src?.setData(mkLine(points.slice(0, currentIdx + 1).map((q: GPSPoint) => [q.lon, q.lat])))
    }
  }, [currentIdx, points, followCar, multiSession])

  // Style change — rebuild route after style loads
  useEffect(() => {
    if (styleFirstRun.current) { styleFirstRun.current = false; return }
    const m = mapRef.current
    if (!m) return
    m.setStyle(`mapbox://styles/mapbox/${mapStyle}`)
    m.once('style.load', () => {
      const { points: pts, multiSession: ms, currentIdx: idx } = useStore.getState()
      if (!pts.length) return
      clearRoute(m)
      if (ms) {
        const vsegs = buildVisualSegments(ms, pts.length)
        visualSegsRef.current = vsegs
        addVisualSegments(m, vsegs, pts, idx)
      } else {
        const coords = decimateCoords(pts.map((p: GPSPoint) => [p.lon, p.lat]), MAX_ROUTE_PTS)
        const passed = pts.slice(0, idx + 1).map((p: GPSPoint) => [p.lon, p.lat])
        m.addSource('route',        { type: 'geojson', data: mkLine(coords) })
        m.addSource('route-passed', { type: 'geojson', data: mkLine(passed.length >= 2 ? passed : [coords[0], coords[0]]) })
        m.addLayer({ id: 'route-full',   type: 'line', source: 'route',        paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-opacity': 0.2 } })
        m.addLayer({ id: 'route-passed', type: 'line', source: 'route-passed', paint: { 'line-color': '#f5c542', 'line-width': 3,   'line-opacity': 1   } })
      }
    })
  }, [mapStyle, clearRoute, addVisualSegments])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <style>{`.mapboxgl-ctrl-logo,.mapboxgl-ctrl-attrib{display:none!important}`}</style>
    </div>
  )
}

// ── Utilities ──────────────────────────────────────────────────────────────

function mkLine(coords: number[][]): GeoJSON.Feature {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }
}

function fitBounds(m: mapboxgl.Map, pts: GPSPoint[]) {
  if (pts.length < 2) return
  let minLon = pts[0].lon, maxLon = pts[0].lon
  let minLat = pts[0].lat, maxLat = pts[0].lat
  for (const p of pts) {
    if (p.lon < minLon) minLon = p.lon
    else if (p.lon > maxLon) maxLon = p.lon
    if (p.lat < minLat) minLat = p.lat
    else if (p.lat > maxLat) maxLat = p.lat
  }
  m.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 50 })
}
