#!/bin/sh
# =============================================================================
#  entrypoint.sh - runs INSIDE the container
#
#  Renders the Xray configuration from environment variables, validates it with
#  the real Xray binary, then starts Xray. Nothing about the config is
#  hardcoded: every tunable is an environment variable (see .env.example).
#
#  !! THIS FILE MUST SIT NEXT TO THE Dockerfile !!
#  The Dockerfile does `COPY entrypoint.sh /usr/local/bin/entrypoint.sh`.
#  If it is missing from the repo, the image build fails immediately.
# =============================================================================
set -eu

log()  { printf '[entrypoint] %s\n' "$*" >&2; }
fail() { printf '[entrypoint] FATAL: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
is_int() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

to_bool() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)     printf 'true'  ;;
    0|false|no|off|'') printf 'false' ;;
    *) fail "expected a boolean (true/false), got '$1'" ;;
  esac
}

# Reject values that would break the JSON template generated below.
safe_str() { # <name> <value>
  case "${2:-}" in
    *'"'*) fail "$1 must not contain a double quote" ;;
    *'\'*) fail "$1 must not contain a backslash" ;;
  esac
  if [ "$(printf '%s' "${2:-}" | wc -l | tr -d ' ')" != "0" ]; then
    fail "$1 must be a single line"
  fi
}

# ---------------------------------------------------------------------------
# shared steps (used by both the generated-config and supplied-config paths)
# ---------------------------------------------------------------------------
validate_config() {
  _log="$(mktemp)"
  if ! xray run -test -config "$CONFIG_PATH" >"$_log" 2>&1; then
    log "the config did not validate:"
    cat "$_log" >&2
    rm -f "$_log"
    fail "invalid Xray config - see the validator output above"
  fi
  rm -f "$_log"
}

# Keep the Go runtime inside a small container limit. GOMEMLIMIT is read by the
# Go runtime itself, so exporting it is enough.
apply_gomemlimit() {
  [ -z "${GOMEMLIMIT:-}" ] || return 0
  _limit=""
  if [ -r /sys/fs/cgroup/memory.max ]; then
    _limit="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"
  elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    _limit="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)"
  fi
  case "${_limit:-}" in
    ''|max) return 0 ;;
  esac
  if is_int "$_limit" && [ "$_limit" -gt 0 ] && [ "$_limit" -le 8589934592 ]; then
    GOMEMLIMIT="$(( _limit * 70 / 100 ))"
    export GOMEMLIMIT
    log "container memory limit ${_limit} bytes -> GOMEMLIMIT=${GOMEMLIMIT}"
  fi
  return 0
}

CONFIG_PATH="${CONFIG_PATH:-/etc/xray/config.json}"

# ---------------------------------------------------------------------------
# ESCAPE HATCH - a complete config supplied as one environment variable.
# When XRAY_CONFIG_JSON is set, every other setting below is ignored.
# You do not need this: by default the config is generated from variables.
# ---------------------------------------------------------------------------
if [ -n "${XRAY_CONFIG_JSON:-}" ]; then
  mkdir -p "$(dirname "$CONFIG_PATH")"
  printf '%s' "$XRAY_CONFIG_JSON" > "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH" 2>/dev/null || true
  log "using the config supplied in XRAY_CONFIG_JSON (all other variables are ignored)"
  validate_config
  apply_gomemlimit
  exec xray run -config "$CONFIG_PATH"
fi

# ---------------------------------------------------------------------------
# required / basic settings
# ---------------------------------------------------------------------------
PORT="${PORT:-8080}"
is_int "$PORT" || fail "PORT must be a number"
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "PORT must be between 1 and 65535"

UUIDS="${UUID:-}"
[ -n "$UUIDS" ] || fail "UUID is required (one or more VLESS client ids, comma separated)"

XHTTP_PATH="${XHTTP_PATH:-/}"
safe_str XHTTP_PATH "$XHTTP_PATH"
case "$XHTTP_PATH" in /*) ;; *) fail "XHTTP_PATH must start with '/'" ;; esac

XHTTP_HOST="${XHTTP_HOST:-}"
safe_str XHTTP_HOST "$XHTTP_HOST"

XHTTP_MODE="${XHTTP_MODE:-packet-up}"
case "$XHTTP_MODE" in
  packet-up|stream-up|stream-one|auto) ;;
  *) fail "XHTTP_MODE must be one of: packet-up, stream-up, stream-one, auto" ;;
esac

LOG_LEVEL="${LOG_LEVEL:-warning}"
case "$LOG_LEVEL" in
  debug|info|warning|error|none) ;;
  *) fail "LOG_LEVEL must be one of: debug, info, warning, error, none" ;;
esac

# ---------------------------------------------------------------------------
# booleans / enums
# ---------------------------------------------------------------------------
NO_SSE_HEADER="$(to_bool "${NO_SSE_HEADER:-false}")"
ENABLE_SNIFFING="$(to_bool "${ENABLE_SNIFFING:-false}")"
BLOCK_BITTORRENT="$(to_bool "${BLOCK_BITTORRENT:-false}")"

DOMAIN_STRATEGY="${DOMAIN_STRATEGY:-UseIPv4}"
case "$DOMAIN_STRATEGY" in
  AsIs|UseIP|UseIPv4|UseIPv6|UseIPv4v6|UseIPv6v4|ForceIPv4|ForceIPv6|ForceIPv4v6|ForceIPv6v4) ;;
  *) fail "DOMAIN_STRATEGY is not a valid Xray domain strategy: $DOMAIN_STRATEGY" ;;
esac

# ---------------------------------------------------------------------------
# numbers / ranges
# ---------------------------------------------------------------------------
SC_FROM="${SC_MAX_EACH_POST_BYTES_FROM:-1000000}"
SC_TO="${SC_MAX_EACH_POST_BYTES_TO:-1000000}"
is_int "$SC_FROM" || fail "SC_MAX_EACH_POST_BYTES_FROM must be a number"
is_int "$SC_TO"   || fail "SC_MAX_EACH_POST_BYTES_TO must be a number"
[ "$SC_FROM" -gt 0 ] || fail "SC_MAX_EACH_POST_BYTES_FROM must be > 0"
[ "$SC_FROM" -le "$SC_TO" ] || fail "SC_MAX_EACH_POST_BYTES_FROM must be <= SC_MAX_EACH_POST_BYTES_TO"

SC_MAX_BUFFERED_POSTS="${SC_MAX_BUFFERED_POSTS:-30}"
is_int "$SC_MAX_BUFFERED_POSTS" || fail "SC_MAX_BUFFERED_POSTS must be a number"

XP_FROM="${X_PADDING_FROM:-100}"
XP_TO="${X_PADDING_TO:-1000}"
is_int "$XP_FROM" || fail "X_PADDING_FROM must be a number"
is_int "$XP_TO"   || fail "X_PADDING_TO must be a number"
[ "$XP_FROM" -le "$XP_TO" ] || fail "X_PADDING_FROM must be <= X_PADDING_TO"

# Xray's JSON accepts a range either as a plain integer (when from == to) or as
# a "from-to" string. It does NOT accept {"from": x, "to": y} - that form makes
# Xray refuse to start with "Invalid integer range".
if [ "$SC_FROM" = "$SC_TO" ]; then
  SC_EACH_JSON="$SC_FROM"
else
  SC_EACH_JSON="\"$SC_FROM-$SC_TO\""
fi
if [ "$XP_FROM" = "$XP_TO" ]; then
  XP_JSON="$XP_FROM"
else
  XP_JSON="\"$XP_FROM-$XP_TO\""
fi

# ---------------------------------------------------------------------------
# build lists
# ---------------------------------------------------------------------------
CLIENTS_JSON=""
CLIENT_COUNT=0
OLD_IFS="$IFS"
IFS=','
for _id in $UUIDS; do
  _id="$(printf '%s' "$_id" | tr -d ' ')"
  [ -n "$_id" ] || continue
  safe_str UUID "$_id"
  if [ "$CLIENT_COUNT" -eq 0 ]; then
    CLIENTS_JSON="{\"id\": \"$_id\", \"flow\": \"\"}"
  else
    CLIENTS_JSON="$CLIENTS_JSON, {\"id\": \"$_id\", \"flow\": \"\"}"
  fi
  CLIENT_COUNT=$((CLIENT_COUNT + 1))
done
IFS="$OLD_IFS"
[ "$CLIENT_COUNT" -gt 0 ] || fail "UUID did not contain a usable id"

DNS_JSON=""
DNS_SERVERS="${DNS_SERVERS:-1.1.1.1,8.8.8.8}"
OLD_IFS="$IFS"
IFS=','
for _dns in $DNS_SERVERS; do
  _dns="$(printf '%s' "$_dns" | tr -d ' ')"
  [ -n "$_dns" ] || continue
  safe_str DNS_SERVERS "$_dns"
  if [ -z "$DNS_JSON" ]; then DNS_JSON="\"$_dns\""; else DNS_JSON="$DNS_JSON, \"$_dns\""; fi
done
IFS="$OLD_IFS"
[ -n "$DNS_JSON" ] || DNS_JSON='"1.1.1.1"'

# ---------------------------------------------------------------------------
# optional fragments
# ---------------------------------------------------------------------------
OUTBOUNDS_EXTRA=""
ROUTING_RULES="[]"
if [ "$BLOCK_BITTORRENT" = "true" ]; then
  OUTBOUNDS_EXTRA=",
    {
      \"tag\": \"blocked\",
      \"protocol\": \"blackhole\",
      \"settings\": {}
    }"
  ROUTING_RULES='[
      {
        "type": "field",
        "protocol": ["bittorrent"],
        "outboundTag": "blocked"
      }
    ]'
fi

# ---------------------------------------------------------------------------
# render config
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$CONFIG_PATH")"

cat > "$CONFIG_PATH" <<EOF
{
  "log": {
    "loglevel": "${LOG_LEVEL}",
    "access": "none",
    "dnsLog": false
  },
  "dns": {
    "servers": [${DNS_JSON}]
  },
  "inbounds": [
    {
      "tag": "xhttp-in",
      "listen": "0.0.0.0",
      "port": ${PORT},
      "protocol": "vless",
      "settings": {
        "clients": [${CLIENTS_JSON}],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "xhttp",
        "security": "none",
        "xhttpSettings": {
          "path": "${XHTTP_PATH}",
          "host": "${XHTTP_HOST}",
          "mode": "${XHTTP_MODE}",
          "scMaxEachPostBytes": ${SC_EACH_JSON},
          "scMaxBufferedPosts": ${SC_MAX_BUFFERED_POSTS},
          "xPaddingBytes": ${XP_JSON},
          "noSSEHeader": ${NO_SSE_HEADER}
        }
      },
      "sniffing": {
        "enabled": ${ENABLE_SNIFFING},
        "destOverride": ["http", "tls", "quic"],
        "routeOnly": false
      }
    }
  ],
  "outbounds": [
    {
      "tag": "direct",
      "protocol": "freedom",
      "settings": {
        "domainStrategy": "${DOMAIN_STRATEGY}"
      }
    }${OUTBOUNDS_EXTRA}
  ],
  "routing": {
    "domainStrategy": "AsIs",
    "rules": ${ROUTING_RULES}
  },
  "policy": {
    "levels": {
      "0": {
        "handshake": 4,
        "connIdle": 300,
        "uplinkOnly": 1,
        "downlinkOnly": 1
      }
    },
    "system": {
      "statsInboundUplink": false,
      "statsInboundDownlink": false
    }
  }
}
EOF
chmod 600 "$CONFIG_PATH" 2>/dev/null || true

# ---------------------------------------------------------------------------
# validate the rendered config with the real binary before starting
# ---------------------------------------------------------------------------
validate_config

# ---------------------------------------------------------------------------
# memory + start
# ---------------------------------------------------------------------------
apply_gomemlimit

log "starting Xray - port=${PORT} mode=${XHTTP_MODE} path=${XHTTP_PATH} clients=${CLIENT_COUNT} loglevel=${LOG_LEVEL}"
[ "$XHTTP_HOST" = "" ] || log "warning: XHTTP_HOST='${XHTTP_HOST}' turns on Host validation - it must match exactly what Cloudflare sends"
exec xray run -config "$CONFIG_PATH"
