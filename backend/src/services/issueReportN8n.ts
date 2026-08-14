import { createSign, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { query } from '../db/connection.js'
import { RISK_TOP_WHERE } from './lot.service.js'
import { listOpenIssueDetailsByLotId } from './issue.service.js'
import { buildLotIssueReportHtml } from './issueReportHtml.js'

const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'

export type DispatchIssueReportsResult = {
  enabled: boolean
  baseline: boolean
  lots: number
  inserted: number
  webhooks: number
  skipped: number
}

type MailUser = {
  user_id: string
  email: string
}

type InsertResult = {
  insertId?: number | bigint
  affectedRows?: number
}

let cachedAccess: { token: string; expMs: number } | null = null

function envFlagOn(name: string, defaultOn = true): boolean {
  const v = (process.env[name] ?? (defaultOn ? '1' : '0')).trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

function envTrim(name: string): string {
  return (process.env[name] || '').trim()
}

function mailFrom(): string {
  return envTrim('ISSUE_REPORT_MAIL_FROM') || envTrim('GMAIL_SENDER') || envTrim('GOOGLE_MAIL_DELEGATED_USER')
}

function webhookUrl(): string {
  return envTrim('N8N_ISSUE_REPORT_WEBHOOK_URL')
}

function webhookSecret(): string {
  return envTrim('N8N_WEBHOOK_SECRET')
}

export function isIssueReportMailEnabled(): boolean {
  return envFlagOn('ISSUE_REPORT_MAIL_ENABLED', true)
}

export function secretsEqual(provided: string, expected: string): boolean {
  if (!expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function pemFromEnv(raw: string): string {
  return raw.replace(/\\n/g, '\n')
}

type ServiceAccountFile = {
  client_email?: string
  private_key?: string
}

/** Load SA credentials from a JSON key file. Never log file contents. */
function loadServiceAccountFile(): { clientEmail: string; privateKey: string } | null {
  const filePath =
    envTrim('GOOGLE_MAIL_SERVICE_ACCOUNT_FILE') || envTrim('GOOGLE_APPLICATION_CREDENTIALS')
  if (!filePath) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ServiceAccountFile
    const clientEmail = parsed.client_email?.trim()
    const privateKey = parsed.private_key ? pemFromEnv(parsed.private_key) : ''
    if (!clientEmail || !privateKey) {
      console.error('[issue-report-mail] service_account_file_incomplete')
      return null
    }
    return { clientEmail, privateKey }
  } catch {
    console.error('[issue-report-mail] service_account_file_unreadable')
    return null
  }
}

async function fetchAccessTokenOAuth(): Promise<string | null> {
  const clientId = envTrim('GMAIL_CLIENT_ID')
  const clientSecret = envTrim('GMAIL_CLIENT_SECRET')
  const refreshToken = envTrim('GMAIL_REFRESH_TOKEN')
  if (!clientId || !clientSecret || !refreshToken) return null

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    console.error('[issue-report-mail] gmail_oauth_token_failed', res.status)
    return null
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number }
  const token = json.access_token?.trim()
  if (!token) return null
  const expiresIn = Number(json.expires_in) || 3600
  cachedAccess = { token, expMs: Date.now() + Math.max(expiresIn - 60, 30) * 1000 }
  return token
}

async function fetchAccessTokenServiceAccount(subjectOverride?: string): Promise<string | null> {
  const fromFile = loadServiceAccountFile()
  const clientEmail = fromFile?.clientEmail || envTrim('GOOGLE_MAIL_CLIENT_EMAIL')
  const privateKey = fromFile?.privateKey || pemFromEnv(envTrim('GOOGLE_MAIL_PRIVATE_KEY'))
  const subject = subjectOverride || envTrim('GOOGLE_MAIL_DELEGATED_USER') || mailFrom()
  if (!clientEmail || !privateKey || !subject) return null

  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claim = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: GMAIL_SEND_SCOPE,
      aud: GMAIL_TOKEN_URL,
      iat: now,
      exp: now + 3600,
      sub: subject,
    }),
  ).toString('base64url')
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  const assertion = `${header}.${claim}.${signer.sign(privateKey, 'base64url')}`

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    let detail = String(res.status)
    try {
      const body = (await res.json()) as { error?: string; error_description?: string }
      detail = [res.status, body.error, body.error_description].filter(Boolean).join(' ')
    } catch {
      /* ignore body parse */
    }
    console.error('[issue-report-mail] gmail_sa_token_failed', detail)
    return null
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number }
  const token = json.access_token?.trim()
  if (!token) return null
  const expiresIn = Number(json.expires_in) || 3600
  cachedAccess = { token, expMs: Date.now() + Math.max(expiresIn - 60, 30) * 1000 }
  return token
}

async function getGmailAccessToken(subjectOverride?: string): Promise<string | null> {
  if (cachedAccess && cachedAccess.expMs > Date.now()) return cachedAccess.token
  // Personal Gmail: OAuth refresh token. SA impersonation cannot send as @gmail.com.
  return (await fetchAccessTokenOAuth()) ?? (await fetchAccessTokenServiceAccount(subjectOverride))
}

async function countSendEmailRows(): Promise<number> {
  const rows = await query<{ c: number }[]>(`SELECT COUNT(*) AS c FROM send_email`)
  return Number(rows[0]?.c ?? 0)
}

/** Any existing row (send O or X) blocks that lot forever. No retry on failure. */
async function listKnownLotIds(lotIds: string[]): Promise<Set<string>> {
  if (lotIds.length === 0) return new Set()
  const placeholders = lotIds.map(() => '?').join(', ')
  const rows = await query<{ lot_id: string }[]>(
    `SELECT DISTINCT lot_id FROM send_email WHERE lot_id IN (${placeholders})`,
    lotIds,
  )
  return new Set(rows.map((r) => r.lot_id))
}

async function listRiskTopLotIdsWithOpenIssues(): Promise<string[]> {
  const rows = await query<{ lot_id: string }[]>(
    `SELECT DISTINCT l.id AS lot_id
     FROM lots l
     LEFT JOIN SPC_LOT s ON s.lot_id = l.id
     INNER JOIN analysis_lots a ON a.lot_id = l.id
     INNER JOIN issues i ON i.lot_id = l.id AND i.completed_at IS NULL
     WHERE ${RISK_TOP_WHERE}
     ORDER BY COALESCE(s.produced_at, l.\`timestamp\`) DESC`,
  )
  return rows.map((r) => r.lot_id)
}

async function listMailUsers(optInOnly: boolean): Promise<MailUser[]> {
  const where = optInOnly
    ? `u.email IS NOT NULL AND TRIM(u.email) <> '' AND COALESCE(s.email_check, 'X') = 'O'`
    : `u.email IS NOT NULL AND TRIM(u.email) <> ''`
  const rows = await query<MailUser[]>(
    `SELECT u.user_id, u.email
     FROM users u
     LEFT JOIN user_settings s ON s.user_id = u.user_id
     WHERE ${where}`,
  )
  return rows
}

async function insertSendEmailRow(input: {
  lotId: string
  userId: string
  email: string
  html: string
  error: string | null
}): Promise<number | null> {
  try {
    const result = (await query(
      `INSERT INTO send_email (lot_id, user_id, email, mail_contents, send, error)
       VALUES (?, ?, ?, ?, 'X', ?)`,
      [input.lotId, input.userId, input.email, input.html, input.error],
    )) as InsertResult
    const id = result?.insertId
    return id == null ? null : Number(id)
  } catch (err: unknown) {
    const code = typeof err === 'object' && err && 'code' in err ? String((err as { code: string }).code) : ''
    if (code === 'ER_DUP_ENTRY') return null
    throw err
  }
}

export async function applySendEmailResult(input: {
  id: number
  send: 'O' | 'X'
  error?: string | null
}): Promise<boolean> {
  const error = input.send === 'O' ? null : (input.error ?? 'n8n_failed').slice(0, 255)
  const result = (await query(
    input.send === 'O'
      ? `UPDATE send_email SET send = 'O', sent_at = NOW(), error = NULL WHERE id = ?`
      : `UPDATE send_email SET send = 'X', error = ? WHERE id = ?`,
    input.send === 'O' ? [input.id] : [error, input.id],
  )) as InsertResult
  return Number(result?.affectedRows ?? 0) > 0
}

async function postN8nWebhook(payload: {
  id: number
  lotId: string
  to: string
  subject: string
  html: string
  from: string
  noReply: true
  accessToken: string
}): Promise<{ send?: 'O' | 'X'; error?: string }> {
  const url = webhookUrl()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const secret = webhookSecret()
  if (secret) headers.Authorization = `Bearer ${secret}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    return { send: 'X', error: `webhook_${res.status}`.slice(0, 255) }
  }
  try {
    const json = JSON.parse(text) as { send?: string; error?: string }
    if (json.send === 'O' || json.send === 'X') {
      return { send: json.send, error: json.error }
    }
  } catch {
    /* n8n may return empty 200; wait for callback */
  }
  return {}
}

/**
 * After ensureIssuesForRiskLots: mail new 위험 LOT Top lots via n8n.
 * Empty send_email table = baseline (insert X, no webhook).
 * send='X' is final: a row in send_email (O or X) means that lot is never dispatched again.
 */
export async function dispatchNewRiskTopIssueReports(): Promise<DispatchIssueReportsResult> {
  const empty: DispatchIssueReportsResult = {
    enabled: false,
    baseline: false,
    lots: 0,
    inserted: 0,
    webhooks: 0,
    skipped: 0,
  }
  if (!isIssueReportMailEnabled()) return empty

  const lotIds = await listRiskTopLotIdsWithOpenIssues()
  const baseline = (await countSendEmailRows()) === 0
  const known = baseline ? new Set<string>() : await listKnownLotIds(lotIds)
  const newLotIds = lotIds.filter((id) => !known.has(id))
  if (newLotIds.length === 0) {
    return { ...empty, enabled: true, baseline, skipped: lotIds.length }
  }

  const recipients = await listMailUsers(baseline ? false : true)
  if (recipients.length === 0) {
    console.log('[issue-report-mail] no_recipients', { baseline })
    return { ...empty, enabled: true, baseline, lots: newLotIds.length }
  }

  const from = mailFrom()
  let accessToken: string | null = null
  if (!baseline) {
    if (!webhookUrl() || !from) {
      console.log('[issue-report-mail] skipped_env', {
        webhook: Boolean(webhookUrl()),
        from: Boolean(from),
      })
    } else {
      accessToken = await getGmailAccessToken()
      if (!accessToken) console.log('[issue-report-mail] skipped_gmail_token')
    }
  }

  let inserted = 0
  let webhooks = 0
  for (const lotId of newLotIds) {
    const issues = await listOpenIssueDetailsByLotId(lotId)
    if (issues.length === 0) continue
    const html = buildLotIssueReportHtml({ lotId, issues })
    const subject = `[이슈 보고서] LOT ${lotId} · 심각`

    for (const user of recipients) {
      const error = baseline
        ? 'baseline_skip'
        : !webhookUrl()
          ? 'webhook_url_missing'
          : !from
            ? 'mail_from_missing'
            : !accessToken
              ? 'gmail_token_missing'
              : null
      const id = await insertSendEmailRow({
        lotId,
        userId: user.user_id,
        email: user.email,
        html,
        error,
      })
      if (id == null) continue
      inserted++
      if (baseline || !accessToken || !webhookUrl() || !from) continue

      try {
        const result = await postN8nWebhook({
          id,
          lotId,
          to: user.email,
          subject,
          html,
          from,
          noReply: true,
          accessToken,
        })
        webhooks++
        if (result.send === 'O' || result.send === 'X') {
          await applySendEmailResult({ id, send: result.send, error: result.error ?? null })
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        console.error('[issue-report-mail] webhook_failed', { id, lotId })
        await applySendEmailResult({ id, send: 'X', error: detail.slice(0, 255) })
      }
    }
  }

  return {
    enabled: true,
    baseline,
    lots: newLotIds.length,
    inserted,
    webhooks,
    skipped: lotIds.length - newLotIds.length,
  }
}

export function n8nCallbackSecret(): string {
  return webhookSecret()
}

/** Token check only. Does not send mail. */
export async function diagnoseGmailAuth(subjectOverride?: string): Promise<{ ok: boolean; detail: string }> {
  cachedAccess = null
  const token = await getGmailAccessToken(subjectOverride || mailFrom() || undefined)
  return token
    ? { ok: true, detail: 'token_ok' }
    : { ok: false, detail: 'token_failed (see gmail_sa_token_failed log)' }
}

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sendViaGmailApi(input: {
  accessToken: string
  from: string
  to: string
  subject: string
  html: string
}): Promise<{ send: 'O' | 'X'; error?: string }> {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(input.subject, 'utf8').toString('base64')}?=`
  const rfc822 = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Auto-Submitted: auto-generated',
    '',
    input.html,
  ].join('\r\n')
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: toBase64Url(rfc822) }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    let detail = `gmail_${res.status}`
    try {
      const body = (await res.json()) as {
        error?: { message?: string; status?: string }
      }
      const msg = body.error?.message || body.error?.status
      if (msg) detail = `gmail_${res.status}:${msg}`.slice(0, 255)
    } catch {
      /* ignore body parse */
    }
    return { send: 'X', error: detail }
  }
  return { send: 'O' }
}

async function existingSendEmailId(lotId: string, userId: string): Promise<number | null> {
  const rows = await query<{ id: number | bigint }[]>(
    `SELECT id FROM send_email WHERE lot_id = ? AND user_id = ? LIMIT 1`,
    [lotId, userId],
  )
  const id = rows[0]?.id
  return id == null ? null : Number(id)
}

/** Manual one-shot send. Poller still never retries send=X. */
export async function sendIssueReportOnce(input: {
  lotId: string
  html: string
  recipients: MailUser[]
  treatAsNew: boolean
}): Promise<{
  channel: 'n8n' | 'gmail'
  from: string
  sent: { userId: string; send: 'O' | 'X'; error?: string }[]
}> {
  const from = mailFrom() || input.recipients[0]?.email || ''
  if (!from) throw new Error('ISSUE_REPORT_MAIL_FROM / GOOGLE_MAIL_DELEGATED_USER 가 비어 있고 수신자도 없습니다.')

  cachedAccess = null
  const accessToken = await getGmailAccessToken(from)
  if (!accessToken) {
    throw new Error('Gmail access token 실패. 서비스 계정 JSON·도메인 위임·발신 주소를 확인하세요.')
  }

  const n8n = webhookUrl()
  const channel: 'n8n' | 'gmail' = n8n ? 'n8n' : 'gmail'
  const subject = `[이슈 보고서] LOT ${input.lotId} · 심각`
  const sent: { userId: string; send: 'O' | 'X'; error?: string }[] = []

  for (const user of input.recipients) {
    let id = await insertSendEmailRow({
      lotId: input.lotId,
      userId: user.user_id,
      email: user.email,
      html: input.html,
      error: input.treatAsNew ? 'manual_test' : null,
    })
    if (id == null) id = await existingSendEmailId(input.lotId, user.user_id)
    if (id == null) {
      sent.push({ userId: user.user_id, send: 'X', error: 'insert_failed' })
      continue
    }

    let result: { send: 'O' | 'X'; error?: string }
    try {
      if (channel === 'n8n') {
        const hook = await postN8nWebhook({
          id,
          lotId: input.lotId,
          to: user.email,
          subject,
          html: input.html,
          from,
          noReply: true,
          accessToken,
        })
        result = {
          send: hook.send === 'O' || hook.send === 'X' ? hook.send : 'X',
          error: hook.error ?? (hook.send ? undefined : 'n8n_no_result'),
        }
      } else {
        result = await sendViaGmailApi({
          accessToken,
          from,
          to: user.email,
          subject,
          html: input.html,
        })
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      result = { send: 'X', error: detail.slice(0, 255) }
    }
    await applySendEmailResult({ id, send: result.send, error: result.error ?? null })
    sent.push({ userId: user.user_id, send: result.send, error: result.error })
  }

  return { channel, from, sent }
}
