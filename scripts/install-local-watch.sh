#!/usr/bin/env bash
# Install the local quota-forward watch on this Mac. Safe to re-run: it replaces
# the script, re-renders the LaunchAgent and reloads it.
#
# The watch exists because launchd only restarts a tunnel whose process exits. A
# remote reboot can leave `ssh -L` alive with no listener, and the quota panel
# then says "fetch failed" until a person kills it by hand.

set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
watch_src="${repo_dir}/scripts/local-tunnel-watch.sh"
template="${repo_dir}/scripts/launchd/com.agg.antigravity-tunnel-watch.plist.template"
label="com.agg.antigravity-tunnel-watch"
target="${HOME}/.dsh/antigravity-tunnel-watch.sh"
plist="${HOME}/Library/LaunchAgents/${label}.plist"
uid=$(id -u)

[ -f "$watch_src" ] || { echo "missing $watch_src" >&2; exit 1; }
[ -f "$template" ] || { echo "missing $template" >&2; exit 1; }

mkdir -p "${HOME}/.dsh" "${HOME}/Library/LaunchAgents"
install -m 755 "$watch_src" "$target"

# launchd does not expand variables: the absolute path has to be written in.
sed "s|__HOME__|${HOME}|g" "$template" > "$plist"
plutil -lint "$plist" >/dev/null

launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
launchctl bootstrap "gui/${uid}" "$plist"
launchctl enable "gui/${uid}/${label}"

echo "installed:"
echo "  script: $target"
echo "  plist:  $plist (every 30s)"
echo "  log:    ${HOME}/.dsh/cache/antigravity-tunnel-watch/watch.log"
