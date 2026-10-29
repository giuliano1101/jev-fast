#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rebuild the S7 summary exclusively from archived sanitized trial/decision files."""
import json, statistics, datetime
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts/real'
def read(path): return json.loads(path.read_text())
def median(xs): return statistics.median(xs) if xs else None
def secs(value): return '—' if value is None else f'{value/1000:.2f}'
rows=read(OUT/'computer-use.json')+read(OUT/'jev-baseline.json')
rows += [read(p) for p in sorted((OUT/'trials').glob('*.json'))]
tasks=read(OUT/'tasks.json')
modes=['computer-use','jev-baseline','jev-integrated-baseline','jev-optimized','jev-final']
labels=['普通 computer use','Jev 原基线（外层交接）','仅集成循环对照','Jev 第一版优化','Jev 最终修复版']
decisions=[read(p) for p in sorted((OUT/'decisions').glob('*.json'))]
known=0;unknown=0;requests=0;latencies=[];singletons=0
for d in decisions:
 a=d.get('result') or d.get('error',{}).get('accounting',{})
 known+=a.get('known_cost_usd',0);unknown+=a.get('unknown_usage_requests',0);requests+=a.get('request_count',0)
 if d.get('result'):
  latencies.append(d['result']['elapsed_ms'])
  singletons+=len(d['result'].get('request_plan',{}).get('effective_candidates',[]))==1
summary={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'groups':{},'cost':{'s7_known_usd':known,'s7_unknown_usage_requests':unknown,'s7_reserved_attempts':requests,'prior_known_usd':0.003050334,'prior_unknown_usage_requests':1,'cumulative_known_usd':known+0.003050334,'cumulative_unknown_usage_requests':unknown+1,'cumulative_reserved_attempts':115+requests,'cumulative_reserved_usd':(115+requests)*.01,'budget_usd':3,'computer_use_cost':'unknown, not zero'},'api_success_latency_median_ms':median(latencies),'singleton_decisions':singletons}
for mode in modes:
 group=[r for r in rows if r['mode']==mode and r['task_id']!='W3-blocked-site'];ok=[r for r in group if r['status']=='SUCCEEDED']
 summary['groups'][mode]={'started':len(group),'successes':len(ok),'median_all_started_ms':median([r['elapsed_ms'] for r in group]),'median_success_ms':median([r['elapsed_ms'] for r in ok]),'actions':sum(r['actions'] for r in group),'failures':{reason:sum(r.get('reason')==reason for r in group) for reason in sorted({r['reason'] for r in group if r.get('reason')})}}
paired=[]
for r in rows:
 if r['mode']!='jev-final' or r['status']!='SUCCEEDED': continue
 peers=[p for p in rows if p['mode']=='computer-use' and p['task_id']==r['task_id'] and p['repeat']==r['repeat'] and p['status']=='SUCCEEDED']
 if peers: paired.append({'task_id':r['task_id'],'repeat':r['repeat'],'computer_use_ms':peers[0]['elapsed_ms'],'optimized_ms':r['elapsed_ms'],'ratio':peers[0]['elapsed_ms']/r['elapsed_ms']})
summary['final_success_pairs']={'count':len(paired),'median_ratio':median([p['ratio'] for p in paired]),'rows':paired}
(OUT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
(OUT/'all-trials.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
lines=['# S7 真实网页与抖音交互测试','', '测试日期：2026-10-30（北京时间）。所有题目在真实网站或已安装抖音 App 中执行。测试浏览器为本机 Codex 内置浏览器，不是独立 Chrome。','', '## 测试题目','', '| 编号 | 难度 | 工具 | 题目 | 验收信号 |','|---|---|---|---|---|']
for t in tasks: lines.append(f"| {t['id']} | {t['difficulty']} | {t['surface']} | {t['question']} | {t['success']} |")
lines += ['', '完整起点：[tasks.json](tasks.json)。原始逐次记录：[all-trials.json](all-trials.json)。机器可读统计：[summary.json](summary.json)。','', '## 逐题结果','', '单元格为 **成功次数/开始次数；成功耗时中位数（秒）**。失败耗时不算完成速度。','', '| 题目 | '+' | '.join(labels)+' |','|---|'+'---|'*5]
for t in tasks:
 cells=[]
 for mode in modes:
  group=[r for r in rows if r['task_id']==t['id'] and r['mode']==mode];ok=[r for r in group if r['status']=='SUCCEEDED']
  cells.append(f"{len(ok)}/{len(group)}；{secs(median([r['elapsed_ms'] for r in ok]))}")
 lines.append('| '+t['id']+' | '+' | '.join(cells)+' |')
lines += ['', '## 总体结果与解释','']
for mode,label in zip(modes,labels):
 g=summary['groups'][mode];lines.append(f"- {label}：{g['successes']}/{g['started']} 成功；成功任务耗时中位数 {secs(g['median_success_ms'])} 秒；全部开始任务耗时中位数 {secs(g['median_all_started_ms'])} 秒（后者包含失败停止，不能作为完成速度）。")
if paired: lines += ['',f"最终修复版与普通 computer use 双方成功的 {len(paired)} 个同题同轮配对，耗时比中位数为 **{summary['final_success_pairs']['median_ratio']:.2f}×**。这是完整工作流的条件比值，不是纯模型速度，也不含失败的完成时间。"]
lines += ['', '## 失败与诊断','', '| 试次 | 结果 | 耗时（秒） | 原因 |','|---|---|---|---|']
for r in rows:
 if r['status']!='SUCCEEDED': lines.append(f"| {r['trial_id']} | {r['status']} | {secs(r['elapsed_ms'])} | {r.get('reason','未记录')} |")
lines += ['', '- 原 timeanddate 日期任务被反机器人页面阻挡，保留为单独的未配对失败，未绕过。随后全部三方使用 Calculator.net。', '- 最初两次集成循环的本地子进程无法解析官方 API 域名（第二次因 REPL 函数仍绑定旧通道），记录为连接失败并停止；改由已授权的本地请求工作进程处理，仍使用同一预算与 CLI 决策逻辑。两次试次均不删除、不当作成功。', '- 原 Jev 基线的六次低置信度选择没有被执行；未降低 0.90 门槛。集成原规则日期题还收到一次不符合概率校验的返回，记录 INVALID_PROBABILITIES 并停止。', '- 第一版优化日期题两次停在隐藏复选框：DOM input 尺寸为 0，而 AX 中存在可操作控件。改为仅在新观察确认未选中时点击 AX 控件；保留两次 EXECUTION_UNCERTAIN，重新从干净状态测试。', '- 最终版本再次完整运行六题各两轮，8/12 成功；搜索与复杂组合筛选共四次仍因低置信度停止，不能作为稳定的通用替代品。', '- D3 普通首轮观察到排序期间筛选标签变空，并进行了恢复。可能是短暂加载，不能断言网站永久清空筛选；第二轮及优化按排序、审核状态、体裁顺序执行。', '- 原普通 W3 首轮修正了结果文字验证（实际是 15 calendar days）；Jev W2 首轮修复了 REPL 起始时间变量，使用此前已输出的精确时间戳。这些额外耗时和注释均保留。','', '## 优化及适用范围','', '1. 对同一可见表单的准备动作进行合并：语言和关键词、日期字段和包含结束日；提交仍单独决策，每个字段操作前重新绑定，提交前验证全部条件。','2. 删除当前已经满足的无进展候选，给筛选任务明确当前阶段。状态来自当前界面，不累加历史点击。','3. 用受限循环减少外层代理和工具交接；单独记录“集成循环 + 原候选规则”的消融对照，不能把全部提速归因于 Jev 本身。',f"4. 本轮成功返回的 API 决策耗时中位数为 {secs(summary['api_success_latency_median_ms'])} 秒；{singletons} 次只有一个有效候选，属于受约束选择，不能证明通用推理能力。",'', '## 费用','',f"本轮已知 API 费用 **${known:.8f}**，另有 {unknown} 次用量未知。连同 S6，累计已知费用 **${known+0.003050334:.8f}**，另有 {unknown+1} 次用量未知。累计 {115+requests} 次保守预留，预留总额 ${(115+requests)*.01:.2f} / $3.00；预留额不是实际账单。Codex computer use 会话费用不可得，未计作免费。",'', '## 实验限制','', '- 六道预先知道的题，普通和原基线各两轮，第一版优化两轮、最终修复版两轮；方法分批执行，非随机交错，存在学习、网络和缓存影响。消融每题主要一轮，连接失败保留额外试次。','- 原基线包含外层代理思考、CLI/CUA 交接和验证；集成循环消除了部分这类开销。时间从初次观察前到终态验证，重置不计时。','- 优化使用当前题目的模板和阶段提示；不能外推任意网站、任意电脑操作或未见任务。','- 抖音仅测创作者中心导航与筛选，验收是可见控件状态，不是后台数据排序审计。没有发布、删除、上传、发消息或修改账号设置。','- 原始账号数据未上传；只有公开控件 ID、固定测试值、脱敏决策与公开网页截图。','', '## 证据与复现','', '- [运行与隐私边界](../../docs/real-testing.md)','- [优化前发现与假设](optimization.md)','- [优化前源码哈希](baseline-manifest.json) / [第一版复测源码哈希](optimized-manifest.json) / [最终修复版哈希](final-manifest.json)','- [完整检查记录](verification/checks.json)','- [公开网站结果截图](screenshots/date-result.jpg)','']
checks_path=OUT/'verification/checks.json'
if checks_path.exists():
 checks=read(checks_path)
 lines += ['## 离线验证', '', '最终类型检查、代码规范、144 项单元/核心测试、29 项浏览器集成测试和 40 项安全测试全部通过（不同测试命令存在重叠，不相加为唯一测试数）。首次集成测试 28/29 的失败日志保留；修复既有测试对异步完成的断言竞争后，定向 2/2、全套 29/29 通过。执行核心未修改。' if checks.get('all_passed') else '最终验证尚未全部通过，请查看检查记录。', '']
(OUT/'report.md').write_text('\n'.join(lines))
print(json.dumps(summary,ensure_ascii=False,indent=2))
