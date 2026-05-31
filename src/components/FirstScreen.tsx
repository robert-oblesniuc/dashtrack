import { useCallback, useRef, useState } from 'react'
import { useStore } from '../store'
import { parseGPX } from '../hooks/useGPX'
import Icon from './Icon'

function Clapperboard({ size = 44 }: { size?: number }) {
  return (
    <svg className="fs1-clap" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
      <path d="m6.2 5.3 3.1 3.9" />
      <path d="m12.4 3.4 3.1 4" />
      <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

interface Props {
  onOpenLibrary: () => void
  onOpenUpload: () => void
}

export default function FirstScreen({ onOpenLibrary, onOpenUpload }: Props) {
  const {
    setVideoFile, setPoints,
    setExtractionStatus, setExtractionProgress, setExtractionError,
    extractionStatus, extractionProgress,
  } = useStore()

  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(async (file: File) => {
    if (!file) return
    setVideoFile(file)
    setExtractionError(null)
    setExtractionStatus('uploading')
    setExtractionProgress(0)

    try {
      const form = new FormData()
      form.append('file', file)

      const res = await fetch('/api/extract/start', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Upload failed' }))
        throw new Error(err.detail ?? 'Upload failed')
      }
      const { job_id } = await res.json()
      setExtractionStatus('extracting')

      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${wsProto}://${location.host}/api/ws/extract/${job_id}`)

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'progress') {
          setExtractionProgress(msg.points)
        } else if (msg.type === 'done') {
          setPoints(parseGPX(msg.gpx))
          setExtractionStatus('done')
          setExtractionProgress(msg.stats.points)
          ws.close()
        } else if (msg.type === 'error') {
          setExtractionError(msg.message)
          setExtractionStatus('error')
          ws.close()
        }
      }
      ws.onerror = () => {
        setExtractionError('Connection error — is the server running?')
        setExtractionStatus('error')
      }
    } catch (err: any) {
      setExtractionError(err.message)
      setExtractionStatus('error')
    }
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const uploading  = extractionStatus === 'uploading'
  const extracting = extractionStatus === 'extracting'
  const error      = extractionStatus === 'error'
  const busy       = uploading || extracting

  return (
    <div className="fs1">
      <div className="fs1-wordmark">
        <Icon name="navigation" className="navico" size={40} />
        Dash<b>Track</b>
      </div>
      <div className="fs1-tag mono">GPS route visualization for Viofo dashcams</div>

      <div
        className={`fs1-drop ${drag ? 'drag' : ''}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <Clapperboard size={46} />
        <div className="fs1-drop-t">Drop dashcam video here</div>
        <div className="fs1-drop-s mono">MP4 · MOV · AVI — GPS extracted automatically</div>
        <input ref={fileRef} type="file" accept="video/*" style={{ display: 'none' }}
          onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
      </div>

      <div className="fs1-lib mono">
        or <a onClick={onOpenLibrary}>open Library</a> to browse indexed footage
      </div>

      {/* Import overlay */}
      {busy && (
        <div className="fs1-import">
          <Clapperboard size={40} />
          <div className="imp-file"><span>{useStore.getState().videoFile?.name ?? 'video.MP4'}</span></div>
          <div className="imp-bar"><i style={{ width: extracting ? '100%' : '30%' }} /></div>
          <div className="imp-step">
            {uploading ? 'Uploading…' : `Extracting GPS… ${extractionProgress} pts`}
          </div>
        </div>
      )}

      {error && (
        <div className="fs1-import">
          <div className="imp-file" style={{ color: 'var(--red)' }}>
            {useStore.getState().extractionError ?? 'Extraction failed'}
          </div>
          <button
            className="primarybtn"
            style={{ marginTop: 12 }}
            onClick={() => { setExtractionStatus('idle'); setExtractionError(null) }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
