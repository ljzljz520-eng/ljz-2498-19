<script setup>
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: Array, required: true },
  samples: { type: Object, required: true },
  diagnostics: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue', 'update:samples'])

const TYPES = [
  { v: 'text', label: '文本 text' },
  { v: 'number', label: '数字 number' },
  { v: 'boolean', label: '布尔 boolean' },
  { v: 'datetime', label: '日期时间 datetime' },
  { v: 'date', label: '日期 date' },
  { v: 'url', label: '链接 url' },
]

const defs = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

function uid() {
  return 'var_' + Math.random().toString(36).slice(2, 9)
}
function addVar() {
  defs.value = [...defs.value, {
    id: uid(), key: 'newVar' + (defs.value.length + 1), label: '', type: 'text',
    expr: '', defaultValue: '', sensitive: false, sourceId: '', tz: '', format: null,
  }]
}
function update(i, patch) {
  const next = defs.value.slice()
  next[i] = { ...next[i], ...patch }
  defs.value = next
}
function remove(i) {
  const removed = defs.value[i]
  defs.value = defs.value.filter((_, idx) => idx !== i)
  const s = { ...props.samples }
  delete s[removed.key]
  emit('update:samples', s)
}
function setSample(key, patch) {
  const cur = props.samples[key] || { state: 'value', text: '' }
  emit('update:samples', { ...props.samples, [key]: { ...cur, ...patch } })
}
const diagByVar = computed(() => {
  const m = new Map()
  for (const d of props.diagnostics) {
    if (!d.variableId) continue
    if (!m.has(d.variableId)) m.set(d.variableId, [])
    m.get(d.variableId).push(d)
  }
  return m
})
</script>

<template>
  <div class="var-panel">
    <div class="var-toolbar">
      <button type="button" class="mini-btn primary" @click="addVar">+ 新增变量</button>
      <span class="hint">直接映射变量用「数据源字段」（如 order.customer.firstName）；表达式变量在「受限表达式」中引用其它变量。</span>
    </div>

    <div v-for="(d, i) in defs" :key="d.id" class="var-card" :class="{ 'has-err': diagByVar.has(d.id) }">
      <div class="var-row">
        <input class="inp key-inp" :value="d.key" @input="update(i, { key: $event.target.value })" placeholder="变量名" />
        <select class="inp" :value="d.type" @change="update(i, { type: $event.target.value })">
          <option v-for="t in TYPES" :key="t.v" :value="t.v">{{ t.label }}</option>
        </select>
        <label class="chk"><input type="checkbox" :checked="d.sensitive" @change="update(i, { sensitive: $event.target.checked })" /> 敏感</label>
        <button type="button" class="mini-btn danger" @click="remove(i)">删除</button>
      </div>

      <div class="var-row">
        <input class="inp grow" :value="d.label" @input="update(i, { label: $event.target.value })" placeholder="显示名（可选）" />
      </div>

      <div class="var-row">
        <input class="inp grow mono" :value="d.sourceId" @input="update(i, { sourceId: $event.target.value })" placeholder="数据源字段（直接映射），如 order.customer.firstName" />
      </div>

      <div class="var-row">
        <input class="inp grow mono" :value="d.expr" @input="update(i, { expr: $event.target.value })" placeholder="受限表达式（可引用变量/数据源），如 upper(concat(greet, '!'))" />
      </div>

      <div class="var-row">
        <input class="inp grow" :value="d.defaultValue ?? ''" @input="update(i, { defaultValue: $event.target.value })" placeholder="默认值（仅缺值/NULL 时生效；空串不触发）" />
        <input class="inp narrow" type="number" min="0" max="6" :value="d.format ?? ''" @input="update(i, { format: $event.target.value === '' ? null : Number($event.target.value) })" placeholder="小数位" />
        <input class="inp narrow" :value="d.tz ?? ''" @input="update(i, { tz: $event.target.value })" placeholder="时区" />
      </div>

      <!-- 网页示例值：三态 -->
      <div class="sample-row">
        <span class="sample-label">示例值</span>
        <div class="seg">
          <button type="button" class="seg-btn" :class="{ on: (samples[d.key]?.state || 'value') === 'value' }" @click="setSample(d.key, { state: 'value' })">有值</button>
          <button type="button" class="seg-btn" :class="{ on: samples[d.key]?.state === 'empty' }" @click="setSample(d.key, { state: 'empty' })">空串</button>
          <button type="button" class="seg-btn" :class="{ on: samples[d.key]?.state === 'missing' }" @click="setSample(d.key, { state: 'missing' })">缺值</button>
        </div>
        <input
          v-if="(samples[d.key]?.state || 'value') === 'value'"
          class="inp grow mono"
          :value="samples[d.key]?.text ?? ''"
          @input="setSample(d.key, { text: $event.target.value })"
          placeholder="示例文本（留空输入框且选「有值」= 显式空串）"
        />
        <span v-else-if="samples[d.key]?.state === 'empty'" class="state-tag empty">'' 显式空字符串（不触发默认值）</span>
        <span v-else class="state-tag missing">∅ 缺值（字段不存在，触发默认值）</span>
      </div>

      <ul v-if="diagByVar.has(d.id)" class="var-diags">
        <li v-for="(dg, k) in diagByVar.get(d.id)" :key="k" :class="dg.level">
          <b>{{ dg.code }}</b> {{ dg.message }}
          <span v-if="dg.location?.refVar" class="ref-node">引用节点: {{ dg.location.refVar }}
            <template v-if="dg.location.path?.length"> @{{ dg.location.path.join('/') }}</template>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.var-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px; }
.var-toolbar { display: flex; align-items: center; gap: 10px; }
.hint { color: var(--muted); font-size: 0.78rem; }
.var-card { border: 1px solid var(--border); border-radius: 12px; padding: 10px; background: #fcfefd; display: flex; flex-direction: column; gap: 8px; }
.var-card.has-err { border-color: #d9a08a; background: #fffaf7; }
.var-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.inp { border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; font-size: 0.85rem; background: #fff; }
.inp.grow { flex: 1; min-width: 180px; }
.inp.narrow { width: 84px; }
.key-inp { width: 150px; font-weight: 600; }
.mono { font-family: "JetBrains Mono", monospace; font-size: 0.8rem; }
.chk { font-size: 0.82rem; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.mini-btn { border: 1px solid var(--border); background: #fff; border-radius: 8px; padding: 5px 10px; cursor: pointer; font-size: 0.8rem; }
.mini-btn.primary { border-color: var(--accent); color: var(--accent); }
.mini-btn.danger { color: var(--danger); }
.sample-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 6px; border-top: 1px dashed #dbe6e0; }
.sample-label { font-size: 0.78rem; color: var(--muted); }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.seg-btn { border: 0; background: #fff; padding: 4px 10px; cursor: pointer; font-size: 0.78rem; }
.seg-btn.on { background: var(--accent); color: #fff; }
.state-tag { font-size: 0.78rem; padding: 3px 8px; border-radius: 6px; }
.state-tag.empty { background: #eef4ff; color: #2b4a8a; }
.state-tag.missing { background: #fdf0ea; color: #9a4a2a; }
.var-diags { margin: 4px 0 0; padding-left: 16px; font-size: 0.78rem; }
.var-diags .error { color: var(--danger); }
.var-diags .warning { color: #a06a1a; }
.ref-node { color: var(--muted); margin-left: 6px; }
</style>
