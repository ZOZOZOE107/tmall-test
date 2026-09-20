#!/bin/bash
#
# 双击这个文件 = 起 dev server + 打开衣服骨骼调参台。
# 关掉这个终端窗口（或按 Control+C）= 关掉服务器。
#
# Finder 里双击时不一定读得到你的 shell 配置，node 的路径先手动补上。
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

cd "$(dirname "$0")" || exit 1

PORT=5173
URL="http://localhost:$PORT/tune.html"

pause_on_error() {
  echo ""
  echo "❌ $1"
  echo "按任意键关闭这个窗口。"
  read -r -n 1 -s
  exit 1
}

command -v node >/dev/null 2>&1 || pause_on_error "找不到 node，先去 nodejs.org 装一个。"

# 已经在跑就别再起一个，直接开页面
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "dev server 已经在 $PORT 上跑着了，直接打开页面。"
  open "$URL"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "首次运行，先装依赖（要几分钟）…"
  npm install || pause_on_error "npm install 失败。"
fi

echo "启动 dev server…"
npx vite &
VITE_PID=$!

# 等端口起来再开浏览器，最多等 20 秒
for _ in $(seq 1 80); do
  lsof -ti "tcp:$PORT" >/dev/null 2>&1 && break
  kill -0 "$VITE_PID" 2>/dev/null || pause_on_error "dev server 启动失败，看上面的报错。"
  sleep 0.25
done

open "$URL"

echo ""
echo "———————————————————————————————"
echo "调参台：$URL"
echo "主页面：http://localhost:$PORT/"
echo "关掉这个窗口就是关掉服务器。"
echo "———————————————————————————————"
echo ""

wait "$VITE_PID"
