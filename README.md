# Catalpa 模板编辑产品 · 类型化变量与受控渲染

在原有「Catalpa 文本编辑 + 实时预览」基础上，新增了一套**类型化变量**能力：
网页配置变量与示例值（区分缺值与空串），后端用**受限表达式**解析与求值，
变量之间可相互引用（依赖图 + 循环检测 + 求值规模限制），渲染由**单次取数的数据快照**驱动，
模板**绝不作为任意脚本执行**；日期时区、数字格式、默认值有固定规则；输出保留
**源变量 → 可见片段**映射，HTML 与链接上下文分别转义，敏感值在日志与共享预览中脱敏。

---

## 1. 快速开始

```bash
corepack prepare pnpm@10.28.2 --activate
pnpm install

# 开发：前端 + API 同端口（Vite 中间件）
pnpm dev            # http://localhost:3000

# 或独立后端（生产形态）
pnpm server         # http://localhost:4000 ，并托管 dist 时可前置静态服务
pnpm build

# 测试
pnpm test:unit      # 引擎：表达式/缺值空串/循环/非法日期/ACL/时区/预算/一致性
pnpm test:e2e       # 端到端验收（需先启动 pnpm server）
```

数据库为真实 SQL（sql.js / SQLite），文件落在 `server/data/app.sqlite`。

---

## 2. 目录结构

```text
src/
  shared/                     # 前后端同一份核心（预览即导出，杜绝两套实现漂移）
    errors.js                 # 统一诊断模型（code + 定位到变量/引用节点）
    types.js                  # 运行时值模型：MISSING / 空串 / NULL / Secret / DateTime
    rules.js                  # 固定规则：日期时区、数字/货币格式、默认值
    variables.js              # 变量定义校验、AST 规模限制、依赖图、循环/深度检测
    snapshot.js               # 快照求值编排：预算、字段级 ACL 守卫代理、诊断
    template.js               # 模板扫描/替换、片段映射、HTML/URL 上下文转义、脱敏占位
    pipeline.js               # 求值→展开→Markdown；预览与导出同一入口
    redact.js                 # 敏感值脱敏（日志、共享预览）
    expr/
      lexer.js                # 受限词法（白名单函数/运算符，无赋值/new/模板串）
      parser.js               # Pratt 解析 -> 可序列化 AST
      evaluator.js            # AST 白名单解释执行（无 eval / new Function）
  frontend/
    api.js                    # HTTP 客户端 + 任务轮询
    sample.js                 # 网页示例值三态（有值 / 显式空串 / 缺值）
  components/
    VariablePanel.vue         # 变量定义编辑 + 三态示例输入 + 变量级诊断
    TaskPanel.vue             # 渲染任务、恢复、数据源演练、日志
  utils/catalpa.js            # 安全 Markdown 渲染（文本转义 / href 白名单）
server/
  db.js                       # SQL 建表与持久化
  sources.js                  # 模拟数据源（含 updating 状态、版本、唤醒）
  service.js                  # 模板/变量保存、单次取数快照、渲染任务与恢复、失配检测
  index.js                    # HTTP API
vite.config.js                # dev 下把 API 挂为同端口中间件
acceptance.mjs                # 端到端验收（31 项）
t1.mjs / t2.mjs               # 引擎单元验收
```

---

## 3. 变量与受限表达式

- 变量类型：`text / number / boolean / datetime / date / url`，可标记 `sensitive`。
- 变量可**直接映射**数据源字段（`sourceId`，如 `order.customer.firstName`），
  也可写**受限表达式**，在其中引用其它变量或数据源根（`upper(fullName)`、`money(order.total,'CNY')`）。
- 表达式能力被严格限制在：字面量、变量/成员访问、白名单函数
  （`date/number/upper/lower/trim/concat/len/money/numberFormat/ifNull(default)/now/today`）、
  算术、比较、逻辑短路、三元。
- **安全**：没有 `eval` / `new Function`；不能调用数据对象上的方法（`a.foo()` 直接拒绝）、
  不能赋值、不能 `new`、不能执行模板字符串。模板只是被扫描的文本，不是脚本。
- 函数白名单在词法层识别，任何非白名单调用报 `E_SECURITY`。

### 规模限制（`src/shared/variables.js`）

| 限制 | 默认值 | 超限错误 |
| --- | --- | --- |
| 变量数量 | 200 | `E_LIMIT` |
| 单表达式 AST 节点 | 400 | `E_LIMIT` |
| 依赖链深度 | 32 | `E_LIMIT` |
| 一次整稿求值节点访问 | 20000 | `E_LIMIT`（预算耗尽即停） |

依赖图用 DFS 三色标记检测循环，错误信息给出完整环，如 `a -> b -> c -> a`（`E_CYCLE`），
未定义引用在**建图阶段**即报 `E_UNDEFINED_VAR`，不会拖到渲染期。

---

## 4. 缺值、空串、默认值（三者不混淆）

- `MISSING`：字段不存在 / 无权访问 / 上游失败（带 `MISSING|NO_ACCESS|FAILED` 原因）。
- 空字符串 `''`：**显式空串**，是一个有效值。
- `null`：显式 NULL。

默认值规则（`applyDefault`）：

```text
MISSING / NO_ACCESS / FAILED / null  -> 使用默认值
''                                   -> 保留 ''（不被默认值覆盖）
0 / false                            -> 保留（是有效值）
```

网页示例输入对每个直接映射变量提供三态开关：**有值 / 空串 / 缺值**；
数据源示例 JSON 中「不写字段」即缺值，写 `""` 即显式空串。

---

## 5. 日期时区与数字格式（固定规则，集中在 rules.js）

- 内部时间一律存 epoch 毫秒；`date(...)` **严格**解析，非法日期
  （`2021-02-30`、非法分量、落入不存在的夏令时区间）报 `E_DATE`，绝不回退成当前时间。
- 时区走 IANA（`UTC/Asia/Shanghai/...`），兼容 `Z/CST/...` 缩写归一；
  不支持的时区报 `E_TIMEZONE`。
- datetime 一律在固定输出时区（默认 `Asia/Shanghai`）呈现，例如
  `2026-01-01T09:00:00 UTC` → `2026-01-01 17:00:00 Asia/Shanghai`；
  `date` 是无时点语义的日历日期，按其声明时区呈现。
- 数字：千分位 + 最多 6 位小数四舍五入（`numberFormat(x,2)`）；
  货币按币种固定小数位（`money(x,'CNY')` → `CNY 1,234,567.50`，JPY 为 0 位）。

---

## 6. 快照、预览与导出（同一快照，绝不两次取数）

- 创建快照时**一次性**取齐所需数据源并冻结（`snapshots.data/acl/source_epochs`）。
- **预览与导出调用同一个 `renderDocument`**，都只吃快照数据，不再访问数据源。
- 任务复用快照时写 `task.snapshot_reused`，仅在「尚无快照」时才允许取一次数并写
  `task.snapshot_fetched`；验收断言一个任务生命周期内取数恰为 1 次。
- `comparePreExpanded(preExpanded, ...)` 比较「预先展开文稿」与「渲染时求值」：
  同一快照必须逐字节一致；换快照即检测为漂移，从机制上防止正式文件混用两次取数。
- **模板版本**：快照绑定建快照时的 `template_version`。模板升版后，用旧快照回放会被
  判定为 `template_stale`（`E_TEMPLATE_STALE`），不产出混用文稿，需基于新快照重新导出。

### 数据源更新中的任务恢复

- 取数时若数据源 `updating`，任务进入 `waiting_data`（不产生半成品快照），等待回调。
- 数据源 `finish-update` 后任务被唤醒：同一任务**恢复**，此时才取数一次；
  已持有快照的恢复永远复用快照（不会读到更新后的数据——更新后的数据属于新快照）。

---

## 7. 安全：转义、链接、字段权限、脱敏

- **HTML 上下文**：所有 Markdown 文本节点先 HTML 转义（`<img onerror>` 无法注入）。
- **链接上下文**：`{{ x | url }}` 与 Markdown 链接的 href 走协议白名单
  （仅 http(s)/站内路径/mailto），`javascript:`/`data:` 被替换为 `#blocked-url`，并做 URL 编码。
- **字段级 ACL**：数据源根由守卫代理包装，读取被 `deniedPaths` 拒绝的字段时抛
  `AccessDeniedError`，在该变量处语义化为「缺值(NO_ACCESS)」并可走默认值；
  诊断定位到**变量 + 字段路径**，明文绝不进入产物。
- **敏感值**：`sensitive` 变量及其子字段在内部以 `SecretValue` 传播；
  - 共享预览（share token）以**同一快照**重新渲染一份脱敏版（占位 `〔已脱敏〕`，
    避免裸 `***` 被 Markdown 当成分割线）；
  - 任务日志写入前经 `buildLogLine` 对 `secret/password/idNo/salary/token/phone/email`
    等字段打码（手机号 `138****5678`、邮箱 `a***@domain`）。

---

## 8. 溯源与诊断

- 每次替换都记录片段：`{key, start, end, ctx, missing, secret, redacted}`，
  UI 表格展示「源变量 → 可见片段」与状态（可见/空串/缺值/已脱敏）。
- 诊断结构：`{level, code, message, variableId, variableKey, location:{refVar,path,cycle,pos}}`，
  能定位到**具体变量**与**引用节点**（如非法日期 → `badDate`；循环 → 环路径；无权 → 字段路径）。
- 单个变量求值失败不整稿崩溃：该变量按缺值(FAILED)参与下游并记录错误，其余照常渲染。

---

## 9. SQL 表

`templates`、`template_versions`（版本历史）、`variable_defs`（变量定义）、
`snapshots`（冻结数据/ACL/数据源 epoch）、`render_tasks`（任务状态机与产物）、
`task_logs`（脱敏日志）。详见 `server/db.js`。

任务状态机：`pending → running → succeeded | failed`，
取数受阻 → `waiting_data →（恢复）running`，
版本失配 → `template_stale`。

---

## 10. 验收清单（`acceptance.mjs` 自动覆盖）

1. 嵌套依赖 `first → greet → shout` 正常渲染；货币/日期格式正确。
2. 循环依赖在**保存时**被拒并给出环路径。
3. 非法日期诊断定位到具体变量（`E_DATE`）。
4. 字段无权读取：`deniedPaths` 生效、明文不外泄、诊断含变量与字段。
5. 共享预览敏感值脱敏。
6. 数据源 `updating → finish`：任务 `waiting_data → 恢复 succeeded`，且全周期仅取数一次。
7. 模板升版后旧快照回放 → `template_stale`，不混用两次取数/两份文稿。
8. 引擎单测：预算超限、深度超限、未定义引用、缺值 vs 空串、预展开一致性、漂移检测、XSS/危险 URL 拦截。
