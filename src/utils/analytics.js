/**
 * Google Analytics 4 with Consent Mode v2.
 *
 * Loading model (Option B — "Consent Mode degraded"):
 *
 *   - On page load (regardless of consent decision):
 *       gtag.js is fetched and the dataLayer is set up with all consent
 *       categories DENIED. In this state GA4 sends "cookieless pings" —
 *       no _ga cookie is set, no client ID is persisted, the server
 *       receives anonymous aggregate hits only. This is what Google's
 *       Consent Mode v2 calls "advanced" / "modeled" mode.
 *
 *   - When the user clicks Accept on the consent banner:
 *       gtag('consent','update',{analytics_storage:'granted',...}) flips
 *       on full collection — the _ga cookie is set, full event params
 *       ride with future hits.
 *
 *   - When the user clicks Decline:
 *       Consent stays denied. We continue receiving cookieless pings
 *       (already happening), but the user has explicitly opted out of
 *       cookies. We respect that — the deny path doesn't disable GA,
 *       it just stays in the cookieless mode it was already in.
 *
 * Hard no-ops unless ALL of:
 *   - VITE_BUILD_TARGET === 'web'    (skip Electron)
 *   - VITE_GA_ID is set              (skip if env unset)
 *
 * The presence of the ConsentBanner is now decoupled from "should GA
 * exist at all?" — GA always exists in degraded mode if the env var is
 * set; the banner just gates the upgrade to full collection.
 *
 * Note: under strict GDPR / EU DPA interpretations, Consent Mode v2's
 * cookieless pings are still arguable as "processing requiring consent."
 * Google's stance is that the aggregate-only signal is non-personal and
 * exempt. If a user (or our jurisdiction) requires hard opt-in, flip
 * back to opt-in mode by removing the bootGaDegraded() call from main.jsx
 * and reverting setConsent('granted') to call initAnalytics() instead.
 */

import { upgradeSentryConsent } from './sentry'

const CONSENT_KEY = 'analytics-consent-v1'
const GA_ID = import.meta.env.VITE_GA_ID
const IS_WEB = import.meta.env.VITE_BUILD_TARGET === 'web'

let degradedBooted = false
let upgraded = false
let pendingEvents = []

export function getConsent() {
  if (typeof localStorage === 'undefined') return null
  const v = localStorage.getItem(CONSENT_KEY)
  return v === 'granted' || v === 'denied' ? v : null
}

export function setConsent(value) {
  if (value !== 'granted' && value !== 'denied') return
  try {
    localStorage.setItem(CONSENT_KEY, value)
  } catch {
    // Private mode / quota — non-fatal.
  }
  if (value === 'granted') {
    upgradeAnalytics()
    upgradeSentryConsent()
    track('app_view')
  }
  // 'denied' just persists the choice; we stay in cookieless degraded mode.
}

export function isAnalyticsAvailable() {
  return IS_WEB && !!GA_ID
}

/**
 * Boot GA4 in cookieless / Consent Mode v2 degraded state.
 * Called once from main.jsx on every page load.
 */
export function bootGaDegraded() {
  if (degradedBooted) return
  if (!IS_WEB || !GA_ID) return
  degradedBooted = true

  window.dataLayer = window.dataLayer || []
  window.gtag = function () {
    window.dataLayer.push(arguments)
  }

  // Set Consent Mode v2 default state: everything denied. This is what
  // tells GA4 to send cookieless pings instead of full hits with cookies.
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted',
    wait_for_update: 500,
  })

  window.gtag('js', new Date())
  window.gtag('config', GA_ID, {
    anonymize_ip: true,
    // Don't auto-send the initial page view — the gtag config call would
    // fire it before consent has been read out of localStorage. We send
    // page_view manually below if the user has previously consented.
    send_page_view: false,
  })

  // Inject the gtag.js script. Async so it doesn't block anything.
  const s = document.createElement('script')
  s.async = true
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`
  document.head.appendChild(s)

  // If the user already accepted on a previous visit, immediately upgrade
  // and replay the pending app_view.
  if (getConsent() === 'granted') {
    upgradeAnalytics()
    track('app_view')
  }
}

/**
 * Upgrade from cookieless degraded mode to full analytics collection.
 * Called from setConsent('granted') (banner accepted) and from
 * bootGaDegraded when the user has already consented on a previous visit.
 */
function upgradeAnalytics() {
  if (upgraded) return
  if (!degradedBooted) return
  upgraded = true

  window.gtag('consent', 'update', {
    analytics_storage: 'granted',
  })

  // Now that we have full analytics_storage, flush any pending events.
  for (const [name, params] of pendingEvents) {
    window.gtag('event', name, params)
  }
  pendingEvents = []
}

export function track(eventName, params) {
  if (!IS_WEB || !GA_ID) return
  if (!degradedBooted) return

  // In degraded mode, gtag('event', ...) hits still go out as cookieless
  // pings if `analytics_storage` is denied — Google's documented behaviour
  // for Consent Mode v2. Once `update` flips it to granted, the same
  // events get the full client ID + cookie context.
  //
  // We DO still gate on consent for one reason: GA4's "modeled" cookieless
  // mode is best for high-level page-view signals; named custom events
  // before consent risks under-measurement and clutter. Buffer named
  // events until consent and replay on grant.
  if (!upgraded) {
    pendingEvents.push([eventName, params || {}])
    return
  }
  if (typeof window.gtag === 'function') {
    window.gtag('event', eventName, params || {})
  }
}

// Backwards-compatible alias — used to be the single init entry point.
// Kept so existing call sites compile while we transition. New code
// should call bootGaDegraded() from main.jsx and rely on setConsent.
export function initAnalytics() {
  bootGaDegraded()
  if (getConsent() === 'granted') upgradeAnalytics()
}
