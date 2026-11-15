#!/usr/bin/env bash
# Antigravity ACP: the host-side baseline the plugin expects from the machine
# that runs `agy acp`. Idempotent; run as root (or through sudo).
#
# Why this exists. One ACP worker is cheap, but every client reconnect can leave
# one behind, and a small VM has no room for that. The incident this was written
# for: a 1.6 GB instance with no swap retried one stale forward 1336 times, ran
# out of memory, and then sat for two hours accepting TCP without ever sending
# an SSH banner. Nothing on the host acted, so a person had to notice and reboot.
#
# This installs a guard that acts on its own, every minute:
#   1. swap with a low swappiness, so pressure slows the host instead of freezing it
#   2. capped journald and rotated guard log, so disk pressure cannot build up
#   3. reaps `agy acp` workers whose parent is gone
#   4. frees memory by ending the largest worker when the host is nearly out
#   5. restarts sshd when it stops answering on port 22
#   6. reboots, as the last resort, when memory is critical and sshd is already gone
#
# Every action is written to /var/log/antigravity-guard.log; an untouched line is
# `status=ok ... actions=0`.

set -euo pipefail

SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
GUARD_LOG="/var/log/antigravity-guard.log"
GUARD_BIN="/usr/local/sbin/antigravity-guard"
STATE_DIR="/run/antigravity-guard"
MEM_WARN_MB="${MEM_WARN_MB:-200}"
MEM_FREE_MB="${MEM_FREE_MB:-150}"
MEM_REBOOT_MB="${MEM_REBOOT_MB:-80}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
SSHD_PROBE_TIMEOUT="${SSHD_PROBE_TIMEOUT:-4}"

say() { printf '[server-guard] %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  say "needs root: re-run with sudo"
  exit 1
fi

# ---------------------------------------------------------------- 1. swap
if swapon --show 2>/dev/null | grep -q .; then
  say "swap already active, left alone"
else
  if [ -f "$SWAP_FILE" ]; then
    say "$SWAP_FILE exists, activating it"
  else
    say "creating $SWAP_SIZE swap at $SWAP_FILE"
    if ! fallocate -l "$SWAP_SIZE" "$SWAP_FILE" 2>/dev/null; then
      dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$(numfmt --from=iec "$SWAP_SIZE" | awk '{print int($1/1048576)}')" status=none
    fi
    chmod 600 "$SWAP_FILE"
    mkswap "$SWAP_FILE" >/dev/null
  fi
  swapon "$SWAP_FILE"
  grep -qs "^$SWAP_FILE" /etc/fstab || printf '%s none swap sw 0 0\n' "$SWAP_FILE" >> /etc/fstab
  say "swap active"
fi
install -d /etc/sysctl.d
cat > /etc/sysctl.d/99-antigravity-guard.conf <<'EOF'
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOF
sysctl --system >/dev/null

# --------------------------------------------------------- 2. log budgets
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/50-antigravity-guard.conf <<'EOF'
[Journal]
SystemMaxUse=200M
SystemKeepFree=1G
EOF
systemctl restart systemd-journald

# ------------------------------------------------------------ 3. the guard
cat > "$GUARD_BIN" <<EOF
#!/usr/bin/env bash
# Written by server-guard. Acts on the host by itself; nothing here waits for a
# person. One line per run in \$LOG, plus one line per action taken.
set -uo pipefail
LOG='$GUARD_LOG'
STATE='$STATE_DIR'
MEM_WARN_MB='$MEM_WARN_MB'
MEM_FREE_MB='$MEM_FREE_MB'
MEM_REBOOT_MB='$MEM_REBOOT_MB'
DISK_WARN_PCT='$DISK_WARN_PCT'
SSHD_PROBE_TIMEOUT='$SSHD_PROBE_TIMEOUT'
mkdir -p "\$STATE" 2>/dev/null

actions=0
notes=''
note() { notes="\${notes}\$1 "; }
act() { actions=\$((actions + 1)); printf '%s action=%s\n' "\$(date -Is)" "\$1" >> "\$LOG"; }

mem_avail=\$(awk '/^MemAvailable:/{print int(\$2/1024)}' /proc/meminfo)
swap_total=\$(awk '/^SwapTotal:/{print int(\$2/1024)}' /proc/meminfo)
swap_free=\$(awk '/^SwapFree:/{print int(\$2/1024)}' /proc/meminfo)
swap_used=\$((swap_total - swap_free))
read -r load1 _ < /proc/loadavg
disk_used=\$(df -P / | awk 'NR==2{gsub("%","",\$5); print \$5}')
iowait=\$(vmstat 1 2 2>/dev/null | tail -1 | awk '{print \$16}')

# sshd answers on port 22 with a banner, or it does not. This is the exact test
# that failed during the incident, and it needs no key.
banner=ok
if ! timeout "\$SSHD_PROBE_TIMEOUT" bash -c 'exec 3<>/dev/tcp/127.0.0.1/22 && IFS= read -r -t 3 line <&3 && [[ \$line == SSH-* ]]' 2>/dev/null; then
  banner=dead
fi

# ---- workers: count, reap orphans, free memory under pressure
agy=0; orphan=0; reaped=0; killed_heavy=0
pids=\$(pgrep -f 'agy acp' 2>/dev/null || true)
for pid in \$pids; do
  agy=\$((agy + 1))
  ppid=\$(awk '{print \$4}' "/proc/\$pid/stat" 2>/dev/null || echo 1)
  if [ "\${ppid:-1}" = "1" ]; then
    orphan=\$((orphan + 1))
    kill -TERM "\$pid" 2>/dev/null && { reaped=\$((reaped + 1)); act "reaped-orphan pid=\$pid"; }
  fi
done
if [ "\$mem_avail" -lt "\$MEM_FREE_MB" ] && [ "\$agy" -gt 0 ]; then
  # Nearly out of memory: end the largest worker rather than let the box freeze.
  # That ACP session is rebound by the plugin on its next turn.
  while [ "\$killed_heavy" -lt 3 ]; do
    victim=\$(ps -eo pid=,rss=,args= | awk '/agy acp/ && !/awk/ {print \$1, \$2}' | sort -k2 -nr | head -1 | cut -d' ' -f1)
    [ -z "\${victim:-}" ] && break
    kill -TERM "\$victim" 2>/dev/null || break
    killed_heavy=\$((killed_heavy + 1))
    act "freed-memory pid=\$victim mem_avail=\${mem_avail}M"
    sleep 2
    mem_avail=\$(awk '/^MemAvailable:/{print int(\$2/1024)}' /proc/meminfo)
    [ "\$mem_avail" -ge "\$MEM_FREE_MB" ] && break
  done
  agy=\$(pgrep -fc '[a]gy acp' 2>/dev/null || true)
fi

# ---- disk pressure: shrink logs before anything else needs space
if [ "\$disk_used" -ge "\$DISK_WARN_PCT" ]; then
  journalctl --vacuum-size=100M >/dev/null 2>&1 && act 'vacuumed-journal'
  find /var/log -maxdepth 1 -name '*.gz' -mtime +3 -delete 2>/dev/null && act 'removed-old-logs'
  : > "\$LOG.1" 2>/dev/null || true
  disk_used=\$(df -P / | awk 'NR==2{gsub("%","",\$5); print \$5}')
fi

# ---- sshd: restart it when it stops answering, at most three times per half hour
banner_restarts=0
if [ "\$banner" = dead ]; then
  fails=\$(( \$(cat "\$STATE/banner-fail" 2>/dev/null || echo 0) + 1 ))
  echo "\$fails" > "\$STATE/banner-fail"
  if [ "\$fails" -ge 2 ]; then
    window=\$(( \$(date +%s) - \$(cat "\$STATE/last-restart" 2>/dev/null || echo 0) ))
    count=\$(cat "\$STATE/restart-count" 2>/dev/null || echo 0)
    [ "\$window" -gt 1800 ] && count=0
    if [ "\$count" -lt 3 ]; then
      act "restarting-sshd banner=dead consecutive=\$fails"
      systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
      echo 0 > "\$STATE/banner-fail"
      date +%s > "\$STATE/last-restart"
      echo \$((count + 1)) > "\$STATE/restart-count"
      sleep 2
      timeout "\$SSHD_PROBE_TIMEOUT" bash -c 'exec 3<>/dev/tcp/127.0.0.1/22 && IFS= read -r -t 3 line <&3 && [[ \$line == SSH-* ]]' 2>/dev/null && banner=ok
    else
      note 'sshd-restart-budget-spent'
    fi
  fi
else
  echo 0 > "\$STATE/banner-fail"
fi

# ---- last resort: memory critical and sshd unreachable means the host is frozen
if [ "\$mem_avail" -lt "\$MEM_REBOOT_MB" ] && [ "\$banner" = dead ]; then
  if [ "\$(cat "\$STATE/rebooted" 2>/dev/null || echo 0)" = "0" ]; then
    act "reboot mem_avail=\${mem_avail}M banner=dead"
    echo 1 > "\$STATE/rebooted"
    sync
    ( sleep 1; systemctl reboot ) >/dev/null 2>&1 &
  fi
fi

status=ok
[ "\$mem_avail" -lt "\$MEM_WARN_MB" ] && { status=warn; note "mem<\${MEM_WARN_MB}M"; }
[ "\$disk_used" -ge "\$DISK_WARN_PCT" ] && { status=warn; note "disk>=\${DISK_WARN_PCT}%"; }
[ "\$swap_total" -gt 0 ] && [ "\$swap_used" -gt \$((swap_total * 8 / 10)) ] && { status=warn; note 'swap>=80%'; }
[ "\$banner" = dead ] && { status=warn; note 'sshd-no-banner'; }

printf '%s status=%s load=%s mem_avail=%sM swap=%s/%sM iowait=%s%% disk=%s%% agy=%s orphan=%s reaped=%s actions=%s %s\n' \
  "\$(date -Is)" "\$status" "\$load1" "\$mem_avail" "\$swap_used" "\$swap_total" "\$iowait" "\$disk_used" \
  "\$agy" "\$orphan" "\$reaped" "\$actions" "\$notes" >> "\$LOG"
EOF
chmod 755 "$GUARD_BIN"
install -d "$STATE_DIR"
touch "$GUARD_LOG"

cat > /etc/systemd/system/antigravity-guard.service <<'EOF'
[Unit]
Description=Antigravity ACP host guard: keep the host running without a human
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/antigravity-guard
EOF

cat > /etc/systemd/system/antigravity-guard.timer <<'EOF'
[Unit]
Description=Run the Antigravity ACP host guard every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > /etc/logrotate.d/antigravity-guard <<EOF
$GUARD_LOG {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
EOF

systemctl daemon-reload
systemctl enable --now antigravity-guard.timer >/dev/null 2>&1
systemctl start antigravity-guard.service

# ---------------------------------------------------------------- summary
say 'installed:'
awk '/^MemTotal:|^SwapTotal:/{printf "[server-guard]   %s %d MB\n", $1, $2/1024}' /proc/meminfo
say "  sshd banner: $(timeout "$SSHD_PROBE_TIMEOUT" bash -c 'exec 3<>/dev/tcp/127.0.0.1/22 && IFS= read -r -t 3 line <&3 && [[ $line == SSH-* ]]' 2>/dev/null && echo ok || echo dead)"
say "  timer: $(systemctl is-active antigravity-guard.timer 2>/dev/null || echo unknown) (every minute)"
say "  last line: $(tail -1 "$GUARD_LOG" 2>/dev/null || echo '(none)')"
