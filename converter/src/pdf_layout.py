"""Optional layout backend: geometry only, one-to-one preservation of native lines.

Provenance
----------
Copied from ``resume-conversion-build/tools/conversion/pdf_layout.py``
(read-only reference, 2026-11).  The contract is unchanged:

    * the backend is *optional*; unconfigured means ``infer() -> None`` and the
      caller must fall back to native content-stream order (never to a blanket
      x/y sort);
    * geometry may change order and paragraph breaks, never text or link targets;
    * every native line must be assigned exactly once or the page is rejected;
    * ``stream_order_issue`` only *recognises* a non-monotone native order —
      it never guesses a fix.

This project ships no geometry model: ``RESUME_CONVERSION_PDF_LAYOUT`` is
unset, so ``dependency_root()`` is ``None`` and ``infer()`` returns ``None``.
That is reported honestly as "backend unconfigured" (see README / acceptance
report), never as "reading order verified".
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import fitz

from . import content


def dependency_root():
    configured = os.environ.get('RESUME_CONVERSION_PDF_LAYOUT', '')
    root = Path(configured).resolve() if configured else None
    return root if root and (root / 'pymupdf4llm').is_dir() else None


def fingerprint():
    root = dependency_root()
    if root is None:
        return 'pdf-layout-unconfigured'
    digest = hashlib.sha256()
    # Include model files, distribution versions and inference implementation;
    # cache reuse must not silently survive a model/package replacement.
    paths = sorted(p for p in root.rglob('*') if p.is_file() and (
        p.suffix in {'.onnx', '.safetensors', '.pt'} or
        (p.name in {'METADATA', 'RECORD'} and '.dist-info' in str(p.parent)) or
        (p.suffix == '.py' and any(part in {'pymupdf4llm', 'pymupdf_layout'} for part in p.parts))))
    for path in paths:
        digest.update(str(path.relative_to(root)).encode('utf8'))
        digest.update(path.read_bytes())
    return str(root) + ':' + digest.hexdigest()


def infer(path):
    """Return geometry for ``path`` or ``None`` when no backend is configured.

    A *configured but broken* backend raises: silently ignoring a broken backend
    would turn "unverified" into "verified".
    """
    root = dependency_root()
    if root is None:
        return None
    worker = Path(__file__).with_name('pdf_layout_worker.py')
    if not worker.is_file():
        raise RuntimeError('layout backend is configured but pdf_layout_worker.py is missing')
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1')
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    original = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    result = subprocess.run([sys.executable, str(worker), str(root), str(Path(path).resolve())],
                            capture_output=True, text=True, encoding='utf8',
                            timeout=50, creationflags=flags, env=env)
    if result.returncode:
        raise RuntimeError('configured PDF layout backend could not read this original; native text retained')
    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != original:
        raise RuntimeError('original changed during PDF layout inference')
    data = json.loads(result.stdout)
    data['source_sha256'] = original
    return data


def _rect(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4 or not all(
            isinstance(v, (float, int)) and math.isfinite(v) for v in value):
        raise ValueError('invalid layout geometry')
    rect = fitz.Rect(value)
    if rect.is_empty or rect.is_infinite:
        raise ValueError('empty layout geometry')
    return rect


def order_page(page, geometry, number):
    """Assign every native line exactly once or reject this page's layout.

    Geometry may change order and paragraph breaks, never text or link targets.
    Duplicate model text in a picture is geometry only. Missing native lines,
    coordinate changes, rotated text or cross-region lines reject the order.
    """
    if abs(geometry['width'] - page.rect.width) > 1 or abs(geometry['height'] - page.rect.height) > 1:
        raise ValueError('layout page dimensions differ from native page')
    candidates = []
    for region_id, region in enumerate(geometry['regions']):
        candidates.append((region_id, None, region['kind'], _rect(region['bbox'])))
        for line_id, bbox in enumerate(region.get('lines', [])):
            candidates.append((region_id, line_id, region['kind'], _rect(bbox)))
    native = page.get_text('rawdict', sort=False)['blocks']
    assigned = []
    for block_id, block in enumerate(native):
        if block.get('type') != 0:
            continue
        for line_id, line in enumerate(block.get('lines', [])):
            characters = [char for span in line['spans'] for char in span.get('chars', [])]
            text = ''.join(char['c'] for char in characters)
            if not text.strip():
                continue
            if tuple(line.get('dir', (1, 0))) != (1, 0):
                raise ValueError('rotated native line needs a separate layout reader')
            rect = fitz.Rect()
            for char in characters:
                if char['c'].strip():
                    rect |= _rect(char['bbox'])
            rect = _rect(list(rect))
            scores = []
            for region_id, model_line, kind, target in candidates:
                coverage = (rect & target).get_area() / rect.get_area()
                overlap = rect & target
                # The model uses actual glyph boxes while the native reader
                # uses font ascenders/descenders. Match the line centre and
                # horizontal extent, not an identical font-box height. A line
                # crossing two independent columns still cannot match one side.
                if target.contains((rect.tl + rect.br) / 2) and overlap.width / rect.width >= .95:
                    score = (model_line is not None, coverage, kind != 'picture',
                             -abs(target.get_area() - rect.get_area()))
                    scores.append((score, region_id, model_line))
            if not scores:
                raise ValueError('native line has no complete model geometry match')
            _, region_id, model_line = max(scores, key=lambda item: item[0])
            baseline = min(span.get('origin', (0, rect.y1))[1] for span in line['spans'])
            assigned.append((region_id, round(baseline, 1), rect.x0, block_id, line_id, text, list(line['bbox'])))
    # Preserve native paragraphs inside each region. In a row-paired table,
    # interleaving every physical line would separate a role/date from its
    # company and weave the neighbouring description through it.
    groups = {}
    for item in assigned:
        groups.setdefault((item[0], item[3]), []).append(item)
    ordered_groups = sorted(groups.values(), key=lambda group: (
        group[0][0], min(item[1] for item in group), min(item[2] for item in group)))
    assigned = [item for group in ordered_groups for item in sorted(group, key=lambda item: item[4])]
    blocks = []
    previous = None
    for region, baseline, x0, block_id, line_id, text, bbox in assigned:
        key = (region, block_id)
        location = {'page': number, 'bbox': bbox, 'native_block': block_id,
                    'native_lines': [line_id], 'layout_region': region}
        if previous == key and line_id == blocks[-1]['location']['native_lines'][-1] + 1:
            target = blocks[-1]
            target['text'] += '\n' + content.normalize(text)
            target['location']['bbox'] = list(fitz.Rect(target['location']['bbox']) | fitz.Rect(bbox))
            target['location']['native_lines'].append(line_id)
        else:
            blocks.append(content.block('paragraph', text, location))
        previous = key
    return blocks


def stream_order_issue(blocks):
    """Recognize demonstrably non-monotone native order, without guessing a fix."""
    rects = [fitz.Rect(block['location']['bbox']) for block in blocks if block['kind'] == 'paragraph']
    return any(right.y1 + max(2, min(left.height, right.height)) < left.y0
               for left, right in zip(rects, rects[1:]))
