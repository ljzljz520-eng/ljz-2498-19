import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { getDb, all as dbAll, one as dbOne } from './server/db.js'
import {
  saveTemplate, saveVariables, getVariables,
  createSnapshot, createRenderTask, getTask, getTaskLogs, resumeTask, getSharedPreview,
  createReplayTask,
} from './server/service.js'
import { beginUpdate, finishUpdate, sourceState } from './server/sources.js'

// 开发模式：API 作为 Vite 中间件与前端同端口；生产可独立 `node server/index.js`
function catalpaApi() {
  let listenerPromise
  const getListener = () => (listenerPromise ||= getDb().then(() => buildListener()))
  return {
    name: 'catalpa-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith('/api/')) return next()
        const listener = await getListener()
        listener(req, res)
      })
    },
  }
}

function buildListener() {
  const send = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let d = ''
    req.on('data', (c) => { d += c; if (d.length > 2e6) reject(new Error('too large')) })
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}) } catch { reject(new Error('bad json')) } })
  })
  const routes = [
    ['GET', /^\/api\/health$/, async () => ({ ok: true, sources: sourceState() })],
    ['GET', /^\/api\/sources$/, async () => ({ sources: sourceState() })],
    ['POST', /^\/api\/sources\/([^/]+)\/begin-update$/, async (m) => ({ ok: beginUpdate(decodeURIComponent(m[1])) })],
    ['POST', /^\/api\/sources\/([^/]+)\/finish-update$/, async (m, body) => {
      finishUpdate(decodeURIComponent(m[1]), body.data || null); return { state: sourceState() }
    }],
    ['GET', /^\/api\/templates\/([^/]+)$/, async (m) => {
      const row = dbOne('SELECT id,name,version,source,updated_at FROM templates WHERE id=?', [m[1]])
      if (!row) return { __status: 404, error: { code: 'E_NOT_FOUND', message: '模板不存在' } }
      return { ...row, variables: getVariables(m[1]) }
    }],
    ['PUT', /^\/api\/templates\/([^/]+)$/, async (m, body) => {
      const r = await saveTemplate(m[1], body.name || '未命名', body.source || '')
      if (Array.isArray(body.variables)) await saveVariables(m[1], body.variables)
      return r
    }],
    ['PUT', /^\/api\/templates\/([^/]+)\/variables$/, async (m, body) =>
      saveVariables(m[1], body.variables || [])],
    ['POST', /^\/api\/templates\/([^/]+)\/snapshots$/, async (m, body) =>
      createSnapshot(m[1], body.principal || 'anonymous', body.deniedPaths || [], body.sourceKeys)],
    ['POST', /^\/api\/templates\/([^/]+)\/render-tasks$/, async (m, body) =>
      createRenderTask(m[1], body.principal || 'anonymous', body.deniedPaths || [])],
    ['GET', /^\/api\/render-tasks\/([^/]+)$/, async (m) =>
      getTask(m[1]) || { __status: 404, error: { code: 'E_NOT_FOUND' } }],
    ['POST', /^\/api\/render-tasks\/([^/]+)\/resume$/, async (m, body) => {
      await resumeTask(m[1], { deniedPaths: body?.deniedPaths || [] })
      return { taskId: m[1], status: getTask(m[1])?.status }
    }],
    ['POST', /^\/api\/templates\/([^/]+)\/replay-snapshot$/, async (m, body) =>
      createReplayTask(m[1], body.snapshotId, body.principal || 'anonymous')],
    ['GET', /^\/api\/render-tasks\/([^/]+)\/logs$/, async (m) => ({ logs: getTaskLogs(m[1]) })],
    ['GET', /^\/api\/shared\/([^/?]+)$/, async (m, b, req) =>
      getSharedPreview(decodeURIComponent(m[1]), new URL(req.url, 'http://x').searchParams.get('viewer') || 'shared-viewer')],
  ]
  return async (req, res) => {
    const url = new URL(req.url, 'http://x')
    try {
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {}
      for (const [method, re, fn] of routes) {
        if (method !== req.method) continue
        const m = url.pathname.match(re)
        if (!m) continue
        const out = await fn(m, body, req)
        return send(res, out?.__status || 200, out)
      }
      send(res, 404, { error: { code: 'E_ROUTE' } })
    } catch (e) {
      send(res, e.statusCode || 400, { error: { code: e.code || 'E_ERROR', message: e.message, location: e.location || null } })
    }
  }
}

export default defineConfig({
  plugins: [vue(), catalpaApi()],
  server: { host: '0.0.0.0', port: 3000 },
})
