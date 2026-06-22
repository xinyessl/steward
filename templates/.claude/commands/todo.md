---
description: 把零碎小任务记进「速记清单」(docs/tasks.json 的 items)——不建 spec、不进开发流程
---

把用户这次给的一批**零碎小事**（bug 小修、查数据、本地脚本、临时提醒…）记进**速记小任务清单**。

## 铁律
- **不建 spec、不碰 `docs/specs`**。这清单是个人速记：本地、不入库、不进看板/验收/铃铛，dev agent 平时也不读。
- 只记「**不改变系统规约**」的零碎事。若某条其实是需求 / 会改逻辑 / 影响其它模块 → **不要记这里**，回一句「这条像正经需求，建议走 `/spec`」，由用户定。**一条只去一个地方，绝不 spec 和速记并存。**

## 怎么写（用 node 安全改 JSON，别手抠文件）
把每条事项填进下面的 `ADD` 数组再运行（用户强调重要/紧急的 `pri:true`）：

```bash
node -e '
const fs=require("fs"),f="docs/tasks.json";
let j; try{j=JSON.parse(fs.readFileSync(f))}catch{j={title:"开发清单",groups:[],items:[]}}
j.items=Array.isArray(j.items)?j.items:[];
const ADD=[
  {text:"<一句话事项，≤300字>", pri:false},
  // …每条一行
];
for(const a of ADD) j.items.push({id:"t"+Date.now().toString(36)+Math.random().toString(36).slice(2,7), text:String(a.text).slice(0,300), done:false, pri:!!a.pri, ts:Date.now()});
fs.writeFileSync(f, JSON.stringify(j,null,2));
console.log("已记入", ADD.length, "条");
'
```

## 收尾
一句话回报：记了哪几条、哪些标了重要；并提示用户「在控制台右上角『速记』里查看/勾选/删除」。
