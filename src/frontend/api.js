async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${res.status}`), { error: data?.error, status: res.status })
  return data
}

export const api = {
  health: () => request('/api/health'),
  sources: () => request('/api/sources'),
  beginUpdate: (key) => request(`/api/sources/${key}/begin-update`, { method: 'POST', body: {} }),
  finishUpdate: (key, data) => request(`/api/sources/${key}/finish-update`, { method: 'POST', body: { data } }),
  getTemplate: (id) => request(`/api/templates/${id}`),
  putTemplate: (id, body) => request(`/api/templates/${id}`, { method: 'PUT', body }),
  putVariables: (id, variables) => request(`/api/templates/${id}/variables`, { method: 'PUT', body: { variables } }),
  createSnapshot: (id, body) => request(`/api/templates/${id}/snapshots`, { method: 'POST', body }),
  createTask: (id, body) => request(`/api/templates/${id}/render-tasks`, { method: 'POST', body }),
  getTask: (taskId) => request(`/api/render-tasks/${taskId}`),
  resumeTask: (taskId, body) => request(`/api/render-tasks/${taskId}/resume`, { method: 'POST', body }),
  taskLogs: (taskId) => request(`/api/render-tasks/${taskId}/logs`),
  shared: (token, viewer) => request(`/api/shared/${token}?viewer=${encodeURIComponent(viewer)}`),
}

export async function pollTask(taskId, { interval = 400, timeout = 15000 } = {}) {
  const start = Date.now()
  for (;;) {
    const t = await api.getTask(taskId)
    if (['succeeded', 'failed', 'template_stale'].includes(t.status)) return t
    if (Date.now() - start > timeout) return t
    await new Promise((r) => setTimeout(r, interval))
  }
}
