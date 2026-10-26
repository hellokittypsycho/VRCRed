export function createHelpUi() {
  const $ = selector => document.querySelector(selector);
  for (const input of document.querySelectorAll('input[type=password]')) {
    const wrapper = document.createElement('div'); wrapper.className = 'password-field';
    input.before(wrapper); wrapper.append(input);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'password-reveal';
    const label = input.labels?.[0]?.textContent.trim() || 'password';
    const paint = () => {
      const visible = input.type === 'text'; button.textContent = visible ? 'Hide' : 'Show';
      button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`);
      button.setAttribute('aria-pressed', String(visible));
    };
    button.onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; paint(); };
    wrapper.append(button); paint();
  }
  function resetPasswords() {
    for (const wrapper of document.querySelectorAll('.password-field')) {
      const input = wrapper.querySelector('input'), button = wrapper.querySelector('button');
      input.type = 'password'; button.textContent = 'Show'; button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', `Show ${(input.labels?.[0]?.textContent.trim() || 'password').toLowerCase()}`);
    }
  }
  function check(id, ready, text) {
    const node = $(`#${id}`); node.textContent = text; node.dataset.state = ready ? 'ready' : 'waiting';
  }
  function render(state) {
    const camera = state.camera || {};
    check('help-receiver', camera.supported && camera.installed, !camera.supported ? 'Windows required' : camera.installed ? 'Installed' : 'Setup needed');
    check('help-source', camera.connected, camera.connected ? 'Camera connected' : camera.senders?.length ? 'Source detected' : 'Waiting for camera');
    check('help-avatar', !!state.selectedId, state.selectedId ? 'Avatar loaded' : 'Waiting for avatar');
    check('help-sharing', !!state.publicOrigin, state.publicOrigin ? 'Public URL saved' : 'Local only');
    $('#help-stream-summary').textContent = camera.connected ? 'Your camera is connected. You can adjust the stream in Settings.' : 'Follow these steps on the PC running VRChat. You only need to install the camera receiver once.';
  }
  return { render, resetPasswords };
}
