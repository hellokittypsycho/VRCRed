export function createCommunityUi({ api, get, toast, changePassword }) {
  const $ = selector => document.querySelector(selector);
  const messages = new Map(), list = $('#chat-messages'), panel = $('#chat-panel');
  let me, connected = false, unread = 0, lastRole = '';
  let relayBusy = false;
  $('#chat-relay-enabled').onchange = async event => {
    const enabled = event.target.checked, status = $('#chat-relay-status');
    relayBusy = true; event.target.disabled = true; status.textContent = ''; delete status.dataset.state;
    try {
      await api('chat/relay', { enabled }, true);
      status.dataset.state = 'success'; status.textContent = enabled ? 'New chat messages will be sent to VRChat.' : 'Chat relay off. Pending messages cleared.';
    } catch (error) {
      event.target.checked = !enabled; status.dataset.state = 'error'; status.textContent = error.message;
    } finally { relayBusy = false; event.target.disabled = !connected || me?.role !== 'admin'; }
  };
  function el(tag, className, text) {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  }
  function icon(name) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.classList.add('ui-icon');
    node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`); node.append(use); return node;
  }
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 70;
  function bottom() { list.scrollTop = list.scrollHeight; $('#chat-new').hidden = true; }
  function setOpen(open) {
    panel.hidden = !open; $('#chat-toggle').setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('chat-open', open);
    if (open) { unread = 0; $('#chat-unread').hidden = true; bottom(); if (connected) $('#chat-input').focus(); }
  }
  $('#chat-toggle').onclick = () => setOpen(panel.hidden);
  $('#chat-close').onclick = () => { setOpen(false); $('#chat-toggle').focus(); };
  $('#chat-new').onclick = bottom;
  list.addEventListener('scroll', () => { if (nearBottom()) $('#chat-new').hidden = true; });
  function row(message) {
    const node = el('article', `chat-message${message.deleted ? ' is-deleted' : ''}${message.role === 'admin' ? ' is-admin' : ''}`); node.dataset.messageId = String(message.id);
    const avatar = el('span', 'chat-avatar', message.username.slice(0, 1).toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    const head = el('div', 'chat-message-heading');
    head.append(el('strong', 'chat-username', message.username));
    if (message.role === 'admin') head.append(el('span', 'role-badge', 'ADMIN'));
    const time = el('time', '', new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    time.dateTime = new Date(message.time).toISOString(); head.append(time);
    if (me?.role === 'admin' && !message.deleted) {
      const remove = el('button', 'chat-remove'); remove.append(icon('close')); remove.title = 'Remove message';
      remove.setAttribute('aria-label', `Remove message from ${message.username}`);
      remove.onclick = () => api('chat/remove', { id: message.id }).catch(() => {}); head.append(remove);
    }
    const text = el('p', '', message.deleted ? 'Message removed by an admin.' : message.text);
    text.dir = 'auto'; node.append(avatar, head, text); return node;
  }
  function add(message, history = false) {
    const previous = messages.get(message.id), pinned = nearBottom();
    messages.set(message.id, message);
    list.querySelector('.chat-empty')?.remove();
    const existing = list.querySelector(`[data-message-id="${message.id}"]`);
    if (existing) existing.replaceWith(row(message)); else list.append(row(message));
    while (messages.size > 100) { const first = messages.keys().next().value; messages.delete(first); list.querySelector(`[data-message-id="${first}"]`)?.remove(); }
    if (history || pinned || message.userId === me?.id) bottom(); else if (!panel.hidden) $('#chat-new').hidden = false;
    if (!history && !previous && panel.hidden && message.userId !== me?.id) {
      unread++; $('#chat-unread').textContent = unread > 99 ? '99+' : String(unread); $('#chat-unread').hidden = false;
    }
  }
  function history(data) {
    messages.clear(); list.replaceChildren();
    for (const message of data.messages) add(message, true);
    if (!messages.size) list.append(el('p', 'chat-empty', 'The chat is yours. Say hello.'));
    bottom();
  }
  $('#chat-input').oninput = () => { $('#chat-count').textContent = `${$('#chat-input').value.length} / 500`; $('#chat-error').textContent = ''; };
  $('#chat-input').onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chat-form').requestSubmit(); }
  };
  let sending = false;
  $('#chat-form').onsubmit = async event => {
    event.preventDefault(); if (sending || !connected) return;
    const text = $('#chat-input').value.trim(); if (!text) return;
    sending = true; $('#chat-send').disabled = true; $('#chat-error').textContent = '';
    try { const result = await api('chat/send', { text }, true); add(result.message); $('#chat-input').value = ''; $('#chat-count').textContent = '0 / 500'; bottom(); }
    catch (error) { $('#chat-error').textContent = error.message; }
    finally { sending = false; $('#chat-send').disabled = !connected; }
  };
  async function loadAccounts() {
    if (me?.role !== 'admin') return;
    $('#accounts-list').setAttribute('aria-busy', 'true'); $('#accounts-refresh').disabled = true; $('#accounts-refresh').dataset.loading = 'true';
    if (!$('#accounts-list').children.length) $('#accounts-list').append(el('p', 'fine-print', 'Loading members…'));
    try { const [users, invites] = await Promise.all([get('accounts'), get('invites')]); renderUsers(users.users); renderInvites(invites.invites); }
    catch (error) { $('#accounts-status').dataset.state = 'error'; $('#accounts-status').textContent = error.message; }
    finally { $('#accounts-list').setAttribute('aria-busy', 'false'); $('#accounts-refresh').disabled = false; delete $('#accounts-refresh').dataset.loading; }
  }
  function renderUsers(users) {
    const container = $('#accounts-list'); container.replaceChildren();
    for (const user of users) {
      const node = el('div', `managed-account${user.disabled ? ' member-disabled' : ''}`), identity = el('div', 'managed-identity');
      const copy = el('div', ''); copy.append(el('strong', '', user.username), el('small', '', user.id === me?.id ? 'Your account' : user.disabled ? 'Account disabled' : 'Active member'));
      identity.append(el('span', 'member-avatar', user.username.slice(0, 1).toUpperCase()), copy);
      const role = el('select', ''); role.add(new Option('Viewer', 'viewer')); role.add(new Option('Admin', 'admin')); role.value = user.role;
      role.setAttribute('aria-label', `Role for ${user.username}`);
      const label = el('label', 'disable-account'), disabled = el('input', ''); disabled.type = 'checkbox'; disabled.checked = user.disabled;
      disabled.setAttribute('aria-label', `Disable ${user.username}`); label.append(disabled, document.createTextNode('Disable'));
      const save = el('button', 'secondary-button', 'Save'); save.setAttribute('aria-label', `Save ${user.username}`);
      const own = user.id === me?.id; role.disabled = disabled.disabled = own;
      const dirty = () => { save.disabled = own || (role.value === user.role && disabled.checked === user.disabled); };
      role.onchange = disabled.onchange = dirty; dirty();
      save.onclick = async () => {
        save.disabled = true; save.dataset.loading = 'true';
        try { const result = await api('accounts/update', { id: user.id, role: role.value, disabled: disabled.checked }); renderUsers(result.users); $('#accounts-status').dataset.state = 'success'; $('#accounts-status').textContent = 'Account updated. That person will need to sign in again.'; }
        catch { save.disabled = false; delete save.dataset.loading; }
      };
      node.append(identity, role, label, save); container.append(node);
    }
  }
  function renderInvites(invites) {
    const container = $('#invite-list'); container.replaceChildren();
    if (!invites.length) container.append(el('p', 'fine-print invites-empty', 'No invitations yet. Create one above.'));
    for (const invite of invites.slice(0, 12)) {
      const active = !invite.revoked && invite.uses < invite.maxUses && invite.expiresAt > Date.now();
      const node = el('div', 'managed-invite'), copy = el('div', '');
      const heading = el('div', 'invite-name');
      const state = invite.revoked ? 'Revoked' : invite.uses >= invite.maxUses ? 'Used' : invite.expiresAt <= Date.now() ? 'Expired' : 'Active';
      heading.append(el('strong', '', invite.label), el('span', `invite-state state-${state.toLowerCase()}`, state));
      copy.append(heading, el('small', '', `${invite.uses}/${invite.maxUses} used · ${invite.revoked ? 'Revoked' : invite.expiresAt <= Date.now() ? 'Expired' : `Expires ${new Date(invite.expiresAt).toLocaleDateString()}`}`)); node.append(copy);
      if (active) {
        const revoke = el('button', 'text-button', 'Revoke'); revoke.setAttribute('aria-label', `Revoke ${invite.label}`);
        revoke.onclick = async () => { try { const result = await api('invites/revoke', { id: invite.id }); renderInvites(result.invites); } catch { /* api shows the error. */ } }; node.append(revoke);
      }
      container.append(node);
    }
  }
  $('#invite-form').onsubmit = async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; button.dataset.loading = 'true';
    try {
      const result = await api('invites/create', { label: $('#invite-label').value, maxUses: Number($('#invite-uses').value), days: Number($('#invite-days').value) });
      $('#created-invite-code').textContent = result.code; $('#created-invite').hidden = false; renderInvites(result.invites);
    } catch { /* api shows the error. */ } finally { button.disabled = false; delete button.dataset.loading; }
  };
  $('#accounts-refresh').onclick = loadAccounts;
  $('#copy-invite').onclick = async () => {
    const value = $('#created-invite-code').textContent;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value); $('#copy-invite span').textContent = 'Copied';
      $('#accounts-status').dataset.state = 'success'; $('#accounts-status').textContent = 'Invitation code copied.';
      setTimeout(() => { $('#copy-invite span').textContent = 'Copy'; }, 2000);
    } catch { $('#accounts-status').dataset.state = 'error'; $('#accounts-status').textContent = 'Select the invitation code to copy it.'; }
  };
  const observer = new MutationObserver(() => { if ($('#accounts-dialog').open) { $('#accounts-status').textContent = ''; loadAccounts(); } else { $('#created-invite-code').textContent = ''; $('#created-invite').hidden = true; } });
  observer.observe($('#accounts-dialog'), { attributes: true, attributeFilter: ['open'] });
  $('#password-form').onsubmit = async event => {
    event.preventDefault(); const status = $('#password-status'); status.textContent = ''; delete status.dataset.state;
    if ($('#new-password').value !== $('#new-password-confirm').value) { status.dataset.state = 'error'; status.textContent = 'The new passwords do not match.'; return; }
    const button = event.submitter; button.disabled = true; button.dataset.loading = 'true';
    try {
      await changePassword({ currentPassword: $('#current-password').value, newPassword: $('#new-password').value });
      $('#password-form').reset(); status.dataset.state = 'success'; status.textContent = 'Password changed. Other sessions were signed out.';
    } catch (error) { status.dataset.state = 'error'; status.textContent = error.message; } finally { button.disabled = false; delete button.dataset.loading; }
  };
  function render(state, online) {
    me = state?.user; connected = online;
    if (!relayBusy) $('#chat-relay-enabled').checked = !!state?.chatRelayEnabled;
    $('#chat-relay-enabled').disabled = relayBusy || !online || me?.role !== 'admin';
    $('#chat-relay-notice').hidden = !state?.chatRelayEnabled;
    $('#chat-presence').dataset.state = online ? 'live' : 'pending';
    if (!online) $('#chat-presence').textContent = 'Reconnecting…';
    else if (Number.isInteger(state?.online)) $('#chat-presence').textContent = `${state.online} online`;
    $('#chat-input').disabled = !connected; $('#chat-send').disabled = !connected || sending;
    $('#chat-as').textContent = connected && me ? `Chatting as ${me.username}` : 'Reconnecting…';
    $('#account-open').disabled = !connected;
    $('#account-open').textContent = me?.username.slice(0, 1).toUpperCase() || 'U';
    $('#account-open').title = me ? `${me.username} · ${me.role}` : 'My account';
    $('#account-name').textContent = me?.username || ''; $('#account-avatar').textContent = me?.username.slice(0, 1).toUpperCase() || 'A'; $('#account-role').dataset.role = me?.role || ''; $('#account-role').textContent = me?.role?.toUpperCase() || '';
    if (lastRole !== me?.role) { lastRole = me?.role || ''; for (const message of messages.values()) list.querySelector(`[data-message-id="${message.id}"]`)?.replaceWith(row(message)); }
  }
  function reset() {
    setOpen(false); me = null; connected = false; messages.clear(); list.replaceChildren(); unread = 0;
    $('#chat-unread').hidden = true; $('#chat-input').value = ''; $('#chat-count').textContent = '0 / 500';
    $('#accounts-list').replaceChildren(); $('#invite-list').replaceChildren(); $('#created-invite-code').textContent = '';
    $('#password-form').reset(); $('#password-status').textContent = ''; render(null, false);
  }
  return { render, history, add, presence: data => { $('#chat-presence').textContent = `${data.online} online`; }, reset, isOpen: () => !panel.hidden, close: () => setOpen(false) };
}
