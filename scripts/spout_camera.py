"""VRChat Spout + isolated process audio + microphone, encoded once for all viewers."""
import array
import collections
import fractions
import io
import json
import os
import pathlib
import struct
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / '.camera-deps'))


def emit(kind, payload):
    if kind == 1:
        payload = json.dumps(payload).encode('utf-8')
    sys.stdout.buffer.write(b'CDK1' + bytes([kind]) + struct.pack('>I', len(payload)) + payload)
    sys.stdout.buffer.flush()


class Output:
    def write(self, data):
        emit(3, bytes(data))
        return len(data)

    def writable(self):
        return True

    def seekable(self):
        return False

    def flush(self):
        pass


class AudioBuffer:
    def __init__(self):
        self.parts = collections.deque()
        self.lock = threading.Lock()
        self.last = 0
        self.peak = 0

    def put(self, data):
        import numpy as np
        block = np.frombuffer(data, dtype=np.float32).reshape(-1, 2).copy()
        with self.lock:
            self.parts.append(block)
            while sum(len(p) for p in self.parts) > 24000:
                self.parts.popleft()
            self.last = time.monotonic()
            self.peak = float(np.max(np.abs(block))) if len(block) else 0

    def take(self, frames):
        import numpy as np
        result = np.zeros((frames, 2), dtype=np.float32)
        offset = 0
        with self.lock:
            while self.parts and offset < frames:
                part = self.parts.popleft()
                count = min(len(part), frames - offset)
                result[offset:offset + count] = part[:count]
                offset += count
                if count < len(part):
                    self.parts.appendleft(part[count:])
        return result


def devices():
    import sounddevice as sd
    result = []
    for index, device in enumerate(sd.query_devices()):
        if device['max_input_channels'] > 0:
            api = sd.query_hostapis(device['hostapi'])['name']
            result.append({'id': index, 'name': device['name'], 'api': api})
    return result


def watch_parent(pid):
    # A force-closed Node process must not leave a microphone capture running.
    if not pid:
        return
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x00100000, False, int(pid))
    if not handle:
        raise RuntimeError('Cannot monitor the local streaming server.')
    def watch():
        try:
            while True:
                result = kernel.WaitForSingleObject(handle, 500)
                if result != 0x00000102:  # WAIT_TIMEOUT
                    os._exit(0)
        finally:
            kernel.CloseHandle(handle)
    threading.Thread(target=watch, daemon=True).start()


def main():
    import av
    import numpy as np
    import SpoutGL
    from SpoutGL.enums import GL_RGBA
    from PIL import Image

    requested = sys.argv[1] if len(sys.argv) > 1 else ''
    fps = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    options = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    if fps not in (15, 30, 60) or (requested and not requested.lower().startswith('vrc')):
        raise ValueError('Choose a VRChat source and 15, 30, or 60 FPS.')
    watch_parent(options.get('parentPid'))
    height_out = options.get('resolution', 1080)
    width_out = 1920 if height_out == 1080 else 1280
    game, mic = AudioBuffer(), AudioBuffer()
    tap = microphone = None
    audio_errors = []
    game_reconnect = threading.Event()
    def start_game():
        nonlocal tap
        try:
            from proctap import ProcessAudioCapture
            pid = subprocess.check_output(['powershell.exe', '-NoProfile', '-Command',
                '(Get-Process VRChat -ErrorAction Stop | Select-Object -First 1).Id'],
                creationflags=subprocess.CREATE_NO_WINDOW, stderr=subprocess.DEVNULL, timeout=8).decode().strip()
            pending = ProcessAudioCapture(int(pid), on_data=lambda data, frames: game.put(data))
            pending.start()
            tap = pending
            audio_errors[:] = [item for item in audio_errors if not item.startswith('VRChat audio:')]
        except Exception as error:
            audio_errors[:] = [item for item in audio_errors if not item.startswith('VRChat audio:')]
            audio_errors.append('VRChat audio: ' + str(error))
    def maintain_game():
        nonlocal tap
        while True:
            previous = tap
            tap = None
            if previous:
                previous.close()
            start_game()
            game_reconnect.wait(timeout=3 if not tap or not tap.is_running else None)
            game_reconnect.clear()
    def start_microphone():
        nonlocal microphone
        try:
            import sounddevice as sd
            device = options.get('device')
            info = sd.query_devices(device, 'input')
            channels = min(2, info['max_input_channels'])
            def on_mic(data, frames, timing, status):
                if channels == 1:
                    data = np.repeat(data, 2, axis=1)
                mic.put(data.astype(np.float32).tobytes())
            pending = sd.InputStream(device=device, channels=channels, samplerate=48000,
                dtype='float32', blocksize=960, callback=on_mic)
            pending.start()
            microphone = pending
        except Exception as error:
            audio_errors.append('Microphone: ' + str(error))
    for enabled, initialize in [(options.get('game', True), maintain_game),
                                (options.get('microphone', True), start_microphone)]:
        if enabled:
            threading.Thread(target=initialize, daemon=True).start()
    # Audio and video share one timeline and one HTTP fragmented MP4 transport.
    container = av.open(Output(), mode='w', format='mp4', options={
        'movflags': 'frag_keyframe+empty_moov+default_base_moof', 'flush_packets': '1'})
    video = container.add_stream('libx264', rate=fps)
    video.width, video.height, video.pix_fmt = width_out, height_out, 'yuv420p'
    video.bit_rate = 6_000_000 if height_out == 1080 else 3_000_000
    video.codec_context.gop_size = max(1, fps // 2)
    video.codec_context.max_b_frames = 0
    video.options = {'preset': 'ultrafast', 'tune': 'zerolatency', 'profile': 'baseline',
                     'level': '4.2', 'sc_threshold': '0', 'threads': '4',
                     'maxrate': '6500k', 'bufsize': '6500k'}
    audio = container.add_stream('aac', rate=48000)
    audio.layout = 'stereo'
    audio.bit_rate = 128000
    origin = time.monotonic()
    audio_pts = 0
    last_video_pts = -1
    frame_count = 0
    last_encoded = 0
    black = np.zeros((height_out, width_out, 3), dtype=np.uint8)
    with SpoutGL.SpoutReceiver() as receiver:
        if not receiver.createOpenGL():
            raise RuntimeError('Could not create a graphics context for the Spout camera.')
        buffer = None
        selected = ''
        last_status = last_discovery = last_snapshot = 0
        last_count = 0
        last_received = 0
        ever_received = False
        senders = []
        width = height = 0
        try:
            while True:
                tick = time.monotonic()
                if tick - last_discovery >= 1:
                    senders = [name for name in receiver.getSenderList() if name.lower().startswith('vrc')]
                    last_discovery = tick
                target = requested if requested in senders else '' if requested else next(
                    (name for name in senders if name.lower().startswith('vrcsender')), senders[0] if senders else '')
                if tick - last_status >= 1:
                    current_tap = tap
                    emit(1, {'senders': senders, 'source': selected or target, 'width': width, 'height': height,
                        'outputWidth': width_out, 'outputHeight': height_out,
                        'actualFps': round((frame_count - last_count) / max(.01, tick - last_status), 1) if last_status else 0,
                        'gameActive': bool(current_tap and current_tap.is_running), 'microphoneActive': bool(microphone and microphone.active),
                        'gameLevel': round(game.peak, 3) if tick - game.last < 1 else 0,
                        'microphoneLevel': round(mic.peak, 3) if tick - mic.last < 1 else 0,
                        'audioError': '; '.join(audio_errors + (['VRChat audio has not started. Check that VRChat is running.'] if options.get('game', True) and not tap and tick - origin > 12 else []) + (['Microphone has not started. Select another microphone.'] if options.get('microphone', True) and not microphone and tick - origin > 12 else [])),
                        'message': '' if target else 'Waiting for VRChat. Enable Camera > Stream > Spout Stream.'})
                    last_status, last_count = tick, frame_count
                # Always advance audio in fixed 20ms blocks, including silence when an app is quiet.
                target_audio = int((tick - origin) * 48000)
                while audio_pts + 960 <= target_audio:
                    samples = np.clip(game.take(960) + mic.take(960), -1, 1)
                    frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(samples.T), format='fltp', layout='stereo')
                    frame.sample_rate, frame.pts, frame.time_base = 48000, audio_pts, fractions.Fraction(1, 48000)
                    audio_pts += 960
                    for packet in audio.encode(frame):
                        container.mux(packet)
                if tick - last_encoded > .5:
                    # Bound muxer buffering if the sender stops: keep both tracks advancing.
                    blank = av.VideoFrame.from_ndarray(black, format='rgb24').reformat(format='yuv420p')
                    blank.pts = max(last_video_pts + 1, round((tick - origin) * fps))
                    blank.time_base = fractions.Fraction(1, fps)
                    blank.pict_type = av.video.frame.PictureType.I
                    for packet in video.encode(blank):
                        container.mux(packet)
                    last_video_pts, last_encoded = blank.pts, tick
                if not target:
                    if selected:
                        receiver.releaseReceiver()
                        selected, buffer = '', None
                        if ever_received:
                            game_reconnect.set()
                    time.sleep(.01)
                    continue
                if selected and tick - last_received > 5:
                    # Recreate stale Spout handles after a sender/window or GPU restart.
                    receiver.releaseReceiver()
                    receiver.setReceiverName(target)
                    buffer = None
                    last_received = tick
                    if ever_received:
                        game_reconnect.set()
                if target != selected:
                    receiver.releaseReceiver()
                    receiver.setReceiverName(target)
                    selected, buffer = target, None
                    last_received = tick
                    if ever_received:
                        game_reconnect.set()
                result = receiver.receiveImage(buffer, GL_RGBA, False, 0)
                if receiver.isUpdated():
                    width, height = receiver.getSenderWidth(), receiver.getSenderHeight()
                    if not (0 < width <= 8192 and 0 < height <= 8192 and width * height <= 33_177_600):
                        raise RuntimeError('Camera resolution is outside the supported range.')
                    buffer = array.array('B', [0]) * (width * height * 4)
                    continue
                if result and buffer is not None and receiver.isFrameNew():
                    last_received = tick
                    ever_received = True
                    pts = max(last_video_pts + 1, round((time.monotonic() - origin) * fps))
                    frame = av.VideoFrame.from_ndarray(np.frombuffer(buffer, dtype=np.uint8).reshape(height, width, 4), format='rgba')
                    frame = frame.reformat(width_out, height_out, format='yuv420p')
                    frame.pts, frame.time_base = pts, fractions.Fraction(1, fps)
                    for packet in video.encode(frame):
                        container.mux(packet)
                    last_video_pts = pts
                    last_encoded = time.monotonic()
                    frame_count += 1
                    if tick - last_snapshot >= 1:
                        image = Image.frombuffer('RGBA', (width, height), buffer, 'raw', 'RGBA', 0, 1).convert('RGB')
                        image.thumbnail((width_out, height_out))
                        jpeg = io.BytesIO()
                        image.save(jpeg, 'JPEG', quality=85)
                        emit(2, jpeg.getvalue())
                        last_snapshot = tick
                time.sleep(max(.001, 1 / fps - (time.monotonic() - tick)))
        finally:
            if microphone:
                microphone.stop()
                microphone.close()
            if tap:
                tap.close()
            receiver.releaseReceiver()
            receiver.closeOpenGL()
            container.close()


if __name__ == '__main__':
    if '--devices' in sys.argv:
        print(json.dumps(devices()))
    else:
        try:
            main()
        except (BrokenPipeError, KeyboardInterrupt):
            pass
        except Exception as error:
            emit(1, {'error': str(error)})
