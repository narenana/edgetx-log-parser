// Blackbox BBL/TXT binary format parser.
// Handles iNAV and Betaflight logs (binary format, ASCII header + binary frames).

// ── Encoding constants ────────────────────────────────────────────────────────
const SIGNED_VB   = 0  // ZigZag VLQ
const UNSIGNED_VB = 1  // Plain VLQ
const NEG_14BIT   = 3  // -readUVB()
const TAG8_8SVB   = 6  // 1 tag byte, up to 8 SVB values
const TAG8_4S16   = 7  // 1 tag byte (2 bits/field): 0=zero, 1=nibble(4-bit), 2=s8, 3=s16
const TAG2_3S32   = 8  // 1 tag byte per 3 values: 0=zero, 1=s8, 2=s16, 3=s32
const NULL_ENC    = 9  // always 0, no bytes

// ── Flight-mode bit definitions ───────────────────────────────────────────────
const INAV_FM = [
  [0x0001,'ANGLE'],[0x0002,'HORIZON'],[0x0004,'ACROPLUS'],
  [0x0008,'ALT'],  [0x0010,'POSHOLD'],[0x0020,'RTH'],
  [0x0040,'WP'],   [0x0080,'HEADFREE'],[0x0100,'AUTOTUNE'],
  [0x0200,'CRUISE'],[0x0400,'LAUNCH'], [0x0800,'MANUAL'],
]
const BF_FM = [
  [0x0001,'ANGLE'],[0x0002,'HORIZON'],[0x0004,'BARO'],
  [0x0008,'MAG'],  [0x0010,'HEADFREE'],[0x0020,'GPS_RESCUE'],
  [0x0040,'FAILSAFE'],
]

function fmString(flags, defs) {
  if (!flags) return 'ACRO'
  for (const [bit, name] of defs) if (flags & bit) return name
  return 'ACRO'
}

// ── Field size estimator (nibble-aware, no side effects) ──────────────────────
// Returns byte position after consuming maxN fields starting at startP.
function computeFieldsSize(defs, buf, startP, maxN) {
  let p = startP
  const n = Math.min(maxN, defs.length)
  let i = 0
  while (i < n) {
    const enc = defs[i].encoding
    if (enc === NULL_ENC) { i++; continue }
    if (enc === SIGNED_VB || enc === UNSIGNED_VB || enc === NEG_14BIT) {
      while (p < buf.length) { if (!(buf[p++] & 0x80)) break }
      i++; continue
    }
    if (enc === TAG8_8SVB) {
      let j = i; while (j < n && defs[j].encoding === TAG8_8SVB) j++
      const tag = buf[p++], cnt = j - i
      for (let k = 0; k < cnt; k++) if (tag & (1 << k)) {
        while (p < buf.length) { if (!(buf[p++] & 0x80)) break }
      }
      i = j; continue
    }
    if (enc === TAG8_4S16) {
      let j = i; while (j < n && defs[j].encoding === TAG8_4S16) j++
      const cnt = j - i, tag = buf[p++]
      let nibblePending = false
      for (let k = 0; k < cnt; k++) {
        const c = (tag >> (k * 2)) & 3
        if (c === 0) {}
        else if (c === 1) { if (!nibblePending) { p++; nibblePending = true } else nibblePending = false }
        else if (c === 2) { p++ }
        else              { p += 2 }
      }
      i = j; continue
    }
    if (enc === TAG2_3S32) {
      let j = i; while (j < n && defs[j].encoding === TAG2_3S32) j++
      const cnt = j - i
      for (let chunk = 0; chunk * 3 < cnt; chunk++) {
        const tag = buf[p++], sz = Math.min(3, cnt - chunk * 3)
        for (let k = 0; k < sz; k++) {
          const c = (tag >> (k * 2)) & 3
          if (c === 1) p++; else if (c === 2) p += 2; else if (c === 3) p += 4
        }
      }
      i = j; continue
    }
    i++
  }
  return p
}

// ── Low-level binary reader ───────────────────────────────────────────────────
class Reader {
  constructor(buf, pos) { this.b = buf; this.p = pos }

  byte() { return this.p < this.b.length ? this.b[this.p++] : 0 }

  uvb() {
    let r = 0, s = 0
    while (this.p < this.b.length) {
      const b = this.b[this.p++]
      r |= (b & 0x7f) << s
      if (!(b & 0x80)) break
      s += 7
    }
    return r >>> 0
  }

  svb()  { const r = this.uvb(); return (r >>> 1) ^ -(r & 1) }
  s8()   { return (this.byte() << 24) >> 24 }
  s16()  { const lo = this.byte(), hi = this.byte(); return ((lo | (hi << 8)) << 16) >> 16 }
  s32()  {
    const b0 = this.byte(), b1 = this.byte(), b2 = this.byte(), b3 = this.byte()
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) | 0
  }
  neg14() { return -this.uvb() }

  // Decode up to maxN fields (defaults to all). Fields beyond maxN stay 0.
  fields(defs, maxN = defs.length) {
    const n = Math.min(maxN, defs.length)
    const vals = new Array(defs.length).fill(0)
    let i = 0
    while (i < n) {
      const enc = defs[i].encoding
      if (enc === NULL_ENC) {
        vals[i++] = 0
      } else if (enc === TAG8_8SVB) {
        let j = i; while (j < n && defs[j].encoding === TAG8_8SVB) j++
        const cnt = j - i, tag = this.byte()
        for (let k = 0; k < cnt; k++) vals[i + k] = (tag & (1 << k)) ? this.svb() : 0
        i = j
      } else if (enc === TAG8_4S16) {
        // code 0=zero, 1=4-bit nibble (2 packed per byte, low then high), 2=s8, 3=s16
        let j = i; while (j < n && defs[j].encoding === TAG8_4S16) j++
        const cnt = j - i, tag = this.byte()
        let nibbleByte = -1  // -1 = no pending nibble; >=0 = saved byte for 2nd nibble
        for (let k = 0; k < cnt; k++) {
          const c = (tag >> (k * 2)) & 3
          if (c === 0) {
            vals[i + k] = 0
          } else if (c === 1) {
            if (nibbleByte < 0) {
              nibbleByte = this.byte()
              vals[i + k] = ((nibbleByte & 0xF) << 28) >> 28  // sign-extend low 4 bits
            } else {
              vals[i + k] = ((nibbleByte >> 4) << 28) >> 28   // sign-extend high 4 bits
              nibbleByte = -1
            }
          } else if (c === 2) {
            vals[i + k] = this.s8()
          } else {
            vals[i + k] = this.s16()
          }
        }
        i = j
      } else if (enc === TAG2_3S32) {
        let j = i; while (j < n && defs[j].encoding === TAG2_3S32) j++
        const cnt = j - i
        for (let chunk = 0; chunk * 3 < cnt; chunk++) {
          const tag = this.byte()
          const sz = Math.min(3, cnt - chunk * 3)
          for (let k = 0; k < sz; k++) {
            const c = (tag >> (k * 2)) & 3
            const idx = chunk * 3 + k
            if      (c === 0) vals[i + idx] = 0
            else if (c === 1) vals[i + idx] = this.s8()
            else if (c === 2) vals[i + idx] = this.s16()
            else              vals[i + idx] = this.s32()
          }
        }
        i = j
      } else if (enc === SIGNED_VB)   { vals[i++] = this.svb()   }
        else if (enc === UNSIGNED_VB) { vals[i++] = this.uvb()   }
        else if (enc === NEG_14BIT)   { vals[i++] = this.neg14() }
        else                          { vals[i++] = 0 }
    }
    return vals
  }
}

// ── Header parser ─────────────────────────────────────────────────────────────
function parseHeaders(buf, startPos) {
  const headers = {}
  const fieldDefs = {}
  let pos = startPos

  while (pos < buf.length) {
    if (buf[pos] !== 0x48 || buf[pos + 1] !== 0x20) break
    pos += 2
    const lineStart = pos
    while (pos < buf.length && buf[pos] !== 0x0a) pos++
    const lineEnd = (pos > lineStart && buf[pos - 1] === 0x0d) ? pos - 1 : pos
    if (pos < buf.length) pos++
    let text = ''
    for (let i = lineStart; i < lineEnd; i++) text += String.fromCharCode(buf[i])
    const colon = text.indexOf(':')
    if (colon < 0) continue
    const key = text.slice(0, colon).trim()
    const val = text.slice(colon + 1).trim()
    headers[key] = val
    const m = key.match(/^Field ([A-Z]) (name|signed|predictor|encoding)$/)
    if (m) {
      const fl = m[1], attr = m[2]
      if (!fieldDefs[fl]) fieldDefs[fl] = []
      const parts = val.split(',')
      while (fieldDefs[fl].length < parts.length) fieldDefs[fl].push({})
      parts.forEach((v, i) => {
        if      (attr === 'name')      fieldDefs[fl][i].name = v
        else if (attr === 'signed')    fieldDefs[fl][i].signed = v === '1'
        else if (attr === 'predictor') fieldDefs[fl][i].predictor = parseInt(v)
        else if (attr === 'encoding')  fieldDefs[fl][i].encoding = parseInt(v)
      })
    }
  }

  return { headers, fieldDefs, dataStart: pos }
}

// ── Frame decoder ─────────────────────────────────────────────────────────────
function decodeFrames(buf, dataStart, fieldDefs, headers) {
  const iDefs = fieldDefs.I || []
  const pDefs = fieldDefs.P || []
  const gDefs = fieldDefs.G || []
  const hDefs = fieldDefs.H || []
  const sDefs = fieldDefs.S || []

  const iNames = iDefs.map(f => f.name)
  const gNames = gDefs.map(f => f.name)
  const sNames = sDefs.map(f => f.name)

  const iI = n => iNames.indexOf(n)
  const gI = n => gNames.indexOf(n)
  const sI = n => sNames.indexOf(n)

  const IF = {
    time:   iI('time'),
    att0:   iI('attitude[0]'),
    att1:   iI('attitude[1]'),
    att2:   iI('attitude[2]'),
    baro:   iI('BaroAlt') >= 0 ? iI('BaroAlt') : iI('baroAlt'),
    rssi:   iI('rssi'),
    vbat:   iI('vbat') >= 0 ? iI('vbat') : iI('vbatLatest'),
    amp:    iI('amperage') >= 0 ? iI('amperage') : iI('amperageLatest'),
    airspd: iI('AirSpeed'),
  }
  const GF = {
    time:   gI('time'),
    lat:    gI('GPS_coord[0]'),
    lon:    gI('GPS_coord[1]'),
    alt:    gI('GPS_altitude'),
    speed:  gI('GPS_speed'),
    course: gI('GPS_ground_course'),
    fix:    gI('GPS_fixType'),
    sats:   gI('GPS_numSat'),
  }
  const SF = {
    fm:       sI('flightModeFlags'),
    activeFm: sI('activeFlightModeFlags'),
  }

  const vbatref  = parseInt(headers['vbatref'] || '0')
  const isINAV   = (headers['Firmware revision'] || '').includes('INAV')
  const fmDefs   = isINAV ? INAV_FM : BF_FM

  const VALID = new Set([0x45, 0x47, 0x48, 0x49, 0x50, 0x53])

  // Effective field counts: some firmware (e.g. iNAV 8.0.1) declares more fields in
  // headers than it actually writes. Calibrated on first real frame of each type.
  let effectivePCount = -1  // -1 = not yet calibrated
  let effectiveSCount = -1

  let t0 = -1
  const att = [0, 0, 0]
  let gpsLat = null, gpsLon = null, gpsAlt = 0, gpsSpd = 0, gpsCourse = 0
  let gpsHome = [0, 0]
  let prevGTime = 0
  let lastFM = 0, lastActiveFM = 0
  let prevPVals = new Array(iDefs.length).fill(0)
  let refIVals = null

  const rows = []
  let lastEmitT = -Infinity
  const SAMPLE_DT = 0.1

  const r = new Reader(buf, dataStart)
  let errors = 0

  function fillRow(last, vals) {
    if (!last) return
    if (IF.rssi >= 0 && vals[IF.rssi] != null) last['1RSS(dB)'] = vals[IF.rssi]
    if (IF.baro >= 0) {
      last._baroAlt = vals[IF.baro] / 100
      if (!gpsAlt && last._baroAlt) last['Alt(m)'] = last._baroAlt
    }
    if (IF.vbat >= 0) last['RxBt(V)'] = vals[IF.vbat] / 100
    if (IF.amp  >= 0) last['Curr(A)'] = vals[IF.amp]  / 100
  }

  function emitRow(tSec) {
    if (tSec - lastEmitT < SAMPLE_DT && tSec !== 0) return
    lastEmitT = tSec
    rows.push({
      _tSec:       tSec,
      _lat:        gpsLat,
      _lon:        gpsLon,
      _pitchDeg:   att[1] / 10,
      _rollDeg:    att[0] / 10,
      _yawDeg:     ((att[2] / 10) % 360 + 360) % 360,
      'Alt(m)':    gpsAlt > 0 ? gpsAlt : 0,
      'GSpd(kmh)': gpsSpd,
      'Hdg(°)':    gpsCourse,
      'VSpd(m/s)': null,
      'FM':        fmString(lastActiveFM || lastFM, fmDefs),
      'RxBt(V)':   null,
      'Curr(A)':   null,
      '1RSS(dB)':  null,
      '2RSS(dB)':  null,
      'RQly(%)':   null,
      _baroAlt:    0,
    })
    return rows[rows.length - 1]
  }

  while (r.p < buf.length && errors < 200) {
    // Detect start of next log segment
    if (buf[r.p] === 0x48 && r.p + 1 < buf.length && buf[r.p + 1] === 0x20) break

    const ft = r.byte()

    if (ft === 0x49) {  // ── I-frame ──────────────────────────────────────────
      if (!iDefs.length) continue
      try {
        const raw = r.fields(iDefs)
        const vals = raw.slice()
        for (let i = 0; i < iDefs.length; i++) {
          const p = iDefs[i].predictor
          if      (p === 9)             vals[i] = raw[i] + vbatref
          else if (p === 4 && refIVals) vals[i] = raw[i] + refIVals[i]
          else if (p === 8 && i > 0)    vals[i] = raw[i] + vals[i - 1]
        }
        if (!refIVals) refIVals = vals.slice()

        const timeUs = IF.time >= 0 ? vals[IF.time] : 0
        // t0 is set ONLY from I-frames — G-frames use a different time epoch
        if (t0 < 0) t0 = timeUs
        const tSec = (timeUs - t0) / 1e6

        if (IF.att0 >= 0) { att[0] = vals[IF.att0]; att[1] = vals[IF.att1]; att[2] = vals[IF.att2] }

        const last = emitRow(tSec)
        fillRow(last, vals)

        prevPVals = vals
      } catch { errors++ }

    } else if (ft === 0x50) {  // ── P-frame ───────────────────────────────────
      if (!pDefs.length) continue
      try {
        // Calibrate field count on first real P-frame by probing from declared down
        if (effectivePCount < 0) {
          effectivePCount = pDefs.length
          for (let n = pDefs.length; n >= Math.max(1, pDefs.length - 10); n--) {
            if (VALID.has(buf[computeFieldsSize(pDefs, buf, r.p, n)])) { effectivePCount = n; break }
          }
        }
        const raw = r.fields(pDefs, effectivePCount)
        const vals = new Array(pDefs.length).fill(0)
        for (let i = 0; i < effectivePCount; i++) {
          const p = pDefs[i].predictor
          if      (p === 0)            vals[i] = raw[i]
          else if (p === 1 || p === 3) vals[i] = (prevPVals[i] || 0) + raw[i]
          else if (p === 2)            vals[i] = (prevPVals[i] || 0) + raw[i]
          else if (p === 6)            vals[i] = (refIVals?.[i] || 0) + raw[i]
          else if (p === 9)            vals[i] = raw[i] + vbatref
          else if (p === 8 && i > 0)   vals[i] = raw[i] + (vals[i - 1] || 0)
          else                         vals[i] = (prevPVals[i] || 0) + raw[i]
        }
        if (IF.att0 >= 0 && IF.att0 < effectivePCount) {
          att[0] = vals[IF.att0]; att[1] = vals[IF.att1]; att[2] = vals[IF.att2]
        }
        if (t0 >= 0 && IF.time >= 0 && IF.time < effectivePCount) {
          const tSec = (vals[IF.time] - t0) / 1e6
          if (tSec >= 0) {
            const last = emitRow(tSec)
            fillRow(last, vals)
          }
        }
        prevPVals = vals
      } catch { errors++ }

    } else if (ft === 0x47) {  // ── G-frame (GPS) ─────────────────────────────
      if (!gDefs.length) continue
      try {
        const raw = r.fields(gDefs)
        const vals = raw.slice()
        // Predictor 7 = GPS home offset; predictor 10 = prev G-frame time (different epoch)
        if (GF.lat  >= 0) vals[GF.lat]  = raw[GF.lat]  + gpsHome[0]
        if (GF.lon  >= 0) vals[GF.lon]  = raw[GF.lon]  + gpsHome[1]
        if (GF.time >= 0) { vals[GF.time] = raw[GF.time] + prevGTime; prevGTime = vals[GF.time] }
        // NOTE: G-frame time uses a different epoch than I-frame time; never set t0 from here

        const fixOk = GF.fix < 0 || vals[GF.fix] >= 2
        if (fixOk && GF.lat >= 0) {
          const lat = vals[GF.lat] / 1e7
          const lon = vals[GF.lon] / 1e7
          if (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001) {
            gpsLat    = lat
            gpsLon    = lon
            gpsAlt    = GF.alt    >= 0 ? vals[GF.alt]    / 100      : 0
            gpsSpd    = GF.speed  >= 0 ? vals[GF.speed]  / 100 * 3.6 : 0
            gpsCourse = GF.course >= 0 ? vals[GF.course] / 10        : 0
            // Attach to the most recent row — don't use time matching since epochs differ
            if (rows.length) {
              const last = rows[rows.length - 1]
              last._lat = gpsLat; last._lon = gpsLon
              last['Alt(m)']    = gpsAlt
              last['GSpd(kmh)'] = gpsSpd
              last['Hdg(°)']    = gpsCourse
            }
          }
        }
      } catch { errors++ }

    } else if (ft === 0x48) {  // ── H-frame (GPS home) ────────────────────────
      if (!hDefs.length) continue
      try {
        const raw = r.fields(hDefs)
        gpsHome[0] = raw[0] || 0
        gpsHome[1] = raw[1] || 0
      } catch { errors++ }

    } else if (ft === 0x53) {  // ── S-frame (slow) ────────────────────────────
      if (!sDefs.length) continue
      try {
        if (effectiveSCount < 0) {
          effectiveSCount = sDefs.length
          for (let n = sDefs.length; n >= Math.max(1, sDefs.length - 10); n--) {
            if (VALID.has(buf[computeFieldsSize(sDefs, buf, r.p, n)])) { effectiveSCount = n; break }
          }
        }
        const raw = r.fields(sDefs, effectiveSCount)
        if (SF.fm >= 0)       lastFM       = raw[SF.fm]
        if (SF.activeFm >= 0) lastActiveFM = raw[SF.activeFm]
      } catch { errors++ }

    } else if (ft === 0x45) {  // ── E-frame (event) ───────────────────────────
      const ev = r.byte()
      if (ev === 0xff) {
        // LOG_END: "End of log\0" — skip the 11-byte message so next log header is found
        r.p += 11
        break
      }
      // Skip known event payloads to stay in sync
      if      (ev === 0x00) { r.uvb() }            // SYNC_BEEP: timestamp (event value 0)
      else if (ev === 0x0e) { r.uvb(); r.uvb() }   // LOGGING_RESUME: iteration + time
      else if (ev === 0x1e) { r.uvb(); r.uvb() }   // FLIGHT_MODE: flags + last_flags
      else if (ev === 0x0d) { r.uvb(); r.uvb() }   // INFLIGHT_ADJUSTMENT
      else { while (r.p < buf.length && !VALID.has(buf[r.p])) r.p++ }

    } else {
      while (r.p < buf.length && !VALID.has(buf[r.p])) r.p++
      errors++
    }
  }

  // Compute VSpd from altitude differences
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i]._tSec - rows[i - 1]._tSec
    if (dt > 0) rows[i]['VSpd(m/s)'] = (rows[i]['Alt(m)'] - rows[i - 1]['Alt(m)']) / dt
  }
  if (rows.length) rows[0]['VSpd(m/s)'] = 0

  return { rows, nextPos: r.p }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isBlackboxBuffer(buf) {
  const sig = 'H Product:Blackbox'
  if (buf.length < sig.length) return false
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig.charCodeAt(i)) return false
  return true
}

export function parseBlackbox(buffer, filename) {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const logs = []
  let pos = 0

  while (pos < buf.length) {
    if (!isBlackboxBuffer(buf.subarray(pos))) {
      const sig = [0x48, 0x20, 0x50, 0x72, 0x6f, 0x64, 0x75, 0x63, 0x74, 0x3a, 0x42]
      let found = -1
      for (let i = pos; i < buf.length - sig.length; i++) {
        let ok = true
        for (let j = 0; j < sig.length; j++) if (buf[i + j] !== sig[j]) { ok = false; break }
        if (ok) { found = i; break }
      }
      if (found < 0) break
      pos = found
    }

    const { headers, fieldDefs, dataStart } = parseHeaders(buf, pos)
    if (dataStart === pos) break

    const { rows, nextPos } = decodeFrames(buf, dataStart, fieldDefs, headers)

    if (rows.length > 1) {
      const craftName = headers['Craft name'] || filename.replace(/\.[^.]+$/, '')
      const fwRev     = headers['Firmware revision'] || ''
      const dateStr   = (headers['Log start datetime'] || '').replace('T', ' ').slice(0, 19)
      const logFilename = `${craftName} ${dateStr || filename}`

      const hasGPS     = rows.some(r => r._lat !== null)
      const hasBattery = rows.some(r => r['RxBt(V)'] != null)
      const hasCurrent = rows.some(r => r['Curr(A)'] != null)

      const fmSet = new Set(rows.map(r => r['FM']))
      const flightModes = [...fmSet].map(fm => ({ name: fm }))

      const alts = rows.map(r => r['Alt(m)']).filter(v => v != null)
      const spds = rows.map(r => r['GSpd(kmh)']).filter(v => v != null)
      const dur  = rows[rows.length - 1]._tSec - rows[0]._tSec
      const stats = {
        duration:  dur,
        maxAlt:    alts.length ? Math.max(...alts) : 0,
        maxSpeed:  spds.length ? Math.max(...spds) : 0,
        totalDist: 0,
        firmware:  fwRev.split(' ').slice(0, 2).join(' '),
      }

      const ALT_THRESHOLD = 2
      const events = []
      const takeoffIdx = rows.findIndex(r => r['Alt(m)'] > ALT_THRESHOLD)
      if (takeoffIdx >= 0) events.push({ type: 'takeoff', index: takeoffIdx })
      let landIdx = -1
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]['Alt(m)'] > ALT_THRESHOLD) { landIdx = i; break }
      }
      if (landIdx >= 0 && landIdx !== takeoffIdx) events.push({ type: 'landing', index: landIdx })

      logs.push({ filename: logFilename, rows, flightModes, hasGPS, hasBattery, hasCurrent, stats, events })
    }

    pos = nextPos
    if (pos <= dataStart) break
  }

  return logs
}
