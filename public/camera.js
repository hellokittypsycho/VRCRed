export function createCameraUi({ api, toast }) {
  const $ = selector => document.querySelector(selector);
  const video = $('#screen-preview'), stage = $('#camera-stage');
  let camera, role = 'viewer', busy = false, controller, sourceUrl, retry = null, streamGeneration = 0;
  let viewing = false, suspended = true, settingsInitialized = false, attempts = 0, lastBytes = 0, lastProgress = 0, lastTime = -1;
  let playbackProblem = '';
  const requested = () => !!(camera?.enabled ?? camera?.running);
  try { $('#camera-fit').checked = localStorage.getItem('chaos-deck-camera-fit') === 'true'; } catch { /* Optional. */ }
  stage.classList.toggle('fit-frame', $('#camera-fit').checked);
  $('#camera-fit').onchange = event => {
    stage.classList.toggle('fit-frame', event.target.checked);
    try { localStorage.setItem('chaos-deck-camera-fit', String(event.target.checked)); } catch { /* Optional. */ }
  };
  function stopViewing() {
    streamGeneration++; clearTimeout(retry); retry = null; controller?.abort(); controller = null; viewing = false;
    video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
    if (sourceUrl) URL.revokeObjectURL(sourceUrl); sourceUrl = null;
  }
  function updateStatus() {
    if (!camera || suspended) return;
    const live = camera.connected && !video.hidden && video.readyState >= 2 && video.videoWidth > 0;
    stage.classList.toggle('is-reconnecting', requested() && !live);
    stage.classList.toggle('is-live', live); $('#camera-empty').hidden = live;
    $('#camera-empty h3').textContent = requested() ? 'Reconnecting…' : role === 'admin' && !camera.installed ? 'Camera setup needed' : 'Stream offline';
    $('#camera-empty-message').textContent = requested()
      ? playbackProblem || (camera.connected ? 'Restoring the live stream…' : !camera.senders?.length ? 'Waiting for VRChat. Enable Camera → Stream → Spout Stream.' : camera.message || 'Waiting for VRChat’s streaming camera. Reconnecting automatically.')
      : role === 'admin' ? !camera.supported ? 'The host needs Windows for VRChat camera capture. Friends can watch in their browser.' : !camera.installed ? 'Run Setup Camera.cmd on this PC, then reopen the panel. Open Help & setup for the steps.' : 'Enable Spout Stream in VRChat, then start your stream.' : 'Waiting for the host to go live.';
    $('#camera-status').textContent = live ? 'LIVE' : requested() ? 'RECONNECTING' : 'OFFLINE';
    $('#camera-status').classList.toggle('live-camera', live);
    $('#camera-help').textContent = requested()
      ? camera.error || playbackProblem || (live ? `${camera.outputWidth || 1920} × ${camera.outputHeight || 1080} · ${Math.round(camera.actualFps || 0)} FPS · ${camera.fps} FPS target` : 'Reconnecting automatically…')
      : !camera.installed ? 'Run Setup Camera.cmd first. Help & setup walks through the installation.' : 'Start your in-game stream camera.';
    $('#camera-stop').hidden = !requested();
    // Starting a stopped broadcast remains explicit; interruptions recover automatically.
    $('#camera-connect').hidden = role !== 'admin' || requested() || busy;
    $('#camera-connect').disabled = busy || !camera.supported || !camera.installed;
    $('#camera-fullscreen').hidden = !live; $('#camera-flip-label').hidden = !live;
    updateApplyButton();
  }
  function scheduleRetry() {
    if (suspended || !camera?.running) return;
    stopViewing(); playbackProblem = 'Connection interrupted. Reconnecting automatically…';
    const delay = Math.min(1000 * 2 ** Math.min(attempts++, 4), 15000);
    retry = setTimeout(() => { retry = null; if (!suspended && camera?.running) void startViewing(); }, delay);
    updateStatus();
  }
  function healthyPlayback() {
    if (suspended || !viewing) return;
    if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastProgress = Date.now(); }
    if (video.readyState >= 2) { attempts = 0; playbackProblem = ''; updateStatus(); }
  }
  video.addEventListener('timeupdate', healthyPlayback);
  video.addEventListener('playing', healthyPlayback);
  video.addEventListener('loadeddata', healthyPlayback);
  video.addEventListener('progress', () => { lastBytes = Date.now(); });
  video.addEventListener('error', () => { if (!suspended && viewing) scheduleRetry(); });
  setInterval(() => {
    if (suspended || !viewing || document.hidden || !camera?.running) return;
    const now = Date.now();
    if (now - lastProgress > 12000 || (controller && now - lastBytes > 12000)) scheduleRetry();
  }, 2000);
  document.addEventListener('visibilitychange', () => { lastProgress = lastBytes = Date.now(); });
  window.addEventListener('online', () => {
    if (!suspended && camera?.running && !viewing) { clearTimeout(retry); retry = null; void startViewing(); }
  });
  async function startViewing() {
    if (viewing || retry || suspended || !camera?.running) return;
    viewing = true; lastBytes = lastProgress = Date.now(); lastTime = -1;
    const generation = ++streamGeneration;
    controller = new AbortController(); const signal = controller.signal;
    try {
      if (!window.MediaSource || !MediaSource.isTypeSupported('video/mp4; codecs="avc1.42C02A, mp4a.40.2"')) {
        controller = null; video.src = '/api/camera/stream'; video.hidden = false;
        await video.play(); return;
      }
      const media = new MediaSource(); sourceUrl = URL.createObjectURL(media); video.src = sourceUrl;
      await new Promise((resolve, reject) => {
        const cleanup = () => { media.removeEventListener('sourceopen', ready); signal.removeEventListener('abort', aborted); };
        const ready = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
        media.addEventListener('sourceopen', ready, { once: true }); signal.addEventListener('abort', aborted, { once: true });
      });
      const buffer = media.addSourceBuffer('video/mp4; codecs="avc1.42C02A, mp4a.40.2"');
      const response = await fetch('/api/camera/stream', { signal });
      if (!response.ok) throw new Error('Stream is unavailable.');
      const reader = response.body.getReader();
      const update = action => new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(new Error('The browser could not decode this stream.')); };
        const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
        function cleanup() { buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', bad); signal.removeEventListener('abort', aborted); }
        buffer.addEventListener('updateend', done, { once: true }); buffer.addEventListener('error', bad, { once: true });
        signal.addEventListener('abort', aborted, { once: true });
        try { action(); } catch (error) { cleanup(); reject(error); }
      });
      while (generation === streamGeneration) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Stream ended.');
        lastBytes = Date.now(); await update(() => buffer.appendBuffer(value));
        if (buffer.buffered.length) {
          const start = buffer.buffered.start(0), end = buffer.buffered.end(buffer.buffered.length - 1);
          if (video.currentTime < start || end - video.currentTime > 2) video.currentTime = Math.max(start, end - .6);
          if (end - start > 15 && video.currentTime > start + 5) await update(() => buffer.remove(start, video.currentTime - 5));
          video.hidden = false;
          if (video.paused) video.play().catch(() => {});
        }
      }
    } catch (error) {
      if (generation !== streamGeneration || error.name === 'AbortError') return;
      scheduleRetry();
    }
  }
  function options() {
    return { source: $('#camera-sender').value, fps: Number($('#camera-fps').value), resolution: Number($('#camera-resolution').value),
      game: $('#audio-game').checked, microphone: $('#audio-mic').checked,
      device: $('#audio-device').value === '' ? null : Number($('#audio-device').value) };
  }
  function updateApplyButton() {
    const current = camera && { source: camera.requestedSource ?? $('#camera-sender').value, fps: camera.fps || 60, resolution: camera.resolution || 1080,
      game: camera.audio?.game ?? true, microphone: camera.audio?.microphone ?? true, device: camera.audio?.device ?? null };
    $('#camera-apply').textContent = requested() ? 'Apply stream settings' : 'Start stream';
    $('#camera-apply').disabled = busy || role !== 'admin' || !camera?.supported || !camera?.installed || (requested() && JSON.stringify(options()) === JSON.stringify(current));
  }
  async function connect() {
    if (role !== 'admin' || busy) return;
    busy = true; attempts = 0; playbackProblem = ''; stopViewing(); updateStatus();
    try { await api('camera/start', options()); }
    catch { /* api displays errors. */ }
    finally { busy = false; updateStatus(); }
  }
  $('#camera-connect').onclick = connect; $('#camera-apply').onclick = connect;
  for (const id of ['camera-fps', 'camera-resolution', 'camera-sender', 'audio-game', 'audio-mic', 'audio-device']) $(`#${id}`).addEventListener('change', updateApplyButton);
  $('#camera-stop').onclick = async () => { stopViewing(); try { await api('camera/stop'); } catch { /* Shown by api. */ } };
  $('#audio-refresh').onclick = async () => {
    try {
      const { devices } = await api('audio/devices'); const selected = $('#audio-device').value;
      $('#audio-device').replaceChildren(new Option('Windows default microphone', ''));
      for (const device of devices) if (device.api === 'Windows WASAPI' || device.api === 'MME') $('#audio-device').add(new Option(`${device.name} · ${device.api}`, String(device.id)));
      if ([...$('#audio-device').options].some(o => o.value === selected)) $('#audio-device').value = selected;
      updateApplyButton();
    } catch { /* Shown by api. */ }
  };
  $('#camera-fullscreen').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stage.requestFullscreen?.().catch(() => toast('Fullscreen is unavailable in this browser.'));
  };
  document.addEventListener('fullscreenchange', () => { $('#camera-fullscreen').setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen camera'); });
  $('#camera-flip').onchange = event => stage.classList.toggle('flip-video', event.target.checked);
  $('#stream-audio').onclick = async () => {
    video.muted = !video.muted;
    $('#stream-audio').setAttribute('aria-label', video.muted ? 'Unmute stream' : 'Mute stream');
    $('#stream-audio').title = video.muted ? 'Unmute stream' : 'Mute stream';
    $('#stream-audio').classList.toggle('audio-on', !video.muted);
    try { await video.play(); } catch { toast('The stream will play when the host goes live.'); }
  };
  function render(next, sessionRole) {
    suspended = false; role = sessionRole; camera = next;
    const select = $('#camera-sender'), key = JSON.stringify(next.senders || []);
    if (select.dataset.sources !== key) {
      const chosen = select.value;
      select.replaceChildren(new Option('Auto-select VRChat camera', ''));
      for (const source of next.senders || []) select.add(new Option(source, source));
      // Keep the chosen source even while its sender is temporarily absent.
      if (chosen && ![...select.options].some(o => o.value === chosen)) select.add(new Option(chosen, chosen));
      select.value = chosen; select.dataset.sources = key;
    }
    if (requested() && !settingsInitialized && !busy) {
      $('#camera-fps').value = String(next.fps || 60); $('#camera-resolution').value = String(next.resolution || 1080);
      $('#audio-game').checked = next.audio?.game ?? true; $('#audio-mic').checked = next.audio?.microphone ?? true;
      if (next.audio?.device != null && ![...$('#audio-device').options].some(o => o.value === String(next.audio.device))) $('#audio-device').add(new Option('Selected microphone', String(next.audio.device)));
      $('#audio-device').value = next.audio?.device == null ? '' : String(next.audio.device);
      if (next.requestedSource) { if (![...select.options].some(o => o.value === next.requestedSource)) select.add(new Option(next.requestedSource, next.requestedSource)); select.value = next.requestedSource; }
      settingsInitialized = true;
    }
    if (next.running && !busy && !retry) void startViewing();
    if (!next.running && (viewing || retry)) stopViewing();
    if (!requested()) { attempts = 0; playbackProblem = ''; }
    const audioReady = (!next.audio?.game || next.gameActive) && (!next.audio?.microphone || next.microphoneActive);
    $('#audio-status').dataset.state = next.audioError ? 'error' : requested() ? audioReady ? 'live' : 'pending' : 'off';
    $('#audio-status').textContent = next.audioError || (requested() ? `${next.gameActive ? 'VRChat connected' : next.audio?.game ? 'VRChat audio connecting…' : 'VRChat audio off'} · ${next.microphoneActive ? 'Microphone connected' : next.audio?.microphone ? 'Microphone connecting…' : 'Microphone off'}` : 'VRChat and microphone audio start with the stream.');
    updateStatus();
  }
  return { render, stopViewing() { suspended = true; camera = null; settingsInitialized = false; stopViewing(); } };
}
