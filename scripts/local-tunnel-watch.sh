#!/usr/bin/env bash
# The quota forwards are launchd ssh -L processes. launchd only restarts them
# when they exit. A remote reboot can leave the local ssh alive with no listener
# (the connection looks established, ServerAlive never fires), and the quota
# panel then reports "fetch failed" until a person kills the process.
#
# This watches every local `ssh -N -L <port>:` and, when that port stops
# answering, kills that ssh so KeepAlive can start a fresh one. It will not
# kill the same port again within three minutes: if the remote bridge is down,
# flapping the tunnel does not bring it back.

set -u
STATE_DIR="${HOME}/.dsh/cache/antigravity-tunnel-watch"
LOG="${STATE_DIR}/watch.log"
mkdir -p "$STATE_DIR"
touch "$LOG"

now=$(date +%s)
say() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }

# macOS ps has `etime` (MM:SS / HH:MM:SS / D-HH:MM:SS), not Linux `etimes`.
elapsed_seconds() {
  local raw rest days=0 h=0 m=0 s=0 a b c
  raw=$(ps -p "$1" -o etime= 2>/dev/null | tr -d ' ')
  [ -z "$raw" ] && { echo 0; return; }
  rest=$raw
  if [[ $rest == *-* ]]; then
    days=${rest%%-*}
    rest=${rest#*-}
  fi
  IFS=: read -r a b c <<EOF
$rest
EOF
  if [ -n "${c:-}" ]; then h=$a; m=$b; s=$c
  elif [ -n "${b:-}" ]; then m=$a; s=$b
  else s=${a:-0}
  fi
  echo $((10#$days * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s))
}

# Keep the log from growing without a rotator.
if [ "$(wc -l < "$LOG" | tr -d ' ')" -gt 400 ]; then
  tail -n 200 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi

# pgrep -f matches itself; the character class stops that.
pids=$(pgrep -f '[s]sh .*-L [0-9]*:' || true)
[ -z "$pids" ] && exit 0

for pid in $pids; do
  spec=$(ps -o args= -p "$pid" 2>/dev/null | sed -n 's/.*-L \([0-9][0-9]*\):.*/\1/p' | head -1)
  [ -z "${spec:-}" ] && continue
  port=$spec
  age=$(elapsed_seconds "$pid")
  case "$age" in
    ''|*[!0-9]*) continue ;;
  esac
  [ "$age" -lt 20 ] && continue

  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:${port}/v1/usage" || true)
  case "$code" in
    200|401|400|404|405) continue ;;
  esac

  stamp="${STATE_DIR}/${port}.killed"
  last=0
  [ -f "$stamp" ] && last=$(cat "$stamp" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt 180 ]; then
    say "port ${port} still not answering; not restarting again yet"
    continue
  fi
  if kill "$pid" 2>/dev/null; then
    echo "$now" > "$stamp"
    say "restarted ssh for 127.0.0.1:${port} (http ${code:-none}, pid ${pid}, age ${age}s)"
  fi
done
