import { useLayoutEffect, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import MapView from './components/MapView'
import MultiVideoPlayer from './components/MultiVideoPlayer'
import Hud from './components/Hud'
import StatsTile from './components/StatsTile'
import SpeedGraph from './components/SpeedGraph'
import WaypointList from './components/WaypointList'
import PlayerBar from './components/PlayerBar'
import FirstScreen from './components/FirstScreen'
import LibraryModal from './components/LibraryModal'
import Icon from './components/Icon'
import { useStore } from './store'
import type { MapStyle } from './store'
import { useViewportWidth } from './hooks/useViewportWidth'

type StageMode = 'map' | 'video'

export default function App() {
  const {
    swapped, setSwapped, multiSession, points, reset,
    followCar, setFollowCar, mapStyle, setMapStyle,
  } = useStore()

  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryInitialTab, setLibraryInitialTab] = useState<'library' | 'upload'>('library')
  const [libraryChecked, setLibraryChecked] = useState<Set<string>>(new Set())
  const [dockOpen, setDockOpen] = useState(true)
  const [showWp, setShowWp] = useState(false)
  const [stage, setStage] = useState<StageMode>('map')
  const [focusVid, setFocusVid] = useState(false)
  const [focusMap, setFocusMap] = useState(false)

  const vw = useViewportWidth()
  const isMobile = vw < 760

  const openModal = (tab: 'library' | 'upload') => {
    setLibraryInitialTab(tab)
    setLibraryOpen(true)
  }

  const welcomeMode = points.length === 0

  // Stable imperative containers — created once, never destroyed.
  const mapBox   = useRef<HTMLDivElement | null>(null)
  const videoBox = useRef<HTMLDivElement | null>(null)
  if (!mapBox.current) {
    mapBox.current = document.createElement('div')
    mapBox.current.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden'
  }
  if (!videoBox.current) {
    videoBox.current = document.createElement('div')
    videoBox.current.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column'
  }

  const stageRef    = useRef<HTMLDivElement>(null)
  const dockVidRef  = useRef<HTMLDivElement>(null)
  const dockMapRef  = useRef<HTMLDivElement>(null)
  const focusVidRef = useRef<HTMLDivElement>(null)
  const focusMapRef = useRef<HTMLDivElement>(null)
  const cinemaPipRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const mapEl   = mapBox.current!
    const videoEl = videoBox.current!

    // Reset styles for placement
    mapEl.style.cssText   = 'width:100%;height:100%;position:relative;overflow:hidden'
    videoEl.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column'

    // Focus overlays take priority
    if (focusVid && focusVidRef.current) {
      videoEl.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column'
      focusVidRef.current.appendChild(videoEl)
      if (stageRef.current) {
        mapEl.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden'
        stageRef.current.appendChild(mapEl)
      }
      return () => { mapEl.parentElement?.removeChild(mapEl); videoEl.parentElement?.removeChild(videoEl) }
    }
    if (focusMap && focusMapRef.current) {
      mapEl.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden'
      focusMapRef.current.appendChild(mapEl)
      if (stageRef.current) {
        videoEl.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column'
        stageRef.current.appendChild(videoEl)
      }
      return () => { mapEl.parentElement?.removeChild(mapEl); videoEl.parentElement?.removeChild(videoEl) }
    }

    if (stage === 'map') {
      // Map fills stage, video goes in dock or cinema PiP
      mapEl.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden'
      stageRef.current?.appendChild(mapEl)

      if (dockOpen && dockVidRef.current) {
        videoEl.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column'
        dockVidRef.current.appendChild(videoEl)
      } else if (cinemaPipRef.current) {
        videoEl.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column'
        cinemaPipRef.current.appendChild(videoEl)
      }
    } else {
      // Video fills stage, map goes in dock or cinema PiP
      videoEl.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column'
      stageRef.current?.appendChild(videoEl)

      if (dockOpen && dockMapRef.current) {
        mapEl.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden'
        dockMapRef.current.appendChild(mapEl)
      } else if (cinemaPipRef.current) {
        mapEl.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden'
        cinemaPipRef.current.appendChild(mapEl)
      }
    }

    return () => {
      mapEl.parentElement?.removeChild(mapEl)
      videoEl.parentElement?.removeChild(videoEl)
    }
  }, [stage, dockOpen, focusVid, focusMap, welcomeMode])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return
      const vid = document.querySelector('video[data-channel="primary"]') as HTMLVideoElement | null
        ?? document.querySelector('video') as HTMLVideoElement | null
      if (e.code === 'Space') { e.preventDefault(); vid && (vid.paused ? vid.play() : vid.pause()) }
      if (e.code === 'ArrowRight') { e.preventDefault(); if (vid) vid.currentTime += e.shiftKey ? 30 : 10 }
      if (e.code === 'ArrowLeft')  { e.preventDefault(); if (vid) vid.currentTime -= e.shiftKey ? 30 : 10 }
      if (e.code === 'KeyM') { if (vid) vid.muted = !vid.muted }
      if (e.code === 'KeyC') setDockOpen(d => !d)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const mapStyleLabel = mapStyle === 'standard-satellite' ? 'Sat' : mapStyle === 'dark-v11' ? 'Dark' : 'Light'
  const mapStyles: [MapStyle, string][] = [['standard-satellite', 'Sat'], ['dark-v11', 'Dark'], ['light-v11', 'Light']]

  return (
    <>
      <div className="app">
        <div className="stage" ref={stageRef}>
          {/* Top floating bar */}
          <div className="topbar">
            <div className="brand">
              <Icon name="navigation" size={15} className="brand-mark" />
              Dash<b>Track</b>
            </div>

            {!isMobile && !welcomeMode && (
              <div className="topbar-route mono">
                {multiSession
                  ? `${multiSession.clips.length} segments`
                  : points.length > 0
                    ? `${points.length} pts`
                    : ''}
              </div>
            )}

            <div className="topbar-spacer" />

            {!welcomeMode && (
              <>
                {!isMobile && (
                  <div className="seg">
                    {mapStyles.map(([k, l]) => (
                      <button key={k} className={mapStyle === k ? 'on' : ''} onClick={() => setMapStyle(k)}>{l}</button>
                    ))}
                  </div>
                )}
                <button className="pill" onClick={() => setStage(s => s === 'map' ? 'video' : 'map')} title="Swap map / video">
                  <Icon name="swap" size={14} />{!isMobile && 'Swap'}
                </button>
                <button className={`pill ${dockOpen ? 'on' : ''}`} onClick={() => setDockOpen(d => !d)} title="Dashboard / Cinema">
                  <Icon name="layout" size={14} />{!isMobile && (dockOpen ? 'Cinema' : 'Dashboard')}
                </button>
                <button className={`pill ${followCar ? 'on' : ''}`} onClick={() => setFollowCar(!followCar)} title="Follow car / Overview">
                  <Icon name={followCar ? 'crosshair' : 'map'} size={14} />{!isMobile && (followCar ? 'Follow' : 'Overview')}
                </button>
                <button className="pill" onClick={() => openModal('library')} title="Library">
                  <Icon name="film" size={15} />{!isMobile && 'Library'}
                </button>
                <button className="pill pill--accent" onClick={() => openModal('upload')} title="Add video">
                  <Icon name="plus" size={15} />{!isMobile && 'Add'}
                </button>
              </>
            )}
          </div>

          {/* HUD — speed + compass */}
          {!welcomeMode && <Hud />}

          {/* BENTO DOCK */}
          {!welcomeMode && dockOpen && (
            <div className="dock">
              {stage === 'map' ? (
                <div className="tile vtilewrap">
                  <div className="vtile" ref={dockVidRef}>
                    {/* video moves here via DOM */}
                  </div>
                  <button className="vbtn" onClick={() => setFocusVid(true)} title="Expand" style={{ position: 'absolute', top: 8, right: 8, zIndex: 5 }}>
                    <Icon name="fullscreen" size={14} />
                  </button>
                </div>
              ) : (
                <div className="tile maptilewrap" ref={dockMapRef}>
                  {/* map moves here via DOM */}
                  <button className="vbtn map-expand" onClick={() => setFocusMap(true)} title="Expand map">
                    <Icon name="fullscreen" size={14} />
                  </button>
                </div>
              )}
              <StatsTile />
              <SpeedGraph />
              <div className="dock-tabs">
                <button className={showWp ? '' : 'on'} onClick={() => setShowWp(false)}>Graph view</button>
                <button className={showWp ? 'on' : ''} onClick={() => setShowWp(true)}>Waypoints</button>
              </div>
              {showWp && <WaypointList />}
            </div>
          )}

          {/* Cinema PiP — shows when dock is closed */}
          {!welcomeMode && !dockOpen && (
            <div className="cinema-pip" ref={cinemaPipRef}>
              {/* the non-stage element moves here via DOM */}
            </div>
          )}

          {/* Floating player bar */}
          {!welcomeMode && <PlayerBar />}
        </div>
      </div>

      {/* Video focus overlay */}
      {focusVid && (
        <div className="modal-scrim" onClick={() => setFocusVid(false)}>
          <div className="vid-focus" onClick={e => e.stopPropagation()}>
            <div ref={focusVidRef} style={{ width: '100%', height: '100%' }} />
            <button className="iconbtn vid-focus-x" onClick={() => setFocusVid(false)}>
              <Icon name="x" size={15} />
            </button>
          </div>
        </div>
      )}

      {/* Map focus overlay */}
      {focusMap && (
        <div className="modal-scrim" onClick={() => setFocusMap(false)}>
          <div className="vid-focus" onClick={e => e.stopPropagation()}>
            <div ref={focusMapRef} className="focus-map" />
            <button className="iconbtn vid-focus-x" onClick={() => setFocusMap(false)}>
              <Icon name="x" size={15} />
            </button>
          </div>
        </div>
      )}

      {/* First screen / welcome */}
      {welcomeMode && (
        <FirstScreen
          onOpenLibrary={() => openModal('library')}
          onOpenUpload={() => openModal('upload')}
        />
      )}

      {/* Portals: always live in their stable containers, never remount */}
      {createPortal(<MapView />,          mapBox.current!)}
      {createPortal(<MultiVideoPlayer />, videoBox.current!)}

      {/* Library / Add video modal */}
      {libraryOpen && (
        <LibraryModal
          onClose={() => setLibraryOpen(false)}
          initialTab={libraryInitialTab}
          checked={libraryChecked}
          setChecked={setLibraryChecked}
        />
      )}
    </>
  )
}
