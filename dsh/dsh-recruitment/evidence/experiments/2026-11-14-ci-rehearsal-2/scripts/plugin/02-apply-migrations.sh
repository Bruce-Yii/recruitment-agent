set -euo pipefail
for f in $(ls db/migrations/*.sql | sort); do f=$(basename "$f" .sql);
  psql -v ON_ERROR_STOP=1 -q -f "db/migrations/$f.sql"
done