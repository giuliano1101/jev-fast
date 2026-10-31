#!/bin/zsh
# macOS Finder launcher. No service or goal is started automatically.
cd -- "${0:A:h}" || exit 1
jev_node=''
for jev_candidate in "${JEV_NODE:-}" "$(command -v node 2>/dev/null)" "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
  [[ -n "$jev_candidate" && -x "$jev_candidate" ]] || continue
  if "$jev_candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||a===24&&b>=19?0:1)' >/dev/null 2>&1; then
    jev_node="$jev_candidate"
    break
  fi
done
if [[ -z "$jev_node" ]]; then
  print '未找到 Node.js 24.19+。请先安装 Node，或设置 JEV_NODE 为 Node 可执行文件的绝对路径。'
  read '?按回车退出。'
  exit 1
fi
export PATH="${jev_node:h}:$PATH"
if [[ ! -d node_modules ]]; then
  print '请先在本目录运行 npm ci --ignore-scripts 和 npx playwright install chromium。'
  read '?按回车退出。'
  exit 1
fi
print '正在编译并打开本机控制面板；不会自动开启协调服务或执行任务。'
"$jev_node" scripts/build.mjs || exit 1
"$jev_node" dist/src/control/main.js --open
jev_result=$?
if (( jev_result != 0 )); then
  print '面板未正常启动。若端口被占用，请先关闭原面板终端，或按手册指定其他端口。'
  read '?按回车退出。'
fi
exit $jev_result
