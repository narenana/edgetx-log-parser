import { useEffect, useId, useRef, useState } from 'react'
import { sendFeedback, FEEDBACK_MAX_COMMENT } from '../utils/feedback'
import { track } from '../utils/analytics'

/**
 * Product feedback dialog: a 1–10 rating (required) + an optional comment.
 *
 * Stays mounted after its first open and renders nothing while closed, so
 * a half-written comment survives an accidental Esc. After a successful
 * send, closing resets it to a fresh form.
 *
 * The rating is an ARIA radiogroup with a roving tabindex: Tab enters the
 * group once; arrows / Home / End move the choice; 1–9 and 0 (= 10) jump.
 */
const SCALE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const ERRORS = {
  missing: 'Pick a number from 1 to 10 first.',
  network: "Couldn't send it. You may be offline; your text is still here, so try again.",
  rate: "You've sent a few already. Please try again a little later.",
  server: 'Something went wrong on our side. Your text is still here; please try again.',
}

export default function FeedbackDialog({ open, onClose, context }) {
  const [rating, setRating] = useState(null)
  const [comment, setComment] = useState('')
  const [website, setWebsite] = useState('') // honeypot
  const [status, setStatus] = useState('idle') // idle | sending | sent
  const [error, setError] = useState(null)
  const cardRef = useRef(null)
  const radioRefs = useRef([])
  const closeRef = useRef(null)
  const returnFocusRef = useRef(null)
  const ids = useId()

  const reset = () => {
    setRating(null)
    setComment('')
    setWebsite('')
    setStatus('idle')
    setError(null)
  }

  const close = () => {
    if (status === 'sending') return
    if (status === 'sent') reset()
    onClose()
  }
  // The document-level Esc listener below always calls the latest close().
  const closeLatest = useRef(close)
  closeLatest.current = close

  // Focus in on open, back to the trigger on close; Esc closes from anywhere.
  useEffect(() => {
    if (!open) return undefined
    returnFocusRef.current = document.activeElement
    const t = setTimeout(() => {
      const target = status === 'sent' ? closeRef.current : radioRefs.current[(rating || 1) - 1]
      target?.focus()
    }, 0)
    const onEsc = e => {
      if (e.key === 'Escape') closeLatest.current()
    }
    document.addEventListener('keydown', onEsc)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onEsc)
      const back = returnFocusRef.current
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus()
    }
    // Only on open/close transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const choose = n => {
    setRating(n)
    if (error === 'missing') setError(null)
    radioRefs.current[n - 1]?.focus()
  }

  const onRadioKey = e => {
    const cur = rating || 0
    let next = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(10, cur + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(1, cur - 1 || 1)
    else if (e.key === 'Home') next = 1
    else if (e.key === 'End') next = 10
    else if (/^[0-9]$/.test(e.key)) next = e.key === '0' ? 10 : Number(e.key)
    if (next != null) {
      e.preventDefault()
      choose(next)
    }
  }

  // Keep Tab inside the dialog.
  const onCardKey = e => {
    if (e.key !== 'Tab' || !cardRef.current) return
    const f = [...cardRef.current.querySelectorAll('button:not([disabled]), textarea, [href], input:not([tabindex="-1"])')]
      .filter(el => el.tabIndex >= 0 && el.offsetParent !== null)
    if (!f.length) return
    const first = f[0]
    const last = f[f.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const submit = async e => {
    e.preventDefault()
    if (status === 'sending') return
    if (rating == null) {
      setError('missing')
      radioRefs.current[0]?.focus()
      return
    }
    setStatus('sending')
    setError(null)
    const res = await sendFeedback({ rating, comment, context, website })
    if (res.ok) {
      track('feedback_sent', { rating, has_comment: comment.trim() ? 1 : 0 })
      setStatus('sent')
      setTimeout(() => closeRef.current?.focus(), 0)
    } else {
      setStatus('idle')
      setError(res.error)
    }
  }

  // A stray click outside only closes a form with nothing in it yet.
  const pristine = rating == null && !comment.trim()
  const onBackdrop = e => {
    if (e.target === e.currentTarget && (pristine || status === 'sent')) close()
  }

  const left = FEEDBACK_MAX_COMMENT - comment.length

  return (
    <div className="fb-backdrop" onMouseDown={onBackdrop}>
      <div
        ref={cardRef}
        className="fb-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        onKeyDown={onCardKey}
      >
        <button type="button" className="fb-x" onClick={close} aria-label="Close feedback" disabled={status === 'sending'}>
          ×
        </button>

        {status === 'sent' ? (
          <div className="fb-done" aria-live="polite">
            <div className="fb-done-mark" aria-hidden="true">✓</div>
            <h2 id={`${ids}-title`} className="fb-title">Thanks for the feedback!</h2>
            <p className="fb-sub">It helps decide what to fix and build next.</p>
            <button ref={closeRef} type="button" className="fb-send" onClick={close}>
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <h2 id={`${ids}-title`} className="fb-title">Share your feedback</h2>
            <p id={`${ids}-q`} className="fb-sub">How would you rate the RC Log Viewer overall?</p>

            <div
              className="fb-scale"
              role="radiogroup"
              aria-labelledby={`${ids}-q`}
              aria-describedby={error === 'missing' ? `${ids}-err` : undefined}
              onKeyDown={onRadioKey}
            >
              {SCALE.map(n => (
                <button
                  key={n}
                  ref={el => { radioRefs.current[n - 1] = el }}
                  type="button"
                  role="radio"
                  aria-checked={rating === n}
                  aria-label={n === 1 ? '1, poor' : n === 10 ? '10, excellent' : String(n)}
                  tabIndex={rating === n || (rating == null && n === 1) ? 0 : -1}
                  className={`fb-num${rating === n ? ' on' : ''}`}
                  onClick={() => choose(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="fb-ends" aria-hidden="true">
              <span>1 · Poor</span>
              <span>10 · Excellent</span>
            </div>

            <label className="fb-label" htmlFor={`${ids}-c`}>
              Anything you'd like to tell us? <span>(optional)</span>
            </label>
            <textarea
              id={`${ids}-c`}
              className="fb-text"
              rows={4}
              maxLength={FEEDBACK_MAX_COMMENT}
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="What works, what doesn't, what's missing…"
            />
            {left < 300 && <div className="fb-count" aria-live="polite">{left} characters left</div>}

            {/* Honeypot: off-screen and out of the tab order. People never fill it. */}
            <div className="fb-hp" aria-hidden="true">
              <label>
                Website
                <input tabIndex={-1} autoComplete="off" name="website" value={website} onChange={e => setWebsite(e.target.value)} />
              </label>
            </div>

            <p className="fb-privacy">
              We store your rating, your comment and which screen you were on. Never your log,
              and nothing that identifies you, so please leave personal details out.
            </p>

            {error && (
              <div id={`${ids}-err`} className="fb-error" role="alert">
                {ERRORS[error] || ERRORS.server}
              </div>
            )}

            <div className="fb-actions">
              <button type="button" className="fb-cancel" onClick={close} disabled={status === 'sending'}>
                Cancel
              </button>
              <button type="submit" className="fb-send" disabled={status === 'sending'}>
                {status === 'sending' ? 'Sending…' : 'Send feedback'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
