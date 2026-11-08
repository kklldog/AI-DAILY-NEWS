#!/usr/bin/env bash
# AI News Daily Report - daily pipeline for a Linux server (run by systemd timer or by hand).
#   Chinese RSS/API/archive -> up to 6 reporting-day AI stories -> email preview -> stop.
#   Explicit content-bound approval is required before WeChat draft/publication.
# Re-runnable: finished steps are skipped via files in $OUT (article.md, appmsgid, cover.done).
# Env (or ~/.ai-daily/config.env): DRY_RUN=1, PUBLISH_MODE=preview|publish|draft,
#   APPROVED_ARTICLE_SHA256 (command-line approval), REPORT_DATE (optional review date),
#   GPT_*, RUN_AFTER_HOUR, LOGIN_WAIT, CHROME_PATH, SMTP_* / MAIL_TO (see config.example.env)
set -uo pipefail

CONF="${AI_DAILY_CONFIG:-$HOME/.ai-daily/config.env}"
if [ -f "$CONF" ]; then
  _env="$(export -p)"            # values given on the command line win over config.env
  set -a; . "$CONF"; set +a
  eval "$_env"; unset _env
fi
export AI_DAILY_CONFIG="$CONF"

SKILL="${AI_DAILY_SKILL:-$HOME/.agents/skills/ai-daily}"
S="$SKILL/scripts"
BAOYU="${BAOYU_SCRIPTS:-$HOME/.agents/skills/baoyu-post-to-wechat/scripts}"
PORT="${CDP_PORT:-9333}"
export WECHAT_BROWSER_DEBUG_PORT="$PORT"
export PATH="$HOME/.local/share/ai-daily/node/bin:$HOME/.local/share/ai-daily/npm/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"

DATE="${REPORT_DATE:-$(TZ=Asia/Shanghai date +%F)}"
MD="${DATE:5}"
HOUR="$(TZ=Asia/Shanghai date +%-H)"
OUT="${AI_DAILY_HOME:-$HOME/ai-daily}/output/$DATE"
mkdir -p "$OUT"
LOG="$OUT/run.log"
exec > >(tee -a "$LOG") 2>&1
PREFIX="AI News Daily Report $MD"
MODE="${PUBLISH_MODE:-preview}"
DRY="${DRY_RUN:-0}"

echo "===== $(date '+%F %T %z') start  date=$DATE mode=$MODE dry=$DRY ====="

exec 9>"${XDG_RUNTIME_DIR:-/tmp}/ai-daily.lock"
flock -n 9 || { echo "another run is in progress, retry later"; exit 75; }

if [ -n "${RUN_AFTER_HOUR:-}" ] && [ "$HOUR" -lt "$RUN_AFTER_HOUR" ]; then
  echo "before ${RUN_AFTER_HOUR}:00 Beijing time (catch-up run?), skip"; exit 0
fi

XVFB_PID=""
BRIDGE_PID=""
BROWSER_USED=0
cleanup() {
  if [ "$BROWSER_USED" = "1" ]; then
    node --input-type=module -e "import('$S/chrome.mjs').then(m=>m.closeChrome($PORT))" >/dev/null 2>&1 || true
  fi
  if [ -n "$XVFB_PID" ]; then kill "$XVFB_PID" 2>/dev/null || true; fi
  if [ -n "$BRIDGE_PID" ]; then kill "$BRIDGE_PID" 2>/dev/null || true; fi
  echo "===== $(date '+%F %T %z') end ====="
}
trap cleanup EXIT

mail() { node "$S/notify.mjs" "$@" || true; }
fail() {
  echo "FAILED: $1"
  tail -n 60 "$LOG" > "$OUT/log-tail.txt"
  mail --subject "【AI News Daily Report】$DATE 失败：$1" \
       --text "$1

输出目录：$OUT
日志最后 60 行见附件。可在服务器上手动重跑：systemctl --user start ai-daily" \
       --attach "$OUT/log-tail.txt"
  exit 1
}

# --- API configuration (fail before waiting for a WeChat QR scan) ---
node "$S/generate-article.mjs" --check-config || fail "GPT API 配置不完整或不合法"
case "$MODE" in preview|draft|publish) ;; *) fail "PUBLISH_MODE 必须是 preview、draft 或 publish" ;; esac

# Approval is tied to an already-emailed article; no generation or browser before it.
if [ "$MODE" != "preview" ] && [ "$DRY" != "1" ]; then
  node "$S/generate-article.mjs" --date "$DATE" --out "$OUT" --check-approval --sha "${APPROVED_ARTICLE_SHA256:-}" \
    || fail "尚未确认这封预览邮件对应的文章，禁止创建草稿或发表"
fi

# --- proxy (GPT API only; news sites and WeChat connect directly) ---
if [ -n "${PROXY:-}" ] && { [ "$MODE" = preview ] || [ "$DRY" = 1 ]; }; then
  P="$PROXY"
  if [[ "$PROXY" == socks* ]]; then
    # most CLIs only speak HTTP proxies -> local HTTP-to-SOCKS bridge
    BP="${PROXY_BRIDGE_PORT:-18080}"
    node "$S/socks-bridge.mjs" --socks "$PROXY" --listen "127.0.0.1:$BP" &
    BRIDGE_PID=$!
    sleep 1
    kill -0 "$BRIDGE_PID" 2>/dev/null || fail "socks 代理桥启动失败"
    P="http://127.0.0.1:$BP"
  fi
  export http_proxy="$P" https_proxy="$P" HTTP_PROXY="$P" HTTPS_PROXY="$P"
  export no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1"
  # Keep these if the model endpoint is hosted on the LAN.
  if [ -n "${PROXY_NO_PROXY:-}" ]; then
    export no_proxy="$no_proxy,$PROXY_NO_PROXY" NO_PROXY="$NO_PROXY,$PROXY_NO_PROXY"
  fi
  echo "proxy: $P"
fi

# --- 1. Chinese news and GPT writing (or reuse approved content without API calls) ---
echo "--- generating article with GPT Responses API ---"
GEN_FLAGS=()
if [ "$MODE" != "preview" ] && [ "$DRY" != "1" ]; then GEN_FLAGS+=(--cached-only); fi
timeout "${GPT_JOB_TIMEOUT:-60m}" node "$S/generate-article.mjs" --date "$DATE" --out "$OUT" "${GEN_FLAGS[@]}" >"$OUT/gpt.log" 2>&1
GRC=$?
tail -n 20 "$OUT/gpt.log"
[ "$GRC" = "0" ] || fail "新闻收集/GPT 写稿失败（exit $GRC），见 gpt.log"
if grep -q "^NO_NEWS $DATE$" "$OUT/gpt.log"; then
  node "$S/notify.mjs" --subject "【AI News Daily Report】$DATE 暂无合适新闻（未发布）" \
    --text "中文来源中没有可选的当天发布的 AI 资讯。不把历史报道改成今天，不生成空日报，也未创建草稿或发表。" \
    || fail "暂无新闻通知邮件发送失败"
  exit 0
fi
TITLE="$(sed -n 's/^TITLE //p' "$OUT/gpt.log" | tail -n1)"
[ -n "$TITLE" ] || fail "GPT 写稿缺少标题输出"
echo "article ok: $TITLE"

# --- 2. cover ---
ICONS="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).icons.join(","))' "$OUT/cover.json")" \
  || fail "封面图标配置损坏"
COVER="$OUT/cover.png"
if [ "$MODE" = "preview" ] || [ "$DRY" = "1" ]; then
  node "$S/make-cover.mjs" --date "$DATE" --icons "$ICONS" --out "$COVER" || fail "封面生成失败"
else
  [ -s "$COVER" ] || fail "已批准预览的封面不存在"
fi

if [ "$MODE" = "preview" ] || [ "$DRY" = "1" ]; then
  echo "PREVIEW: email only; stop before draft/publish"
  node "$S/send-preview.mjs" --date "$DATE" --out "$OUT" \
    || fail "预览邮件未发送成功或版本发生变化，禁止发表"
  exit 0
fi

# --- 3. approved article only: browser login and publication deduplication ---
if [ -z "${DISPLAY:-}" ]; then
  command -v Xvfb >/dev/null || fail "Xvfb 未安装"
  export DISPLAY=":${XVFB_DISPLAY:-99}"
  [ ! -S "/tmp/.X11-unix/X${DISPLAY#:}" ] || fail "虚拟显示器已被其他程序占用"
  Xvfb "$DISPLAY" -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 &
  XVFB_PID=$!
  sleep 2
  kill -0 "$XVFB_PID" 2>/dev/null || fail "虚拟显示器启动失败"
fi
BROWSER_USED=1
node "$S/wechat-login.mjs" --port "$PORT" --wait "${LOGIN_WAIT:-3600}" --qr-out "$OUT/login-qr.png" \
  || fail "公众号未登录（扫码超时）"
node "$S/wechat-publish.mjs" --port "$PORT" --check-title "$PREFIX"
case $? in
  0)
    node "$S/generate-article.mjs" --date "$DATE" --out "$OUT" --record-publication \
      --sha "$APPROVED_ARTICLE_SHA256" --status already-published || fail "无法记录已有发表结果"
    mail --subject "【AI News Daily Report】$DATE 已有发表记录，未重复发表" \
      --text "已收到对本期预览的确认，但公众号已有同日期日报发表记录，因此没有重复发表。"
    echo "already published, nothing to do"; exit 0 ;;
  2) ;;
  *) fail "检查发表记录失败" ;;
esac

# --- 4. draft ---
node "$S/generate-article.mjs" --date "$DATE" --out "$OUT" --check-approval --sha "${APPROVED_ARTICLE_SHA256:-}" \
  || fail "扫码等待后文章或封面已变化，请重新预览确认"
if [ ! -s "$OUT/appmsgid" ]; then
  echo "--- saving draft (baoyu-post-to-wechat) ---"
  DRAFT_FLAGS=(--markdown "$OUT/article.md" --theme default --color blue --submit)
  if [ -n "${WECHAT_AUTHOR:-}" ]; then DRAFT_FLAGS+=(--author "$WECHAT_AUTHOR"); fi
  ( cd "$BAOYU" && timeout 15m npx -y bun wechat-article.ts "${DRAFT_FLAGS[@]}" ) 2>&1 | tee "$OUT/draft.log"
  ID="$(grep -oE 'appmsgid[: ]+[0-9]+' "$OUT/draft.log" | grep -oE '[0-9]+' | tail -n1)"
  [ -n "$ID" ] || fail "保存草稿失败"
  echo "$ID" > "$OUT/appmsgid"
fi
ID="$(cat "$OUT/appmsgid")"
echo "draft appmsgid=$ID"

# --- 5. cover upload ---
if [ ! -f "$OUT/cover.done" ]; then
  timeout 10m node "$S/wechat-cover-upload.mjs" --port "$PORT" --appmsgid "$ID" --cover "$COVER"
  [ $? = 0 ] || fail "封面上传失败（草稿 $ID 已保存）"
  touch "$OUT/cover.done"
fi

# --- 6. publish ---
if [ "$MODE" != "publish" ]; then
  mail --subject "【AI News Daily Report】$DATE 草稿已保存，待你发表" --text "标题：$TITLE
草稿 appmsgid：$ID（封面已设置）
请到公众号后台「草稿箱」预览后发表。" --image "$COVER"
  exit 0
fi
node "$S/generate-article.mjs" --date "$DATE" --out "$OUT" --check-approval --sha "${APPROVED_ARTICLE_SHA256:-}" \
  || fail "发表前文章或封面已变化，请重新预览确认"
timeout 15m node "$S/wechat-publish.mjs" --port "$PORT" --appmsgid "$ID" --wait 600 --qr-out "$OUT/publish-qr.png"
PRC=$?
if [ "$PRC" = "0" ]; then
  node "$S/generate-article.mjs" --date "$DATE" --out "$OUT" --record-publication \
    --sha "$APPROVED_ARTICLE_SHA256" --status published || fail "发表成功但无法保存结果，请人工核查，不要重复发表"
  SUMMARY="$(sed -n 's/^summary:[[:space:]]*//p' "$OUT/article.md" | head -n1)"
  mail --subject "【AI News Daily Report】$DATE 已发表 ✅" --text "标题：$TITLE

$SUMMARY

草稿 appmsgid：$ID" --image "$COVER"
  echo "PUBLISHED"
else
  fail "发表未确认（exit $PRC），草稿 $ID 已保留，请到后台检查，不要重复发表"
fi
