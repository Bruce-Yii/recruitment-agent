set -euo pipefail
MIGS=$(ls db/migrations/*.sql | sort | xargs -n1 basename | sed 's/\.sql$//')

echo "== fresh: 0001→latest on a brand-new database"
psql -v ON_ERROR_STOP=1 -q -c "create database ra_fresh"
for f in $MIGS; do psql -v ON_ERROR_STOP=1 -q -d ra_fresh -f "db/migrations/$f.sql"; done

echo "== upgrade: 0001→0007, then 0008, then the rest"
psql -v ON_ERROR_STOP=1 -q -c "create database ra_upgrade"
for f in 0001_init 0002_seed 0003_review_queue 0004_stage_catalog 0005_version_binding 0006_integrity_gaps 0007_decision_integrity; do
  psql -v ON_ERROR_STOP=1 -q -d ra_upgrade -f "db/migrations/$f.sql"
done
psql -v ON_ERROR_STOP=1 -q -d ra_upgrade -f db/migrations/0008_decision_uniqueness.sql
for f in 0009_application_identity 0010_migration_ledger; do
  psql -v ON_ERROR_STOP=1 -q -d ra_upgrade -f "db/migrations/$f.sql"
done

echo "== re-run: latest migration twice on the migrated database"
psql -v ON_ERROR_STOP=1 -q -d ra_fresh -f db/migrations/0010_migration_ledger.sql

echo "== ledger vs files: 台账必须与 db/migrations/*.sql 完全一致（漏跑 / 幽灵迁移都红）"
ls db/migrations/*.sql | sort | xargs -n1 basename | sed 's/\.sql$//' > /tmp/files.txt
psql -t -A -d ra_fresh -c "select version from recruitment.schema_migration order by version" > /tmp/ledger.txt
diff -u /tmp/files.txt /tmp/ledger.txt && echo "ledger matches files"
echo "migration lifecycle OK"