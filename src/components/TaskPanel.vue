<script setup>
defineProps({
  task: { type: Object, default: null },
  logs: { type: Array, default: () => [] },
  loading: Boolean,
})
const emit = defineEmits(['export', 'poll', 'resume', 'begin-update', 'finish-update', 'open-share'])

const STATUS_LABEL = {
  pending: '待处理', running: '运行中', waiting_data: '等待数据源',
  succeeded: '成功', failed: '失败', template_stale: '模板已变更',
}
</script>

<template>
  <div class="task-panel">
    <div class="task-actions">
      <button class="mini-btn primary" :disabled="loading" @click="emit('export')">生成正式导出（新建快照+渲染任务）</button>
      <button class="mini-btn" :disabled="!task || loading" @click="emit('poll')">刷新任务</button>
      <button class="mini-btn" :disabled="!task" @click="emit('resume')">恢复任务</button>
    </div>
    <div class="task-actions">
      <span class="grp-label">数据源演练：</span>
      <button class="mini-btn" @click="emit('begin-update', 'order')">order 置为更新中</button>
      <button class="mini-btn" @click="emit('finish-update', 'order')">完成 order 更新</button>
    </div>

    <div v-if="task" class="task-card">
      <div class="task-head">
        <span class="status" :class="task.status">{{ STATUS_LABEL[task.status] || task.status }}</span>
        <span class="tid">{{ task.taskId }}</span>
        <span class="ver">模板 v{{ task.templateVersion }}</span>
        <span class="ver" v-if="task.snapshotId">快照 {{ task.snapshotId.slice(0, 10) }}…</span>
      </div>
      <div v-if="task.error" class="task-error">
        <b>{{ task.error.code }}</b>：{{ task.error.message }}
        <div v-if="task.error.snapshotVersion" class="stale-actions">
          <span>快照基于 v{{ task.error.snapshotVersion }}，当前 v{{ task.error.currentVersion }}，需基于新快照重新导出。</span>
        </div>
      </div>
      <button v-if="task.shareToken" class="mini-btn" @click="emit('open-share', task.shareToken)">打开共享预览（脱敏）</button>

      <div class="logs">
        <div v-for="(l, i) in logs" :key="i" class="log-line">
          <span class="log-ts">{{ new Date(l.ts).toLocaleTimeString() }}</span>
          <span class="log-ev">{{ l.event }}</span>
          <span class="log-payload">{{ l.payload }}</span>
        </div>
      </div>
    </div>
    <p v-else class="empty-hint">尚未创建渲染任务。</p>
  </div>
</template>

<style scoped>
.task-panel { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.task-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.grp-label { font-size: 0.8rem; color: var(--muted); }
.mini-btn { border: 1px solid var(--border); background: #fff; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 0.8rem; }
.mini-btn.primary { border-color: var(--accent); color: var(--accent); }
.mini-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.task-card { border: 1px solid var(--border); border-radius: 12px; padding: 10px; background: #fcfefd; }
.task-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 0.82rem; }
.status { padding: 2px 10px; border-radius: 999px; font-weight: 600; }
.status.succeeded { background: #e4f6ec; color: #146c43; }
.status.failed { background: #fdeceb; color: var(--danger); }
.status.waiting_data, .status.template_stale { background: #fdf2e2; color: #a06a1a; }
.status.running, .status.pending { background: #eef3f0; color: var(--muted); }
.tid { color: var(--muted); font-family: monospace; }
.ver { color: var(--muted); }
.task-error { margin: 8px 0; padding: 8px; border-radius: 8px; background: #fdf0ea; color: #8a3f22; font-size: 0.82rem; }
.stale-actions { margin-top: 4px; color: var(--muted); }
.logs { margin-top: 10px; border-top: 1px dashed #dbe6e0; padding-top: 8px; max-height: 220px; overflow: auto; font-family: monospace; }
.log-line { font-size: 0.74rem; color: var(--muted); display: flex; gap: 8px; }
.log-ev { color: var(--accent); }
.empty-hint { color: var(--muted); font-size: 0.84rem; }
</style>
