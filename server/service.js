// 业务服务：模板/变量保存、单次取数建快照、渲染任务编排与恢复、日志脱敏。
import { all, one, run } from './db.js'
import { fetchSource } from './sources.js'
import { renderDocument } from '../src/shared/pipeline.js'
import { compileDefinitions, buildGraph } from '../src/shared/variables.js'
import { ExpressionError } from '../src/shared/errors.js'
import { buildLogLine } from '../src/shared/redact.js'
import { DEFAULT_ZONE } from '../src/shared/rules.js'

const rid = (p) => p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
const now = () => Date.now()

async function logTask(taskId, event, payload, redact = true) {
  await run(
    'INSERT INTO task_logs (task_id, ts, event, payload) VALUES (?,?,?,?)',
    [taskId, now(), event, buildLogLine(event, { taskId, ...payload }, { redact })],
  )
}

// ---------- 模板 ----------
export async function saveTemplate(id, name, source) {
  const existing = one('SELECT * FROM templates WHERE id=?', [id])
  let version
  if (existing) {
    version = existing.version + 1
    await run('UPDATE templates SET name=?, source=?, version=?, updated_at=? WHERE id=?',
      [name, source, version, now(), id])
  } else {
    version = 1
    await run('INSERT INTO templates (id,name,version,source,updated_at) VALUES (?,?,?,?,?)',
      [id, name, version, source, now()])
  }
  await run('INSERT INTO template_versions (template_id,version,source,created_at) VALUES (?,?,?,?)',
    [id, version, source, now()])
  await logTask(id, 'template.saved', { templateId: id, version }, false)
  return { id, version }
}

// ---------- 变量定义 ----------
export async function saveVariables(templateId, defs) {
  // 静态校验 + 依赖图（在保存时即可发现循环/未定义引用）
  const snapshotKeys = new Set(['order', 'hr']) // 已知数据源根
  const { compiled } = compileDefinitions(defs)
  buildGraph(compiled, snapshotKeys) // 抛 E_CYCLE / E_UNDEFINED_VAR / E_SYNTAX
  await run('DELETE FROM variable_defs WHERE template_id=?', [templateId])
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i]
    await run(
      `INSERT INTO variable_defs (id,template_id,key,label,type,expr,default_value,sensitive,source_id,tz,format,sort,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.id || rid('var'), templateId, d.key, d.label || '', d.type, d.expr || null,
       d.defaultValue ?? null, d.sensitive ? 1 : 0, d.sourceId || null, d.tz || null,
       d.format ?? null, i, now()],
    )
  }
  return { saved: defs.length }
}

export function getVariables(templateId) {
  const rows = all('SELECT * FROM variable_defs WHERE template_id=? ORDER BY sort', [templateId])
  return rows.map(toDef)
}
function toDef(r) {
  return {
    id: r.id, key: r.key, label: r.label, type: r.type, expr: r.expr,
    defaultValue: r.default_value, sensitive: !!r.sensitive, sourceId: r.source_id,
    tz: r.tz, format: r.format,
  }
}

// ---------- 快照：一次取数，永久冻结 ----------
export async function createSnapshot(templateId, principal, deniedPaths = [], sourceKeys) {
  const tpl = one('SELECT * FROM templates WHERE id=?', [templateId])
  if (!tpl) throw httpError(404, 'E_NOT_FOUND', '模板不存在')
  const keys = sourceKeys && sourceKeys.length ? sourceKeys : ['order', 'hr']

  const data = {}
  const epochs = {}
  // 单次、批量取数；任何一个数据源 updating，整体不产生半成品快照
  const fetched = await Promise.all(keys.map(async (k) => [k, await fetchSource(k)]))
  for (const [k, res] of fetched) { data[k] = res.data; epochs[k] = res.epoch }

  const id = rid('snap')
  await run(
    `INSERT INTO snapshots (id,template_id,template_version,data,acl,zone,source_epochs,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, templateId, tpl.version, JSON.stringify(data),
     JSON.stringify({ principal, deniedPaths }), DEFAULT_ZONE, JSON.stringify(epochs), now()],
  )
  await logTask(id, 'snapshot.created', { snapshotId: id, templateVersion: tpl.version, epochs, principal, deniedPaths }, false)
  return { id, templateVersion: tpl.version, data, epochs }
}

// ---------- 渲染任务 ----------
export async function createRenderTask(templateId, principal, deniedPaths) {
  const tpl = one('SELECT * FROM templates WHERE id=?', [templateId])
  if (!tpl) throw httpError(404, 'E_NOT_FOUND', '模板不存在')
  const id = rid('task')
  await run(
    `INSERT INTO render_tasks (id,template_id,template_version,snapshot_id,principal,status,attempt,created_at,updated_at)
     VALUES (?,?,?,NULL,?, 'pending',0,?,?)`,
    [id, templateId, tpl.version, principal, now(), now()],
  )
  await logTask(id, 'task.created', { templateId, templateVersion: tpl.version, principal }, false)
  // 异步驱动
  runTask(id, { deniedPaths }).catch(() => {})
  return { taskId: id }
}

export async function runTask(taskId, options = {}) {
  const task = one('SELECT * FROM render_tasks WHERE id=?', [taskId])
  if (!task) return
  // 取数阶段：失败可恢复（数据源更新中）
  let snapshotId = task.snapshot_id
  let snapshotRow = snapshotId ? one('SELECT * FROM snapshots WHERE id=?', [snapshotId]) : null

  if (snapshotRow) {
    await logTask(taskId, 'task.snapshot_reused', { snapshotId }, false)
  }

  if (!snapshotRow) {
    await setStatus(taskId, 'running')
    await run('UPDATE render_tasks SET attempt=attempt+1, updated_at=? WHERE id=?', [now(), taskId])
    let snapshot
    try {
      snapshot = await createSnapshot(task.template_id, task.principal, options.deniedPaths || [])
      await logTask(taskId, 'task.snapshot_fetched', { snapshotId: snapshot.id, epochs: snapshot.epochs }, false)
    } catch (e) {
      if (e.code === 'E_SOURCE_UPDATING') {
        await setStatus(taskId, 'waiting_data')
        await run('UPDATE render_tasks SET error=?, updated_at=? WHERE id=?',
          [JSON.stringify({ code: e.code, message: e.message, waitToken: e.waitToken }), now(), taskId])
        await logTask(taskId, 'task.waiting_data', { reason: e.message })
        // 数据源就绪后恢复（复用同一任务；快照尚未生成，因此这里才允许取数——不是二次取数）
        e.wait.then(() => resumeTask(taskId, options))
        return
      }
      await failTask(taskId, e)
      return
    }
    snapshotId = snapshot.id
    snapshotRow = one('SELECT * FROM snapshots WHERE id=?', [snapshotId])
    await run('UPDATE render_tasks SET snapshot_id=? WHERE id=?', [snapshotId, taskId])
  }

  // 渲染阶段：必须检查模板版本——快照绑定的是建快照时的版本
  const tpl = one('SELECT * FROM templates WHERE id=?', [task.template_id])
  if (tpl.version !== snapshotRow.template_version) {
    await setStatus(taskId, 'template_stale')
    await run('UPDATE render_tasks SET error=?, updated_at=? WHERE id=?',
      [JSON.stringify({
        code: 'E_TEMPLATE_STALE',
        message: `模板已变更：快照基于 v${snapshotRow.template_version}，当前 v${tpl.version}，请基于新快照重新导出`,
        snapshotVersion: snapshotRow.template_version, currentVersion: tpl.version,
      }), now(), taskId])
    await logTask(taskId, 'task.template_stale', {
      snapshotVersion: snapshotRow.template_version, currentVersion: tpl.version,
    }, false)
    return
  }

  // 使用快照内冻结数据渲染（正式导出绝不再调用 fetchSource）
  await setStatus(taskId, 'running')
  try {
    const defs = getVariables(task.template_id)
    const snapshot = {
      id: snapshotRow.id,
      templateVersion: snapshotRow.template_version,
      createdAt: snapshotRow.created_at,
      zone: snapshotRow.zone,
      data: JSON.parse(snapshotRow.data),
      acl: JSON.parse(snapshotRow.acl),
    }
    const result = renderDocument(
      { version: tpl.version, source: tpl.source },
      defs, snapshot, { redactSecrets: false, principal: task.principal },
    )
    const shareToken = rid('share')
    await run('UPDATE render_tasks SET status=?, result=?, share_token=?, error=NULL, updated_at=? WHERE id=?',
      ['succeeded', JSON.stringify(serializeResult(result)), shareToken, now(), taskId])
    await logTask(taskId, 'task.succeeded', {
      templateVersion: tpl.version, snapshotId, budgetUsed: result.budgetUsed,
      diagnostics: result.diagnostics.map((d) => d.code),
      secretOwners: result.secretOwners,
    }, false)
  } catch (e) {
    await failTask(taskId, e)
  }
}

// 恢复入口：仅在「尚未生成快照」时允许重新取数；已有快照则永远复用
export async function resumeTask(taskId, options = {}) {
  const task = one('SELECT * FROM render_tasks WHERE id=?', [taskId])
  if (!task) return
  await logTask(taskId, 'task.resumed', { priorStatus: task.status }, false)
  return runTask(taskId, options)
}

// 用既有快照创建一个回放任务（不取数）。用于模板已升版后验证「旧快照 × 新模板」的失配检测。
export async function createReplayTask(templateId, snapshotId, principal) {
  const tpl = one('SELECT * FROM templates WHERE id=?', [templateId])
  const snap = one('SELECT * FROM snapshots WHERE id=?', [snapshotId])
  if (!tpl) throw httpError(404, 'E_NOT_FOUND', '模板不存在')
  if (!snap) throw httpError(404, 'E_NOT_FOUND', '快照不存在')
  const id = rid('task')
  await run(
    `INSERT INTO render_tasks (id,template_id,template_version,snapshot_id,principal,status,attempt,created_at,updated_at)
     VALUES (?,?,?,?,?, 'pending',0,?,?)`,
    [id, templateId, tpl.version, snapshotId, principal, now(), now()],
  )
  await logTask(id, 'task.created', { templateId, templateVersion: tpl.version, principal, replaySnapshot: snapshotId }, false)
  runTask(id, {}).catch(() => {})
  return { taskId: id }
}

async function failTask(taskId, e) {
  await setStatus(taskId, 'failed')
  await run('UPDATE render_tasks SET error=?, updated_at=? WHERE id=?',
    [JSON.stringify({ code: e.code || 'E_TASK', message: e.message, location: e.location || null }), now(), taskId])
  await logTask(taskId, 'task.failed', { code: e.code, message: e.message, location: e.location || null }, false)
}
async function setStatus(taskId, status) {
  await run('UPDATE render_tasks SET status=?, updated_at=? WHERE id=?', [status, now(), taskId])
}

function serializeResult(result) {
  return {
    templateVersion: result.templateVersion,
    snapshotId: result.snapshotId,
    expandedText: result.expandedText,
    html: result.html,
    fragments: result.fragments,
    diagnostics: result.diagnostics,
    budgetUsed: result.budgetUsed,
    secretOwners: result.secretOwners,
    refLinks: result.refLinks,
  }
}

export function getTask(taskId) {
  const task = one('SELECT * FROM render_tasks WHERE id=?', [taskId])
  if (!task) return null
  return {
    taskId: task.id, templateId: task.template_id, templateVersion: task.template_version,
    snapshotId: task.snapshot_id, status: task.status, principal: task.principal,
    attempt: task.attempt, shareToken: task.share_token,
    result: task.result ? JSON.parse(task.result) : null,
    error: task.error ? JSON.parse(task.error) : null,
    updatedAt: task.updated_at,
  }
}

export function getTaskLogs(taskId) {
  return all('SELECT ts,event,payload FROM task_logs WHERE task_id=? ORDER BY id', [taskId])
}

// 共享预览：敏感值脱敏后才能通过分享链接查看
export function getSharedPreview(shareToken, viewer) {
  const task = one("SELECT * FROM render_tasks WHERE share_token=? AND status='succeeded'", [shareToken])
  if (!task) throw httpError(404, 'E_NOT_FOUND', '分享不存在或任务未成功')
  const result = JSON.parse(task.result)
  const defs = getVariables(task.template_id)
  const secretIds = new Set(result.secretOwners)
  // 重新从展开文本生成 HTML 不现实（片段已合并），直接对已渲染 HTML 中片段做处理：
  // 更稳妥的做法是重新渲染一份脱敏版（仍用同一快照，不重新取数）
  const snapRow = one('SELECT * FROM snapshots WHERE id=?', [task.snapshot_id])
  const snapshot = {
    id: snapRow.id, templateVersion: snapRow.template_version, createdAt: snapRow.created_at,
    zone: snapRow.zone, data: JSON.parse(snapRow.data), acl: JSON.parse(snapRow.acl),
  }
  const tpl = one('SELECT version,source FROM templates WHERE id=?', [task.template_id])
  // 用「原取数主体」的 ACL 重渲染（不随分享查看者提权），仅对敏感值脱敏；viewer 仅用于审计
  const redacted = renderDocument({ version: tpl.version, source: tpl.source }, defs, snapshot,
    { redactSecrets: true, principal: snapshot.acl?.principal || 'owner' })
  return {
    html: redacted.html, fragments: redacted.fragments,
    diagnostics: redacted.diagnostics, viewer: viewer || 'shared-viewer',
    renderedAsPrincipal: snapshot.acl?.principal || 'owner', redacted: true,
  }
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { statusCode: status, code })
}
