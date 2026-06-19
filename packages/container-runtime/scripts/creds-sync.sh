#!/bin/bash
set -uo pipefail

log() { echo "[creds-sync] $*"; }

WORKSPACE="${JODE_WORKSPACE_ROOT:-/workspace}"
AGENT="${AGENT:-unknown}"
STORE="${WORKSPACE}/.jode-auth/${AGENT}"
INTERVAL="${JODE_CREDS_INTERVAL:-30}"

persistent_mount() { grep -qs "${WORKSPACE} fuse" /proc/mounts; }

exclude_args=()
read -ra _excl <<<"${JODE_CREDS_EXCLUDES:-}"
for _g in "${_excl[@]}"; do
  [ -n "$_g" ] && exclude_args+=("--exclude=$_g")
done

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
    log "restoring '${label}' -> ${path}"
    mkdir -p "$(dirname "$path")"
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
    rel="${path#/}"
    tmp="/tmp/creds-${AGENT}-${label}.tgz"
    tar czf "$tmp" --ignore-failed-read "${exclude_args[@]}" -C / "$rel" \
      2>/tmp/creds-save.err || true
    if [ ! -s "$tmp" ]; then
      log "WARN snapshot of '${label}' (${path}) produced nothing: $(tail -1 /tmp/creds-save.err 2>/dev/null)"
      rm -f "$tmp"
      continue
    fi
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
  log "watching credentials every ${INTERVAL}s -> ${STORE}"
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
