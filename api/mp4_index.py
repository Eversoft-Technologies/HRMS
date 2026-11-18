"""
Pure-Python indexing of MP4 interview recordings - no FFmpeg required.

Chrome's MediaRecorder writes a *fragmented* MP4: a ``moov`` with no sample
tables (just ``mvex`` defaults) followed by many ``moof``/``mdat`` pairs. It
plays, but the ``<video>`` element has no index, so it must read the whole
file to learn the duration or to seek: the "Buffering..." the recruiter sees
when pressing play, and again on every seek.

``defragment_mp4`` rewrites such a file as a plain MP4 - ``ftyp``, one
``moov`` carrying real sample tables (stts/stsc/stsz/co64/stss/ctts), then one
``mdat`` with the media bytes in their original order. Nothing is decoded or
re-encoded; it is bookkeeping on the container, so it takes about as long as
copying the file. ``faststart_mp4`` handles the other unindexed shape, a
flat MP4 whose ``moov`` sits after the media.

Used by ``video_processor.index_video`` when FFmpeg is absent (the usual
case on shared hosting) and by ``manage.py index_recordings``.
"""
import os
import shutil
import struct
from pathlib import Path

CONTAINERS = {b'moov', b'trak', b'mdia', b'minf', b'stbl', b'edts', b'mvex', b'udta', b'moof', b'traf'}
COPY_CHUNK = 1024 * 1024


class Mp4IndexError(Exception):
    """The file is not an MP4 this module can index."""


# ── low-level box helpers ──────────────────────────────────────────────────

def _u32(b, o):
    return struct.unpack_from('>I', b, o)[0]


def _u64(b, o):
    return struct.unpack_from('>Q', b, o)[0]


def _box(typ, payload):
    return struct.pack('>I', 8 + len(payload)) + typ + payload


def _fullbox(typ, version, flags, payload):
    return _box(typ, bytes([version]) + flags.to_bytes(3, 'big') + payload)


def iter_boxes(data, start=0, end=None):
    """Yield (type, payload_start, box_end) for the boxes in data[start:end]."""
    end = len(data) if end is None else end
    i = start
    while i + 8 <= end:
        size = _u32(data, i)
        typ = data[i + 4:i + 8]
        hdr = 8
        if size == 1:
            if i + 16 > end:
                break
            size = _u64(data, i + 8)
            hdr = 16
        elif size == 0:
            size = end - i
        if size < hdr:
            raise Mp4IndexError(f'corrupt {typ!r} box')
        yield typ, i + hdr, min(i + size, end)
        i += size


def scan_top_level(f, file_size):
    """[(type, box_start, header_len, box_size)] for the file's top-level boxes."""
    out, pos = [], 0
    while pos + 8 <= file_size:
        f.seek(pos)
        hdr = f.read(16)
        if len(hdr) < 8:
            break
        size, typ, hlen = _u32(hdr, 0), hdr[4:8], 8
        if size == 1:
            if len(hdr) < 16:
                break
            size, hlen = _u64(hdr, 8), 16
        elif size == 0:
            size = file_size - pos
        if size < hlen or not typ.isalnum() and typ not in (b'url ', b'uuid'):
            raise Mp4IndexError(f'corrupt top-level {typ!r} box')
        if pos + size > file_size:
            raise Mp4IndexError(f'{typ.decode("ascii", "replace")} box runs past the end of the file (truncated upload)')
        out.append((typ, pos, hlen, size))
        pos += size
    return out


def _find(data, typ, start=0, end=None):
    for t, ps, pe in iter_boxes(data, start, end):
        if t == typ:
            return ps, pe
    return None


# ── box tree (for rewriting moov) ──────────────────────────────────────────

class Node:
    __slots__ = ('typ', 'payload', 'children')

    def __init__(self, typ, payload=b'', children=None):
        self.typ = typ
        self.payload = payload          # leaf bytes (after the 8/16-byte header)
        self.children = children        # list[Node] for containers, else None

    def child(self, typ):
        for c in self.children or ():
            if c.typ == typ:
                return c
        return None

    def serialize(self):
        if self.children is None:
            return _box(self.typ, self.payload)
        return _box(self.typ, b''.join(c.serialize() for c in self.children))


def parse_tree(data, typ, start, end):
    if typ in CONTAINERS:
        return Node(typ, children=[parse_tree(data, t, ps, pe) for t, ps, pe in iter_boxes(data, start, end)])
    return Node(typ, payload=bytes(data[start:end]))


# ── reading the fragmented input ───────────────────────────────────────────

def _mvhd_info(mvhd):
    v = mvhd[0]
    return {'timescale': _u32(mvhd, 12 if v == 0 else 20)}


def _mdhd_info(mdhd):
    v = mdhd[0]
    return {'timescale': _u32(mdhd, 12 if v == 0 else 20)}


def _tkhd_id(tkhd):
    v = tkhd[0]
    return _u32(tkhd, 12 if v == 0 else 20)


def _parse_trex(mvex_node):
    defaults = {}
    for c in mvex_node.children or ():
        if c.typ == b'trex':
            p = c.payload
            defaults[_u32(p, 4)] = {'sdi': _u32(p, 8), 'dur': _u32(p, 12), 'size': _u32(p, 16), 'flags': _u32(p, 20)}
    return defaults


class _Track:
    def __init__(self, node, trex):
        self.node = node
        self.track_id = _tkhd_id(node.child(b'tkhd').payload)
        mdia = node.child(b'mdia')
        self.timescale = _mdhd_info(mdia.child(b'mdhd').payload)['timescale']
        hdlr = mdia.child(b'hdlr')
        self.handler = hdlr.payload[8:12] if hdlr else b''
        self.trex = trex.get(self.track_id, {'sdi': 1, 'dur': 0, 'size': 0, 'flags': 0})
        self.sizes, self.durs, self.ctos, self.sync = [], [], [], []
        self.chunks = []                 # (abs_offset_in_src, sample_count, byte_count)
        self.first_dts = None
        self.next_dts = 0


def _parse_moof(data, moof_pos, tracks_by_id):
    """Append the samples described by one moof (bytes) to the tracks."""
    traf_base_default = moof_pos            # for trafs without default-base-is-moof
    for ttyp, tps, tpe in iter_boxes(data, 8, len(data)):
        if ttyp != b'traf':
            continue
        tfhd = _find(data, b'tfhd', tps, tpe)
        if not tfhd:
            raise Mp4IndexError('traf without tfhd')
        p = tfhd[0]
        flags = int.from_bytes(data[p + 1:p + 4], 'big')
        track_id = _u32(data, p + 4)
        q = p + 8
        base = None
        if flags & 0x01:
            base = _u64(data, q)
            q += 8
        if flags & 0x02:
            q += 4
        d_dur = d_size = d_flags = None
        if flags & 0x08:
            d_dur = _u32(data, q)
            q += 4
        if flags & 0x10:
            d_size = _u32(data, q)
            q += 4
        if flags & 0x20:
            d_flags = _u32(data, q)
            q += 4
        track = tracks_by_id.get(track_id)
        if track is None:
            continue
        if base is None:
            base = moof_pos if flags & 0x20000 else traf_base_default
        if d_dur is None:
            d_dur = track.trex['dur']
        if d_size is None:
            d_size = track.trex['size']
        if d_flags is None:
            d_flags = track.trex['flags']

        tfdt = _find(data, b'tfdt', tps, tpe)
        if tfdt:
            v = data[tfdt[0]]
            dts = _u64(data, tfdt[0] + 4) if v == 1 else _u32(data, tfdt[0] + 4)
            if track.first_dts is None:
                track.first_dts = dts
            track.next_dts = dts
        elif track.first_dts is None:
            track.first_dts = 0

        run_offset = base
        for rtyp, rps, rpe in iter_boxes(data, tps, tpe):
            if rtyp != b'trun':
                continue
            v = data[rps]
            rflags = int.from_bytes(data[rps + 1:rps + 4], 'big')
            count = _u32(data, rps + 4)
            r = rps + 8
            if rflags & 0x01:
                data_offset = struct.unpack_from('>i', data, r)[0]
                r += 4
                run_offset = base + data_offset
            first_flags = None
            if rflags & 0x04:
                first_flags = _u32(data, r)
                r += 4
            byte_count = 0
            for i in range(count):
                dur, size, sflags, cto = d_dur, d_size, d_flags, 0
                if rflags & 0x100:
                    dur = _u32(data, r)
                    r += 4
                if rflags & 0x200:
                    size = _u32(data, r)
                    r += 4
                if rflags & 0x400:
                    sflags = _u32(data, r)
                    r += 4
                if rflags & 0x800:
                    cto = struct.unpack_from('>i' if v else '>I', data, r)[0]
                    r += 4
                if i == 0 and first_flags is not None:
                    sflags = first_flags
                track.sizes.append(size)
                track.durs.append(dur)
                track.ctos.append(cto)
                track.sync.append(not (sflags & 0x10000))
                byte_count += size
            if count:
                track.chunks.append((run_offset, count, byte_count))
            run_offset += byte_count
            track.next_dts += sum(track.durs[-count:]) if count else 0
        traf_base_default = run_offset


# ── building the flat output ───────────────────────────────────────────────

def _runs(values):
    out = []
    for val in values:
        if out and out[-1][1] == val:
            out[-1][0] += 1
        else:
            out.append([1, val])
    return out


def _build_stbl(old_stbl, track, chunk_offsets):
    stsd = old_stbl.child(b'stsd')
    if stsd is None:
        raise Mp4IndexError('track without stsd')
    children = [stsd]

    stts = _runs(track.durs)
    children.append(Node(b'stts', _fullbox(b'stts', 0, 0, struct.pack('>I', len(stts)) + b''.join(
        struct.pack('>II', n, d) for n, d in stts))[8:]))

    if any(track.ctos):
        ctts = _runs(track.ctos)
        signed = any(c < 0 for c in track.ctos)
        fmt = '>Ii' if signed else '>II'
        children.append(Node(b'ctts', _fullbox(b'ctts', 1 if signed else 0, 0, struct.pack('>I', len(ctts)) + b''.join(
            struct.pack(fmt, n, c) for n, c in ctts))[8:]))

    if track.handler == b'vide' and not all(track.sync) and any(track.sync):
        syncs = [i + 1 for i, s in enumerate(track.sync) if s]
        children.append(Node(b'stss', _fullbox(b'stss', 0, 0, struct.pack('>I', len(syncs)) + b''.join(
            struct.pack('>I', s) for s in syncs))[8:]))

    # one chunk per trun; stsc compresses equal consecutive samples-per-chunk
    stsc = []
    for idx, (_, count, _) in enumerate(track.chunks, start=1):
        if not stsc or stsc[-1][1] != count:
            stsc.append((idx, count))
    children.append(Node(b'stsc', _fullbox(b'stsc', 0, 0, struct.pack('>I', len(stsc)) + b''.join(
        struct.pack('>III', first, count, 1) for first, count in stsc))[8:]))

    children.append(Node(b'stsz', _fullbox(b'stsz', 0, 0, struct.pack('>II', 0, len(track.sizes)) + b''.join(
        struct.pack('>I', s) for s in track.sizes))[8:]))

    children.append(Node(b'co64', _fullbox(b'co64', 0, 0, struct.pack('>I', len(chunk_offsets)) + b''.join(
        struct.pack('>Q', o) for o in chunk_offsets))[8:]))
    return Node(b'stbl', children=children)


def _patch_u32(payload, offset, value):
    if value > 0xFFFFFFFF:
        raise Mp4IndexError('duration does not fit a 32-bit field')
    return payload[:offset] + struct.pack('>I', value) + payload[offset + 4:]


def _rebuild_moov(moov, tracks, movie_ts, offsets_by_track):
    """New moov Node: mvex gone, durations set, sample tables rebuilt."""
    kept = []
    movie_dur = 0
    for t in tracks:
        total = sum(t.durs)
        delay = t.first_dts or 0
        movie_dur = max(movie_dur, (delay + total) * movie_ts // t.timescale)
    for c in moov.children:
        if c.typ == b'mvex':
            continue
        if c.typ == b'mvhd':
            v = c.payload[0]
            if v == 0:
                c = Node(b'mvhd', _patch_u32(c.payload, 16, movie_dur))
            else:
                c = Node(b'mvhd', c.payload[:24] + struct.pack('>Q', movie_dur) + c.payload[32:])
            kept.append(c)
            continue
        if c.typ != b'trak':
            kept.append(c)
            continue
        track = next((t for t in tracks if t.node is c), None)
        if track is None:
            continue                      # track with no samples: dropped
        total = sum(track.durs)
        delay = track.first_dts or 0
        tk_dur = (delay + total) * movie_ts // track.timescale
        new_children = []
        for tc in c.children:
            if tc.typ == b'tkhd':
                v = tc.payload[0]
                payload = _patch_u32(tc.payload, 20, tk_dur) if v == 0 else tc.payload[:28] + struct.pack('>Q', tk_dur) + tc.payload[36:]
                new_children.append(Node(b'tkhd', payload))
            elif tc.typ == b'edts':
                continue                  # rewritten below when needed
            elif tc.typ == b'mdia':
                mdia_children = []
                for mc in tc.children:
                    if mc.typ == b'mdhd':
                        v = mc.payload[0]
                        payload = _patch_u32(mc.payload, 16, total) if v == 0 else mc.payload[:24] + struct.pack('>Q', total) + mc.payload[32:]
                        mdia_children.append(Node(b'mdhd', payload))
                    elif mc.typ == b'minf':
                        minf_children = []
                        for nc in mc.children:
                            if nc.typ == b'stbl':
                                minf_children.append(_build_stbl(nc, track, offsets_by_track[track.track_id]))
                            else:
                                minf_children.append(nc)
                        mdia_children.append(Node(b'minf', children=minf_children))
                    else:
                        mdia_children.append(mc)
                new_children.append(Node(b'mdia', children=mdia_children))
            else:
                new_children.append(tc)
        if delay:
            # The media starts late (audio after video, say): an empty edit keeps it in sync.
            empty = struct.pack('>IiHH', delay * movie_ts // track.timescale, -1, 1, 0)
            media = struct.pack('>IiHH', total * movie_ts // track.timescale, 0, 1, 0)
            elst = Node(b'elst', _fullbox(b'elst', 0, 0, struct.pack('>I', 2) + empty + media)[8:])
            new_children.insert(1, Node(b'edts', children=[elst]))
        kept.append(Node(b'trak', children=new_children))
    return Node(b'moov', children=kept)


def defragment_mp4(src, dst):
    """Rewrite the fragmented MP4 ``src`` as an indexed flat MP4 at ``dst``.
    Returns the media duration in seconds. Raises Mp4IndexError when the
    input is not a fragmented MP4 this module understands."""
    src, dst = Path(src), Path(dst)
    file_size = src.stat().st_size
    with open(src, 'rb') as f:
        top = scan_top_level(f, file_size)
        types = [t for t, _, _, _ in top]
        if b'moov' not in types:
            raise Mp4IndexError('no moov box')
        if b'moof' not in types:
            raise Mp4IndexError('not fragmented (no moof boxes)')
        ftyp_bytes = b''
        moov_node = None
        for typ, pos, hlen, size in top:
            if typ == b'ftyp':
                f.seek(pos)
                ftyp_bytes = f.read(size)
            elif typ == b'moov':
                f.seek(pos)
                raw = f.read(size)
                moov_node = parse_tree(raw, b'moov', hlen, size)
        if moov_node is None:
            raise Mp4IndexError('unreadable moov')
        mvhd = moov_node.child(b'mvhd')
        mvex = moov_node.child(b'mvex')
        if mvhd is None or mvex is None:
            raise Mp4IndexError('moov is not a fragmented-MP4 header')
        movie_ts = _mvhd_info(mvhd.payload)['timescale'] or 1000
        trex = _parse_trex(mvex)
        tracks = [_Track(n, trex) for n in moov_node.children if n.typ == b'trak']
        if not tracks:
            raise Mp4IndexError('no tracks')
        by_id = {t.track_id: t for t in tracks}

        for typ, pos, hlen, size in top:
            if typ == b'moof':
                f.seek(pos)
                _parse_moof(f.read(size), pos, by_id)

        tracks = [t for t in tracks if t.sizes]
        if not tracks:
            raise Mp4IndexError('no samples in fragments')

        # Media bytes go out in file order; each trun becomes one chunk.
        all_chunks = sorted((off, t.track_id, count, nbytes) for t in tracks for off, count, nbytes in t.chunks)
        for off, _, _, nbytes in all_chunks:
            if off + nbytes > file_size:
                raise Mp4IndexError('fragment points outside the file (truncated upload)')
        payload_size = sum(n for _, _, _, n in all_chunks)
        mdat_hdr = 8 if payload_size + 8 < 0xFFFFFFFF else 16

        rel, rel_by_chunk = 0, {}
        for off, tid, count, nbytes in all_chunks:
            rel_by_chunk[(off, tid)] = rel
            rel += nbytes
        placeholder = {t.track_id: [0] * len(t.chunks) for t in tracks}
        moov_size = len(_rebuild_moov(moov_node, tracks, movie_ts, placeholder).serialize())
        if not ftyp_bytes:
            ftyp_bytes = _box(b'ftyp', b'isom' + struct.pack('>I', 512) + b'isomiso2avc1mp41')
        data_start = len(ftyp_bytes) + moov_size + mdat_hdr
        offsets = {t.track_id: [data_start + rel_by_chunk[(off, t.track_id)] for off, _, _ in t.chunks] for t in tracks}
        moov_bytes = _rebuild_moov(moov_node, tracks, movie_ts, offsets).serialize()
        if len(moov_bytes) != moov_size:
            raise Mp4IndexError('internal: moov size changed')

        tmp = dst.with_name(dst.name + '.part')
        with open(tmp, 'wb') as out:
            out.write(ftyp_bytes)
            out.write(moov_bytes)
            if mdat_hdr == 8:
                out.write(struct.pack('>I', payload_size + 8) + b'mdat')
            else:
                out.write(struct.pack('>I', 1) + b'mdat' + struct.pack('>Q', payload_size + 16))
            for off, _, _, nbytes in all_chunks:
                f.seek(off)
                left = nbytes
                while left:
                    buf = f.read(min(COPY_CHUNK, left))
                    if not buf:
                        raise Mp4IndexError('unexpected end of file while copying media')
                    out.write(buf)
                    left -= len(buf)
        os.replace(tmp, dst)

    duration = max(((t.first_dts or 0) + sum(t.durs)) / t.timescale for t in tracks)
    return duration


def faststart_mp4(src, dst):
    """Move a trailing ``moov`` in front of the media (chunk offsets fixed up).
    Returns True when the file was rewritten, False when it was already fine."""
    src, dst = Path(src), Path(dst)
    file_size = src.stat().st_size
    with open(src, 'rb') as f:
        top = scan_top_level(f, file_size)
        order = [t for t, _, _, _ in top]
        if b'moov' not in order or b'mdat' not in order or order.index(b'moov') < order.index(b'mdat'):
            return False
        moov_pos = next(pos for t, pos, _, _ in top if t == b'moov')
        typ, pos, hlen, size = next(b for b in top if b[0] == b'moov')
        f.seek(pos)
        moov = parse_tree(f.read(size), b'moov', hlen, size)

        # every stco becomes co64 so the shifted offsets always fit
        def convert(node):
            if node.children is None:
                return node
            out = []
            for c in node.children:
                if c.typ == b'stco':
                    n = _u32(c.payload, 4)
                    vals = [_u32(c.payload, 8 + 4 * i) for i in range(n)]
                    out.append(Node(b'co64', c.payload[:4] + struct.pack('>I', n) + b''.join(struct.pack('>Q', v) for v in vals)))
                else:
                    out.append(convert(c))
            return Node(node.typ, children=out)

        moov = convert(moov)
        shift = len(moov.serialize())

        def patch(node):
            if node.children is None:
                if node.typ == b'co64':
                    n = _u32(node.payload, 4)
                    vals = [_u64(node.payload, 8 + 8 * i) for i in range(n)]
                    vals = [v + shift if v < moov_pos else v for v in vals]
                    node.payload = node.payload[:8] + b''.join(struct.pack('>Q', v) for v in vals)
                return
            for c in node.children:
                patch(c)

        patch(moov)
        moov_bytes = moov.serialize()
        tmp = dst.with_name(dst.name + '.part')
        with open(tmp, 'wb') as out:
            wrote_moov = False
            for typ, pos, hlen, size in top:
                if typ == b'moov':
                    continue
                if typ != b'ftyp' and not wrote_moov:
                    out.write(moov_bytes)
                    wrote_moov = True
                f.seek(pos)
                left = size
                while left:
                    buf = f.read(min(COPY_CHUNK, left))
                    if not buf:
                        raise Mp4IndexError('unexpected end of file')
                    out.write(buf)
                    left -= len(buf)
            if not wrote_moov:
                out.write(moov_bytes)
        os.replace(tmp, dst)
    return True


def read_duration(path):
    """Seconds from the ``mvhd`` of an indexed MP4, or None (missing, not an
    MP4, or a fragmented file whose header says 0)."""
    try:
        path = Path(path)
        with open(path, 'rb') as f:
            top = scan_top_level(f, path.stat().st_size)
            for typ, pos, hlen, size in top:
                if typ != b'moov':
                    continue
                f.seek(pos)
                raw = f.read(size)
                hit = _find(raw, b'mvhd', hlen, size)
                if not hit:
                    return None
                mv = raw[hit[0]:hit[1]]
                v = mv[0]
                ts = _u32(mv, 12 if v == 0 else 20)
                dur = _u32(mv, 16) if v == 0 else _u64(mv, 24)
                return dur / ts if ts and dur else None
    except Exception:
        return None
    return None


def index_mp4(src, dst):
    """Make ``src`` seekable at ``dst`` without FFmpeg.
    Returns (ok, method, error, duration_seconds_or_None)."""
    src = Path(src)
    try:
        with open(src, 'rb') as f:
            top = scan_top_level(f, src.stat().st_size)
        order = [t for t, _, _, _ in top]
        if b'moof' in order:
            return True, 'defragment', '', defragment_mp4(src, dst)
        if b'moov' not in order:
            raise Mp4IndexError('no moov box')
        if b'mdat' in order and order.index(b'moov') > order.index(b'mdat'):
            faststart_mp4(src, dst)
            return True, 'faststart', '', None
        shutil.copyfile(src, dst)
        return True, 'copy', '', None
    except Mp4IndexError as exc:
        return False, '', str(exc), None
    except Exception as exc:  # struct errors on garbage input and the like
        return False, '', f'{type(exc).__name__}: {exc}', None
