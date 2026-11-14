set -euo pipefail
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r converter/requirements.txt "psycopg[binary]>=3.2"