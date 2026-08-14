import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { query } from '../db/connection.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  buildIssueTitle,
  combineLotScore,
  DEFECT_JUDGE_THRESHOLD,
  emptySpcHistory,
  evaluateSpcForFeatures,
  normalizeRiskLevel,
  pushCompleteLotHistory,
  residualMargin,
  scoreLotWithAi,
  type LotScoreResult,
  type ProcessFeatures,
  type RiskLevel,
  RESIDUAL_USL,
} from './lotScore.js'
import { loadStandard } from './standard.js'
import { evaluateLotSpc, isProcessComplete, loadPhase1Limits, SPC_PARAM_KEYS, type SpcParamKey } from './spcEngine.js'
import { composeIssueContentViaVllm } from './vllmRiskReason.js'

export type LotDto = {
  lotId: string
  recordedAt: string
  d50: number | null
  d90: number | null
  metalImpurity: number | null
  lithiumInput: number | null
  additiveRatio: number | null
  processTime: number | null
  sinteringTemp: number | null
  humidity: number | null
  tankPressure: number | null
  operatorId: string | null
  qualityDefect: boolean
  defectProb: number | null
  residualLithium: number | null
  /** USL(4000) − residual; null if residual missing */
  residualMargin: number | null
  spcStatus: string | null
  riskLevel: RiskLevel
  riskReason: string | null
}

type LotRow = {
  lot_id: string
  recorded_at: Date | string
  d50: number | null
  d90: number | null
  metal_impurity: number | null
  lithium_input: number | null
  additive_ratio: number | null
  process_time: number | null
  sintering_temp: number | null
  humidity: number | null
  tank_pressure: number | null
  operator_id: string | null
  quality_defect: number | boolean
  residual_lithium: number | null
  probability: number | null
  spc_status: string | null
  risk_level: string | null
  risk_reason: string | null
}

function formatDateTime(value: Date | string | null | undefined): string {
  if (value == null) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function toDto(row: LotRow): LotDto {
  const residual = row.residual_lithium != null ? Number(row.residual_lithium) : null
  return {
    lotId: row.lot_id,
    recordedAt: formatDateTime(row.recorded_at),
    d50: row.d50 != null ? Number(row.d50) : null,
    d90: row.d90 != null ? Number(row.d90) : null,
    metalImpurity: row.metal_impurity != null ? Number(row.metal_impurity) : null,
    lithiumInput: row.lithium_input != null ? Number(row.lithium_input) : null,
    additiveRatio: row.additive_ratio != null ? Number(row.additive_ratio) : null,
    processTime: row.process_time != null ? Number(row.process_time) : null,
    sinteringTemp: row.sintering_temp != null ? Number(row.sintering_temp) : null,
    humidity: row.humidity != null ? Number(row.humidity) : null,
    tankPressure: row.tank_pressure != null ? Number(row.tank_pressure) : null,
    operatorId: row.operator_id,
    qualityDefect: Boolean(row.quality_defect),
    defectProb: row.probability != null ? Number(row.probability) : null,
    residualLithium: residual,
    residualMargin: residual != null ? residualMargin(residual, RESIDUAL_USL) : null,
    spcStatus: row.spc_status,
    riskLevel: normalizeRiskLevel(row.risk_level),
    riskReason: row.risk_reason,
  }
}

function rowToFeatures(row: LotRow): ProcessFeatures {
  return {
    d50: row.d50 != null ? Number(row.d50) : null,
    d90: row.d90 != null ? Number(row.d90) : null,
    metal_impurity: row.metal_impurity != null ? Number(row.metal_impurity) : null,
    lithium_input: row.lithium_input != null ? Number(row.lithium_input) : null,
    additive_ratio: row.additive_ratio != null ? Number(row.additive_ratio) : null,
    process_time: row.process_time != null ? Number(row.process_time) : null,
    sintering_temp: row.sintering_temp != null ? Number(row.sintering_temp) : null,
    humidity: row.humidity != null ? Number(row.humidity) : null,
    tank_pressure: row.tank_pressure != null ? Number(row.tank_pressure) : null,
    operator_id: row.operator_id,
    id: row.lot_id,
    timestamp: formatDateTime(row.recorded_at),
  }
}

/** Process on `lots` + scores on `analysis_lots` + residual on `judgment_lots`. */
const LOT_SELECT = `SELECT l.id AS lot_id, COALESCE(s.produced_at, l.\`timestamp\`) AS recorded_at,
  COALESCE(s.d50, l.d50) AS d50,
  COALESCE(s.d90, l.d90) AS d90,
  COALESCE(s.metal_impurity, l.metal_impurity) AS metal_impurity,
  COALESCE(s.lithium_input, l.lithium_input) AS lithium_input,
  COALESCE(s.additive_ratio, l.additive_ratio) AS additive_ratio,
  COALESCE(s.process_time, l.process_time) AS process_time,
  COALESCE(s.sintering_temp, l.sintering_temp) AS sintering_temp,
  COALESCE(s.humidity, l.humidity) AS humidity,
  COALESCE(s.tank_pressure, l.tank_pressure) AS tank_pressure,
  COALESCE(s.operator_id, l.operator_id) AS operator_id,
  0 AS quality_defect, j.residual_li AS residual_lithium,
  COALESCE(j.probability, a.probability) AS probability,
  a.spc_status, a.risk_level, a.risk_reason
  FROM lots l
  LEFT JOIN SPC_LOT s ON s.lot_id = l.id
  LEFT JOIN analysis_lots a ON a.lot_id = l.id
  LEFT JOIN judgment_lots j ON j.lot_id = l.id`

export async function getLotById(lotId: string): Promise<LotDto> {
  const rows = await query<LotRow[]>(`${LOT_SELECT} WHERE l.id = ? LIMIT 1`, [lotId])
  if (!rows[0]) throw new AppError(404, 'LOT를 찾을 수 없습니다.')
  return toDto(rows[0])
}

export type DailyProbabilityKpi = {
  threshold: number
  total: number
  goodCount: number
  defectCount: number
  /** 0~100, null when total=0 */
  goodRate: number | null
  /** 0~100, null when total=0 */
  defectRate: number | null
}

/** Today 00:00~ · analysis_lots.probability vs DEFECT_JUDGE_THRESHOLD (Main KPI). */
export async function getDailyProbabilityKpi(): Promise<DailyProbabilityKpi> {
  const thr = DEFECT_JUDGE_THRESHOLD
  const rows = await query<
    { total: number; defect_count: number | null; good_count: number | null }[]
  >(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN a.probability >= ? THEN 1 ELSE 0 END) AS defect_count,
       SUM(CASE WHEN a.probability <  ? THEN 1 ELSE 0 END) AS good_count
     FROM lots l
     LEFT JOIN SPC_LOT s ON s.lot_id = l.id
     INNER JOIN analysis_lots a ON a.lot_id = l.id
     WHERE COALESCE(s.produced_at, l.\`timestamp\`) >= CURDATE()
       AND a.probability IS NOT NULL`,
    [thr, thr],
  )
  const total = Number(rows[0]?.total ?? 0)
  const defectCount = Number(rows[0]?.defect_count ?? 0)
  const goodCount = Number(rows[0]?.good_count ?? 0)
  const round1 = (n: number) => Math.round(n * 10) / 10
  return {
    threshold: thr,
    total,
    goodCount,
    defectCount,
    goodRate: total > 0 ? round1((goodCount / total) * 100) : null,
    defectRate: total > 0 ? round1((defectCount / total) * 100) : null,
  }
}

/** Tier-based Q-Cost unit prices (KRW) — keep in sync with frontend/src/lib/qCost.ts */
const Q_COST_APPRAISAL = {
  stable: 50_000,
  warning: 100_000,
  critical: 250_000,
} as const
const Q_COST_INTERNAL_UNIT = 500_000
const Q_COST_EXTERNAL_UNIT = 3_000_000
const Q_COST_PREVENTION = 20_000_000

export type QCostSummary = {
  from: string
  to: string
  stableCount: number
  warningCount: number
  criticalCount: number
  internalDefectCount: number
  /** Not tracked in DB yet — always 0 until leak source is defined */
  externalLeakCount: number
  appraisalCost: number
  appraisalBreakdown: {
    stable: number
    warning: number
    critical: number
  }
  internalCost: number
  externalCost: number
  preventionCost: number
  totalQCost: number
}

function toDateOnlyIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Period Q-Cost counts + costs.
 * Default window: current calendar month (prevention is monthly fixed).
 * - Appraisal tiers: analysis_lots.risk_level
 * - Internal defects: judgment_lots.quality_defect = 1
 * - External leaks: 0 (no column yet)
 */
export async function getQCostSummary(opts: {
  from?: string
  to?: string
} = {}): Promise<QCostSummary> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEndExclusive = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  const fromStr =
    opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)
      ? opts.from
      : toDateOnlyIso(monthStart)
  const toExclusiveStr =
    opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)
      ? opts.to
      : toDateOnlyIso(monthEndExclusive)

  const riskRows = await query<
    {
      stable_count: number | null
      warning_count: number | null
      critical_count: number | null
    }[]
  >(
    `SELECT
       SUM(CASE WHEN a.risk_level = '안정' THEN 1 ELSE 0 END) AS stable_count,
       SUM(CASE WHEN a.risk_level = '주의' THEN 1 ELSE 0 END) AS warning_count,
       SUM(CASE WHEN a.risk_level = '심각' THEN 1 ELSE 0 END) AS critical_count
     FROM lots l
     LEFT JOIN SPC_LOT s ON s.lot_id = l.id
     INNER JOIN analysis_lots a ON a.lot_id = l.id
     WHERE COALESCE(s.produced_at, l.\`timestamp\`) >= ?
       AND COALESCE(s.produced_at, l.\`timestamp\`) < ?`,
    [fromStr, toExclusiveStr],
  )

  const defectRows = await query<{ c: number | null }[]>(
    `SELECT COUNT(*) AS c
     FROM judgment_lots j
     INNER JOIN lots l ON l.id = j.lot_id
     LEFT JOIN SPC_LOT s ON s.lot_id = l.id
     WHERE j.quality_defect = 1
       AND COALESCE(s.produced_at, l.\`timestamp\`) >= ?
       AND COALESCE(s.produced_at, l.\`timestamp\`) < ?`,
    [fromStr, toExclusiveStr],
  )

  const stableCount = Number(riskRows[0]?.stable_count ?? 0)
  const warningCount = Number(riskRows[0]?.warning_count ?? 0)
  const criticalCount = Number(riskRows[0]?.critical_count ?? 0)
  const internalDefectCount = Number(defectRows[0]?.c ?? 0)
  const externalLeakCount = 0

  const appraisalBreakdown = {
    stable: stableCount * Q_COST_APPRAISAL.stable,
    warning: warningCount * Q_COST_APPRAISAL.warning,
    critical: criticalCount * Q_COST_APPRAISAL.critical,
  }
  const appraisalCost =
    appraisalBreakdown.stable +
    appraisalBreakdown.warning +
    appraisalBreakdown.critical
  const internalCost = internalDefectCount * Q_COST_INTERNAL_UNIT
  const externalCost = externalLeakCount * Q_COST_EXTERNAL_UNIT
  const preventionCost = Q_COST_PREVENTION
  const totalQCost = appraisalCost + internalCost + externalCost + preventionCost

  return {
    from: fromStr,
    to: toExclusiveStr,
    stableCount,
    warningCount,
    criticalCount,
    internalDefectCount,
    externalLeakCount,
    appraisalCost,
    appraisalBreakdown,
    internalCost,
    externalCost,
    preventionCost,
    totalQCost,
  }
}

export type RiskTopResult = {
  lots: LotDto[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export const RISK_TOP_WHERE = `a.risk_level = '심각'
  AND COALESCE(s.produced_at, l.\`timestamp\`) >= DATE_SUB(NOW(), INTERVAL 3 DAY)`

/** Recent 3 days · risk_level 심각 — paginated for Main 「위험 LOT Top」. */
export async function getRiskTop(opts: {
  page?: number
  pageSize?: number
} = {}): Promise<RiskTopResult> {
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 8, 1), 50)
  let page = Math.max(Number(opts.page) || 1, 1)

  const countRows = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c
     FROM lots l
     LEFT JOIN SPC_LOT s ON s.lot_id = l.id
     INNER JOIN analysis_lots a ON a.lot_id = l.id
     WHERE ${RISK_TOP_WHERE}`,
  )
  const total = Number(countRows[0]?.c ?? 0)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (page > totalPages) page = totalPages
  const offset = (page - 1) * pageSize

  const rows =
    total === 0
      ? []
      : await query<LotRow[]>(
        `${LOT_SELECT}
           WHERE ${RISK_TOP_WHERE}
           ORDER BY COALESCE(s.produced_at, l.\`timestamp\`) DESC
           LIMIT ? OFFSET ?`,
        [pageSize, offset],
      )

  return {
    lots: rows.map(toDto),
    total,
    page,
    pageSize,
    totalPages,
  }
}

function resolveCsvPath(): string {
  const envPath = process.env.LOT_CSV_PATH
  if (envPath && fs.existsSync(envPath)) return path.resolve(envPath)

  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, '../../../../ai-service/data/cathode_clf_data.csv'),
    path.resolve(here, '../../../ai-service/data/cathode_clf_data.csv'),
    path.resolve(process.cwd(), '../ai-service/data/cathode_clf_data.csv'),
    path.resolve(process.cwd(), 'ai-service/data/cathode_clf_data.csv'),
    path.resolve(process.cwd(), '../practice/cathode_clf_data.csv'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new AppError(500, 'cathode_clf_data.csv 경로를 찾을 수 없습니다. LOT_CSV_PATH를 설정하세요.')
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

function num(v: string | undefined): number | null {
  if (v == null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Upsert process features from clf CSV.
 * Scoring is separate (`scoreAllLots`) so import stays fast without ai-service.
 */
export async function importLotsFromCsv(csvPath?: string): Promise<{ imported: number; path: string }> {
  const filePath = csvPath && fs.existsSync(csvPath) ? csvPath : resolveCsvPath()
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) throw new AppError(400, 'CSV에 데이터가 없습니다.')

  const header = parseCsvLine(lines[0]).map((h) => h.trim())
  const idx = (name: string) => header.indexOf(name)

  let imported = 0
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    const lotId = cols[idx('id')]?.trim()
    if (!lotId) continue

    const recordedRaw = cols[idx('timestamp')]?.trim() || ''
    const recordedAt = recordedRaw.replace('T', ' ').slice(0, 19)

    await query(
      `INSERT INTO lots (
        id, \`timestamp\`, d50, d90, metal_impurity, lithium_input, additive_ratio,
        process_time, sintering_temp, humidity, tank_pressure, operator_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`timestamp\` = VALUES(\`timestamp\`),
        d50 = VALUES(d50), d90 = VALUES(d90),
        metal_impurity = VALUES(metal_impurity), lithium_input = VALUES(lithium_input),
        additive_ratio = VALUES(additive_ratio), process_time = VALUES(process_time),
        sintering_temp = VALUES(sintering_temp), humidity = VALUES(humidity),
        tank_pressure = VALUES(tank_pressure), operator_id = VALUES(operator_id)`,
      [
        lotId,
        recordedAt,
        num(cols[idx('d50')]),
        num(cols[idx('d90')]),
        num(cols[idx('metal_impurity')]),
        num(cols[idx('lithium_input')]),
        num(cols[idx('additive_ratio')]),
        num(cols[idx('process_time')]),
        num(cols[idx('sintering_temp')]),
        num(cols[idx('humidity')]),
        num(cols[idx('tank_pressure')]),
        cols[idx('operator_id')]?.trim() || null,
      ],
    )
    imported++
  }

  return { imported, path: filePath }
}

async function upsertAnalysisScore(
  lotId: string,
  scored: LotScoreResult,
  spcChart?: any,
) {
  const chartJson =
    spcChart === undefined ? undefined : JSON.stringify(spcChart ?? { metrics: [] })
  if (chartJson === undefined) {
    await query(
      `INSERT INTO analysis_lots (
        lot_id, probability, spc_status, risk_level, risk_reason, scored_at
      ) VALUES (?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        probability = VALUES(probability),
        spc_status = VALUES(spc_status),
        risk_level = VALUES(risk_level),
        risk_reason = VALUES(risk_reason),
        scored_at = NOW()`,
      [
        lotId,
        scored.probability,
        scored.spc_status,
        scored.risk_level,
        scored.risk_reason,
      ],
    )
    return
  }
  await query(
    `INSERT INTO analysis_lots (
      lot_id, probability, spc_status, risk_level, risk_reason, spc_chart_json, scored_at
    ) VALUES (?, ?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      probability = VALUES(probability),
      spc_status = VALUES(spc_status),
      risk_level = VALUES(risk_level),
      risk_reason = VALUES(risk_reason),
      spc_chart_json = VALUES(spc_chart_json),
      scored_at = NOW()`,
    [
      lotId,
      scored.probability,
      scored.spc_status,
      scored.risk_level,
      scored.risk_reason,
      chartJson,
    ],
  )
}

type LotResultsRow = {
  seq: number
  lot_id: string
  quality_defect: number | null
  residual_li: number | null
  measured_at: Date | string | null
}

async function getLotResults(lotId: string): Promise<LotResultsRow | null> {
  const rows = await query<LotResultsRow[]>(
    `SELECT seq, lot_id, quality_defect, residual_li, measured_at
     FROM lot_results WHERE lot_id = ? LIMIT 1`,
    [lotId],
  )
  return rows[0] ?? null
}

/** AI NULL-fill only — feeder measurements are never overwritten. */
async function upsertLotResultsNullFill(
  lotId: string,
  qualityDefect: number,
  residualLi: number,
): Promise<LotResultsRow | null> {
  const qd = qualityDefect === 1 ? 1 : 0
  const res = Number.isFinite(residualLi) ? residualLi : null

  const applyCoalesceUpdate = async () => {
    await query(
      `UPDATE lot_results
       SET quality_defect = COALESCE(quality_defect, ?),
           residual_li = COALESCE(residual_li, ?),
           measured_at = COALESCE(measured_at, NOW())
       WHERE lot_id = ?`,
      [qd, res, lotId],
    )
  }

  const existing = await getLotResults(lotId)
  if (existing) {
    await applyCoalesceUpdate()
    return getLotResults(lotId)
  }

  // Concurrent scorers race on MAX(seq)+1 — retry on PK clash; if another
  // worker already inserted this lot_id, fall through to COALESCE update.
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await getLotResults(lotId)) {
      await applyCoalesceUpdate()
      return getLotResults(lotId)
    }
    const maxRows = await query<{ m: number | null }[]>(
      `SELECT MAX(seq) AS m FROM lot_results`,
    )
    const seq = Number(maxRows[0]?.m ?? 0) + 1 + attempt
    try {
      await query(
        `INSERT INTO lot_results (seq, lot_id, quality_defect, residual_li, measured_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [seq, lotId, qd, res],
      )
      return getLotResults(lotId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const dup = /Duplicate entry/i.test(msg) || /ER_DUP_ENTRY/i.test(msg)
      if (!dup || attempt === 7) throw err
    }
  }
  return getLotResults(lotId)
}


/**
 * Prefer lot_results residual/qd for judgment write inputs.
 */
function judgmentInputsFromLotResults(
  voted: LotScoreResult,
  lr: LotResultsRow | null,
): { quality_defect: number; residual_li: number; capacity: number | null; probability: number; spc: string } {
  const residual =
    lr?.residual_li != null && Number.isFinite(Number(lr.residual_li))
      ? Number(lr.residual_li)
      : voted.residual_lithium
  const qd =
    lr?.quality_defect != null
      ? Number(lr.quality_defect) === 1
        ? 1
        : 0
      : voted.quality_defect
  return {
    quality_defect: qd === 1 ? 1 : 0,
    residual_li: residual,
    capacity: voted.capacity,
    probability: voted.probability,
    spc: voted.spc_status,
  }
}

type JudgmentRow = {
  lot_id: string
  quality_defect: number
  capacity: number | null
  residual_li: number | null
  probability: number | null
  spc: string | null
}

async function getJudgment(lotId: string): Promise<JudgmentRow | null> {
  const rows = await query<JudgmentRow[]>(
    `SELECT lot_id, quality_defect, capacity, residual_li, probability, spc
     FROM judgment_lots WHERE lot_id = ? LIMIT 1`,
    [lotId],
  )
  return rows[0] ?? null
}

/**
 * 2nd pass: analysis_lots from judgment_lots (+ SPC label already on judgment.spc).
 */
async function mergeScoreFromJudgment(
  j: JudgmentRow,
  fallbackSpc?: string,
): Promise<LotScoreResult> {
  const std = await loadStandard()
  const residual =
    j.residual_li != null && Number.isFinite(Number(j.residual_li))
      ? Number(j.residual_li)
      : 0
  const defectProb =
    j.probability != null && Number.isFinite(Number(j.probability))
      ? Number(j.probability)
      : 0
  const spcRaw = (j.spc || fallbackSpc || '안정').trim()
  const incomplete = spcRaw === '-'
  const merged = combineLotScore({
    defectProb,
    residualLi: residual,
    spcStatus: incomplete ? null : spcRaw,
    incompleteProcess: incomplete,
    thresholds: {
      defect_prob_caution: std.defect_prob_caution,
      defect_prob_severe: std.defect_prob_severe,
      residual_caution: std.residual_caution,
      residual_severe: std.residual_severe,
    },
  })
  merged.quality_defect = Number(j.quality_defect) === 1 ? 1 : 0
  merged.capacity =
    j.capacity != null && Number.isFinite(Number(j.capacity)) ? Number(j.capacity) : null
  // analysis probability mirrors judgment (SSOT after stage 2)
  merged.probability = defectProb
  if (!incomplete) merged.spc_status = spcRaw
  return merged
}

/** When judgment is already filled, rebuild analysis_lots only (2nd pass). */
export async function scoreAnalysisFromJudgment(lotId: string): Promise<boolean> {
  const j = await getJudgment(lotId)
  if (!j || j.probability == null || j.residual_li == null) return false
  const analysisScore = await mergeScoreFromJudgment(j)
  await upsertAnalysisScore(lotId, analysisScore)
  return true
}

async function updateLotScore(
  lotId: string,
  scored: LotScoreResult,
  seed?: {
    recordedAt: string
    qualityDefect: number
    features: ProcessFeatures
  },
  spcChart?: SpcChartSnapshot | null,
) {
  if (seed) {
    const f = seed.features
    await query(
      `INSERT INTO lots (
        id, \`timestamp\`, d50, d90, metal_impurity, lithium_input, additive_ratio,
        process_time, sintering_temp, humidity, tank_pressure, operator_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`timestamp\` = VALUES(\`timestamp\`),
        d50 = VALUES(d50),
        d90 = VALUES(d90),
        metal_impurity = VALUES(metal_impurity),
        lithium_input = VALUES(lithium_input),
        additive_ratio = VALUES(additive_ratio),
        process_time = VALUES(process_time),
        sintering_temp = VALUES(sintering_temp),
        humidity = VALUES(humidity),
        tank_pressure = VALUES(tank_pressure),
        operator_id = VALUES(operator_id)`,
      [
        lotId,
        seed.recordedAt,
        f.d50,
        f.d90,
        f.metal_impurity,
        f.lithium_input,
        f.additive_ratio,
        f.process_time,
        f.sintering_temp,
        f.humidity,
        f.tank_pressure,
        f.operator_id,
      ],
    )
  }

  // Stage 1: lot_results NULL-fill (feeder measurements never overwritten)
  const lr = await upsertLotResultsNullFill(
    lotId,
    scored.quality_defect,
    scored.residual_lithium,
  )

  // Stage 2: judgment_lots from lot_results (+ voting capacity/probability)
  const jIn = judgmentInputsFromLotResults(scored, lr)
  await query(
    `INSERT INTO judgment_lots (lot_id, quality_defect, capacity, residual_li, probability, spc)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       quality_defect = COALESCE(judgment_lots.quality_defect, VALUES(quality_defect)),
       capacity = COALESCE(judgment_lots.capacity, VALUES(capacity)),
       residual_li = COALESCE(judgment_lots.residual_li, VALUES(residual_li)),
       probability = COALESCE(judgment_lots.probability, VALUES(probability)),
       spc = VALUES(spc)`,
    [
      lotId,
      jIn.quality_defect,
      jIn.capacity,
      jIn.residual_li,
      jIn.probability,
      jIn.spc,
    ],
  )

  // Stage 3: analysis_lots from judgment (2nd pass) + scored_at (+ optional chart)
  const j = await getJudgment(lotId)
  const analysisScore = j
    ? await mergeScoreFromJudgment(j, scored.spc_status)
    : scored
  await upsertAnalysisScore(lotId, analysisScore)
}

/** Latest N lot ids by production time (for targeted rescoring). */
export async function getLatestLotIds(limit: number): Promise<string[]> {
  const n = Math.max(1, Math.floor(limit))
  const rows = await query<Array<{ id: string }>>(
    `SELECT id FROM lots ORDER BY \`timestamp\` DESC, id DESC LIMIT ?`,
    [n],
  )
  return rows.map((r) => String(r.id))
}

export type ScoreLotsOptions = {
  /** Max lots to score (after ordering). */
  limit?: number
  /** Skip first N lots in time order. */
  offset?: number
  /** If set, only these lot ids are scored (SPC history still walks all lots). */
  lotIds?: string[]
  concurrency?: number
  onProgress?: (done: number, total: number, lotId: string) => void
}

type LotScoreSourceRow = {
  lot_id: string
  recorded_at: Date | string
  d50: number | null
  d90: number | null
  metal_impurity: number | null
  lithium_input: number | null
  additive_ratio: number | null
  process_time: number | null
  sintering_temp: number | null
  humidity: number | null
  tank_pressure: number | null
  operator_id: string | null
  quality_defect?: number | boolean
}

function lotRowToFeatures(row: LotScoreSourceRow): ProcessFeatures {
  return {
    d50: row.d50 != null ? Number(row.d50) : null,
    d90: row.d90 != null ? Number(row.d90) : null,
    metal_impurity: row.metal_impurity != null ? Number(row.metal_impurity) : null,
    lithium_input: row.lithium_input != null ? Number(row.lithium_input) : null,
    additive_ratio: row.additive_ratio != null ? Number(row.additive_ratio) : null,
    process_time: row.process_time != null ? Number(row.process_time) : null,
    sintering_temp: row.sintering_temp != null ? Number(row.sintering_temp) : null,
    humidity: row.humidity != null ? Number(row.humidity) : null,
    tank_pressure: row.tank_pressure != null ? Number(row.tank_pressure) : null,
    operator_id: row.operator_id,
    id: row.lot_id,
    timestamp: formatDateTime(row.recorded_at),
  }
}

const LOT_SCORE_FEATURE_SELECT = `id AS lot_id, \`timestamp\` AS recorded_at, d50, d90, metal_impurity, lithium_input,
  additive_ratio, process_time, sintering_temp, humidity, tank_pressure, operator_id,
  0 AS quality_defect`

/**
 * Re-score using operational `lots` SSOT (3-stage):
 * 1) /predict-voting → lot_results NULL-fill (qd/residual)
 * 2) judgment_lots from lot_results + voting capacity/prob
 * 3) analysis_lots from judgment (combineLotScore + SPC / scored_at)
 */
export async function scoreAllLots(options: ScoreLotsOptions = {}): Promise<{
  scored: number
  failed: number
  errors: string[]
  /** Successfully scored lot ids (for risk-reason / recommended-action follow-up). */
  lotIds: string[]
}> {
  const offset = Math.max(0, options.offset ?? 0)
  const limit = options.limit != null ? Math.max(1, options.limit) : undefined
  const concurrency = Math.min(Math.max(options.concurrency ?? 4, 1), 16)
  const idFilter =
    options.lotIds != null && options.lotIds.length > 0
      ? new Set(options.lotIds.map(String))
      : null

  const lotRows = await query<LotScoreSourceRow[]>(
    `SELECT ${LOT_SCORE_FEATURE_SELECT}
     FROM lots
     ORDER BY \`timestamp\` ASC, id ASC`,
  )

  const history = emptySpcHistory()
  const timestamps: string[] = []
  let scored = 0
  let failed = 0
  const errors: string[] = []
  const scoredLotIds: string[] = []

  type Job = {
    row: LotScoreSourceRow
    histSnapshot: Record<SpcParamKey, number[]>
    chartSnapshot: SpcChartSnapshot
  }
  const jobs: Job[] = []

  // Walk all lots in time order for SPC history; only enqueue filter/slice targets.
  let considered = 0
  for (let i = 0; i < lotRows.length; i++) {
    const row = lotRows[i]
    const features = lotRowToFeatures(row)
    const bag: Partial<Record<SpcParamKey, number | null>> = {}
    for (const k of SPC_PARAM_KEYS) bag[k] = features[k]
    const complete = isProcessComplete(bag)
    if (complete) {
      for (const k of SPC_PARAM_KEYS) history[k].push(Number(features[k]))
      timestamps.push(formatDateTime(row.recorded_at))
    }

    const inFilter = idFilter == null || idFilter.has(row.lot_id)
    if (!inFilter) continue
    // Handover placeholder lot — not process data; never write analysis_lots.
    if (row.lot_id === 'LOT-SYS-HANDOVER') continue
    if (considered < offset) {
      considered++
      continue
    }
    if (limit != null && jobs.length >= limit) continue
    considered++

    const histSnapshot = {} as Record<SpcParamKey, number[]>
    for (const k of SPC_PARAM_KEYS) {
      histSnapshot[k] = complete ? history[k].slice() : []
    }
    const chartSnapshot = complete
      ? buildSpcChartSnapshot(histSnapshot, timestamps)
      : { metrics: [] }
    jobs.push({ row, histSnapshot, chartSnapshot })
  }

  for (let i = 0; i < jobs.length; i += concurrency) {
    const chunk = jobs.slice(i, i + concurrency)
    const results = await Promise.allSettled(
      chunk.map(async ({ row, histSnapshot, chartSnapshot }) => {
        const features = lotRowToFeatures(row)
        const scoredRow = await scoreLotWithAi(
          features,
          features,
          histSnapshot,
          features,
        )
        await updateLotScore(
          row.lot_id,
          scoredRow,
          {
            recordedAt: formatDateTime(row.recorded_at),
            qualityDefect: Number(row.quality_defect) === 1 ? 1 : 0,
            features,
          },
          chartSnapshot,
        )
        return row.lot_id
      }),
    )
    for (const r of results) {
      if (r.status === 'fulfilled') {
        scored++
        scoredLotIds.push(r.value)
        options.onProgress?.(scored + failed, jobs.length, r.value)
      } else {
        failed++
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
        errors.push(msg.slice(0, 200))
        options.onProgress?.(scored + failed, jobs.length, '?')
      }
    }
  }

  return { scored, failed, errors: errors.slice(0, 20), lotIds: scoredLotIds }
}

export type RefreshSpcRiskOptions = {
  /** If set, only these lot ids are rewritten (SPC history still walks all lots). */
  lotIds?: string[]
  onProgress?: (done: number, total: number, lotId: string) => void
}

/**
 * Recompute SPC + risk_level from existing AI probability/residual (no ai-service call).
 * Also writes analysis_lots.spc_chart_json (dashboard I-chart snapshot).
 */
export async function refreshSpcAndRiskScores(
  options: RefreshSpcRiskOptions = {},
): Promise<{
  updated: number
  unchanged: number
  skipped: number
  syncedJudgment: number
  chartsWritten: number
}> {
  const idFilter =
    options.lotIds != null && options.lotIds.length > 0
      ? new Set(options.lotIds.map(String))
      : null
  const std = await loadStandard()
  const thresholds = {
    defect_prob_caution: std.defect_prob_caution,
    defect_prob_severe: std.defect_prob_severe,
    residual_caution: std.residual_caution,
    residual_severe: std.residual_severe,
  }

  const lotRows = await query<
    (LotScoreSourceRow & {
      a_probability: number | null
      a_spc: string | null
      a_risk: string | null
      j_residual: number | null
      j_spc: string | null
    })[]
  >(
    `SELECT l.id AS lot_id, l.\`timestamp\` AS recorded_at, l.d50, l.d90, l.metal_impurity,
            l.lithium_input, l.additive_ratio, l.process_time, l.sintering_temp, l.humidity,
            l.tank_pressure, l.operator_id, 0 AS quality_defect,
            a.probability AS a_probability, a.spc_status AS a_spc, a.risk_level AS a_risk,
            j.residual_li AS j_residual, j.spc AS j_spc
     FROM lots l
     LEFT JOIN analysis_lots a ON a.lot_id = l.id
     LEFT JOIN judgment_lots j ON j.lot_id = l.id
     ORDER BY l.\`timestamp\` ASC, l.id ASC`,
  )

  const history = emptySpcHistory()
  const timestamps: string[] = []
  let updated = 0
  let unchanged = 0
  let skipped = 0
  let syncedJudgment = 0
  let chartsWritten = 0
  const targets = idFilter
    ? lotRows.filter((r) => idFilter.has(r.lot_id) && r.lot_id !== 'LOT-SYS-HANDOVER')
    : lotRows.filter((r) => r.lot_id !== 'LOT-SYS-HANDOVER')
  const total = targets.length
  let done = 0

  for (const row of lotRows) {
    const features = lotRowToFeatures(row)
    const bag: Partial<Record<SpcParamKey, number | null>> = {}
    for (const k of SPC_PARAM_KEYS) bag[k] = features[k]
    const complete = isProcessComplete(bag)
    if (complete) {
      for (const k of SPC_PARAM_KEYS) history[k].push(Number(features[k]))
      timestamps.push(formatDateTime(row.recorded_at))
    }

    if (row.lot_id === 'LOT-SYS-HANDOVER') continue
    if (idFilter != null && !idFilter.has(row.lot_id)) continue

    const histSnapshot = {} as Record<SpcParamKey, number[]>
    for (const k of SPC_PARAM_KEYS) {
      histSnapshot[k] = complete ? history[k].slice() : []
    }
    const chartSnapshot = complete
      ? buildSpcChartSnapshot(histSnapshot, timestamps)
      : { metrics: [] }
    const chartJson = JSON.stringify(chartSnapshot)

    const prob = row.a_probability != null ? Number(row.a_probability) : null
    if (prob == null || !Number.isFinite(prob)) {
      await query(`UPDATE analysis_lots SET spc_chart_json = ? WHERE lot_id = ?`, [
        chartJson,
        row.lot_id,
      ])
      if (row.a_spc != null || row.a_risk != null) chartsWritten++
      skipped++
      done++
      options.onProgress?.(done, total, row.lot_id)
      continue
    }

    const residual =
      row.j_residual != null && Number.isFinite(Number(row.j_residual))
        ? Number(row.j_residual)
        : 0
    const spc = evaluateSpcForFeatures(features, histSnapshot)
    const scored = combineLotScore({
      defectProb: prob,
      residualLi: residual,
      spcStatus: spc.status,
      incompleteProcess: !spc.complete,
      thresholds,
    })

    const prevSpc = row.a_spc ?? null
    const prevRisk = row.a_risk ?? null
    const spcChanged = prevSpc !== scored.spc_status
    const riskChanged = prevRisk !== scored.risk_level

    if (spcChanged || riskChanged) {
      await query(
        `INSERT INTO analysis_lots (
           lot_id, probability, spc_status, risk_level, risk_reason, spc_chart_json, scored_at
         ) VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           spc_status = VALUES(spc_status),
           risk_level = VALUES(risk_level),
           risk_reason = VALUES(risk_reason),
           spc_chart_json = VALUES(spc_chart_json),
           scored_at = NOW()`,
        [
          row.lot_id,
          prob,
          scored.spc_status,
          scored.risk_level,
          scored.risk_reason,
          chartJson,
        ],
      )
      updated++
      chartsWritten++
    } else {
      await query(`UPDATE analysis_lots SET spc_chart_json = ? WHERE lot_id = ?`, [
        chartJson,
        row.lot_id,
      ])
      unchanged++
      chartsWritten++
    }

    if (row.j_spc !== scored.spc_status) {
      await query(`UPDATE judgment_lots SET spc = ? WHERE lot_id = ?`, [
        scored.spc_status,
        row.lot_id,
      ])
      syncedJudgment++
    }

    done++
    options.onProgress?.(done, total, row.lot_id)
  }

  return { updated, unchanged, skipped, syncedJudgment, chartsWritten }
}

const COMPLETE_PROCESS_SQL_L = `l.d50 IS NOT NULL AND l.d90 IS NOT NULL AND l.metal_impurity IS NOT NULL
  AND l.lithium_input IS NOT NULL AND l.additive_ratio IS NOT NULL AND l.process_time IS NOT NULL
  AND l.sintering_temp IS NOT NULL AND l.humidity IS NOT NULL AND l.tank_pressure IS NOT NULL`

/**
 * Create open issues when analysis_lots is 심각.
 * issue_content: temporary from risk_reason (2차 API_LLM 요약은 후속).
 */
export async function ensureIssuesForRiskLots(): Promise<number> {
  const lots = await query<
    { lot_id: string; recorded_at: Date | string; risk_level: string; risk_reason: string | null }[]
  >(
    `SELECT l.id AS lot_id, l.\`timestamp\` AS recorded_at, a.risk_level, a.risk_reason
     FROM lots l
     INNER JOIN analysis_lots a ON a.lot_id = l.id
     LEFT JOIN issues i ON i.lot_id = l.id AND i.completed_at IS NULL
     WHERE a.risk_level = '심각'
       AND i.issue_id IS NULL`,
  )

  let created = 0
  for (const lot of lots) {
    const existing = await query<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM issues
       WHERE lot_id = ? AND completed_at IS NULL`,
      [lot.lot_id],
    )
    if (Number(existing[0]?.c) > 0) continue

    const createdAt = formatDateTime(lot.recorded_at)
    const day = createdAt.slice(2, 10).replace(/-/g, '')
    const last = await query<{ issue_id: string }[]>(
      `SELECT issue_id FROM issues
       WHERE issue_id REGEXP ?
       ORDER BY issue_id DESC
       LIMIT 1`,
      [`^ISS-${day}-[0-9]{3}$`],
    )
    const seq = last[0]?.issue_id ? Number(last[0].issue_id.slice(-3)) + 1 : 1
    const issueId = `ISS-${day}-${String(seq).padStart(3, '0')}`
    const risk = normalizeRiskLevel(lot.risk_level)
    const reasonText = (lot.risk_reason || risk).trim()
    let issueContent = buildIssueTitle(reasonText, lot.lot_id)
    try {
      const ai = await composeIssueContentViaVllm({
        lotId: lot.lot_id,
        riskLevel: risk,
        riskReason: reasonText,
      })
      if (ai.issue_content && !ai.error) {
        issueContent = ai.issue_content
      }
    } catch {
      /* keep buildIssueTitle fallback */
    }

    await query(
      `INSERT INTO issues (issue_id, lot_id, issue_content, created_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE lot_id = lot_id`,
      [issueId, lot.lot_id, issueContent.slice(0, 255), createdAt],
    )
    created++
  }
  return created
}

/** Trailing LOT count shown on detail I-charts (must cover longest Nelson window: 15). */
export const SPC_DETAIL_CHART_WINDOW = 30


export type SpcChartMetric = {
  key: SpcParamKey
  label: string
  status: string
  currentValue: number
  centerLine: number
  upperControlLimit: number
  lowerControlLimit: number
  violatedRules: Array<{ rule: number; description: string }>
  data: Array<{ timestamp: string; value: number }>
}

export type SpcChartSnapshot = { metrics: SpcChartMetric[] }

/** Dashboard I-charts: 이탈·주의 항목만. 안정 LOT은 metrics [] → 안내 문구. */
export function isChartableSpcStatus(status: string): boolean {
  return status.includes('이탈') || status.includes('주의')
}

export function buildSpcChartSnapshot(
  history: Record<SpcParamKey, number[]>,
  timestamps: string[],
): SpcChartSnapshot {
  if (timestamps.length === 0) return { metrics: [] }
  const evaled = evaluateLotSpc(history)
  const limits = loadPhase1Limits()
  const window = SPC_DETAIL_CHART_WINDOW
  return {
    metrics: evaled.params
      .filter((p) => isChartableSpcStatus(p.status))
      .map((p) => {
        const series = history[p.key]
        const start = Math.max(0, series.length - window)
        const lim = limits[p.key]
        return {
          key: p.key,
          label: lim.label,
          status: p.status,
          currentValue: p.value,
          centerLine: lim.CL_I,
          upperControlLimit: lim.UCL_I,
          lowerControlLimit: lim.LCL_I,
          violatedRules: p.violatedRules,
          data: series.slice(start).map((value, i) => ({
            timestamp: timestamps[start + i] || String(start + i),
            value,
          })),
        }
      }),
  }
}

export function parseSpcChartSnapshot(raw: unknown): SpcChartSnapshot | null {
  if (raw == null || raw === '') return null
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const metrics = (parsed as { metrics?: unknown }).metrics
  if (!Array.isArray(metrics)) return null
  return { metrics: metrics as SpcChartMetric[] }
}



/** SPC series + per-param status for LOT detail (recomputed from Phase I limits). */
export async function getLotSpcDetail(lotId: string): Promise<{
  lotId: string
  spcStatus: string
  metrics: Array<{
    key: SpcParamKey
    label: string
    status: string
    currentValue: number
    centerLine: number
    upperControlLimit: number
    lowerControlLimit: number
    violatedRules: Array<{ rule: number; description: string }>
    data: Array<{ timestamp: string; value: number }>
  }>
}> {
  const targetRows = await query<LotRow[]>(`${LOT_SELECT} WHERE l.id = ? LIMIT 1`, [lotId])
  if (!targetRows[0]) throw new AppError(404, 'LOT를 찾을 수 없습니다.')
  const target = targetRows[0]
  const targetFeatures = rowToFeatures(target)
  const targetBag: Partial<Record<SpcParamKey, number | null>> = {}
  for (const k of SPC_PARAM_KEYS) targetBag[k] = targetFeatures[k]
  if (!isProcessComplete(targetBag)) {
    return { lotId, spcStatus: '-', metrics: [] }
  }

  const prior = await query<LotRow[]>(
    `${LOT_SELECT}
     WHERE l.\`timestamp\` < ? OR (l.\`timestamp\` = ? AND l.id <= ?)
     ORDER BY l.\`timestamp\` ASC, l.id ASC`,
    [target.recorded_at, target.recorded_at, lotId],
  )

  const history = emptySpcHistory()
  const timestamps: string[] = []
  for (const row of prior) {
    const features = rowToFeatures(row)
    if (!pushCompleteLotHistory(history, features)) continue
    timestamps.push(formatDateTime(row.recorded_at))
  }

  const storedSpc = target.spc_status || '-'
  if (timestamps.length === 0) {
    return { lotId, spcStatus: storedSpc === '-' ? '-' : storedSpc, metrics: [] }
  }

  const evaled = evaluateLotSpc(history)
  const snapshot = buildSpcChartSnapshot(history, timestamps)

  return {
    lotId,
    spcStatus: evaled.status,
    metrics: snapshot.metrics,
  }
}

