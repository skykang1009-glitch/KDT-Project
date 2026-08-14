/**
 * One-shot: treat one LOT as 위험 Top and send to email_check=O users.
 * Uses n8n webhook if URL is set, otherwise Gmail API directly.
 * Does not change poller no-retry rules.
 */
import '../src/loadRootEnv.js'
import { query } from '../src/db/connection.js'
import { RISK_TOP_WHERE } from '../src/services/lot.service.js'
import { listOpenIssueDetailsByLotId } from '../src/services/issue.service.js'
import { buildLotIssueReportHtml } from '../src/services/issueReportHtml.js'
import { sendIssueReportOnce } from '../src/services/issueReportN8n.js'

async function main() {
  const recipients = await query<{ user_id: string; email: string }[]>(
    `SELECT u.user_id, u.email
     FROM users u
     INNER JOIN user_settings s ON s.user_id = u.user_id
     WHERE s.email_check = 'O' AND u.email IS NOT NULL AND TRIM(u.email) <> ''`,
  )
  if (!recipients.length) {
    throw new Error('email_check=O 인 사용자가 없습니다. 설정에서 n8n 알림을 켜세요.')
  }

  const top = await query<{ lot_id: string }[]>(
    `SELECT DISTINCT l.id AS lot_id
     FROM lots l
     LEFT JOIN SPC_LOT s ON s.lot_id = l.id
     INNER JOIN analysis_lots a ON a.lot_id = l.id
     INNER JOIN issues i ON i.lot_id = l.id AND i.completed_at IS NULL
     WHERE ${RISK_TOP_WHERE}
     ORDER BY COALESCE(s.produced_at, l.\`timestamp\`) DESC
     LIMIT 1`,
  )
  let lotId = top[0]?.lot_id
  if (!lotId) {
    const any = await query<{ lot_id: string }[]>(
      `SELECT i.lot_id FROM issues i
       WHERE i.completed_at IS NULL
       ORDER BY i.created_at DESC LIMIT 1`,
    )
    lotId = any[0]?.lot_id
  }
  if (!lotId) {
    const lots = await query<{ id: string }[]>(`SELECT id FROM lots ORDER BY \`timestamp\` DESC LIMIT 1`)
    lotId = lots[0]?.id
  }
  if (!lotId) throw new Error('보낼 LOT이 없습니다.')

  const issues = await listOpenIssueDetailsByLotId(lotId)
  const html = buildLotIssueReportHtml({ lotId, issues })
  const result = await sendIssueReportOnce({
    lotId,
    html,
    recipients,
    treatAsNew: true,
  })
  console.log(JSON.stringify({ lotId, recipientCount: recipients.length, ...result }, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL', err instanceof Error ? err.message : err)
    process.exit(1)
  })
