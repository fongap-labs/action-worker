"""Merged suite. Sections keep their original order:
  - test_pdf_support.py: pdf_support: inspect / extract / rasterize / adapt_content + the capability flag.
  - test_scanned_pdf_fallback.py: P2 follow-up B: scanned PDF image fallback (ADR-006 continuation).
  - test_read_lines_cite.py: R4 contract: `read_file_lines` is a first-class read tool that shares the
"""

from __future__ import annotations

import base64
import io
import struct
import zlib
from types import SimpleNamespace
import pytest
from core import pdf_support
from pathlib import Path
from integrations.tools.documents import document_tools
from integrations.tools.files import file_tools


# ==========================================================================
# from test_pdf_support.py
# ==========================================================================

def _blank_pdf_url(pages: int = 3) -> str:
    from pypdf import PdfWriter

    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=300)
    buf = io.BytesIO()
    writer.write(buf)
    return "data:application/pdf;base64," + base64.b64encode(buf.getvalue()).decode()

@pytest.fixture(autouse=True)
def _reset_mode():
    pdf_support.set_fallback_mode("text")
    yield
    pdf_support.set_fallback_mode("text")

def test_inspect_counts_pages_and_bytes():
    result = pdf_support.inspect(_blank_pdf_url(pages=4))
    assert result["ok"] and result["pages"] == 4 and result["bytes"] > 0

def test_inspect_rejects_non_pdf():
    assert not pdf_support.inspect("data:image/png;base64,zz")["ok"]
    assert not pdf_support.inspect("plain text")["ok"]

def test_rasterize_produces_valid_pngs():
    urls = pdf_support.rasterize(_blank_pdf_url(pages=3), max_pages=2)
    assert urls is not None and len(urls) == 2
    png = base64.b64decode(urls[0].split(",", 1)[1])
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = struct.unpack(">II", png[16:24])
    assert (width, height) == (400, 600)  # 200x300 page @ RASTER_SCALE=2
    channels = 4 if png[25] == 6 else 3
    idat = png.find(b"IDAT")
    (length,) = struct.unpack(">I", png[idat - 4 : idat])
    scanlines = zlib.decompress(png[idat + 4 : idat + 4 + length])
    assert len(scanlines) == height * (1 + width * channels)

def _file_part(url: str) -> dict:
    return {"type": "file", "file": {"filename": "doc.pdf", "file_data": url}}

def test_adapt_scanned_pdf_yields_visible_note():
    caps = SimpleNamespace(vision=False, pdf=False)
    out = pdf_support.adapt_content([_file_part(_blank_pdf_url())], caps)
    assert len(out) == 1 and out[0]["type"] == "text"
    assert "no extractable text" in out[0]["text"]

def test_adapt_images_mode_needs_vision():
    url = _blank_pdf_url(pages=2)
    pdf_support.set_fallback_mode("images")
    with_vision = pdf_support.adapt_content(
        [_file_part(url)], SimpleNamespace(vision=True, pdf=False)
    )
    assert [p["type"] for p in with_vision] == ["text", "image_url", "image_url"]
    without_vision = pdf_support.adapt_content(
        [_file_part(url)], SimpleNamespace(vision=False, pdf=False)
    )
    assert all(p["type"] == "text" for p in without_vision)  # degrades to text

def test_adapt_leaves_other_parts_alone():
    caps = SimpleNamespace(vision=False, pdf=False)
    parts = [{"type": "text", "text": "hi"}, _file_part(_blank_pdf_url())]
    out = pdf_support.adapt_content(parts, caps)
    assert out[0] == {"type": "text", "text": "hi"} and len(out) == 2

def test_set_fallback_mode_rejects_junk():
    assert pdf_support.set_fallback_mode("images") == "images"
    assert pdf_support.set_fallback_mode("bogus") == "text"

# ==========================================================================
# from test_scanned_pdf_fallback.py
# ==========================================================================

def _write_scanned_pdf(target: Path, pages: int = 3) -> None:
    """Build a PDF with blank pages (no text content at all).
    These pages have no embedded text, so pypdf's ``extract_text``
    returns ``""`` — mirroring a real scanned PDF.
    """
    from pypdf import PdfWriter

    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=300)
    with open(target, "wb") as fh:
        writer.write(fh)

def _write_mixed_pdf(target: Path) -> None:
    """Build a PDF where page 1 has text, page 2 is blank (scanned), page 3 has text."""
    from pypdf import PdfWriter
    from pypdf.generic import (
        DecodedStreamObject,
        DictionaryObject,
        NameObject,
    )

    writer = PdfWriter()
    for i, has_text in enumerate([True, False, True]):
        page = writer.add_blank_page(width=300, height=400)
        if has_text:
            text_data = f"Page {i + 1} content"
            font_dict = DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Font"),
                    NameObject("/Subtype"): NameObject("/Type1"),
                    NameObject("/BaseFont"): NameObject("/Helvetica"),
                }
            )
            content = DecodedStreamObject()
            content.set_data(
                f"BT /F1 12 Tf 50 {400 - 30 * (i + 1)} Td ({text_data}) Tj ET".encode()
            )
            page[NameObject("/Contents")] = content
            page[NameObject("/Resources")] = DictionaryObject(
                {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_dict})}
            )
    with open(target, "wb") as fh:
        writer.write(fh)

def _reader(tmp_path: Path):
    return document_tools(str(tmp_path))[0]

def test_scanned_pdf_pages_get_image_and_scanned_flag(tmp_path):
    _write_scanned_pdf(tmp_path / "scan.pdf", pages=3)
    read = _reader(tmp_path)
    out = read(path="scan.pdf", block=0)
    block = out["block"]
    assert block.get("scanned") is True
    assert "image" in block
    assert block["image"].startswith("data:image/png;base64,")
    assert "no extractable text" in block["text"]

def test_scanned_pdf_summary_marks_scanned_pages(tmp_path):
    _write_scanned_pdf(tmp_path / "scan.pdf", pages=2)
    read = _reader(tmp_path)
    out = read(path="scan.pdf")  # summary
    for b in out["blocks"]:
        assert b.get("scanned") is True

def test_scanned_pdf_block_keeps_page_locator(tmp_path):
    _write_scanned_pdf(tmp_path / "scan.pdf", pages=3)
    read = _reader(tmp_path)
    out = read(path="scan.pdf", block=1)
    assert out["block"]["page"] == 2

def test_mixed_pdf_only_scanned_pages_get_image(tmp_path):
    _write_mixed_pdf(tmp_path / "mixed.pdf")
    read = _reader(tmp_path)
    # Read each block individually to inspect text + image
    out0 = read(path="mixed.pdf", block=0)
    out1 = read(path="mixed.pdf", block=1)
    out2 = read(path="mixed.pdf", block=2)
    # Page 1 has text -- no scanned flag, no image
    assert not out0["block"].get("scanned")
    assert "image" not in out0["block"]
    assert "Page 1 content" in out0["block"]["text"]
    # Page 2 is blank -- scanned flag + image
    assert out1["block"].get("scanned") is True
    assert "image" in out1["block"]
    assert "no extractable text" in out1["block"]["text"]
    # Page 3 has text -- no scanned flag, no image
    assert not out2["block"].get("scanned")
    assert "image" not in out2["block"]
    assert "Page 3 content" in out2["block"]["text"]

def test_mixed_pdf_reading_scanned_page_keeps_page_locator(tmp_path):
    _write_mixed_pdf(tmp_path / "mixed.pdf")
    read = _reader(tmp_path)
    out = read(path="mixed.pdf", block=1)
    assert out["block"].get("scanned") is True
    assert out["block"]["page"] == 2

def test_text_pdf_no_scanned_flag_or_image(tmp_path):
    """Build a PDF with extractable text and confirm no scanned-page
    markers appear (regression for over-eager rasterization)."""
    from pypdf import PdfWriter
    from pypdf.generic import (
        DecodedStreamObject,
        DictionaryObject,
        NameObject,
    )

    writer = PdfWriter()
    for i in range(2):
        page = writer.add_blank_page(width=300, height=400)
        text_data = f"Page {i + 1} content"
        font_dict = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        content = DecodedStreamObject()
        content.set_data(
            f"BT /F1 12 Tf 50 {400 - 30 * (i + 1)} Td ({text_data}) Tj ET".encode()
        )
        page[NameObject("/Contents")] = content
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_dict})}
        )
    out_path = tmp_path / "text.pdf"
    with open(out_path, "wb") as fh:
        writer.write(fh)

    read = _reader(tmp_path)
    out = read(path="text.pdf")
    for b in out["blocks"]:
        assert not b.get("scanned")
        assert "image" not in b

# ==========================================================================
# from test_read_lines_cite.py
# ==========================================================================

def _read_file_lines(tools):
    return next(t for t in tools if t.__name__ == "read_file_lines")

def test_read_file_lines_returns_numbered_window(tmp_path):
    target = tmp_path / "report.txt"
    target.write_text("\n".join(f"line {i}" for i in range(1, 11)), encoding="utf-8")

    tools = file_tools(str(tmp_path))
    out = _read_file_lines(tools)(str(target), 3, 4)

    assert out["path"] == "report.txt"
    assert out["start_line"] == 3
    assert out["end_line"] == 6
    assert "line 3" in out["content"]
    assert "line 4" in out["content"]
    assert "line 5" in out["content"]
    assert "line 6" in out["content"]
    # The default window is small (100) but we requested 4; pagination works.
    assert out["has_more"] is True

def test_read_file_lines_missing_file_returns_error(tmp_path):
    tools = file_tools(str(tmp_path))
    out = _read_file_lines(tools)("does_not_exist.txt", 1, 5)
    assert "error" in out
    assert "not a file" in out["error"]

def test_read_file_lines_path_escape_returns_error(tmp_path):
    """A path that escapes the single-root workspace must be refused; this is
    the same invariant `read_file` enforces."""
    tools = file_tools(str(tmp_path))
    out = _read_file_lines(tools)("../outside.txt", 1, 5)
    assert "error" in out
    assert "escape" in out["error"]

def test_read_file_lines_resolves_against_second_root(tmp_path):
    """Multi-root: a path inside the second root must be readable."""

    primary = tmp_path / "primary"
    second = tmp_path / "second"
    primary.mkdir()
    second.mkdir()
    (second / "shared.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")

    tools = file_tools(
        str(primary),
        roots=[primary, second],
    )
    # Absolute path inside the second root.
    out = _read_file_lines(tools)(str(second / "shared.txt"), 1, 3)
    assert "error" not in out, out
    assert "alpha" in out["content"]
    # The returned path is relative to the matching root (second), not primary.
    assert out["path"] in ("shared.txt", str(second / "shared.txt"))

def test_read_file_lines_unicode_path(tmp_path):
    """Chinese + spaces in the path must work; the catalog uses the same
    chokepoint as read_file, so the path handling is shared."""
    target_dir = tmp_path / "测试 目录"
    target_dir.mkdir()
    target = target_dir / "数据.txt"
    target.write_text("一行\n二行\n三行\n", encoding="utf-8")

    tools = file_tools(str(tmp_path))
    out = _read_file_lines(tools)(str(target), 1, 3)
    assert "error" not in out, out
    assert "一行" in out["content"]
    assert "二行" in out["content"]
