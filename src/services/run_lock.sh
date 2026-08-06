#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../../.env"

SCRIPT="${1:-}"
LOGFILE="${2:-/home/ubuntu/node_procesos/logs/run_venta_ejecutivo_lock.log}"

if [[ -z "$SCRIPT" ]]; then
  echo "Uso: $0 /ruta/script.js [/ruta/log.log]"
  exit 2
fi

# Lock por script individual: evita que una corrida se solape con la
# siguiente de si misma cuando se demora mas que el intervalo del cron
# (esto es lo que causaba "Requesting main frame too early!" en davila:
# el pkill de limpieza de Chrome mataba una corrida legitima que seguia
# activa porque otra ya se habia disparado encima de ella).
LOCK_FILE="/tmp/venta_ejecutivo_$(basename "$SCRIPT" .js).lock"

mkdir -p "$(dirname "$LOGFILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"; }

log "START wrapper"
log "SCRIPT=$SCRIPT"
log "LOGFILE=$LOGFILE"
log "LOCK_FILE=$LOCK_FILE"

export HOME="/home/ubuntu"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  log "ENV loaded: $ENV_FILE"
else
  log "WARN: No existe ENV_FILE=$ENV_FILE"
fi

# Tomar lock propio del script (espera hasta 20 min; si sigue ocupado, se
# omite esta corrida en vez de acumular instancias de Chrome compitiendo).
log "Intentando tomar lock propio (espera max 1200s)..."
if /usr/bin/flock -w 1200 "$LOCK_FILE" bash -lc "
  echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] LOCK OK, ejecutando node...\";
  /usr/bin/node \"$SCRIPT\"
" >> "$LOGFILE" 2>&1; then
  log "DONE OK (exit=0)"
else
  code=$?
  log "DONE FAIL (exit=$code) - lock ocupado o script falló"
  exit $code
fi
