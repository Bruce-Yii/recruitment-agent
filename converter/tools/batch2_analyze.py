import json
from collections import Counter
from pathlib import Path
C = Path(r"D:\12412\dsh工作区\projects\recruitment-agent\converter")
rows = [json.loads(l) for l in (C/"reports"/"batch2-results.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
ok = [r for r in rows if r.get("ok")]
print("=== issue code 分布 ===")
cnt = Counter()
for r in ok:
    for c in r.get("issue_codes") or []:
        cnt[c] += 1
for k, v in cnt.most_common(15):
    print(f"  {k:42} {v:3} / {len(ok)}")
print("\n=== 字段状态分布 ===")
for field in ("name","phone","email","work_experience","education"):
    c = Counter((r.get("field_states") or {}).get(field) for r in ok)
    print(f"  {field:16} present={c.get('present',0):2} absent={c.get('absent',0):2} unreadable={c.get('unreadable',0):2}")
print("\n=== needs_visual 的 5 份 ===")
for r in ok:
    if r.get("needs_visual"):
        print(f"  {r['file'][:52]:54} pages={r.get('pages')} chars={r.get('chars')} blocks={r.get('blocks')} codes={','.join(r.get('issue_codes') or [])[:60]}")
print("\n=== complete 的 7 份 ===")
for r in ok:
    if r.get("completeness") == "complete":
        print(f"  {r['file'][:52]:54} chars={r.get('chars')} blocks={r.get('blocks')}")
print("\n=== 最慢 3 份 ===")
for r in sorted(ok, key=lambda x: -(x.get("seconds") or 0))[:3]:
    print(f"  {r['file'][:50]:52} {r.get('seconds')}s pages={r.get('pages')}")
