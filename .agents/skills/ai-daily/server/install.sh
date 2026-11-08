#!/usr/bin/env bash
# One-time setup of the AI News Daily Report job on Ubuntu/Debian (run as the normal user, NOT root; uses sudo).
#   Copy both repository skill directories into ~/.agents/skills first (see the repository README).
set -euo pipefail

[ "$(id -u)" = 0 ] && { echo "请用普通用户运行（脚本内部会用 sudo），不要用 root"; exit 1; }
SKILL="$HOME/.agents/skills/ai-daily"
BAOYU="$HOME/.agents/skills/baoyu-post-to-wechat/scripts"
ARCH="$(dpkg --print-architecture)"
RUNTIME="$HOME/.local/share/ai-daily"
export PATH="$RUNTIME/node/bin:$RUNTIME/npm/bin:$PATH"

# Optional proxy for downloads: PROXY=socks5h://host:port or http://host:port  (env or ~/.ai-daily/config.env)
cfg() { [ -f "$HOME/.ai-daily/config.env" ] && sed -n "s/^$1=//p" "$HOME/.ai-daily/config.env" | tr -d "\"'" | tail -1; }
[ -z "${PROXY:-}" ] && PROXY="$(cfg PROXY || true)"
[ -z "${NPM_REGISTRY:-}" ] && NPM_REGISTRY="$(cfg NPM_REGISTRY || true)"
APT_OPTS=(-o Acquire::Retries=5)
if [ -n "${PROXY:-}" ]; then
  echo "==> using proxy $PROXY"
  export http_proxy="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY"
  export npm_config_proxy="$PROXY" npm_config_https_proxy="$PROXY"
  export no_proxy="localhost,127.0.0.1" NO_PROXY="localhost,127.0.0.1"
  # apt reads this; removed again on exit
  printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$PROXY" "$PROXY" | sudo tee /etc/apt/apt.conf.d/95ai-daily-proxy >/dev/null
  trap 'sudo rm -f /etc/apt/apt.conf.d/95ai-daily-proxy' EXIT
fi
if [ -n "${NPM_REGISTRY:-}" ]; then
  echo "==> npm registry $NPM_REGISTRY"
  export npm_config_registry="$NPM_REGISTRY" NPM_CONFIG_REGISTRY="$NPM_REGISTRY" BUN_CONFIG_REGISTRY="$NPM_REGISTRY"
fi

echo "==> apt packages"
sudo apt-get update -y "${APT_OPTS[@]}"
sudo apt-get install -y "${APT_OPTS[@]}" curl ca-certificates gnupg xvfb xauth xclip xdotool \
  fonts-noto-cjk fonts-noto-color-emoji fonts-noto-core unzip

echo "==> browser"
if ! command -v google-chrome >/dev/null && ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  if [ "$ARCH" = amd64 ]; then
    for i in 1 2 3 4 5 6 7 8; do
      curl -fsSL --retry 3 --retry-all-errors -C - -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && break
      echo "chrome download interrupted, resuming ($i)"; sleep 3
    done
    sudo apt-get install -y "${APT_OPTS[@]}" /tmp/chrome.deb && rm -f /tmp/chrome.deb
  else
    sudo apt-get install -y "${APT_OPTS[@]}" chromium || sudo apt-get install -y "${APT_OPTS[@]}" chromium-browser
    echo "非 amd64：已安装 chromium，请在 ~/.ai-daily/config.env 里设置 CHROME_PATH"
  fi
fi

echo "==> Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  case "$ARCH" in
    amd64) NODE_ARCH=x64 ;;
    arm64) NODE_ARCH=arm64 ;;
    *) echo "Unsupported Node.js architecture: $ARCH"; exit 1 ;;
  esac
  mkdir -p "$RUNTIME"
  NODE_TMP="$(mktemp -d "$RUNTIME/node-install.XXXXXX")"
  curl -fsSL --retry 3 --retry-all-errors https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$NODE_TMP/SHASUMS256.txt"
  NODE_FILE="$(awk -v suffix="-linux-$NODE_ARCH.tar.xz" '$2 ~ suffix "$" {print $2}' "$NODE_TMP/SHASUMS256.txt")"
  [[ "$NODE_FILE" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo "Invalid Node.js release manifest"; exit 1; }
  curl -fsSL --retry 3 --retry-all-errors -C - "https://nodejs.org/dist/latest-v22.x/$NODE_FILE" -o "$NODE_TMP/$NODE_FILE"
  (cd "$NODE_TMP" && grep -F "  $NODE_FILE" SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$RUNTIME/node"
  tar -xJf "$NODE_TMP/$NODE_FILE" --strip-components=1 -C "$RUNTIME/node"
  rm -f "$NODE_TMP/$NODE_FILE" "$NODE_TMP/SHASUMS256.txt"
  rmdir "$NODE_TMP"
fi

echo "==> task-local npm prefix (no system Node/npm changes)"
mkdir -p "$RUNTIME/npm"
export npm_config_prefix="$RUNTIME/npm"

echo "==> bun (WeChat scripts only)"
npm i -g bun

echo "==> script dependencies"
(cd "$SKILL/scripts" && npm ci --no-audit --no-fund)
if [[ "${PROXY:-}" == socks* ]]; then
  # bun can't use SOCKS proxies -> go direct via a registry mirror
  (cd "$BAOYU" && env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u npm_config_proxy -u npm_config_https_proxy \
    BUN_CONFIG_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}" bun install --frozen-lockfile)
else
  (cd "$BAOYU" && bun install --frozen-lockfile)
fi
chmod +x "$SKILL/server/"*.sh

echo "==> config"
mkdir -p "$HOME/.ai-daily"
if [ ! -f "$HOME/.ai-daily/config.env" ]; then
  cp "$SKILL/server/config.example.env" "$HOME/.ai-daily/config.env"
fi
if [ -n "${PROXY:-}" ] && ! grep -q '^PROXY=' "$HOME/.ai-daily/config.env"; then
  printf '\nPROXY=%s\n' "$PROXY" >> "$HOME/.ai-daily/config.env"
fi
chmod 600 "$HOME/.ai-daily/config.env"

echo "==> systemd user timer"
if [ "${SKIP_SYSTEMD:-0}" = 1 ]; then echo "SKIP_SYSTEMD=1, skipped"; else
mkdir -p "$HOME/.config/systemd/user"
cp "$SKILL/server/ai-daily.service" "$SKILL/server/ai-daily.timer" \
   "$SKILL/server/ai-daily-review.service" "$SKILL/server/ai-daily-review.timer" "$HOME/.config/systemd/user/"
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable ai-daily.timer
fi

cat <<EOF

安装完成。接下来：
  1) 编辑 GPT 和邮箱配置: nano ~/.ai-daily/config.env
     GPT_ENDPOINT 是完整 /v1/responses 地址，GPT_API_KEY 填 Key，GPT_MODEL 填服务商的 GPT-6.1 模型 ID。
  2) 测试邮件:            node ~/.agents/skills/ai-daily/scripts/notify.mjs --subject 测试 --text hello
  3) 检查 API 配置:       node ~/.agents/skills/ai-daily/scripts/generate-article.mjs --check-config
  4) 试运行（不发布）:    DRY_RUN=1 ~/.agents/skills/ai-daily/server/run-daily.sh
     无需公众号登录：中文网站当天报道最多6条、GPT写稿、封面和完整邮件预览，不碰公众号。
     正式运行时，公众号登录失效会把二维码发到邮箱，也保存在 ~/ai-daily/output/<日期>/login-qr.png。
  5) 如需每天22:00生成预览邮件，再启动定时器（默认不会发表）:
                         systemctl --user start ai-daily.timer && systemctl --user list-timers ai-daily.timer
  6) 如需回复邮件「确认」后自动发表，开启邮箱 IMAP，设置 MAIL_APPROVAL_ENABLED=1，再执行:
                         bash ~/.agents/skills/ai-daily/server/check-replies.sh --check
                         systemctl --user enable --now ai-daily-review.timer
     只回复开启此功能后发出的完整预览邮件，新增正文只写「确认」，不依赖聊天或开发电脑。
EOF
