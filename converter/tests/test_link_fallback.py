"""D-55: a printed URL must not be printed a second time by the fallback path.

The fallback exists for a real URI whose visible words cannot be bound to a
block ("no visible text link keeps the URL").  When the URL *is* printed, the
fallback used to add a second copy of it; the reader now checks the page's
visible block text first.

These PDFs are generated on the fly (fitz), so the cases run without the corpus.
"""
from __future__ import annotations

import fitz

from src import pdf_reader


def _build(path, lines, links=()):
    """Write a one-page PDF with text lines plus URI link annotations."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    for x, y, text, size in lines:
        page.insert_text((x, y), text, fontsize=size, fontname="china-s")
    for rect, uri in links:
        page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(*rect), "uri": uri})
    doc.save(str(path))
    doc.close()
    return path


def test_printed_url_is_not_duplicated_by_fallback(tmp_path):
    """The URL sits inside one long CJK "word"; its centre is outside the link
    rect, so binding misses it.  It is printed once, so no fallback block."""
    pdf = _build(
        tmp_path / "printed-url.pdf",
        [(40, 100, "项目展示：https://example.com/showcase", 12)],
        # the annotation covers only the left edge of that word
        [((40, 90, 80, 104), "https://example.com/showcase")],
    )
    result = pdf_reader.read_pdf(pdf)
    assert [b for b in result["blocks"] if b["kind"] == "link"] == []
    assert result["text"].count("https://example.com/showcase") == 1
    # the annotation's word is still unbound: no block claims a link it cannot see
    assert all(not b.get("links") for b in result["blocks"])


def test_url_without_visible_text_still_kept_as_label(tmp_path):
    """The design the fix must preserve: a link covering no visible word."""
    pdf = _build(
        tmp_path / "url-as-label.pdf",
        [(40, 100, "联系方式", 12)],
        [((300, 300, 380, 320), "https://example.com/only-link")],
    )
    result = pdf_reader.read_pdf(pdf)
    link_blocks = [b for b in result["blocks"] if b["kind"] == "link"]
    assert len(link_blocks) == 1
    assert link_blocks[0]["text"] == (
        "[https://example.com/only-link](<https://example.com/only-link>)")
    assert [link["href"] for link in result["links"]] == ["https://example.com/only-link"]


def test_uri_inside_another_links_href_is_not_visible_text(tmp_path):
    """`href` is not printed text: a shorter URI must not be mistaken as
    "already visible" just because it prefixes another link's href."""
    pdf = _build(
        tmp_path / "href-prefix.pdf",
        [(40, 100, "GitHub：github.com/Mobilteee/BEtube", 12)],
        [
            ((40, 88, 300, 104), "https://github.com/Mobilteee/BEtube"),
            ((300, 300, 380, 320), "https://github.com/Mobilteee"),
        ],
    )
    result = pdf_reader.read_pdf(pdf)
    link_blocks = [b for b in result["blocks"] if b["kind"] == "link"]
    assert len(link_blocks) == 1
    assert link_blocks[0]["text"] == (
        "[https://github.com/Mobilteee](<https://github.com/Mobilteee>)")
