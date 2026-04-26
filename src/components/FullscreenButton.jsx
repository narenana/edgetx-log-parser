import { useEffect, useRef, useState } from 'react'

/**
 * Fullscreen toggle for the globe / map wrap. Targets the closest ancestor
 * with the given className (so it works regardless of whether it's mounted
 * inside .globe-wrap or .map-wrap).
 *
 * Uses the standard Fullscreen API — works in Chrome/Edge/Firefox/Safari and
 * inside Electron's BrowserWindow without further plumbing. Listens for the
 * `fullscreenchange` event so the button icon flips when the user exits via
 * the Esc key or the OS chrome.
 */
export default function FullscreenButton({ targetClass }) {
  const btnRef = useRef(null)
  const [isFs, setIsFs] = useState(false)

  useEffect(() => {
    const onChange = () => setIsFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggle = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.()
      return
    }
    // Walk up from the button to find the wrap with the requested class.
    let el = btnRef.current?.parentElement
    while (el && !el.classList.contains(targetClass)) el = el.parentElement
    el?.requestFullscreen?.()
  }

  return (
    <button
      ref={btnRef}
      type="button"
      className={`fullscreen-btn${isFs ? ' active' : ''}`}
      onClick={toggle}
      title={isFs ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
      aria-pressed={isFs}
    >
      {isFs ? '⤢' : '⛶'}
    </button>
  )
}
