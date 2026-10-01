// Catalpa Markdown 渲染（最小安全子集）。
// 安全模型：所有文本节点先 HTML 转义；链接 href 走 URL 安全校验 + 属性转义（与文本上下文不同）。

import { escapeHtmlText } from '../shared/template.js'

export function escapeHtml(text) {
  return escapeHtmlText(text)
}

function safeHref(url) {
  const raw = String(url)
  if (/^\s*javascript:/i.test(raw) || /^\s*data:/i.test(raw) || /^\s*vbscript:/i.test(raw)) return '#blocked-url'
  if (!/^(https?:\/\/|\/|#|mailto:)/i.test(raw)) return '#blocked-url'
  return encodeURI(raw).replace(/'/g, '%27').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderInline(text) {
  // text 必须已经过 escapeHtml。链接的 URL 单独走 safeHref，不做文本式转义。
  return text
    .replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
      `<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

function listTagFor(line) {
  if (/^\s*[-*+]\s+/.test(line)) return 'ul'
  if (/^\s*\d+\.\s+/.test(line)) return 'ol'
  return ''
}

function stripListPrefix(line) {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
}

export function renderCatalpa(source) {
  const lines = source.split(/\r?\n/)
  const html = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i].trimEnd()
    if (line.trim() === '') { i += 1; continue }

    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim()
      i += 1
      const codeLines = []
      while (i < lines.length && !/^```/.test(lines[i].trim())) { codeLines.push(lines[i]); i += 1 }
      i += 1
      const escaped = escapeHtml(codeLines.join('\n'))
      const langClass = language ? ` class="language-${language}"` : ''
      html.push(`<pre><code${langClass}>${escaped}</code></pre>`)
      continue
    }

    if (/^#{1,6}\s+/.test(line.trim())) {
      const headingLine = line.trim()
      const level = headingLine.match(/^#{1,6}/)[0].length
      const text = escapeHtml(headingLine.replace(/^#{1,6}\s+/, '').trim())
      html.push(`<h${level}>${renderInline(text)}</h${level}>`)
      i += 1
      continue
    }

    if (/^>\s?/.test(line.trim())) {
      const quoteLines = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i += 1
      }
      const quoteText = quoteLines.map((item) => renderInline(escapeHtml(item))).join('<br />')
      html.push(`<blockquote>${quoteText}</blockquote>`)
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      html.push('<hr />')
      i += 1
      continue
    }

    const currentListTag = listTagFor(line)
    if (currentListTag) {
      const listItems = []
      while (i < lines.length && listTagFor(lines[i]) === currentListTag) {
        const text = escapeHtml(stripListPrefix(lines[i].trim()))
        listItems.push(`<li>${renderInline(text)}</li>`)
        i += 1
      }
      html.push(`<${currentListTag}>${listItems.join('')}</${currentListTag}>`)
      continue
    }

    const paragraphLines = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,6}\s+/.test(lines[i].trim()) &&
      !/^```/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !listTagFor(lines[i])
    ) {
      paragraphLines.push(lines[i].trim())
      i += 1
    }
    const paragraphText = escapeHtml(paragraphLines.join(' '))
    html.push(`<p>${renderInline(paragraphText)}</p>`)
  }

  return html.join('\n')
}
