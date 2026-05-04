import { useEffect, useState } from 'react'
import { getConsent, setConsent, isAnalyticsAvailable } from '../utils/analytics'
import { isSentryAvailable } from '../utils/sentry'

/**
 * One-time consent banner for analytics + error reporting. Renders nothing if:
 *   - Both analytics and Sentry are unavailable (desktop build, or neither
 *     env var set)
 *   - User has already chosen (granted or denied) — choice is in localStorage
 *
 * What "Accept" / "Decline" actually do:
 *   - Decline: nothing changes. Analytics is already running in cookieless
 *     "ping" mode (no _ga cookie, anonymous aggregate hits) and error
 *     reports are already running in anonymous mode (no IP, no PII).
 *     The banner just disappears.
 *   - Accept: analytics upgrades to full collection (sets the _ga cookie,
 *     full event params), and error reports start carrying breadcrumbs
 *     (console + clicks) so future crashes have context. IP and URL query
 *     strings remain scrubbed in error reports either way.
 *
 * This is the "Consent Mode degraded" model — both tools are always on
 * in privacy-respecting mode; the banner asks for permission to upgrade
 * to fuller collection. See SENTRY.md for the full disclosure.
 */
export default function ConsentBanner() {
  const [visible, setVisible] = useState(false)
  const [showPolicy, setShowPolicy] = useState(false)

  useEffect(() => {
    if (!isAnalyticsAvailable() && !isSentryAvailable()) return
    if (getConsent() !== null) return
    setVisible(true)
  }, [])

  if (!visible) return null

  const choose = value => {
    setConsent(value)
    setVisible(false)
  }

  return (
    <div className="consent-banner" role="dialog" aria-label="Analytics and error reporting consent">
      <p className="consent-copy">
        Anonymous analytics and crash reports help me improve the tool. Your
        flight logs are never sent — only aggregate usage and error details.{' '}
        <button
          type="button"
          className="consent-policy-toggle"
          onClick={() => setShowPolicy(s => !s)}
          aria-expanded={showPolicy}
        >
          {showPolicy ? 'Hide privacy details' : 'Privacy'}
        </button>
      </p>

      {showPolicy && (
        <div className="consent-policy">
          <p>
            <strong>Always anonymous (whether you accept or decline):</strong>{' '}
            aggregate page-view counts (no cookies until you accept), and crash
            reports with no IP address, no email, no log content. Crash reports
            include only file size, firmware version, and the parser error
            message — never the actual log bytes.
          </p>
          <p>
            <strong>If you accept:</strong> a cookie is set to deduplicate page
            views, and crash reports include breadcrumbs (which buttons you
            clicked before the crash) to help me debug.
          </p>
          <p>
            <strong>Never collected:</strong> the CSV / blackbox content, GPS
            coordinates, flight paths, or anything else from your log file.
          </p>
        </div>
      )}

      <div className="consent-actions">
        <button type="button" className="consent-btn" onClick={() => choose('denied')}>
          Decline
        </button>
        <button type="button" className="consent-btn" onClick={() => choose('granted')}>
          Accept
        </button>
      </div>
    </div>
  )
}
