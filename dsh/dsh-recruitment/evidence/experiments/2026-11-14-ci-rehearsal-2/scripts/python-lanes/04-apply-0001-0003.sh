set -euo pipefail
for f in 0001_init 0002_seed 0003_review_queue; do
  psql -v ON_ERROR_STOP=1 -q -f "db/migrations/$f.sql"
done