"""Turn a Word file into safe HTML so the app can show it instead of only offering a download.

* ``.docx`` (a zip of XML): text, headings, bold/italic/underline/strike, colour, size, alignment,
  bullet/numbered lists, tables and embedded pictures.
* ``.doc`` (the old binary format): the same — styles, character and paragraph formatting, tables
  and embedded pictures are rebuilt from the file's own tables.

Pure standard library — no Word, LibreOffice or extra package is needed, so it works on the
hosting server as it is. Every piece of text is escaped here and the page is shown in a sandboxed
frame with scripts off, so a hostile file cannot run anything.
"""
import base64
import html
import re
import struct
import zipfile
import io
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'

MAX_PART_BYTES = 25 * 1024 * 1024      # biggest XML part we will read (zip-bomb guard)
MAX_IMAGE_BYTES = 3 * 1024 * 1024      # a larger picture is left out of the preview
IMAGE_MIMES = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'bmp': 'image/bmp'}


class PreviewError(Exception):
    """The file could not be turned into a preview (the user can still download it)."""


PAGE_CSS = (
    'html{background:#e6e9ef}body{margin:0;padding:18px 12px;font-family:Calibri,"Segoe UI",Arial,sans-serif}'
    '.page{background:#fff;color:#1a1a1a;max-width:820px;margin:0 auto;padding:48px 56px;box-sizing:border-box;'
    'box-shadow:0 2px 14px rgba(0,0,0,.25);font-size:14.5px;line-height:1.5;min-height:300px;overflow-wrap:anywhere}'
    '.page p{margin:0 0 8px}.page h1,.page h2,.page h3,.page h4{margin:14px 0 8px;line-height:1.25}'
    '.page h1{font-size:26px}.page h2{font-size:21px}.page h3{font-size:17px}.page h4{font-size:15px}'
    '.page table{border-collapse:collapse;margin:8px 0;max-width:100%}.page td{border:1px solid #bbb;padding:4px 7px;vertical-align:top}'
    '.page img{max-width:100%;height:auto}.page .li{display:flex;gap:8px}.page .li .mk{flex:0 0 auto;min-width:18px;text-align:right}'
    '.page .li .tx{flex:1 1 auto}.page hr.pb{border:0;border-top:1px dashed #bbb;margin:18px 0}'
    '.note{max-width:820px;margin:0 auto 10px;font:12px Arial,sans-serif;color:#556}'
)


def _wrap(body, note=''):
    n = f'<div class="note">{html.escape(note)}</div>' if note else ''
    return ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<style>{PAGE_CSS}</style></head><body>{n}<div class="page">{body}</div></body></html>')


# ----------------------------------------------------------------------------- .docx

def _read_part(zf, name):
    try:
        info = zf.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_PART_BYTES:
        raise PreviewError('This Word file is too large to preview.')
    return zf.read(name)


def _parse_xml(data):
    if data is None:
        return None
    head = data[:4096].lower()
    if b'<!doctype' in head or b'<!entity' in head:        # no entity tricks
        raise PreviewError('This Word file cannot be previewed.')
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        raise PreviewError('This Word file cannot be previewed.')


def _num_formats(zf):
    """numId -> {level: 'bullet' | 'decimal' | ...} from numbering.xml."""
    root = _parse_xml(_read_part(zf, 'word/numbering.xml'))
    out = {}
    if root is None:
        return out
    abstract = {}
    for an in root.findall(W + 'abstractNum'):
        levels = {}
        for lvl in an.findall(W + 'lvl'):
            fmt = lvl.find(W + 'numFmt')
            levels[int(lvl.get(W + 'ilvl', '0'))] = fmt.get(W + 'val') if fmt is not None else 'decimal'
        abstract[an.get(W + 'abstractNumId')] = levels
    for num in root.findall(W + 'num'):
        ref = num.find(W + 'abstractNumId')
        if ref is not None:
            out[num.get(W + 'numId')] = abstract.get(ref.get(W + 'val'), {})
    return out


def _heading_styles(zf):
    root = _parse_xml(_read_part(zf, 'word/styles.xml'))
    out = {}
    if root is None:
        return out
    for st in root.findall(W + 'style'):
        name = st.find(W + 'name')
        label = (name.get(W + 'val') if name is not None else '').lower()
        m = re.match(r'heading\s*(\d)', label)
        if m:
            out[st.get(W + 'styleId')] = min(int(m.group(1)), 4)
        elif label == 'title':
            out[st.get(W + 'styleId')] = 1
    return out


def _relationships(zf):
    root = _parse_xml(_read_part(zf, 'word/_rels/document.xml.rels'))
    out = {}
    if root is not None:
        for rel in root.findall(REL + 'Relationship'):
            out[rel.get('Id')] = rel.get('Target')
    return out


class _Docx:
    def __init__(self, zf):
        self.zf = zf
        self.rels = _relationships(zf)
        self.headings = _heading_styles(zf)
        self.numbering = _num_formats(zf)
        self.counters = {}
        self.images_left = 40

    # -- pictures
    def image(self, blip):
        rid = blip.get(R + 'embed')
        target = self.rels.get(rid or '')
        if not target or self.images_left <= 0:
            return ''
        path = target.lstrip('/') if target.startswith('/') else 'word/' + target
        path = re.sub(r'[^/]+/\.\./', '', path)
        ext = path.rsplit('.', 1)[-1].lower()
        mime = IMAGE_MIMES.get(ext)
        try:
            info = self.zf.getinfo(path)
        except KeyError:
            return ''
        if not mime or info.file_size > MAX_IMAGE_BYTES:
            return ''
        self.images_left -= 1
        return '<img alt="" src="data:%s;base64,%s">' % (mime, base64.b64encode(self.zf.read(path)).decode())

    # -- runs
    def run(self, r):
        out = []
        rpr = r.find(W + 'rPr')
        style, tags = [], []
        if rpr is not None:
            def on(tag):
                el = rpr.find(W + tag)
                return el is not None and el.get(W + 'val', 'true') not in ('0', 'false', 'off')
            if on('b'): tags.append('b')
            if on('i'): tags.append('i')
            if rpr.find(W + 'u') is not None and rpr.find(W + 'u').get(W + 'val') not in (None, 'none'): tags.append('u')
            if on('strike'): tags.append('s')
            va = rpr.find(W + 'vertAlign')
            if va is not None and va.get(W + 'val') in ('superscript', 'subscript'):
                tags.append('sup' if va.get(W + 'val') == 'superscript' else 'sub')
            col = rpr.find(W + 'color')
            if col is not None and re.fullmatch(r'[0-9A-Fa-f]{6}', col.get(W + 'val', '')):
                style.append('color:#' + col.get(W + 'val'))
            sz = rpr.find(W + 'sz')
            if sz is not None and (sz.get(W + 'val') or '').isdigit():
                pt = int(sz.get(W + 'val')) / 2
                if 6 <= pt <= 60:
                    style.append('font-size:%gpt' % pt)
            hl = rpr.find(W + 'highlight')
            if hl is not None and re.fullmatch(r'[a-zA-Z]+', hl.get(W + 'val', '')) and hl.get(W + 'val') != 'none':
                style.append('background:' + hl.get(W + 'val'))
        for ch in r:
            if ch.tag == W + 't':
                out.append(html.escape(ch.text or ''))
            elif ch.tag == W + 'tab':
                out.append('&emsp;')
            elif ch.tag in (W + 'br', W + 'cr'):
                out.append('<hr class="pb">' if ch.get(W + 'type') == 'page' else '<br>')
            elif ch.tag == W + 'drawing':
                for blip in ch.iter(A + 'blip'):
                    out.append(self.image(blip))
        text = ''.join(out)
        if not text:
            return ''
        for t in tags:
            text = '<%s>%s</%s>' % (t, text, t)
        return '<span style="%s">%s</span>' % (';'.join(style), text) if style else text

    def inline(self, el):
        parts = []
        for ch in el:
            if ch.tag == W + 'r':
                parts.append(self.run(ch))
            elif ch.tag in (W + 'hyperlink', W + 'ins', W + 'smartTag', W + 'sdt', W + 'sdtContent', W + 'fldSimple'):
                parts.append(self.inline(ch))
        return ''.join(parts)

    # -- paragraphs and tables
    def paragraph(self, p):
        ppr = p.find(W + 'pPr')
        content = self.inline(p)
        align = indent = level = None
        num = None
        if ppr is not None:
            jc = ppr.find(W + 'jc')
            if jc is not None:
                align = {'center': 'center', 'right': 'right', 'both': 'justify', 'end': 'right'}.get(jc.get(W + 'val'))
            ind = ppr.find(W + 'ind')
            left = (ind.get(W + 'left') or ind.get(W + 'start') or '') if ind is not None else ''
            if left.lstrip('-').isdigit():
                indent = max(0, min(int(left) // 15, 300))        # twips -> px
            st = ppr.find(W + 'pStyle')
            if st is not None:
                level = self.headings.get(st.get(W + 'val'))
            np_ = ppr.find(W + 'numPr')
            if np_ is not None and np_.find(W + 'numId') is not None:
                num = (np_.find(W + 'numId').get(W + 'val'),
                       int((np_.find(W + 'ilvl').get(W + 'val') if np_.find(W + 'ilvl') is not None else '0') or 0))
        css = []
        if align: css.append('text-align:' + align)
        if indent and not num: css.append('margin-left:%dpx' % indent)
        style = ' style="%s"' % ';'.join(css) if css else ''
        if num and num[0] != '0':
            fmts = self.numbering.get(num[0], {})
            fmt = fmts.get(num[1], 'bullet')
            if fmt == 'bullet' or fmt == 'none':
                mark = '•' if num[1] == 0 else '◦'
            else:
                key = (num[0], num[1])
                self.counters[key] = self.counters.get(key, 0) + 1
                for k in [k for k in self.counters if k[0] == num[0] and k[1] > num[1]]:
                    del self.counters[k]
                n = self.counters[key]
                mark = (chr(96 + n) if fmt == 'lowerLetter' and n <= 26 else
                        chr(64 + n) if fmt == 'upperLetter' and n <= 26 else str(n)) + '.'
            return '<div class="li" style="margin-left:%dpx"><span class="mk">%s</span><span class="tx"%s>%s</span></div>' % (
                max(indent or 0, 24 + num[1] * 22) - 24, mark, style, content or '&nbsp;')
        if level:
            return '<h%d%s>%s</h%d>' % (level, style, content, level)
        return '<p%s>%s</p>' % (style, content or '&nbsp;')

    def table(self, tbl):
        rows = []
        for tr in tbl.findall(W + 'tr'):
            cells = []
            for tc in tr.findall(W + 'tc'):
                tcpr = tc.find(W + 'tcPr')
                span = tcpr.find(W + 'gridSpan') if tcpr is not None else None
                colspan = ' colspan="%s"' % span.get(W + 'val') if span is not None and (span.get(W + 'val') or '').isdigit() else ''
                cells.append('<td%s>%s</td>' % (colspan, self.block(tc) or '&nbsp;'))
            rows.append('<tr>%s</tr>' % ''.join(cells))
        return '<table>%s</table>' % ''.join(rows)

    def block(self, parent):
        out = []
        for ch in parent:
            if ch.tag == W + 'p':
                out.append(self.paragraph(ch))
            elif ch.tag == W + 'tbl':
                out.append(self.table(ch))
            elif ch.tag in (W + 'sdt', W + 'sdtContent', W + 'ins'):
                out.append(self.block(ch))
        return ''.join(out)


def docx_to_html(data):
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise PreviewError('This is not a valid .docx file.')
    root = _parse_xml(_read_part(zf, 'word/document.xml'))
    body = root.find(W + 'body') if root is not None else None
    if body is None:
        raise PreviewError('This Word file has no readable content.')
    d = _Docx(zf)
    return _wrap(d.block(body) or '<p><em>This document is empty.</em></p>')


# ----------------------------------------------------------------------------- .doc (binary)

_END = 0xFFFFFFFE
_FREE = 0xFFFFFFFF


def _ole_streams(data):
    """Return {stream name: bytes} for an OLE2 compound file."""
    if data[:8] != b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1':
        raise PreviewError('This is not a Word 97-2003 document.')
    sector = 1 << struct.unpack_from('<H', data, 0x1E)[0]
    mini = 1 << struct.unpack_from('<H', data, 0x20)[0]
    n_fat, first_dir, cutoff, first_mfat, n_mfat, first_difat, n_difat = (
        struct.unpack_from('<I', data, 0x2C)[0], struct.unpack_from('<I', data, 0x30)[0],
        struct.unpack_from('<I', data, 0x38)[0], struct.unpack_from('<I', data, 0x3C)[0],
        struct.unpack_from('<I', data, 0x40)[0], struct.unpack_from('<I', data, 0x44)[0],
        struct.unpack_from('<I', data, 0x48)[0])

    def sec(i):
        off = (i + 1) * sector
        return data[off:off + sector]

    fat_ids = list(struct.unpack_from('<109I', data, 0x4C))
    nxt, guard = first_difat, 0
    while n_difat and nxt < _END and guard < 5000:
        block = struct.unpack('<%dI' % (sector // 4), sec(nxt))
        fat_ids += block[:-1]
        nxt, guard = block[-1], guard + 1
    fat = []
    for i in fat_ids[:n_fat]:
        if i >= _END:
            break
        fat += struct.unpack('<%dI' % (sector // 4), sec(i))

    def chain(start, table):
        out, seen = [], set()
        while start < _END and start not in seen and start < len(table):
            seen.add(start)
            out.append(start)
            start = table[start]
        return out

    def read_fat(start, size=None):
        buf = b''.join(sec(i) for i in chain(start, fat))
        return buf if size is None else buf[:size]

    directory = read_fat(first_dir)
    entries = []
    for off in range(0, len(directory) - 127, 128):
        e = directory[off:off + 128]
        name_len = struct.unpack_from('<H', e, 0x40)[0]
        name = e[:max(0, name_len - 2)].decode('utf-16le', 'ignore')
        entries.append((name, e[0x42], struct.unpack_from('<I', e, 0x74)[0], struct.unpack_from('<I', e, 0x78)[0]))
    root = next((e for e in entries if e[1] == 5), None)
    ministream, mfat = b'', []
    if root:
        ministream = read_fat(root[2], root[3])
        mraw = read_fat(first_mfat) if n_mfat else b''
        mfat = list(struct.unpack('<%dI' % (len(mraw) // 4), mraw[:len(mraw) // 4 * 4]))
    out = {}
    for name, typ, start, size in entries:
        if typ != 2 or name in out:
            continue
        if size < cutoff:
            out[name] = b''.join(ministream[i * mini:(i + 1) * mini] for i in chain(start, mfat))[:size]
        else:
            out[name] = read_fat(start, size)
    return out


import bisect

# Word's 16 legacy colour indexes (sprmCIco / sprmCHighlight)
_ICO = [None, '#000000', '#0000ff', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#ffff00', '#ffffff',
        '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0']

MAX_DOC_CHARS = 400_000


def _sprms(grp):
    """A property list ("grpprl") -> [(opcode, operand bytes)]."""
    out, i, n = [], 0, len(grp)
    while i + 2 <= n:
        op = struct.unpack_from('<H', grp, i)[0]
        i += 2
        spra = op >> 13
        if spra in (0, 1):
            size = 1
        elif spra in (2, 4, 5):
            size = 2
        elif spra == 3:
            size = 4
        elif spra == 7:
            size = 3
        else:                                                    # 6: variable
            if i >= n:
                break
            if op == 0xD608:                                     # table definition: 2-byte length
                if i + 2 > n:
                    break
                size = struct.unpack_from('<H', grp, i)[0] + 1
            else:
                size = grp[i] + 1
        out.append((op, grp[i:i + size]))
        i += size
    return out


def _toggle(current, operand):
    v = operand[0] if operand else 0
    if v == 0x80:
        return current
    if v == 0x81:
        return not current
    return bool(v & 1)


def _apply_char(props, grp):
    for op, a in _sprms(grp):
        try:
            if op == 0x0835: props['b'] = _toggle(props.get('b', False), a)
            elif op == 0x0836: props['i'] = _toggle(props.get('i', False), a)
            elif op == 0x0837: props['s'] = _toggle(props.get('s', False), a)
            elif op == 0x083C: props['hidden'] = _toggle(props.get('hidden', False), a)
            elif op == 0x2A3E: props['u'] = a[0] != 0
            elif op == 0x4A43: props['size'] = struct.unpack('<H', a[:2])[0] / 2
            elif op == 0x2A48: props['vert'] = {1: 'sup', 2: 'sub'}.get(a[0])
            elif op == 0x2A42: props['color'] = _ICO[a[0]] if 0 < a[0] < len(_ICO) else None
            elif op == 0x6870: props['color'] = ('#%02x%02x%02x' % tuple(a[:3])) if a[3] == 0 else props.get('color')
            elif op == 0x2A0C: props['bg'] = _ICO[a[0]] if 0 < a[0] < len(_ICO) else None
            elif op == 0x0855: props['spec'] = bool(a[0] & 1)
            elif op == 0x6A03: props['pic'] = struct.unpack('<I', a[:4])[0]
            elif op == 0x4A30: props['cstyle'] = struct.unpack('<H', a[:2])[0]
        except (struct.error, IndexError):
            continue
    return props


def _apply_para(props, grp):
    for op, a in _sprms(grp):
        try:
            if op in (0x2461, 0x2403): props['jc'] = {0: None, 1: 'center', 2: 'right', 3: 'justify'}.get(a[0])
            elif op in (0x845E, 0x840F): props['left'] = struct.unpack('<h', a[:2])[0]
            elif op in (0x8460, 0x8411): props['first'] = struct.unpack('<h', a[:2])[0]
            elif op in (0x845D, 0x840E): props['right'] = struct.unpack('<h', a[:2])[0]
            elif op == 0xA413: props['before'] = struct.unpack('<H', a[:2])[0]
            elif op == 0xA414: props['after'] = struct.unpack('<H', a[:2])[0]
            elif op == 0x2416: props['intable'] = bool(a[0] & 1)
            elif op == 0x2417: props['ttp'] = bool(a[0] & 1)
            elif op == 0x460B: props['ilfo'] = struct.unpack('<H', a[:2])[0]
            elif op == 0x260A: props['ilvl'] = a[0]
            elif op == 0x4600: props['istd'] = struct.unpack('<H', a[:2])[0]
        except (struct.error, IndexError):
            continue
    return props


class _Doc:
    """Enough of the Word 97-2003 binary format to rebuild how a page looks."""

    def __init__(self, data):
        self.streams = _ole_streams(data)
        wd = self.streams.get('WordDocument')
        if not wd or len(wd) < 0x01AA or struct.unpack_from('<H', wd, 0)[0] != 0xA5EC:
            raise PreviewError('This is not a Word 97-2003 document.')
        flags = struct.unpack_from('<H', wd, 0x0A)[0]
        if flags & 0x0100:
            raise PreviewError('This document is encrypted.')
        self.wd = wd
        self.table = self.streams.get('1Table' if flags & 0x0200 else '0Table')
        self.data = self.streams.get('Data', b'')
        if not self.table:
            raise PreviewError('This Word file cannot be previewed.')
        self.ccp_text = struct.unpack_from('<I', wd, 0x4C)[0]
        self._pieces()
        self.chpx = self._fkps(0x00FA, chpx=True)
        self.papx = self._fkps(0x0102, chpx=False)
        self.styles = self._stsh()

    def fib(self, off):
        return struct.unpack_from('<II', self.wd, off)

    # -- text and where it sits in the file
    def _pieces(self):
        fc, lcb = self.fib(0x01A2)
        if not lcb or fc + lcb > len(self.table):
            raise PreviewError('This Word file cannot be previewed.')
        clx = self.table[fc:fc + lcb]
        i = 0
        while i < len(clx) and clx[i] == 1:
            i += 3 + struct.unpack_from('<H', clx, i + 1)[0]
        if i >= len(clx) or clx[i] != 2:
            raise PreviewError('This Word file cannot be previewed.')
        plc = clx[i + 5:i + 5 + struct.unpack_from('<I', clx, i + 1)[0]]
        n = (len(plc) - 4) // 12
        cps = struct.unpack_from('<%dI' % (n + 1), plc, 0)
        self.piece_cp, self.piece_fc, self.piece_comp, parts = [], [], [], []
        total = 0
        limit = min(self.ccp_text, MAX_DOC_CHARS)
        for k in range(n):
            raw = struct.unpack_from('<I', plc, 4 * (n + 1) + 8 * k + 2)[0]
            count = cps[k + 1] - cps[k]
            if count <= 0 or cps[k] >= limit:
                continue
            count = min(count, limit - cps[k])
            comp = bool(raw & 0x40000000)
            base = (raw & 0x3FFFFFFF) // 2 if comp else raw
            self.piece_cp.append(cps[k]); self.piece_fc.append(base); self.piece_comp.append(comp)
            chunk = (self.wd[base:base + count].decode('cp1252', 'replace') if comp
                     else self.wd[base:base + count * 2].decode('utf-16le', 'replace'))
            parts.append(chunk.ljust(count, ' ')[:count])
            total += count
        self.text = ''.join(parts)

    def fc(self, cp):
        k = bisect.bisect_right(self.piece_cp, cp) - 1
        return self.piece_fc[k] + (cp - self.piece_cp[k]) * (1 if self.piece_comp[k] else 2)

    # -- formatting tables (character and paragraph "formatted disk pages")
    def _fkps(self, off, chpx):
        fc, lcb = self.fib(off)
        out = []
        if not lcb or fc + lcb > len(self.table):
            return ([], [], [])
        n = (lcb - 4) // 8
        fcs = struct.unpack_from('<%dI' % (n + 1), self.table, fc)
        for k in range(n):
            pn = struct.unpack_from('<I', self.table, fc + 4 * (n + 1) + 4 * k)[0] & 0x3FFFFF
            page = self.wd[pn * 512:pn * 512 + 512]
            if len(page) < 512:
                continue
            cnt = page[511]
            starts = struct.unpack_from('<%dI' % (cnt + 1), page, 0)
            for j in range(cnt):
                if chpx:
                    o = page[4 * (cnt + 1) + j] * 2
                    grp = b''
                    if o:
                        ln = page[o]
                        grp = page[o + 1:o + 1 + ln]
                    out.append((starts[j], starts[j + 1], grp, 0))
                else:
                    o = page[4 * (cnt + 1) + 13 * j] * 2
                    grp, istd = b'', 0
                    if o:
                        ln = page[o]
                        if ln == 0:
                            ln2 = page[o + 1]
                            body = page[o + 2:o + 2 + 2 * ln2]
                        else:
                            body = page[o + 1:o + 1 + 2 * ln - 1]
                        if len(body) >= 2:
                            istd = struct.unpack_from('<H', body, 0)[0]
                            grp = body[2:]
                    out.append((starts[j], starts[j + 1], grp, istd))
        out.sort(key=lambda e: e[0])
        return ([e[0] for e in out], [e[1] for e in out], out)

    @staticmethod
    def _find(tbl, fc):
        starts, ends, rows = tbl
        k = bisect.bisect_right(starts, fc) - 1
        if k >= 0 and fc < ends[k]:
            return k, rows[k]
        return -1, None

    # -- styles
    def _stsh(self):
        fc, lcb = self.fib(0x00A2)
        styles = {}
        if not lcb or fc + lcb > len(self.table):
            return styles
        t = self.table
        cb_stshi = struct.unpack_from('<H', t, fc)[0]
        cstd, cb_base = struct.unpack_from('<HH', t, fc + 2)
        pos = fc + 2 + cb_stshi
        for istd in range(cstd):
            if pos + 2 > fc + lcb:
                break
            cb = struct.unpack_from('<H', t, pos)[0]
            body = t[pos + 2:pos + 2 + cb]
            pos += 2 + cb
            if cb < 10 or not cb:
                continue
            w2, w3 = struct.unpack_from('<HH', body, 2)[0], struct.unpack_from('<H', body, 4)[0]
            kind, base, cupx = w2 & 0xF, (w2 >> 4) & 0xFFF, w3 & 0xF
            o = cb_base
            nlen = struct.unpack_from('<H', body, o)[0] if o + 2 <= len(body) else 0
            name = body[o + 2:o + 2 + 2 * nlen].decode('utf-16le', 'ignore')
            o += 2 + 2 * nlen + 2
            if o & 1:
                o += 1
            upx = []
            for _ in range(cupx):
                if o + 2 > len(body):
                    break
                ln = struct.unpack_from('<H', body, o)[0]
                upx.append(body[o + 2:o + 2 + ln])
                o += 2 + ln
                if o & 1:
                    o += 1
            papx = chpx = b''
            if kind == 1:
                papx = upx[0][2:] if upx and len(upx[0]) >= 2 else b''
                chpx = upx[1] if len(upx) > 1 else b''
            elif kind == 2:
                chpx = upx[0] if upx else b''
            styles[istd] = {'name': name, 'kind': kind, 'base': base if base != 0xFFF else None, 'papx': papx, 'chpx': chpx}
        return styles

    def style_char(self, istd, depth=0):
        st = self.styles.get(istd)
        if not st or depth > 12:
            return {}
        props = self.style_char(st['base'], depth + 1) if st['base'] is not None else {}
        return _apply_char(dict(props), st['chpx'])

    def style_para(self, istd, depth=0):
        st = self.styles.get(istd)
        if not st or depth > 12:
            return {}
        props = self.style_para(st['base'], depth + 1) if st['base'] is not None else {}
        return _apply_para(dict(props), st['papx'])

    # -- pictures
    def picture(self, offset):
        d = self.data
        if offset + 68 > len(d):
            return ''
        lcb, cb_header = struct.unpack_from('<IH', d, offset)
        end = min(offset + lcb, len(d))
        mm = struct.unpack_from('<H', d, offset + 6)[0]
        if cb_header != 68 or mm not in (0x64, 0x66) or lcb < cb_header:   # not a picture record: show nothing
            return ''
        dxa, dya, mx, my = struct.unpack_from('<hhHH', d, offset + 28)
        pos = offset + cb_header
        if mm == 0x66 and pos < end:
            pos += 1 + d[pos]
        blip = self._find_blip(d, pos, end, 0)
        if not blip:
            return ''
        mime, raw = blip
        if len(raw) > 6 * 1024 * 1024:
            return '<span style="color:#888">[large picture]</span>'
        size = ''
        if dxa > 0 and mx:
            size = ' width="%d"' % max(8, min(int(dxa * mx / 1000 / 15), 2000))
        return '<img alt=""%s src="data:%s;base64,%s">' % (size, mime, base64.b64encode(raw).decode())

    def _find_blip(self, d, pos, end, depth):
        while pos + 8 <= end and depth < 6:
            vi, rtype, ln = struct.unpack_from('<HHI', d, pos)
            ver, inst = vi & 0xF, vi >> 4
            body = pos + 8
            if rtype == 0xF007 and body + 36 <= end:               # a picture-store entry wraps the picture
                found = self._find_blip(d, body + 36 + d[body + 33], min(body + ln, end), depth + 1)
                if found:
                    return found
            elif ver == 0xF:                                       # a container
                found = self._find_blip(d, body, min(body + ln, end), depth + 1)
                if found:
                    return found
            elif rtype in (0xF01D, 0xF02A, 0xF01E, 0xF01F):
                two = inst in (0x46B, 0x6E3, 0x6E1, 0x7A9)
                start = body + (32 if two else 16) + 1
                raw = d[start:body + ln]
                if rtype in (0xF01D, 0xF02A):
                    return 'image/jpeg', raw
                if rtype == 0xF01E:
                    return 'image/png', raw
                if len(raw) > 40:                                  # DIB -> BMP
                    bi = struct.unpack_from('<I', raw, 0)[0]
                    bits, used = struct.unpack_from('<H', raw, 14)[0], struct.unpack_from('<I', raw, 32)[0]
                    pal = (used or (1 << bits)) * 4 if bits <= 8 else 0
                    return 'image/bmp', b'BM' + struct.pack('<IHHI', 14 + len(raw), 0, 0, 14 + bi + pal) + raw
            pos = body + ln
        return None


def doc_to_html(data):
    doc = _Doc(data)
    text = doc.text
    out = []                                  # finished blocks
    table = []                                # rows of cells of block html, while inside a table
    row, cell = [], []
    field = []                                # 'code' / 'result', for nested fields
    state = {'pics': 0}

    def flush_table():
        nonlocal table, row, cell
        if row or cell:
            row.append(''.join(cell)); cell = []
            table.append(row); row = []
        if table:
            out.append('<table>%s</table>' % ''.join(
                '<tr>%s</tr>' % ''.join('<td>%s</td>' % (c or '&nbsp;') for c in r) for r in table))
        table = []

    def runs_html(cp_a, cp_b, pstyle):
        base = doc.style_char(pstyle)
        parts, cp = [], cp_a
        while cp < cp_b:
            fc = doc.fc(cp)
            k, entry = doc._find(doc.chpx, fc)
            # this run lasts until the next character-format boundary
            run_end_fc = entry[1] if entry else fc + 1
            stop = cp + 1
            comp = doc.piece_comp[bisect.bisect_right(doc.piece_cp, cp) - 1]
            step = 1 if comp else 2
            while stop < cp_b and doc.fc(stop) < run_end_fc and (doc.fc(stop) - doc.fc(stop - 1)) == step:
                stop += 1
            props = dict(base)
            if entry:
                _apply_char(props, entry[2])
                if props.get('cstyle') in doc.styles:
                    cp_props = dict(doc.style_char(props['cstyle']))
                    cp_props.update({k2: v for k2, v in props.items() if k2 != 'cstyle'})
                    props = _apply_char(cp_props, entry[2])
            seg = []
            for ch in text[cp:stop]:
                if ch == '\x13':
                    field.append('code'); continue
                if ch == '\x14':
                    if field: field[-1] = 'result'
                    continue
                if ch == '\x15':
                    if field: field.pop()
                    continue
                if 'code' in field or props.get('hidden'):
                    continue
                if ch == '\x01' and props.get('spec') and props.get('pic') is not None and state['pics'] < 40:
                    state['pics'] += 1
                    seg.append(doc.picture(props['pic']))
                elif ch == '\t':
                    seg.append('&emsp;')
                elif ch == '\x0b':
                    seg.append('<br>')
                elif ch == '\x0c':
                    seg.append('<hr class="pb">')
                elif ch in '\x1e':
                    seg.append('-')
                elif ch >= ' ' or ch == '\xa0':
                    seg.append(html.escape(ch))
            cp = stop
            inner = ''.join(seg)
            if not inner:
                continue
            if '<img' not in inner:
                if props.get('b'): inner = '<b>%s</b>' % inner
                if props.get('i'): inner = '<i>%s</i>' % inner
                if props.get('u'): inner = '<u>%s</u>' % inner
                if props.get('s'): inner = '<s>%s</s>' % inner
                if props.get('vert'): inner = '<%s>%s</%s>' % (props['vert'], inner, props['vert'])
                css = []
                if props.get('color') and props['color'] != '#000000': css.append('color:' + props['color'])
                if props.get('bg'): css.append('background:' + props['bg'])
                if props.get('size') and 5 <= props['size'] <= 72: css.append('font-size:%gpt' % props['size'])
                if css:
                    inner = '<span style="%s">%s</span>' % (';'.join(css), inner)
            parts.append(inner)
        return ''.join(parts)

    pos, n = 0, len(text)
    while pos < n:
        m = re.compile(r'[\r\x07]').search(text, pos)
        end = m.end() if m else n               # one past the paragraph mark
        mark = text[end - 1] if m else ''
        cp_last = end - 1
        k, pe = doc._find(doc.papx, doc.fc(cp_last))
        istd = pe[3] if pe else 0
        props = dict(doc.style_para(istd))
        if pe:
            _apply_para(props, pe[2])
        body_end = end - 1 if m else end
        content = runs_html(pos, body_end, istd)
        pos = end
        style_name = (doc.styles.get(istd) or {}).get('name', '').lower()
        in_table = bool(props.get('intable') or props.get('ttp'))
        if in_table:
            if props.get('ttp'):                                    # the end-of-row mark
                if cell:
                    row.append(''.join(cell)); cell = []
                table.append(row); row = []
                continue
            cell.append('<p>%s</p>' % (content or '&nbsp;'))
            if mark == '\x07':
                row.append(''.join(cell)); cell = []
            continue
        if table or row or cell:
            flush_table()
        css = []
        if props.get('jc'): css.append('text-align:' + props['jc'])
        left = props.get('left') or 0
        if left > 0: css.append('margin-left:%dpx' % min(left // 15, 400))
        first = props.get('first') or 0
        if first: css.append('text-indent:%dpx' % max(-200, min(first // 15, 200)))
        if props.get('after') is not None: css.append('margin-bottom:%dpx' % min(props['after'] // 15, 60))
        if props.get('before'): css.append('margin-top:%dpx' % min(props['before'] // 15, 60))
        st = ' style="%s"' % ';'.join(css) if css else ''
        if props.get('ilfo') and content.strip():
            first_px = (props.get('first') or 0) // 15
            mark_w = -first_px if first_px < 0 else 18
            box = max(0, min((props.get('left') or 0) // 15 + min(first_px, 0), 400))
            tx_css = [c for c in css if not c.startswith(('margin-left', 'text-indent'))]
            out.append('<div class="li" style="margin-left:%dpx"><span class="mk" style="width:%dpx;text-align:left">•</span>'
                       '<span class="tx"%s>%s</span></div>' % (box, max(mark_w, 12), ' style="%s"' % ';'.join(tx_css) if tx_css else '', content))
            continue
        h = re.match(r'heading (\d)', style_name)
        tag = 'h%d' % min(int(h.group(1)), 4) if h else ('h1' if style_name == 'title' else 'p')
        out.append('<%s%s>%s</%s>' % (tag, st, content or '&nbsp;', tag))
    flush_table()
    body = ''.join(out)
    return _wrap(body or '<p><em>This document is empty.</em></p>')


def word_to_html(data, mime='', file_name=''):
    name = (file_name or '').lower()
    if data[:2] == b'PK' or name.endswith('.docx') or 'wordprocessingml' in (mime or ''):
        return docx_to_html(data)
    return doc_to_html(data)
