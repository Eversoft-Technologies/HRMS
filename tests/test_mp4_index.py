"""api/mp4_index.py rewrites Chrome's fragmented MP4 into an indexed flat MP4
without FFmpeg. These tests build a tiny fragmented file by hand (the box
layout MediaRecorder produces: moov+mvex, then moof/mdat pairs) and check the
sample tables, the media bytes and the durations of the result."""
import os
import struct
import sys
import tempfile
from pathlib import Path

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import SimpleTestCase

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api import mp4_index as M
from api.video_processor import needs_index


def box(typ, payload=b''):
    return struct.pack('>I', 8 + len(payload)) + typ + payload


def full(typ, version, flags, payload):
    return box(typ, bytes([version]) + flags.to_bytes(3, 'big') + payload)


def u32(*vals):
    return b''.join(struct.pack('>I', v) for v in vals)


TIMESCALE = 30000
SAMPLE_DUR = 1000                 # 30 fps
FRAGMENTS = [[b'A' * 5, b'BB' * 3, b'C' * 7], [b'D' * 4, b'E' * 9, b'F' * 6]]
FRAGMENT_DTS = [0, 3 * SAMPLE_DUR]


def init_segment(video=True):
    mvhd = full(b'mvhd', 0, 0, u32(0, 0, 1000, 0) + u32(0x10000, 0x01000000 >> 16) + b'\0' * 70)
    tkhd = full(b'tkhd', 0, 7, u32(0, 0, 1, 0, 0) + b'\0' * 60)
    mdhd = full(b'mdhd', 0, 0, u32(0, 0, TIMESCALE, 0) + b'\x55\xc4\0\0')
    hdlr = full(b'hdlr', 0, 0, u32(0) + (b'vide' if video else b'soun') + b'\0' * 12 + b'x\0')
    stsd = full(b'stsd', 0, 0, u32(1) + box(b'avc1' if video else b'mp4a', b'\0' * 78 + box(b'avcC', b'\x01\x42\xe0\x1e')))
    stbl = box(b'stbl', stsd + full(b'stts', 0, 0, u32(0)) + full(b'stsc', 0, 0, u32(0))
               + full(b'stsz', 0, 0, u32(0, 0)) + full(b'stco', 0, 0, u32(0)))
    minf = box(b'minf', full(b'vmhd', 0, 1, b'\0' * 8) + box(b'dinf', full(b'dref', 0, 0, u32(1) + full(b'url ', 0, 1, b''))) + stbl)
    mdia = box(b'mdia', mdhd + hdlr + minf)
    trak = box(b'trak', tkhd + mdia)
    trex = full(b'trex', 0, 0, u32(1, 1, SAMPLE_DUR, 0, 0x10000))   # default: non-sync
    moov = box(b'moov', mvhd + trak + box(b'mvex', trex))
    return box(b'ftyp', b'isom' + u32(512) + b'isomiso2avc1mp41') + moov


def fragment(seq, dts, samples):
    sizes = [len(s) for s in samples]
    mfhd = full(b'mfhd', 0, 0, u32(seq))
    tfhd = full(b'tfhd', 0, 0x20020, u32(1, 0x10000))                # default-base-is-moof, default flags
    tfdt = full(b'tfdt', 0, 0, u32(dts))
    # trun: data-offset + first-sample-flags (sync) + per-sample size
    trun_body = u32(len(samples)) + struct.pack('>i', 0) + u32(0x02000000) + b''.join(u32(s) for s in sizes)
    trun = full(b'trun', 0, 0x205, trun_body)
    traf = box(b'traf', tfhd + tfdt + trun)
    moof_len = 8 + len(mfhd) + len(traf)
    data_offset = moof_len + 8                                         # first byte of mdat payload
    trun = full(b'trun', 0, 0x205, u32(len(samples)) + struct.pack('>i', data_offset) + u32(0x02000000) + b''.join(u32(s) for s in sizes))
    traf = box(b'traf', tfhd + tfdt + trun)
    return box(b'moof', mfhd + traf) + box(b'mdat', b''.join(samples))


def fragmented_file():
    return init_segment() + b''.join(fragment(i + 1, FRAGMENT_DTS[i], FRAGMENTS[i]) for i in range(len(FRAGMENTS)))


def table(stbl, typ):
    node = stbl.child(typ)
    return node.payload if node else None


class DefragmentTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src = Path(self.tmp.name) / 'frag.mp4'
        self.dst = Path(self.tmp.name) / 'flat.mp4'
        self.src.write_bytes(fragmented_file())

    def _moov(self):
        data = self.dst.read_bytes()
        for typ, ps, pe in M.iter_boxes(data):
            if typ == b'moov':
                return data, M.parse_tree(data, b'moov', ps, pe)
        self.fail('no moov in output')

    def test_output_is_a_flat_indexed_mp4(self):
        ok, method, err, duration = M.index_mp4(self.src, self.dst)
        self.assertTrue(ok, err)
        self.assertEqual(method, 'defragment')
        self.assertAlmostEqual(duration, 6 * SAMPLE_DUR / TIMESCALE)
        data, moov = self._moov()
        order = [t for t, _, _ in M.iter_boxes(data)]
        self.assertEqual(order, [b'ftyp', b'moov', b'mdat'])
        self.assertIsNone(moov.child(b'mvex'))
        self.assertFalse(needs_index(self.dst))
        self.assertTrue(needs_index(self.src))

    def test_sample_tables_describe_every_sample(self):
        M.index_mp4(self.src, self.dst)
        data, moov = self._moov()
        stbl = moov.child(b'trak').child(b'mdia').child(b'minf').child(b'stbl')
        all_samples = [s for frag in FRAGMENTS for s in frag]

        stsz = table(stbl, b'stsz')
        count = struct.unpack_from('>I', stsz, 8)[0]
        sizes = [struct.unpack_from('>I', stsz, 12 + 4 * i)[0] for i in range(count)]
        self.assertEqual(sizes, [len(s) for s in all_samples])

        stts = table(stbl, b'stts')
        self.assertEqual(struct.unpack_from('>III', stts, 4), (1, len(all_samples), SAMPLE_DUR))

        stss = table(stbl, b'stss')
        n = struct.unpack_from('>I', stss, 4)[0]
        self.assertEqual([struct.unpack_from('>I', stss, 8 + 4 * i)[0] for i in range(n)], [1, 4])   # first sample of each fragment

        stsc = table(stbl, b'stsc')
        self.assertEqual(struct.unpack_from('>IIII', stsc, 4), (1, 1, 3, 1))     # every chunk holds 3 samples

        co64 = table(stbl, b'co64')
        n = struct.unpack_from('>I', co64, 4)[0]
        offsets = [struct.unpack_from('>Q', co64, 8 + 8 * i)[0] for i in range(n)]
        self.assertEqual(n, len(FRAGMENTS))
        for frag_bytes, off in zip(FRAGMENTS, offsets):
            joined = b''.join(frag_bytes)
            self.assertEqual(data[off:off + len(joined)], joined)         # offsets point at the real media bytes

    def test_durations_are_written_into_the_headers(self):
        M.index_mp4(self.src, self.dst)
        data, moov = self._moov()
        mvhd = moov.child(b'mvhd').payload
        self.assertEqual(struct.unpack_from('>I', mvhd, 16)[0], 6 * SAMPLE_DUR * 1000 // TIMESCALE)   # 200 ms in movie timescale
        trak = moov.child(b'trak')
        self.assertEqual(struct.unpack_from('>I', trak.child(b'tkhd').payload, 20)[0], 200)
        self.assertEqual(struct.unpack_from('>I', trak.child(b'mdia').child(b'mdhd').payload, 16)[0], 6 * SAMPLE_DUR)
        self.assertAlmostEqual(M.read_duration(self.dst), 0.2)
        self.assertIsNone(M.read_duration(self.src))                     # fragmented header says 0

    def test_truncated_upload_is_refused_not_mangled(self):
        data = fragmented_file()
        self.src.write_bytes(data[:-10])
        ok, method, err, _ = M.index_mp4(self.src, self.dst)
        self.assertFalse(ok)
        self.assertIn('truncated', err)
        self.assertFalse(self.dst.exists())

    def test_garbage_is_reported_not_raised(self):
        self.src.write_bytes(b'\x1a\x45\xdf\xa3' + b'\0' * 40)
        ok, method, err, _ = M.index_mp4(self.src, self.dst)
        self.assertFalse(ok)
        self.assertTrue(err)


class FaststartTests(SimpleTestCase):
    def test_trailing_moov_is_moved_in_front_and_offsets_fixed(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        src, dst = Path(tmp.name) / 'late.mp4', Path(tmp.name) / 'fast.mp4'
        ftyp = box(b'ftyp', b'isom' + u32(512) + b'isom')
        media = b'MEDIA-BYTES'
        mdat = box(b'mdat', media)
        offset_in_src = len(ftyp) + 8
        stbl = box(b'stbl', full(b'stsd', 0, 0, u32(0)) + full(b'stco', 0, 0, u32(1, offset_in_src)))
        moov = box(b'moov', full(b'mvhd', 0, 0, u32(0, 0, 1000, 5) + b'\0' * 80)
                   + box(b'trak', box(b'mdia', box(b'minf', stbl))))
        src.write_bytes(ftyp + mdat + moov)
        self.assertTrue(needs_index(src))

        ok, method, err, _ = M.index_mp4(src, dst)
        self.assertTrue(ok, err)
        self.assertEqual(method, 'faststart')
        data = dst.read_bytes()
        self.assertEqual([t for t, _, _ in M.iter_boxes(data)], [b'ftyp', b'moov', b'mdat'])
        for typ, ps, pe in M.iter_boxes(data):
            if typ == b'moov':
                tree = M.parse_tree(data, b'moov', ps, pe)
        co64 = tree.child(b'trak').child(b'mdia').child(b'minf').child(b'stbl').child(b'co64').payload
        off = struct.unpack_from('>Q', co64, 8)[0]
        self.assertEqual(data[off:off + len(media)], media)
        self.assertFalse(needs_index(dst))
