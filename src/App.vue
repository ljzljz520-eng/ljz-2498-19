<script setup>
import { computed, reactive, ref, shallowRef } from 'vue'
import { renderDocument } from './shared/pipeline.js'
import { buildSampleData, DEFAULT_SAMPLE_JSON } from './frontend/sample.js'
import { api, pollTask } from './frontend/api.js'
import VariablePanel from './components/VariablePanel.vue'
import TaskPanel from './components/TaskPanel.vue'

const TEMPLATE_ID = 'tpl_order'
const initialDoc = `# 订单 {{ orderNo }}

客户：{{ fullName }}（{{ fullNameUpper }}）
金额：{{ amountText }}
下单时间：{{ placedAtText }}
手机：{{ phone }}
证件号：{{ idNo }}

[查看订单]({{ orderLink | url }})

> 备注为空串时应保留空白而非默认值：[{{ remark }}]
> 缺字段走默认值：{{ fallbackGreeting }}
`

const source = ref(initialDoc)
const templateVersion = ref(1)
const tab = ref('doc')
const principal = ref('alice')
const deniedPathsText = ref('order.customer.idNo')
const sampleJson = ref(DEFAULT_SAMPLE_JSON)
const redactPreview = ref(true)

const defs = ref([
  { id: 'v_orderNo', key: 'orderNo', label: '订单号', type: 'text', expr: '', defaultValue: '', sensitive: false, sourceId: 'order.orderNo', tz: '', format: null },
  { id: 'v_first', key: 'firstName', type: 'text', expr: 'order.customer.firstName', defaultValue: '', sensitive: false, sourceId: '', tz: '', format: null },
  { id: 'v_last', key: 'lastName', type: 'text', expr: 'order.customer.lastName', defaultValue: '', sensitive: false, sourceId: '', tz: '', format: null },
  { id: 'v_full', key: 'fullName', type: 'text', expr: "trim(concat(firstName, ' ', lastName))", defaultValue: '匿名客户', sensitive: false, sourceId: '', tz: '', format: null },
  { id: 'v_fullUp', key: 'fullNameUpper', type: 'text', expr: 'upper(fullName)', defaultValue: '', sensitive: false, sourceId: '', tz: '', format: null },
  { id: 'v_amount', key: 'amountText', type: 'text', expr: "money(order.total, 'CNY')", defaultValue: 'CNY 0.00', sensitive: false, sourceId: '', tz: '', format: null },
  { id: 'v_time', key: 'placedAtText', type: 'datetime', expr: "date(order.placedAt)", defaultValue: '', sensitive: false, sourceId: '', tz: '', format: null },
  { id: 'v_link', key: 'orderLink', type: 'url', expr: 'order.link', defaultValue: '', sensitive: false, sourceId: '', tz: '', format: null },
  { id: 'v_phone', key: 'phone', type: 'text', expr: 'order.customer.phone', defaultValue: '未提供', sensitive: true, sourceId: '', tz: '', format: null },
  { id: 'v_id', key: 'idNo', type: 'text', expr: 'order.customer.idNo', defaultValue: '无', sensitive: true, sourceId: '', tz: '', format: null },
  { id: 'v_remark', key: 'remark', type: 'text', expr: 'order.remark', defaultValue: '默认备注', sensitive: false, sourceId: '', tz: '', format: null },
  { id: 'v_fgreet', key: 'fallbackGreeting', type: 'text', expr: "default(order.missingGreeting, '你好')", defaultValue: '', sensitive: false, sourceId: '', tz: '', format: null },
])
// 示例值三态（默认演示：remark 显式空串）
const samples = reactive({
  remark: { state: 'empty', text: '' },
})

const deniedList = computed(() => deniedPathsText.value.split(/[\s,]+/).filter(Boolean))

// 同一快照驱动实时预览（前端自建"示例快照"，与后端正式快照结构一致）
const sampleSnapshot = computed(() => {
  const { data, jsonDiags } = buildSampleData(sampleJson.value, defs.value, samples)
  return {
    snap: { id: 'sample-snap', templateVersion: templateVersion.value, createdAt: Date.now(), zone: 'Asia/Shanghai', data, acl: { principal: principal.value, deniedPaths: deniedList.value } },
    jsonDiags,
  }
})

const render = computed(() => {
  try {
    const r = renderDocument(
      { version: templateVersion.value, source: source.value },
      defs.value, sampleSnapshot.value.snap,
      { redactSecrets: redactPreview.value, principal: principal.value },
    )
    return { ...r, diagnostics: [...sampleSnapshot.value.jsonDiags, ...r.diagnostics] }
  } catch (e) {
    // 编译期致命错误（循环/语法）
    return {
      html: '', expandedText: '', fragments: [], budgetUsed: 0, secretOwners: [], refLinks: [],
      diagnostics: [{ level: 'error', code: e.code || 'E_FATAL', message: e.message, location: e.location || null, variableId: e.location?.variableId }],
    }
  }
})

const errorDiags = computed(() => render.value.diagnostics.filter((d) => d.level === 'error'))
const warnDiags = computed(() => render.value.diagnostics.filter((d) => d.level !== 'error'))

// 溯源：变量 -> 可见片段
const fragmentIndex = computed(() => {
  const m = new Map()
  for (const f of render.value.fragments) {
    if (!m.has(f.key)) m.set(f.key, [])
    m.get(f.key).push(f)
  }
  return m
})

// 任务
const task = shallowRef(null)
const logs = ref([])
const taskLoading = ref(false)
const shareHtml = ref('')
const showShare = ref(false)

async function exportTask() {
  taskLoading.value = true
  try {
    await api.putTemplate(TEMPLATE_ID, { name: '订单模板', source: source.value, variables: defs.value })
    const { taskId } = await api.createTask(TEMPLATE_ID, { principal: principal.value, deniedPaths: deniedList.value })
    const t = await pollTask(taskId, { timeout: 8000 })
    task.value = t
    logs.value = (await api.taskLogs(taskId)).logs
  } catch (e) {
    alert('导出失败：' + (e.error?.message || e.message))
  } finally {
    taskLoading.value = false
  }
}
async function refreshTask() {
  if (!task.value) return
  const t = await pollTask(task.value.taskId, { timeout: 3000 })
  task.value = t
  logs.value = (await api.taskLogs(task.value.taskId)).logs
}
async function resume() {
  if (!task.value) return
  taskLoading.value = true
  try {
    await api.resumeTask(task.value.taskId, { deniedPaths: deniedList.value })
    const t = await pollTask(task.value.taskId, { timeout: 8000 })
    task.value = t
    logs.value = (await api.taskLogs(task.value.taskId)).logs
  } finally { taskLoading.value = false }
}
async function beginUpdate() { await api.beginUpdate('order'); }
async function finishUpdate() { await api.finishUpdate('order'); alert('order 已更新（等待中的任务可点「恢复任务」；旧任务复用旧快照）') }
async function openShare(token) {
  const r = await api.shared(token, principal.value)
  shareHtml.value = r.html
  showShare.value = true
}

function varDiags(key) {
  return fragmentIndex.value.get(key) || []
}
</script>

<template>
  <div class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">Catalpa · 类型化变量</p>
        <h1>模板编辑与变量渲染</h1>
        <p class="subtitle">受限表达式 · 依赖图 · 单次取数快照 · 溯源片段 · 上下文转义 · 敏感脱敏</p>
      </div>
      <div class="stats">
        <span>v{{ templateVersion }}</span>
        <span>{{ defs.length }} 变量</span>
        <span>预算 {{ render.budgetUsed }}</span>
      </div>
    </header>

    <div class="main-grid">
      <section class="panel left-panel">
        <div class="tabs">
          <button :class="{ on: tab === 'doc' }" @click="tab = 'doc'">文稿</button>
          <button :class="{ on: tab === 'vars' }" @click="tab = 'vars'">变量定义</button>
          <button :class="{ on: tab === 'data' }" @click="tab = 'data'">数据源示例</button>
          <button :class="{ on: tab === 'export' }" @click="tab = 'export'">导出任务</button>
        </div>

        <div v-show="tab === 'doc'" class="tab-body">
          <textarea v-model="source" class="editor" spellcheck="false"></textarea>
        </div>

        <div v-show="tab === 'vars'" class="tab-body scroll">
          <VariablePanel v-model="defs" v-model:samples="samples" :diagnostics="render.diagnostics" />
        </div>

        <div v-show="tab === 'data'" class="tab-body data-tab">
          <label class="field">
            预览主体（principal）
            <input v-model="principal" class="inp" />
          </label>
          <label class="field">
            无权读取的字段路径（逗号/换行分隔）
            <input v-model="deniedPathsText" class="inp mono" />
          </label>
          <label class="field">
            数据源示例 JSON（缺值=不写字段；空串=写 ""）
            <textarea v-model="sampleJson" class="json-editor" spellcheck="false"></textarea>
          </label>
        </div>

        <div v-show="tab === 'export'" class="tab-body scroll">
          <TaskPanel
            :task="task" :logs="logs" :loading="taskLoading"
            @export="exportTask" @poll="refreshTask" @resume="resume"
            @begin-update="beginUpdate" @finish-update="finishUpdate" @open-share="openShare"
          />
        </div>
      </section>

      <section class="panel right-panel">
        <div class="panel-header preview-head">
          <h2>同源快照预览</h2>
          <label class="chk"><input type="checkbox" v-model="redactPreview" /> 敏感脱敏</label>
        </div>
        <article class="preview markdown-body" v-html="render.html"></article>

        <div class="diag-block">
          <div v-if="errorDiags.length" class="diag error">
            <h3>错误（{{ errorDiags.length }}）</h3>
            <ul>
              <li v-for="(d, i) in errorDiags" :key="i">
                <b>[{{ d.code }}]</b> {{ d.message }}
                <span v-if="d.variableKey" class="loc">变量 {{ d.variableKey }}</span>
                <span v-if="d.location?.refVar" class="loc">引用节点 {{ d.location.refVar }}</span>
                <span v-if="d.location?.cycle" class="loc">环：{{ d.location.cycle.join(' → ') }}</span>
              </li>
            </ul>
          </div>
          <div v-if="warnDiags.length" class="diag warning">
            <h3>提示（{{ warnDiags.length }}）</h3>
            <ul>
              <li v-for="(d, i) in warnDiags" :key="i">
                <b>[{{ d.code }}]</b> {{ d.message }}
                <span v-if="d.variableKey" class="loc">变量 {{ d.variableKey }}</span>
              </li>
            </ul>
          </div>

          <div class="frag-block">
            <h3>源变量 → 可见片段映射</h3>
            <table>
              <thead><tr><th>变量</th><th>上下文</th><th>片段</th><th>状态</th></tr></thead>
              <tbody>
                <tr v-for="f in render.fragments" :key="f.key + f.start">
                  <td class="mono">{{ f.key }}</td>
                  <td>{{ f.ctx }}</td>
                  <td class="frag-text">{{ render.expandedText.slice(f.start, f.end) }}</td>
                  <td>
                    <span v-if="f.redacted" class="tag red">已脱敏</span>
                    <span v-else-if="f.missing" class="tag miss">缺值</span>
                    <span v-else-if="render.expandedText.slice(f.start, f.end) === ''" class="tag empty">空串</span>
                    <span v-else class="tag ok">可见</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>

    <div v-if="showShare" class="modal" @click.self="showShare = false">
      <div class="modal-card">
        <div class="modal-head"><h2>共享预览（敏感值已脱敏）</h2><button class="mini-btn" @click="showShare = false">关闭</button></div>
        <article class="preview markdown-body" v-html="shareHtml"></article>
      </div>
    </div>
  </div>
</template>

<style scoped>
.main-grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr); gap: 14px; }
.panel { min-height: 76vh; }
.tabs { display: flex; border-bottom: 1px solid var(--border); background: #f6faf8; }
.tabs button { flex: 0 0 auto; border: 0; background: transparent; padding: 12px 16px; cursor: pointer; color: var(--muted); font-size: 0.9rem; border-bottom: 2px solid transparent; }
.tabs button.on { color: var(--accent); border-bottom-color: var(--accent); font-weight: 700; }
.tab-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.tab-body.scroll { overflow: auto; }
.editor { width: 100%; flex: 1; border: 0; outline: 0; resize: none; padding: 14px; font-family: "JetBrains Mono", monospace; font-size: 14px; line-height: 1.7; }
.data-tab { padding: 14px; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 0.85rem; color: var(--muted); }
.inp { border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; font-size: 0.85rem; }
.mono { font-family: "JetBrains Mono", monospace; }
.json-editor { width: 100%; flex: 1; min-height: 240px; border: 1px solid var(--border); border-radius: 10px; padding: 10px; font-family: "JetBrains Mono", monospace; font-size: 0.8rem; resize: none; }
.preview-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.chk { font-size: 0.84rem; display: flex; gap: 6px; align-items: center; }
.preview { padding: 16px 18px; max-height: 46vh; overflow: auto; }
.diag-block { border-top: 1px solid var(--border); padding: 10px 16px; overflow: auto; font-size: 0.8rem; }
.diag h3 { margin: 4px 0; font-size: 0.82rem; }
.diag ul { margin: 0; padding-left: 16px; }
.diag.error { color: var(--danger); }
.diag.warning { color: #a06a1a; }
.loc { color: var(--muted); margin-left: 8px; }
.frag-block { margin-top: 10px; }
.frag-block h3 { font-size: 0.82rem; margin: 6px 0; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; border-bottom: 1px solid #e6efe9; padding: 4px 6px; font-size: 0.76rem; vertical-align: top; }
.frag-text { max-width: 220px; word-break: break-all; }
.tag { padding: 1px 7px; border-radius: 999px; font-size: 0.7rem; }
.tag.ok { background: #e4f6ec; color: #146c43; }
.tag.empty { background: #eef4ff; color: #2b4a8a; }
.tag.miss { background: #fdf0ea; color: #9a4a2a; }
.tag.red { background: #fde7f0; color: #a0285f; }
.modal { position: fixed; inset: 0; background: rgba(10, 30, 20, 0.5); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.modal-card { background: #fff; border-radius: 16px; max-width: 760px; width: 100%; max-height: 86vh; overflow: auto; padding: 18px; }
.modal-head { display: flex; justify-content: space-between; align-items: center; }
@media (max-width: 980px) { .main-grid { grid-template-columns: 1fr; } }
</style>
