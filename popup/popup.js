'use strict';

const $ = (id) => document.getElementById(id);

const TOGGLES = ['enabled', 'removeOverlays', 'blockPopups', 'autoCloseTabs'];

let state = null;

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function tell(tabId, msg) {
  return new Promise((resolve) =>
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res);
    })
  );
}

function render() {
  const { settings, host, siteDisabled, stats, lastClosed } = state;

  $('host').textContent = host || '';
  $('hostInline').textContent = host || 'this site';

  $('c-overlays').textContent = stats.overlays;
  $('c-popups').textContent = stats.popups;
  $('c-closed').textContent = stats.closed;

  for (const key of TOGGLES) $(key).checked = !!settings[key];
  $('siteOn').checked = !siteDisabled;
  $('siteOn').disabled = !host;

  $('reopen').disabled = !lastClosed;
}

async function save(patch) {
  Object.assign(state.settings, patch);
  await send({ type: 'popup:save', settings: state.settings });
}

async function init() {
  state = await send({ type: 'popup:state' });
  if (!state) return;
  render();

  for (const key of TOGGLES) {
    $(key).addEventListener('change', (e) => save({ [key]: e.target.checked }));
  }

  $('siteOn').addEventListener('change', async (e) => {
    const host = state.host;
    if (!host) return;
    const list = new Set(state.settings.disabledHosts);
    if (e.target.checked) list.delete(host);
    else list.add(host);
    await save({ disabledHosts: Array.from(list) });
    state.siteDisabled = !e.target.checked;
  });

  $('scan').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab) return;
    const res = await tell(tab.id, { type: 'scan-now' });
    if (res) {
      state.stats.overlays = res.overlays;
      state.stats.popups = res.popups;
      render();
    }
  });

  $('restore').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab) return;
    await tell(tab.id, { type: 'restore' });
    state.stats.overlays = 0;
    render();
  });

  $('allow').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab) return;
    await tell(tab.id, { type: 'allow-next-popup' });
    $('allow').textContent = 'Armed - click the link';
    setTimeout(() => window.close(), 900);
  });

  $('reopen').addEventListener('click', async () => {
    await send({ type: 'popup:reopen' });
    window.close();
  });
}

init();
