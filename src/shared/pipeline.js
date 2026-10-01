// 渲染管线：变量求值（基于快照）-> 文稿展开（溯源片段）-> Markdown 渲染。
// 预览与导出调用同一个 renderDocument，且都只吃 snapshot，不重新取数。

import { evaluateVariables, valueToDisplay } from './snapshot.js'
import { expandTemplate } from './template.js'
import { renderCatalpa } from '../utils/catalpa.js'
import { MISSING } from './types.js'

export function renderDocument(template, defs, snapshot, options = {}) {
  // 1) 基于快照一次性求值全部变量
  const evalResult = evaluateVariables(defs, snapshot, options)

  // 2) 展开文稿（变量 -> 文本），得到溯源映射
  const resolve = (key) => {
    const def = defs.find((d) => d.key === key)
    if (!def) return { text: '', missing: true, reason: 'UNDECLARED' }
    const v = evalResult.values.get(key)
    return valueToDisplay(v === undefined ? MISSING : v, def)
  }
  const expanded = expandTemplate(template.source, resolve, {
    redactSecrets: options.redactSecrets ?? true,
  })

  // 3) Markdown 渲染（文本/href 分别转义）
  const html = renderCatalpa(expanded.text)

  return {
    templateVersion: template.version,
    snapshotId: snapshot.id,
    expandedText: expanded.text,
    html,
    fragments: expanded.fragments,
    diagnostics: [...evalResult.diagnostics, ...expanded.diagnostics],
    budgetUsed: evalResult.budgetUsed,
    secretOwners: [...evalResult.secretOwners],
    refLinks: evalResult.refLinks,
    principal: evalResult.principal,
  }
}

// 比较「预先展开文稿」与「渲染时求值」：
// 若两者使用同一快照，展开文本必须逐字节一致，否则说明流程中发生了二次取数/状态漂移。
export function comparePreExpanded(preExpandedText, template, defs, snapshot, options = {}) {
  const live = renderDocument(template, defs, snapshot, options)
  const consistent = preExpandedText === live.expandedText
  return {
    consistent,
    preExpandedText,
    liveExpandedText: live.expandedText,
    reason: consistent ? null : '预展开与渲染时结果不一致：存在跨快照取数或非确定性求值',
    render: live,
  }
}
