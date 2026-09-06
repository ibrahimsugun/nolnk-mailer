#!/usr/bin/env bash
# NoLnk Mailer — faz-sonu KOD snapshot yedeği (git YOK kararı; plan §9a).
#
# HARİÇ tutulanlar (bilinçli):
#   .env            → SIR sızıntısı riski, ASLA yedeğe girmez
#   data/           → kişisel veri; DB idempotent şema + seed ile yeniden kurulur
#   node_modules/   → `npm i` ile geri gelir
#   .git/ · *.zip · .DS_Store → gereksiz
#
# Kullanım:
#   bash scripts/backup.sh T0     # faz yedeği → ../nolnk-mailer-T0-YYYYMMDD-HHMM.zip
#   npm run backup                # etiketsiz (manual) yedek
set -euo pipefail

cd "$(dirname "$0")/.."
TAG="${1:-manual}"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="../nolnk-mailer-${TAG}-${STAMP}.zip"

zip -r "$OUT" . \
  -x '.env' \
  -x './data/*' \
  -x './node_modules/*' \
  -x './.git/*' \
  -x './*.zip' \
  -x '*/.DS_Store' \
  -x '.DS_Store' > /dev/null

echo "✓ Yedek alındı → ${OUT}  ($(du -h "$OUT" | cut -f1))"
echo "  (.env ve data/ dahil DEĞİL — sır/kişisel veri yedeğe girmez)"
