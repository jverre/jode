#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# creds-sync.sh — persist an agent's auth/credentials across container reboots.
#
# WHY: Cloudflare container instances are EPHEMERAL — local disk (/root/…) is
# wiped whenever the Durable Object recycles the container, so every boot the
# user had to re-authenticate. /workspace (the SHARED jode-workspace R2 bucket,
# already FUSE-mounted — see mount-workspace.sh) is the only store that survives.
# This snapshots each agent's credential dir(s) into that bucket and restores
# them on the next boot, so a still-valid session/token is reused automatically.
#
# DESIGN — why a .tgz and not a symlink/bind onto the mount:
#   The mount is tigrisfs (FUSE-over-object-storage). It is NOT POSIX: no reliable
#   file locking, no mmap writes, async write-back (see mount-workspace.sh's own
#   warning against putting "sqlite databases or lock-heavy workloads" on it).
#   Credentials include exactly that (Chromium's Cookies is sqlite; Local Storage
#   is LevelDB). So creds always LIVE on local disk; we only ever read/write a
#   single .tgz OBJECT per path under /workspace/.jode-auth/<AGENT>/. One object
#   per path → no many-tiny-files / DB-on-FUSE corruption.
#
# Identical copies live in apps/{codex,opencode}/scripts/ — keep in sync.
#
# ENV:
#   AGENT               required — subdir under /workspace/.jode-auth/
#   JODE_CREDS_MANIFEST required — newline-separated "label|/abs/path" entries
#   JODE_CREDS_INTERVAL optional — watch-mode snapshot cadence in seconds (def 30)
#   JODE_CREDS_EXCLUDES optional — whitespace-separated tar exclude globs (caches)
#
# USAGE: creds-sync.sh {restore|save|watch}
#   restore — boot: extract saved snapshots back to local disk (best-effort)
#   save    — snapshot live paths to R2 (atomic-ish: write .tmp then rename)
#   watch   — loop `save` every INTERVAL (run backgrounded; also call save on exit)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

log() { echo "[creds-sync] $*"; }

WORKSPACE=/workspace
AGENT="${AGENT:-unknown}"
STORE="${WORKSPACE}/.jode-auth/${AGENT}"
INTERVAL="${JODE_CREDS_INTERVAL:-30}"

# Only meaningful when /workspace is the persistent R2 mount — a local ephemeral
# /workspace would not survive a reboot, so there'd be nothing to gain (and we'd
# just churn the local disk). Skip cleanly in that case (e.g. `wrangler dev`).
persistent_mount() { grep -qs "${WORKSPACE} fuse" /proc/mounts; }

# Split JODE_CREDS_EXCLUDES into "--exclude=GLOB" args WITHOUT letting the shell
# glob-expand the patterns (they contain `*`). `read -ra` splits on whitespace
# and never performs pathname expansion.
exclude_args=()
read -ra _excl <<<"${JODE_CREDS_EXCLUDES:-}"
for _g in "${_excl[@]}"; do
  [ -n "$_g" ] && exclude_args+=("--exclude=$_g")
done

# Emit each "label|path" manifest line, skipping blanks.
manifest() { printf '%s\n' "${JODE_CREDS_MANIFEST:-}" | sed '/^[[:space:]]*$/d'; }

restore() {
  persistent_mount || { log "no persistent /workspace mount; skip restore"; return 0; }
  manifest | while IFS='|' read -r label path; do
    [ -n "${label:-}" ] || continue
    local_archive="${STORE}/${label}.tgz"
    if [ ! -f "$local_archive" ]; then
      log "no saved creds for '${label}' yet (${local_archive}); skip"
      continue
    fi
    log "restoring '${label}' → ${path}"
    mkdir -p "$(dirname "$path")"
    # Archives store paths relative to / (leading slash stripped on save), so we
    # extract from /. Best-effort: a corrupt/partial archive must not abort boot.
    if tar xzf "$local_archive" -C / 2>/tmp/creds-restore.err; then
      log "restored '${label}'"
    else
      log "WARN restore '${label}' failed: $(tail -1 /tmp/creds-restore.err 2>/dev/null)"
    fi
  done
}

save() {
  persistent_mount || return 0
  mkdir -p "$STORE"
  manifest | while IFS='|' read -r label path; do
    [ -n "${label:-}" ] || continue
    [ -e "$path" ] || continue
    rel="${path#/}"                       # store relative to / so it restores in place
    tmp="/tmp/creds-${AGENT}-${label}.tgz"
    # --ignore-failed-read: transient files (sockets, files deleted mid-read) must
    # not fail the snapshot. We validate the result with -s instead of tar's code.
    tar czf "$tmp" --ignore-failed-read "${exclude_args[@]}" -C / "$rel" \
      2>/tmp/creds-save.err || true
    if [ ! -s "$tmp" ]; then
      log "WARN snapshot of '${label}' (${path}) produced nothing: $(tail -1 /tmp/creds-save.err 2>/dev/null)"
      rm -f "$tmp"
      continue
    fi
    # Write the single object to the mount, then rename into place (rename is
    # atomic within the same dir, so a reader never sees a half-written archive).
    if cp "$tmp" "${STORE}/${label}.tgz.tmp" && mv "${STORE}/${label}.tgz.tmp" "${STORE}/${label}.tgz"; then
      log "saved '${label}' ($(du -h "$tmp" | cut -f1))"
    else
      log "WARN could not write snapshot for '${label}' to ${STORE}"
    fi
    rm -f "$tmp"
  done
}

watch() {
  persistent_mount || { log "no persistent /workspace mount; credential watch disabled"; return 0; }
  log "watching credentials every ${INTERVAL}s → ${STORE}"
  while true; do
    sleep "$INTERVAL"
    save
  done
}

case "${1:-}" in
  restore) restore ;;
  save)    save ;;
  watch)   watch ;;
  *) echo "usage: $0 {restore|save|watch}" >&2; exit 2 ;;
esac
