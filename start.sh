#!/usr/bin/env bash
# NoLnk Mailer — hızlı başlatma.
# Kullanım: bash start.sh   (veya: ./start.sh)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-5980}"

if [ ! -f .env ]; then
  echo "✗ .env bulunamadı. .env.example'ı kopyalayıp sırları doldur:"
  echo "  cp .env.example .env"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "→ node_modules yok, bağımlılıklar kuruluyor (npm i)..."
  npm i
fi

PIDS="$(lsof -ti ":${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "${PIDS}" ]; then
  for PID in ${PIDS}; do
    CMD="$(ps -p "${PID}" -o comm= 2>/dev/null || true)"
    case "${CMD}" in
      *node*)
        echo "→ Port ${PORT} önceki bir node süreci (PID ${PID}) tarafından kullanılıyor, durduruluyor..."
        kill "${PID}" 2>/dev/null || true
        for _ in $(seq 1 20); do
          kill -0 "${PID}" 2>/dev/null || break
          sleep 0.2
        done
        if kill -0 "${PID}" 2>/dev/null; then
          echo "  → Nazikçe kapanmadı, zorla sonlandırılıyor (SIGKILL)..."
          kill -9 "${PID}" 2>/dev/null || true
        fi
        ;;
      *)
        echo "✗ Port ${PORT} node-dışı bir süreç tarafından kullanılıyor (PID ${PID}, ${CMD}). Elle durdur ya da PORT=xxxx bash start.sh ile farklı port dene."
        exit 1
        ;;
    esac
  done
fi

echo "→ NoLnk Mailer başlatılıyor → http://localhost:${PORT}"
exec npm start
