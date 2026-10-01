import { renderDocument, comparePreExpanded } from './src/shared/pipeline.js'
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:(fail++,console.log('FAIL:',m))}
const snap = { id:'s', templateVersion:1, data:{}, acl:{principal:'u',deniedPaths:[]} }

// 求值预算：极小预算必然超
let expr = Array(60).fill('(1+2)').reduce((a,b)=>'('+a+'+'+b+')')
const r = renderDocument({version:1, source:'{{x}}'}, [{id:'x',key:'x',type:'number',expr}], snap, {redactSecrets:false, maxNodeVisits:50})
ok(r.diagnostics.some(d=>d.code==='E_LIMIT'),'budget exceeded: '+r.diagnostics.map(d=>d.code))

// 依赖深度上限
const big=[]
for(let i=0;i<100;i++) big.push({id:'v'+i,key:'k'+i,type:'number',expr:i===0?'1+1':'k'+(i-1)+'+1'})
try { renderDocument({version:1,source:'{{k99}}'}, big, snap, {redactSecrets:false}); ok(false,'depth expected') }
catch(e){ ok(e.code==='E_LIMIT'&&/深度/.test(e.message),'depth limit: '+e.message) }

// 未定义引用（建图阶段即失败）
try { renderDocument({version:1,source:'{{a}}'}, [{id:'a',key:'a',type:'text',expr:'nope.field'}], snap, {redactSecrets:false}); ok(false) }
catch(e){ ok(e.code==='E_UNDEFINED_VAR','undefined ref: '+e.code) }

// 同快照：预展开 == 渲染时
const defs=[{id:'d',key:'n',type:'text',expr:'upper(order.c)'}]
const s2={id:'s2',templateVersion:1,data:{order:{c:'ab'}},acl:{principal:'u',deniedPaths:[]}}
const r1=renderDocument({version:1,source:'{{n}}'},defs,s2,{redactSecrets:false})
ok(comparePreExpanded(r1.expandedText,{version:1,source:'{{n}}'},defs,s2,{redactSecrets:false}).consistent,'same snapshot consistent')
// 不同快照（数据变了）应识别为漂移，杜绝正式文件混用两次取数
const s3={...s2,id:'s3',data:{order:{c:'xy'}}}
ok(!comparePreExpanded(r1.expandedText,{version:1,source:'{{n}}'},defs,s3,{redactSecrets:false}).consistent,'cross-snapshot drift detected')

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0)
