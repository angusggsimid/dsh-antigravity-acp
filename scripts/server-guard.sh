#!/usr/bin/env bash
# Antigravity ACP: the host-side baseline the plugin expects from the machine
# that runs `agy acp`. Idempotent; run as root (or through sudo).
#
# Why this exists. One ACP worker is cheap, but every client reconnect can leave
# one behind, and a small VM has no room for that: on a 1.6 GB instance with no
# swap the box thrashes until sshd stops answering, which takes the tool bridge
# and the quota bridge down with it. The incident this was written for ended
# with sshd accepting TCP and never sending a banner for two hours.
#
# What it installs:
#   1. swap and a low swappiness: a slow host instead of a dead one.
#   2. a journald size cap and rotation for the guard log.
#   3. a 5-minute guard that records memory, disk, worker and orphan counts,
#      reaps `agy acp` workers whose parent is gone, and warns before the host
#      runs out of memory.
#
# Everything is safe to re-run; existing swap is never recreated.

set -euo pipefail

SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
GUARD_LOG="/var/log/antigravity-guard.log"
GUARD_BIN="/usr/local/sbin/antigravity-guard"
MEM_WARN_MB="${MEM_WARN_MB:-200}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"

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
  if ! grep -qs "^$SWAP_FILE" /etc/fstab; then
    printf '%s none swap sw 0 0\n' "$SWAP_FILE" >> /etc/fstab
  fi
  say "swap active"
fi
# Reclaim only under real pressure: a busy host that swaps early is slower than
# one that waits for the last few percent.
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
# Written by server-guard. One line per run; no daemon, no state.
set -uo pipefail
LOG='$GUARD_LOG'
MEM_WARN_MB='$MEM_WARN_MB'
DISK_WARN_PCT='$DISK_WARN_PCT'

mem_avail=\$(awk '/^MemAvailable:/{print int(\$2/1024)}' /proc/meminfo)
swap_total=\$(awk '/^SwapTotal:/{print int(\$2/1024)}' /proc/meminfo)
swap_free=\$(awk '/^SwapFree:/{print int(\$2/1024)}' /proc/meminfo)
swap_used=\$((swap_total - swap_free))
read -r load1 _ < /proc/loadavg
disk_used=\$(df -P / | awk 'NR==2{gsub("%","",\$5); print \$5}')
iowait=\$(vmstat 1 2 2>/dev/null | tail -1 | awk '{print \$16}')

agy=0; orphan=0; killed=0
for pid in \$(pgrep -f 'agy acp' 2>/dev/null || true); do
  agy=\$((agy + 1))
  ppid=\$(awk '{print \$4}' "/proc/\$pid/stat" 2>/dev/null || echo 1)
  # sshd reaps a worker when its session dies; a worker reparented to init means
  # that never happened, and it will hold memory until this host is restarted.
  if [ "\${ppid:-1}" = "1" ]; then
    orphan=\$((orphan + 1))
    kill -TERM "\$pid" 2>/dev/null && killed=\$((killed + 1))
  fi
done

status=ok
notes=''
[ "\$mem_avail" -lt "\$MEM_WARN_MB" ] && { status=warn; notes="\${notes}mem<\${MEM_WARN_MB}M "; }
[ "\$disk_used" -ge "\$DISK_WARN_PCT" ] && { status=warn; notes="\${notes}disk>=\${DISK_WARN_PCT}% "; }
if [ "\$swap_total" -gt 0 ] && [ "\$swap_used" -gt \$((swap_total * 8 / 10)) ]; then
  status=warn; notes="\${notes}swap>=80% "
fi

printf '%s status=%s load=%s mem_avail=%sM swap=%s/%sM iowait=%s%% disk=%s%% agy=%s orphan=%s reaped=%s %s\n' \
  "\$(date -Is)" "\$status" "\$load1" "\$mem_avail" "\$swap_used" "\$swap_total" "\$iowait" "\$disk_used" "\$agy" "\$orphan" "\$killed" "\$notes" >> "\$LOG"
EOF
chmod 755 "$GUARD_BIN"
touch "$GUARD_LOG"

cat > /etc/systemd/system/antigravity-guard.service <<'EOF'
[Unit]
Description=Antigravity ACP host guard: record resources, reap orphaned workers
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/antigravity-guard
EOF

cat > /etc/systemd/system/antigravity-guard.timer <<'EOF'
[Unit]
Description=Run the Antigravity ACP host guard every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
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
say "  sshd sessions: $(pgrep -c -f 'sshd:' 2>/dev/null || echo 0)"
say "  timer: $(systemctl is-active antigravity-guard.timer 2>/dev/null || echo unknown)"
say "  last line: $(tail -1 "$GUARD_LOG" 2>/dev/null || echo '(none)')"
