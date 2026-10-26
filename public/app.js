import { describeControls, categories, formatFeedback, integerSliderRange } from './controls.js';
import { createCameraUi } from './camera.js';
import { createCommunityUi } from './community.js';
import { createHelpUi } from './help.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let authMode = 'login', events, accessInfo, checkingAccess = false, state, token, connected = false, toastTimer, parameterKey = '', lastLogKey = '';
let favorites = [];
try { favorites = JSON.parse(localStorage.getItem('chaos-deck-favorites') || '[]'); if (!Array.isArray(favorites)) favorites = []; } catch { /* Storage is optional. */ }
let favoritesOnly = false;
let category = 'All', showInternals = false, aliases = {};
let controlPage = 0, lastFilterKey = '', renaming = null;
let chromeTimer, pointerDown = false, keyboardNavigation = false, lastPointer = null;
const chromeDelay = 3000;
try { aliases = JSON.parse(localStorage.getItem('chaos-deck-labels') || '{}'); if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) aliases = {}; } catch { /* Optional preferences. */ }
const held = new Map();
const keyMap = { KeyW: 'forward', KeyA: 'left', KeyS: 'back', KeyD: 'right', KeyQ: 'turnLeft', KeyE: 'turnRight', Space: 'jump', ShiftLeft: 'run', ShiftRight: 'run' };

function toast(message, tone = 'info') {
  revealChrome();
  $('#toast').dataset.tone = tone; $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
async function api(route, body = {}, quiet = false) {
  try {
    const response = await fetch(`/api/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Deck-Token': token },
      body: JSON.stringify(body), keepalive: ['release', 'pause'].includes(route),
    });
    const result = await response.json();
    if (response.status === 401) { lockScreen(); throw new Error('Sign in to continue.'); }
    if (!response.ok) throw new Error(result.error || 'Command failed');
    return result;
  } catch (error) { if (!quiet) toast(error.message, 'error'); throw error; }
}
const isAdmin = () => state?.role === 'admin';
async function get(route) {
  const response = await fetch(`/api/${route}`), result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
}
function command(route, body) {
  if (!connected || !isAdmin()) return Promise.resolve();
  return api(route, body).catch(() => {});
}
function element(tag, className, text) {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function uiIcon(name) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.classList.add('ui-icon'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`); icon.append(use); return icon;
}
function saveFavorites() { try { localStorage.setItem('chaos-deck-favorites', JSON.stringify(favorites)); } catch { toast('Favorites cannot be saved in this browser.'); } }
function avatar() { return state?.avatars.find(a => a.id === state.selectedId); }
const aliasKey = parameter => `${state.selectedId}:${parameter.address}`;
const controlLabel = parameter => aliases[aliasKey(parameter)] || parameter.label;
const cameraUi = createCameraUi({ api, toast });
const communityUi = createCommunityUi({ api, get, toast, changePassword });
const helpUi = createHelpUi();

function renderParameters(force = false) {
  if (!state) return;
  const query = $('#parameter-search').value.toLowerCase();
  const parameters = describeControls(avatar()?.parameters || []);
  const columns = window.innerWidth <= 380 ? 1 : window.innerWidth <= 800 ? 2 : 3;
  const reserved = 400;
  const rows = Math.max(1, Math.min(3, Math.floor((window.innerHeight - reserved) / 159)));
  const pageSize = columns * rows;
  const filterKey = JSON.stringify([state.selectedId, query, favoritesOnly, category, showInternals, pageSize]);
  if (filterKey !== lastFilterKey) { controlPage = 0; lastFilterKey = filterKey; }
  const key = JSON.stringify([state.selectedId, parameters, query, favoritesOnly, favorites, category, showInternals, aliases, controlPage, pageSize]);
  if (!force && key === parameterKey) return;
  parameterKey = key;
  const list = $('#parameters'); list.replaceChildren();
  const visible = parameters.filter(p => !p.internal || showInternals);
  const matches = visible.filter(p => `${controlLabel(p)} ${p.name} ${p.category}`.toLowerCase().includes(query) && (!favoritesOnly || favorites.includes(p.address)) && (category === 'All' || p.category === category));
  const order = ['Props & toys', 'Expressions', 'Body & effects', 'Outfit', 'Colors', 'Other', 'Internal'];
  matches.sort((a, b) => Number(favorites.includes(b.address)) - Number(favorites.includes(a.address)) || order.indexOf(a.category) - order.indexOf(b.category) || controlLabel(a).localeCompare(controlLabel(b)));
  $('#parameter-count').textContent = `${parameters.filter(p => !p.internal).length} CONTROLS`;
  const pages = Math.ceil(matches.length / pageSize);
  controlPage = Math.max(0, Math.min(controlPage, pages - 1));
  $('#results-count').textContent = matches.length ? `${controlPage * pageSize + 1}–${Math.min((controlPage + 1) * pageSize, matches.length)} of ${matches.length} controls` : '';
  $('#load-more-controls').hidden = pages <= 1;
  $('#previous-controls').hidden = pages <= 1;
  $('#load-more-controls').disabled = controlPage >= pages - 1;
  $('#previous-controls').disabled = controlPage === 0;
  $('#hidden-count').textContent = `${parameters.filter(p => p.internal).length} internal parameters hidden by default`;
  $('#avatar-empty').hidden = matches.length > 0;
  if (!matches.length) {
    $('#avatar-empty h3').textContent = parameters.length ? 'Nothing in this collection yet.' : 'Your avatar is up next.';
    $('#avatar-empty p').textContent = parameters.length ? 'Try another category or search. Advanced mode reveals hidden implementation parameters.' : state.avatars.length ? 'Choose an avatar configuration above. The configuration must match the avatar you are wearing.' : 'Enable OSC in VRChat, load a published avatar, then rescan. Its available controls will show up here.';
    $('#avatar-empty > .mono').textContent = parameters.length ? 'TRY A DIFFERENT SEARCH' : state.avatars.length ? 'WAITING FOR AVATAR SELECTION' : 'NO AVATAR CONFIGURATIONS FOUND';
  }
  for (const parameter of matches.slice(controlPage * pageSize, (controlPage + 1) * pageSize)) {
    const row = element('div', 'parameter-row');
    const favorite = element('button', 'favorite'); favorite.append(uiIcon('star'));
    const label = controlLabel(parameter);
    favorite.setAttribute('aria-label', `Favorite ${label}`);
    favorite.setAttribute('aria-pressed', favorites.includes(parameter.address));
    favorite.onclick = () => {
      favorites = favorites.includes(parameter.address) ? favorites.filter(a => a !== parameter.address) : [...favorites, parameter.address];
      saveFavorites(); renderParameters(); updateControlAvailability();
    };
    const info = element('div', 'parameter-info');
    info.append(element('strong', '', label));
    info.title = `OSC: ${parameter.name}\n${parameter.address}`;
    const readout = element('small', '', `${parameter.category} · ${formatFeedback(state.values[parameter.outputAddress || parameter.address])}`);
    readout.dataset.feedbackAddress = parameter.outputAddress || parameter.address;
    readout.dataset.parameterType = parameter.category; info.append(readout);
    if (showInternals) info.append(element('small', 'technical-name', parameter.name));
    row.append(favorite, info);
    const rename = element('button', 'rename-control'); rename.append(uiIcon('edit')); rename.title = 'Rename this control'; rename.setAttribute('aria-label', `Rename ${label}`);
    rename.onclick = () => {
      renaming = { key: aliasKey(parameter), defaultName: parameter.label };
      $('#rename-input').value = aliases[renaming.key] || '';
      $('#rename-input').placeholder = parameter.label;
      openStudioDialog('rename-dialog'); $('#rename-input').focus();
    };
    row.append(rename);
    if (parameter.type === 'Bool') {
      for (const value of [true, false]) {
        const button = element('button', 'parameter-bool', value ? 'ON' : 'OFF');
        button.dataset.control = ''; button.setAttribute('aria-label', `${label} ${value ? 'on' : 'off'}`);
        button.dataset.parameterAddress = parameter.outputAddress || parameter.address; button.dataset.booleanValue = String(value);
        button.onclick = () => command('parameter', { ...parameter, value }); row.append(button);
      }
    } else if (parameter.type === 'Int') {
      const range = integerSliderRange(parameter, state.values[parameter.outputAddress || parameter.address]);
      const control = element('div', 'parameter-slider-control');
      const input = element('input', 'parameter-slider'); input.type = 'range'; input.step = '1';
      input.min = String(range.min); input.max = String(range.max); input.value = String(range.value);
      input.setAttribute('aria-label', `${label} value`); input.dataset.control = '';
      const value = element('output', 'parameter-slider-value'); value.setAttribute('aria-hidden', 'true');
      const paint = () => {
        value.textContent = input.value;
        input.style.setProperty('--slider-fill', `${100 * (Number(input.value) - range.min) / (range.max - range.min)}%`);
      };
      input.oninput = paint; paint();
      input.title = 'Release to apply';
      input.onchange = () => {
        if (!input.disabled) command('parameter', { ...parameter, value: Number(input.value) });
      };
      control.append(input, value); row.append(control);
    } else {
      const input = element('input', 'parameter-value');
      const observed = state.values[parameter.outputAddress || parameter.address];
      input.type = 'number'; input.value = typeof observed === 'number' ? String(Number(observed.toFixed(3))) : '0'; input.step = 'any';
      input.min = '-1'; input.max = '1';
      input.setAttribute('aria-label', `${label} value`);
      const button = element('button', 'parameter-send', 'Set'); button.append(uiIcon('arrow-right')); button.dataset.control = '';
      button.setAttribute('aria-label', `Set ${label}`);
      button.onclick = () => { if (input.reportValidity()) command('parameter', { ...parameter, value: Number(input.value) }); };
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && !button.disabled) button.click(); });
      row.append(input, button);
    }
    list.append(row);
  }
}

function updateControlAvailability() {
  $$('[data-control]').forEach(button => { button.disabled = !connected || !isAdmin(); });
  $$('[data-move]').forEach(button => { button.disabled = !connected || !isAdmin() || !!state?.activePreset; });
  $$('[data-preset]').forEach(button => {
    button.disabled = !connected || !isAdmin() || !!state?.activePreset ||
      (button.dataset.preset === 'emote' && !avatar()?.parameters.some(p => (p.name === 'VRCEmote' || p.name.endsWith('/VRCEmote')) && p.type === 'Int'));
    if (button.dataset.preset === 'emote') button.title = button.disabled ? 'Requires a selected avatar with VRCEmote (Int)' : 'Send VRCEmote = 1, then restore';
  });
  $('#surprise-cue').disabled = !connected || !isAdmin() || !!state?.activePreset;
  $('#osc-port').disabled = !connected || !isAdmin();
  $('#avatar-select').disabled = !connected || !isAdmin();
}

function render(next) {
  if (!Object.hasOwn(next, 'avatars')) next.avatars = state?.avatars || [];
  state = next;
  $$('[data-admin-only]').forEach(node => { node.hidden = !isAdmin(); });
  if (state.camera) cameraUi.render(state.camera, state.role);
  communityUi.render(state, connected);
  helpUi.render(state);
  if (document.activeElement !== $('#public-origin')) $('#public-origin').value = state.publicOrigin || '';
  const selected = $('#avatar-select');
  const avatarKey = JSON.stringify([state.avatars.map(a => [a.id, a.name]), state.currentId]);
  if (selected.dataset.key !== avatarKey) {
    selected.replaceChildren(new Option('Choose an avatar configuration', ''));
    for (const a of state.avatars) selected.add(new Option(`${a.name}${a.id === state.currentId ? ' · CURRENT' : ''}`, a.id));
    selected.dataset.key = avatarKey;
  }
  selected.value = state.selectedId;
  $('#current-avatar-name').hidden = isAdmin();
  $('#current-avatar-name').textContent = avatar()?.name || 'Waiting for the host’s avatar';
  $('#bridge-label').textContent = connected ? 'Studio connected' : 'Studio disconnected';
  $('#bridge-dot').classList.toggle('good', connected);
  $('#destination').textContent = state.target;
  if (document.activeElement !== $('#osc-port')) $('#osc-port').value = state.oscPort;
  $('#feedback-label').textContent = state.receiverError ? 'Port unavailable' : state.oscObserved ? 'OSC packets received' : 'Waiting for VRChat';
  $('#feedback-help').textContent = state.receiverError || `Sending does not confirm delivery. Feedback listens locally on port ${state.rxPort}.`;
  $('#packet-label').textContent = 'OSC packets actually sent';
  $('#packet-count').textContent = String(state.oscSentCount || 0).padStart(4, '0');
  const last = state.lastCommand;
  $('#command-result').textContent = !last ? 'Controls depend on your avatar’s setup.' : last.status === 'confirmed' ? `VRChat confirmed: ${last.address.split('/').at(-1)} = ${last.observed}` : last.status === 'unconfirmed' ? `VRChat reports ${last.observed ?? 'no value'}; the avatar may override this parameter` : `Sent ${last.address.split('/').at(-1)}; execution not verified`;
  const cueNames = { spin: 'Spin cycle', wiggle: 'The wiggle', hops: 'Bunny mode', emote: 'Main character' };
  $('#preset-status').textContent = state.activePreset ? `Playing ${cueNames[state.activePreset] || state.activePreset}…` : 'All cues ready';
  $('#preset-indicator').classList.toggle('busy', !!state.activePreset);
  const logKey = state.logs[0]?.id;
  if (logKey !== lastLogKey) {
    lastLogKey = logKey;
    const activity = $('#activity'); activity.replaceChildren();
    for (const entry of state.logs.slice(0, 5)) {
      const row = element('div', 'activity-row');
      const time = new Date(entry.time).toLocaleTimeString([], { hour12: false });
      row.append(element('span', 'activity-time', time), element('span', `activity-tag tag-${entry.kind}`, entry.kind.toUpperCase()), element('span', 'activity-message', entry.message));
      activity.append(row);
    }
  }
  renderParameters();
  $$('[data-feedback-address]').forEach(label => {
    const observed = state.values[label.dataset.feedbackAddress];
    label.textContent = `${label.dataset.parameterType} · ${formatFeedback(observed)}`;
  });
  $$('[data-boolean-value]').forEach(button => {
    const selected = typeof state.values[button.dataset.parameterAddress] === 'boolean' && String(state.values[button.dataset.parameterAddress]) === button.dataset.booleanValue;
    button.classList.toggle('is-current', selected); button.setAttribute('aria-pressed', String(selected));
  });
  updateControlAvailability();
}

function press(id, name) {
  if (!connected || !isAdmin() || held.has(id) || state.activePreset) return;
  held.set(id, name); paintHeld();
  command('move', { name, duration: 350 });
}
function paintHeld() { $$('[data-move]').forEach(button => button.classList.toggle('pressed', [...held.values()].includes(button.dataset.move))); }
async function release(id) {
  if (!held.delete(id)) return;
  paintHeld();
  // Release axes immediately, then reassert other held keys.
  if (connected) {
    try {
      await api('release', {}, true);
      for (const name of held.values()) command('move', { name, duration: 350 });
    } catch { /* Independent server timers also release holds. */ }
  }
}
function clearHeld(send = true) {
  const hadHeld = held.size > 0; held.clear(); paintHeld();
  if (send && hadHeld && connected) api('release', {}, true).catch(() => {});
}
setInterval(() => {
  if (connected && isAdmin() && document.visibilityState === 'visible') {
    for (const name of new Set(held.values())) api('move', { name, duration: 350 }, true).catch(() => {});
  }
}, 180);

$$('[data-control]').forEach(button => { button.disabled = true; });
$('#surprise-cue').onclick = () => {
  if (!connected || !isAdmin() || state.activePreset) return;
  clearHeld();
  const available = $$('[data-preset]').filter(button => !button.disabled);
  if (available.length) command('preset', { name: available[Math.floor(Math.random() * available.length)].dataset.preset });
};
function openStudioDialog(id) {
  if (['avatar-dialog', 'deck-dialog', 'movement-dialog', 'settings-dialog', 'accounts-dialog', 'rename-dialog'].includes(id) && !isAdmin()) return;
  clearHeld();
  $$('dialog[open]').forEach(dialog => dialog.close());
  document.getElementById(id).showModal();
}
$('#movement-open').onclick = () => openStudioDialog('movement-dialog');
$$('[data-open-settings]').forEach(button => { button.onclick = () => openStudioDialog('settings-dialog'); });
$$('[data-open-dialog]').forEach(button => { button.onclick = () => openStudioDialog(button.dataset.openDialog); });
$$('[data-close-dialog]').forEach(button => { button.onclick = () => document.getElementById(button.dataset.closeDialog).close(); });
for (const dialog of $$('dialog')) {
  dialog.addEventListener('close', () => clearHeld());
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
}

function setChromeIdle(idle) {
  document.body.classList.toggle('ui-idle', idle);
  $('#player-chrome').inert = idle;
}
function revealChrome() {
  clearTimeout(chromeTimer);
  setChromeIdle(false);
  if (!document.hidden) chromeTimer = setTimeout(hideChrome, chromeDelay);
}
function hideChrome() {
  const menuOpen = !!document.querySelector('dialog[open], details[open]');
  const keyboardFocus = keyboardNavigation && document.hasFocus() && $('#player-chrome').contains(document.activeElement);
  const cameraLive = connected && $('#camera-stage').classList.contains('is-live');
  if (menuOpen || communityUi.isOpen() || pointerDown || keyboardFocus || !cameraLive) {
    revealChrome();
    return;
  }
  setChromeIdle(true);
}
document.addEventListener('pointermove', event => {
  if (lastPointer && lastPointer[0] === event.clientX && lastPointer[1] === event.clientY) return;
  lastPointer = [event.clientX, event.clientY]; keyboardNavigation = false; revealChrome();
}, { passive: true });
document.addEventListener('pointerdown', () => { pointerDown = true; keyboardNavigation = false; revealChrome(); }, { capture: true, passive: true });
for (const name of ['pointerup', 'pointercancel']) document.addEventListener(name, () => { pointerDown = false; revealChrome(); }, { capture: true, passive: true });
document.addEventListener('keydown', event => {
  if (event.key === 'Tab') keyboardNavigation = true;
  else if (event.key === 'Escape') keyboardNavigation = false;
  revealChrome();
}, true);
document.addEventListener('focusin', () => { if (keyboardNavigation || document.querySelector('dialog[open]')) revealChrome(); });
document.addEventListener('visibilitychange', () => {
  pointerDown = false; clearTimeout(chromeTimer);
  if (document.hidden) setChromeIdle(false); else revealChrome();
});
window.addEventListener('blur', () => { pointerDown = false; keyboardNavigation = false; });
const menuObserver = new MutationObserver(revealChrome);
$$('dialog, details').forEach(menu => menuObserver.observe(menu, { attributes: true, attributeFilter: ['open'] }));
const cameraObserver = new MutationObserver(() => { if (!$('#camera-stage').classList.contains('is-live')) revealChrome(); });
cameraObserver.observe($('#camera-stage'), { attributes: true, attributeFilter: ['class'] });
revealChrome();
$$('[data-preset]').forEach(button => { button.onclick = () => { clearHeld(); command('preset', { name: button.dataset.preset }); }; });
$$('[data-move]').forEach(button => {
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || button.disabled) return;
    event.preventDefault(); button.setPointerCapture(event.pointerId);
    press(`pointer:${event.pointerId}`, button.dataset.move);
  });
  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(eventName, event => release(`pointer:${event.pointerId}`));
  button.addEventListener('keydown', event => {
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); press(`button:${button.dataset.move}`, button.dataset.move); }
  });
  button.addEventListener('keyup', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); release(`button:${button.dataset.move}`); } });
  button.addEventListener('contextmenu', event => event.preventDefault());
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (document.fullscreenElement || $$('dialog[open]').length) { clearHeld(); return; }
    if (communityUi.isOpen()) { communityUi.close(); return; }
    clearHeld(); return;
  }
  if (!$('#hotkeys').checked || /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (keyMap[event.code]) { event.preventDefault(); press(event.code, keyMap[event.code]); }
});
document.addEventListener('keyup', event => { if (keyMap[event.code]) release(event.code); });
$('#hotkeys').onchange = () => {
  clearHeld(); $('#movement-open .button-label').textContent = $('#hotkeys').checked ? 'Movement · Keys on' : 'Movement';
};
window.addEventListener('blur', () => clearHeld());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { clearHeld(false); if (connected && isAdmin()) api('pause', {}, true).catch(() => {}); }
});
window.addEventListener('pagehide', () => { if (connected && isAdmin()) api('pause', {}, true).catch(() => {}); });

async function settings() {
  if (!$('#osc-port').reportValidity()) return;
  try { await api('settings', { oscPort: Number($('#osc-port').value) }); toast('OSC port saved.'); }
  catch { if (state) $('#osc-port').value = state.oscPort; }
}
$('#osc-port').onchange = settings;
$('#rename-form').onsubmit = event => {
  event.preventDefault(); if (!renaming) return;
  const next = $('#rename-input').value.trim();
  if (next) aliases[renaming.key] = next; else delete aliases[renaming.key];
  try { localStorage.setItem('chaos-deck-labels', JSON.stringify(aliases)); } catch { toast('Custom names cannot be saved in this browser.', 'error'); }
  renaming = null; $('#rename-dialog').close(); renderParameters(true); updateControlAvailability(); openStudioDialog('avatar-dialog');
};
$('#rename-cancel').onclick = () => $('#rename-dialog').close();
$('#rename-dialog').addEventListener('close', () => { if (renaming) { renaming = null; if (connected && isAdmin()) openStudioDialog('avatar-dialog'); } });
$('#rescan').onclick = async () => { try { await api('rescan'); toast('Avatar configurations refreshed.'); } catch { /* Shown by api. */ } };
$('#avatar-select').onchange = async event => { try { await api('avatar', { id: event.target.value }); } catch { event.target.value = state.selectedId; } };
$('#parameter-search').oninput = () => { renderParameters(); updateControlAvailability(); };
$('#favorites-filter').onclick = () => { favoritesOnly = !favoritesOnly; $('#favorites-filter').setAttribute('aria-pressed', favoritesOnly); renderParameters(); updateControlAvailability(); };
$('#load-more-controls').onclick = () => { controlPage++; renderParameters(true); updateControlAvailability(); };
$('#previous-controls').onclick = () => { controlPage = Math.max(0, controlPage - 1); renderParameters(true); updateControlAvailability(); };
for (const name of categories) {
  const button = element('button', 'category-chip', name); button.setAttribute('aria-pressed', name === category);
  button.onclick = () => { category = name; $$('.category-chip').forEach(chip => chip.setAttribute('aria-pressed', chip.textContent === name)); renderParameters(); updateControlAvailability(); };
  $('#control-categories').append(button);
}
$('#show-internals').onchange = event => { showInternals = event.target.checked; renderParameters(); updateControlAvailability(); };
$('#restore').onclick = () => command('restore');
$('#custom-type').onchange = () => { $('#custom-value').value = $('#custom-type').value === 'Bool' ? 'true' : '0'; };
$('#custom-form').onsubmit = event => {
  event.preventDefault();
  const name = $('#custom-name').value.trim();
  const type = $('#custom-type').value;
  const raw = $('#custom-value').value.trim();
  if (type === 'Bool' && !['true', 'false'].includes(raw.toLowerCase())) { toast('Bool values must be true or false.'); return; }
  command('parameter', { address: name.startsWith('/') ? name : `/avatar/parameters/${name}`, type, value: type === 'Bool' ? raw.toLowerCase() === 'true' : Number(raw) });
};

async function init() {
  const response = await fetch('/api/state');
  if (response.status === 401) { lockScreen(); return; }
  if (!response.ok) throw new Error('The bridge did not respond.');
  const initial = await response.json(); token = initial.token; connected = true; render(initial);
  events?.close(); events = new EventSource('/api/events');
  events.onmessage = event => { connected = true; render(JSON.parse(event.data)); };
  events.addEventListener('chat-history', event => communityUi.history(JSON.parse(event.data)));
  events.addEventListener('chat', event => communityUi.add(JSON.parse(event.data).message));
  events.addEventListener('presence', event => communityUi.presence(JSON.parse(event.data)));
  events.onerror = async () => {
    connected = false; communityUi.render(state, false); clearHeld(false); $('#bridge-label').textContent = 'Bridge disconnected';
    $('#bridge-dot').classList.remove('good'); updateControlAvailability(); revealChrome();
    if (!checkingAccess) {
      checkingAccess = true;
      try { const response = await fetch('/api/auth/session'); const session = await response.json(); if (!session.authenticated) await lockScreen(); } catch { /* Reconnect when the server returns. */ }
      finally { checkingAccess = false; }
    }
  };
  // A restarted server has a new token. Refresh it on each SSE reconnect.
  events.onopen = async () => {
    try { const response = await fetch('/api/state'); const next = await response.json(); if (!response.ok) { lockScreen(); return; } token = next.token; connected = true; render(next); }
    catch { connected = false; updateControlAvailability(); }
  };
}
function showAccessMode(mode) {
  authMode = mode;
  helpUi.resetPasswords(); $('#access-retry').hidden = true;
  const creating = mode !== 'login';
  $('#registration-fields').hidden = mode !== 'register';
  $('#invite-code').required = mode === 'register'; $('#invite-code').disabled = mode !== 'register';
  $('#setup-fields').hidden = mode !== 'setup';
  $('#confirmation-field').hidden = !creating;
  $('#confirm-password').required = creating; $('#confirm-password').disabled = !creating;
  $('#login-password').minLength = creating ? 12 : 1;
  $('#login-password').autocomplete = creating ? 'new-password' : 'current-password';
  $('#access-title').textContent = mode === 'setup' ? 'Your stream. Your circle.' : mode === 'register' ? 'Pull up a seat.' : 'Welcome back.';
  $('#access-description').textContent = mode === 'setup' ? 'Create the first admin account for your private stream.' : mode === 'register' ? 'Use an invitation to create your viewer account.' : accessInfo?.configured ? 'Sign in to watch and join the conversation.' : 'The first admin must set up an account on this PC.';
  $('#access-submit').textContent = mode === 'setup' ? 'Create admin account' : mode === 'register' ? 'Create account' : 'Sign in';
  $('#access-submit').disabled = mode !== 'setup' && !accessInfo?.configured;
  $('#access-switch').hidden = !accessInfo?.configured;
  $('#access-switch').textContent = mode === 'register' ? 'Already have an account? Sign in' : 'Have an invite? Create an account';
  $('#migration-note').hidden = !accessInfo?.migrated || mode !== 'login';
  $('#password-guidance').hidden = !creating;
  $('#access-recovery').hidden = mode !== 'login';
  $('#recovery-host-note').hidden = !accessInfo?.localSetup;
  $('#access-error').textContent = ''; $('#login-password').value = ''; $('#confirm-password').value = '';
}
async function lockScreen() {
  connected = false; token = ''; clearHeld(false); state = null; events?.close(); cameraUi.stopViewing(); communityUi.reset();
  $('#hotkeys').checked = false; $$('dialog[open]').forEach(dialog => dialog.close());
  document.body.classList.add('auth-loading'); $('#top').inert = true; $('#access-screen').hidden = false;
  try {
    const response = await fetch('/api/auth/session'); accessInfo = await response.json();
    showAccessMode(!accessInfo.configured && accessInfo.localSetup ? 'setup' : 'login');
  } catch { $('#access-error').textContent = 'Cannot reach Chaos Deck. On the host PC, open Start Chaos Deck.cmd, then try again.'; $('#access-retry').hidden = false; }
  updateControlAvailability();
}
$('#access-switch').onclick = () => showAccessMode(authMode === 'register' ? 'login' : 'register');
$('#access-retry').onclick = async () => {
  $('#access-retry').disabled = true;
  try { await boot(); } catch { await lockScreen(); }
  finally { $('#access-retry').disabled = false; }
};
$('#access-form').onsubmit = async event => {
  event.preventDefault(); const submitText = $('#access-submit').textContent; $('#access-submit').disabled = true; $('#access-submit').dataset.loading = 'true'; $('#access-submit').textContent = authMode === 'login' ? 'Signing in…' : 'Creating account…'; $('#access-error').textContent = '';
  try {
    if (authMode !== 'login' && $('#login-password').value !== $('#confirm-password').value) throw new Error('The passwords do not match.');
    const body = { username: $('#login-username').value.trim(), password: $('#login-password').value };
    if (authMode === 'setup') body.publicOrigin = $('#setup-origin').value.trim();
    if (authMode === 'register') body.invite = $('#invite-code').value.trim();
    const response = await fetch(`/api/auth/${authMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not sign in.');
    $('#login-password').value = ''; $('#confirm-password').value = ''; $('#invite-code').value = ''; helpUi.resetPasswords();
    $('#access-screen').hidden = true; document.body.classList.remove('auth-loading'); $('#top').inert = false;
    await init();
    if (authMode === 'setup') openStudioDialog('help-dialog');
  } catch (error) { $('#access-error').textContent = error instanceof TypeError ? 'Cannot reach the panel. Check your connection and try again.' : error.message; }
  finally { $('#access-submit').disabled = false; delete $('#access-submit').dataset.loading; $('#access-submit').textContent = submitText; }
};
async function changePassword(body) {
  events?.close();
  try { const result = await api('auth/password', body); token = result.token; return result; }
  finally { await init(); }
}
$('#sign-out').onclick = async () => { try { await api('auth/logout'); } finally { lockScreen(); } };
$('#origin-form').onsubmit = async event => {
  event.preventDefault();
  try { await api('access/origin', { origin: $('#public-origin').value.trim() }); toast('Public URL saved. Share it with an invitation code.'); } catch { /* Shown by api. */ }
};
async function boot() {
  const response = await fetch('/api/auth/session'); const session = await response.json();
  if (!session.authenticated) return lockScreen();
  document.body.classList.remove('auth-loading'); $('#top').inert = false; $('#access-screen').hidden = true;
  await init();
}
boot().catch(() => lockScreen());
