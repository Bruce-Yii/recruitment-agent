set -euo pipefail
if grep -rn --include='*.jsonl' -e 'D:\\' -e 'C:\\' converter/corpus; then
  echo "::error title=Machine path in manifest::Corpus manifests must use root+rel, never a machine-absolute path."
  exit 1
fi
echo "corpus manifests contain no machine-absolute paths"