"""Compare encoders on the same short Spout sample; keep all media in memory.

Run with the camera Python runtime. Writes JSON measurements only, no video/audio.
This does not change the running stream or any VRChat settings.
"""
import array
import fractions
import json
import math
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / '.camera-deps'))
import av
import numpy as np
import SpoutGL
from SpoutGL.enums import GL_RGBA


def capture(count=120):
    frames, samples = [], []
    deadline = time.monotonic() + 12
    with SpoutGL.SpoutReceiver() as receiver:
        if not receiver.createOpenGL():
            raise RuntimeError('Spout graphics context unavailable')
        try:
            sources = [name for name in receiver.getSenderList() if name.lower().startswith('vrcsender')]
            if not sources:
                raise RuntimeError('No active VRChat Spout sender')
            receiver.setReceiverName(sources[0])
            buffer = None
            while len(frames) < count and time.monotonic() < deadline:
                received = receiver.receiveImage(buffer, GL_RGBA, False, 0)
                if receiver.isUpdated():
                    width, height = receiver.getSenderWidth(), receiver.getSenderHeight()
                    if not (0 < width <= 8192 and 0 < height <= 8192 and width * height <= 33177600):
                        raise RuntimeError('Invalid source dimensions')
                    buffer = array.array('B', [0]) * (width * height * 4)
                    continue
                if received and buffer is not None and receiver.isFrameNew():
                    frame = av.VideoFrame.from_ndarray(np.frombuffer(buffer, np.uint8).reshape(height, width, 4), format='rgba')
                    frame = frame.reformat(1920, 1080, format='yuv420p')
                    frames.append(frame)
                    samples.append(frame.to_ndarray()[:1080:4, ::4].astype(np.float32))
                time.sleep(1 / 60)
        finally:
            receiver.releaseReceiver()
            receiver.closeOpenGL()
    if len(frames) < 60:
        raise RuntimeError('Not enough camera frames for a useful sample')
    return frames, samples


def benchmark(frames, reference, name, codec, rate, gop, options):
    encoder = av.CodecContext.create(codec, 'w')
    encoder.width, encoder.height, encoder.pix_fmt = 1920, 1080, 'yuv420p'
    encoder.time_base = fractions.Fraction(1, 60)
    encoder.framerate = fractions.Fraction(60, 1)
    encoder.bit_rate, encoder.gop_size, encoder.max_b_frames = rate, gop, 0
    encoder.thread_count = 4
    encoder.options = options
    start = time.perf_counter()
    encoder.open()
    packets = []
    for index, frame in enumerate(frames):
        frame.pts, frame.time_base = index, fractions.Fraction(1, 60)
        frame.pict_type = av.video.frame.PictureType.NONE
        packets.extend(bytes(packet) for packet in encoder.encode(frame))
    packets.extend(bytes(packet) for packet in encoder.encode(None))
    elapsed = time.perf_counter() - start
    decoder = av.CodecContext.create('h264', 'r')
    errors, decoded = [], 0
    def compare(frame):
        nonlocal decoded
        sample = frame.to_ndarray(format='yuv420p')[:1080:4, ::4].astype(np.float32)
        errors.append(float(np.mean((sample - reference[decoded]) ** 2)))
        decoded += 1
    for packet in packets:
        for frame in decoder.decode(av.Packet(packet)):
            compare(frame)
    for frame in decoder.decode(None):
        compare(frame)
    if decoded != len(frames):
        raise RuntimeError(f'Only {decoded}/{len(frames)} decoded')
    mse = sum(errors) / len(errors)
    return {'name': name, 'codec': codec, 'frames': len(frames),
            'videoMbps': round(sum(map(len, packets)) * 8 / (len(frames) / 60) / 1000000, 3),
            'encodeFps': round(len(frames) / elapsed, 1),
            'lumaPsnrDb': round(10 * math.log10(255 ** 2 / max(mse, 0.000001)), 2)}


if __name__ == '__main__':
    frames, reference = capture()
    captured_seconds = len(frames) / 60
    # Replay the identical sample to reduce the influence of encoder startup bursts.
    # Repeated references keep memory bounded; no additional media is stored.
    frames, reference = frames * 5, reference * 5
    profiles = [
        ('Current 6 Mbps', 'libx264', 6000000, 30,
         {'preset': 'ultrafast', 'tune': 'zerolatency', 'profile': 'baseline', 'level': '4.2',
          'sc_threshold': '0', 'maxrate': '6500k', 'bufsize': '6500k'}),
        ('CPU efficient capped quality', 'libx264', 0, 60,
         {'preset': 'veryfast', 'tune': 'zerolatency', 'profile': 'high', 'level': '4.2',
          'crf': '23', 'sc_threshold': '0', 'maxrate': '4000k', 'bufsize': '4000k'}),
        ('GPU 4 Mbps', 'h264_nvenc', 4000000, 60,
         {'preset': 'p5', 'tune': 'll', 'rc': 'vbr', 'cq': '23', 'profile': 'high', 'level': '4.2',
          'zerolatency': '1', 'rc-lookahead': '0', 'spatial-aq': '1', 'maxrate': '4500k', 'bufsize': '4500k'}),
    ]
    results = []
    for name, codec, rate, gop, options in profiles:
        try:
            results.append(benchmark(frames, reference, name, codec, rate, gop, options))
        except Exception as error:
            results.append({'name': name, 'error': str(error)})
    print(json.dumps({'resolution': '1920x1080', 'fps': 60, 'capturedSeconds': captured_seconds, 'encodedSeconds': round(len(frames) / 60, 2),
                      'notes': 'Same two-second live-camera sample repeated five times; video only. PSNR is sampled luma, not a perceptual guarantee.',
                      'results': results}, indent=2))
