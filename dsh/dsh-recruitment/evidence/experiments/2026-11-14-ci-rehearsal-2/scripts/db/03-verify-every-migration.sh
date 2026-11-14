set -euo pipefail
for f in verify-0003 verify-0004 verify-0005 verify-0006 verify-0007 verify-0008 verify-0009 verify-0010 verify; do
  echo "== $f"
  psql -v ON_ERROR_STOP=1 -q -f "db/$f.sql"
done