#!/bin/zsh
set -e
cd "${0:A:h}"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  CANDIDATE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  if [[ -x "$CANDIDATE" ]]; then NODE_BIN="$CANDIDATE"; fi
fi
if [[ -z "$NODE_BIN" ]]; then
  print '需要 Node.js 24 或更高版本。安装后重新双击此文件。'
  read '?按回车关闭…'
  exit 1
fi
export PATH="${NODE_BIN:h}:$PATH"
"$NODE_BIN" -e "if(Number(process.versions.node.split('.')[0])<24){console.error('需要 Node.js 24+');process.exit(1)}"
if [[ ! -f node_modules/tsx/dist/cli.mjs ]]; then
  PNPM_BIN="$(command -v pnpm || true)"
  if [[ -z "$PNPM_BIN" ]]; then
    CANDIDATE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm"
    if [[ -x "$CANDIDATE" ]]; then PNPM_BIN="$CANDIDATE"; fi
  fi
  if [[ -z "$PNPM_BIN" ]]; then
    print '首次启动需要 pnpm 11 安装依赖。请参阅 README.md。'
    read '?按回车关闭…'
    exit 1
  fi
  "$PNPM_BIN" install --frozen-lockfile
fi
GAME_PORT="$("$NODE_BIN" --env-file-if-exists=.env -e 'const p=Number(process.env.PORT??3111);if(!Number.isInteger(p)||p<1024||p>65535)process.exit(1);console.log(p)' 2>/dev/null)"
GAME_URL="http://127.0.0.1:$GAME_PORT"
if /usr/bin/curl -fsS "$GAME_URL/api/v1/health" 2>/dev/null | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{let v=JSON.parse(s);process.exit(v.contractVersion==="0.5"&&v.apiVersion==="v1"?0:1)}catch{process.exit(1)}})'; then
  print "LAST MILE 已在运行：$GAME_URL"
  /usr/bin/open "$GAME_URL"
  exit 0
fi
print '正在构建 LAST MILE…'
"$NODE_BIN" node_modules/vite/bin/vite.js build
(
  for attempt in {1..40}; do
    if /usr/bin/curl -fsS "$GAME_URL/api/v1/health" >/dev/null 2>&1; then /usr/bin/open "$GAME_URL"; break; fi
    sleep 0.25
  done
) &
print "游戏地址：$GAME_URL"
print '请保持此窗口打开。停止服务：Ctrl+C。'
exec "$NODE_BIN" --import tsx --env-file-if-exists=.env server/index.ts
