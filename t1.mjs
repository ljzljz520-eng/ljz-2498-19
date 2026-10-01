import { parseExpression } from './src/shared/expr/parser.js'
import { buildGraph, compileDefinitions } from './src/shared/variables.js'
import { renderDocument } from './src/shared/pipeline.js'
import { maskValue } from './src/shared/redact.js'

let pass=0,fail=0
const ok=(c,m)=>{ if(c){pass++} else {fail++; console.log('FAIL:',m)} }

// 1) 嵌套依赖
const defs = [
  { id:'d1', key:'first', type:'text', expr:"order.customer.firstName" },
  { id:'d2', key:'greet', type:'text', expr:"concat('Hi ', first)" },
  { id:'d3', key:'shout', type:'text', expr:"upper(greet)" },
]
const snap = { id:'s1', templateVersion:1, createdAt:Date.now(), data:{ order:{ customer:{ firstName:'Ana', idNo:'110101199001011234' } } }, acl:{ principal:'u1', deniedPaths:[] } }
const r = renderDocument({version:1, source:'# {{ shout }}\n编号 {{ order_no | url }}'}, defs, snap, {redactSecrets:false})
ok(r.html.includes('<h1>HI ANA</h1>'), 'nested deps render: '+r.html)
ok(r.fragments.length>=1, 'fragments mapped')
ok(r.fragments.some(f=>f.key==='shout'), 'fragment source var mapping')

// 2) 缺值 vs 空串 vs 默认值
const defs2 = [
  { id:'a', key:'empty', type:'text', expr:"rec.emptyStr", defaultValue:'DEFAULT' },
  { id:'b', key:'gone', type:'text', expr:"rec.missing", defaultValue:'DEFAULT' },
  { id:'c', key:'noDefault', type:'text', expr:"rec.missing" },
]
const snap2 = { id:'s2', templateVersion:1, data:{ rec:{ emptyStr:'' } }, acl:{principal:'u',deniedPaths:[]} }
const r2 = renderDocument({version:1, source:'[{{empty}}][{{gone}}][{{noDefault}}]'}, defs2, snap2, {redactSecrets:false})
ok(r2.expandedText==='[][DEFAULT][]', 'empty string kept, missing defaulted: '+r2.expandedText)

// 3) 非法日期
const defs3=[{id:'d',key:'bad',type:'datetime',expr:"date(rec.when)"}]
const r3=renderDocument({version:1,source:'{{bad}}'},defs3,{id:'s3',templateVersion:1,data:{rec:{when:'2021-02-30'}},acl:{principal:'u',deniedPaths:[]}},{redactSecrets:false})
ok(r3.diagnostics.some(x=>x.code==='E_DATE'),'illegal date diagnosed, got: '+JSON.stringify(r3.diagnostics.map(d=>d.code)))

// 4) 循环检测
const cyc=[{id:'1',key:'a',expr:'b'},{id:'2',key:'b',expr:'c'},{id:'3',key:'c',expr:'a'}]
try{ compileDefinitions(cyc); buildGraph(compileDefinitions(cyc).compiled,new Set()); ok(false,'cycle not detected') }
catch(e){ ok(e.code==='E_CYCLE','cycle detected: '+e.message) }

// 5) 非法/危险表达式
for(const bad of ['a.foo()','x; process.exit()','new Date()','a = 1','${1}','a..b']){
  try{ parseExpression(bad); ok(false,'should reject: '+bad) }catch(e){ ok(true,'') }
}

// 6) ACL 字段无权
const defs6=[{id:'d',key:'idno',type:'text',expr:"order.customer.idNo",sensitive:false}]
const r6=renderDocument({version:1,source:'{{idno}}'},defs6,{id:'s6',templateVersion:1,data:{order:{customer:{idNo:'110xxx'}}},acl:{principal:'u',deniedPaths:['order.customer.idNo']}},{redactSecrets:false})
ok(r6.diagnostics.some(x=>x.code==='E_NO_ACCESS'),'acl denied diagnosed')
ok(r6.expandedText==='','acl value blanked')

// 7) 敏感脱敏
const defs7=[{id:'d',key:'phone',type:'text',expr:"c.phone",sensitive:true}]
const r7=renderDocument({version:1,source:'{{phone}}'},defs7,{id:'s7',templateVersion:1,data:{c:{phone:'13812345678'}},acl:{principal:'u',deniedPaths:[]}},{redactSecrets:true})
ok(!r7.html.includes('13812345678'),'secret not in output')
ok(r7.html.includes('〔已脱敏〕'),'secret masked, html='+r7.html)

// 8) 日期时区固定规则
const defs8=[{id:'d',key:'meet',type:'datetime',expr:"date('2026-01-01T09:00:00 UTC')"}]
const r8=renderDocument({version:1,source:'{{meet}}'},defs8,{id:'s8',templateVersion:1,data:{},acl:{principal:'u',deniedPaths:[]}},{redactSecrets:false})
ok(r8.expandedText.includes('2026-01-01 17:00:00 Asia/Shanghai'),'UTC->CST: '+r8.expandedText)

// 9) 数字格式 + 货币
const defs9=[{id:'d',key:'amt',type:'text',expr:"money(order.total, 'CNY')"}]
const r9=renderDocument({version:1,source:'{{amt}}'},defs9,{id:'s9',templateVersion:1,data:{order:{total:1234567.5}},acl:{principal:'u',deniedPaths:[]}},{redactSecrets:false})
ok(r9.expandedText==='CNY 1,234,567.50','money format: '+r9.expandedText)

// 10) href 安全：javascript 被拦截，http 通过
const defs10=[{id:'d',key:'u',type:'url',expr:"l.href"}]
const r10a=renderDocument({version:1,source:'[go]({{u|url}})'},defs10,{id:'s10',templateVersion:1,data:{l:{href:'javascript:alert(1)'}},acl:{principal:'u',deniedPaths:[]}},{redactSecrets:false})
ok(r10a.html.includes('#blocked-url'),'javascript url blocked: '+r10a.html)

// 11) HTML 注入被转义
const defs11=[{id:'d',key:'x',type:'text',expr:"c.v"}]
const r11=renderDocument({version:1,source:'{{x}}'},defs11,{id:'s11',templateVersion:1,data:{c:{v:'<img src=x onerror=alert(1)>'}},acl:{principal:'u',deniedPaths:[]}},{redactSecrets:false})
ok(!r11.html.includes('<img'),'html injection escaped: '+r11.html)

// 12) mask
ok(maskValue('13812345678')==='138****5678','phone mask: '+maskValue('13812345678'))
ok(maskValue('a@b.com').includes('***'),'email mask')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail?1:0)
