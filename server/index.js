// HTTP API：模板/变量保存、快照、渲染任务、分享预览、数据源管理。
import http from 'http'
import { getDb, persistNow, one } from './db.js'
import {
  saveTemplate, saveVariables, getVariables,
  createSnapshot, createRenderTask, getTask, getTaskLogs, resumeTask, getSharedPreview,
  createReplayTask,
} from './service.js'
import { beginUpdate, finishUpdate, sourceState } from './sources.js'

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
const readBody = (req) => new Promise((resolve, reject) => {
  let data = ''
  req.on('data', (c) => { data += c; if (data.length > 2e6) reject(Object.assign(new Error('body too large'), { statusCode: 413 })) })
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { reject(Object.assign(new Error('bad json'), { statusCode: 400 })) } })
})

const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, sources: sourceState() }),

  'GET /api/templates/:id': async (req, res, { id }) => {
    const row = one('SELECT id,name,version,source,updated_at FROM templates WHERE id=?', [id])
    if (!row) return json(res, 404, { error: { code: 'E_NOT_FOUND', message: '模板不存在' } })
    json(res, 200, { ...row, variables: getVariables(id) })
  },

  'PUT /api/templates/:id': async (req, res, { id }, body) => {
    const r = await saveTemplate(id, body.name || '未命名', body.source || '')
    if (Array.isArray(body.variables)) await saveVariables(id, body.variables)
    json(res, 200, r)
  },

  'PUT /api/templates/:id/variables': async (req, res, { id }, body) => {
    const r = await saveVariables(id, body.variables || [])
    json(res, 200, r)
  },

  'POST /api/templates/:id/snapshots': async (req, res, { id }, body) => {
    const r = await createSnapshot(id, body.principal || 'anonymous', body.deniedPaths || [], body.sourceKeys)
    json(res, 200, r)
  },

  'POST /api/templates/:id/render-tasks': async (req, res, { id }, body) => {
    const r = await createRenderTask(id, body.principal || 'anonymous', body.deniedPaths || [])
    json(res, 202, r)
  },

  'GET /api/render-tasks/:taskId': async (req, res, { taskId }) => {
    const t = getTask(taskId)
    if (!t) return json(res, 404, { error: { code: 'E_NOT_FOUND' } })
    json(res, 200, t)
  },

  'POST /api/render-tasks/:taskId/resume': async (req, res, { taskId }, body) => {
    await resumeTask(taskId, { deniedPaths: body?.deniedPaths || [] })
    json(res, 200, { taskId, status: getTask(taskId)?.status })
  },

  'POST /api/templates/:id/replay-snapshot': async (req, res, { id }, body) => {
    const r = await createReplayTask(id, body.snapshotId, body.principal || 'anonymous')
    json(res, 202, r)
  },

  'GET /api/render-tasks/:taskId/logs': async (req, res, { taskId }) => {
    json(res, 200, { logs: getTaskLogs(taskId) })
  },

  'GET /api/shared/:token': async (req, res, { token }) => {
    try {
      const viewer = new URL(req.url, 'http://x').searchParams.get('viewer') || 'shared-viewer'
      json(res, 200, await getSharedPreview(token, viewer))
    } catch (e) { json(res, e.statusCode || 500, { error: { code: e.code, message: e.message } }) }
  },

  'POST /api/sources/:key/begin-update': async (req, res, { key }) => {
    json(res, 200, { ok: beginUpdate(key) })
  },
  'POST /api/sources/:key/finish-update': async (req, res, { key }, body) => {
    json(res, 200, { ok: finishUpdate(key, body.data || null), state: sourceState() })
  },
  'GET /api/sources': async (req, res) => json(res, 200, { sources: sourceState() }),
}

function matchRoute(method, pathname) {
  for (const [signature, handler] of Object.entries(routes)) {
    const [m, pattern] = signature.split(' ')
    if (m !== method) continue
    const pParts = pattern.split('/')
    const uParts = pathname.split('/')
    if (pParts.length !== uParts.length) continue
    const params = {}
    let okm = true
    for (let i = 0; i < pParts.length; i++) {
      if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = decodeURIComponent(uParts[i])
      else if (pParts[i] !== uParts[i]) { okm = false; break }
    }
    if (okm) return { handler, params }
  }
  return null
}

export async function startServer(port = 4000) {
  await getDb()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      const matched = matchRoute(req.method, url.pathname)
      if (!matched) return json(res, 404, { error: { code: 'E_ROUTE', message: 'unknown route' } })
      try {
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {}
        await matched.handler(req, res, matched.params, body)
      } catch (e) {
        json(res, e.statusCode || 400, { error: { code: e.code || 'E_ERROR', message: e.message, location: e.location || null } })
      }
      return
    }
    // 非 API：交给 Vite 中间件（dev）或静态文件；由 dev-server 包装，此处 404
    json(res, 404, { error: { code: 'E_ROUTE' } })
  })
  await new Promise((r) => server.listen(port, r))
  console.log(`[catalpa-api] http://localhost:${port}`)
  return server
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer(Number(process.env.PORT) || 4000)
  process.on('SIGINT', async () => { await persistNow(); process.exit(0) })
}
