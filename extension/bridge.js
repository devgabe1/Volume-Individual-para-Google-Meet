// Ponte entre o inject.js (roda no "MAIN world" da página, sem acesso às APIs da
// extensão) e o chrome.storage, que a página de opções também usa.
//
//   inject.js  --postMessage-->  bridge.js  --chrome.storage.local-->  options.html
//              <--postMessage--             <--storage.onChanged--
(() => {
  'use strict';
  const TAG = 'meet-volume';
  const KEY = 'settings';

  const version = chrome.runtime.getManifest().version;
  const toPage = (type, settings) => window.postMessage({ [TAG]: 'toPage', type, settings, version }, location.origin);

  // Extensão recarregada/atualizada com a aba aberta: esta ponte fica órfã e qualquer
  // chamada chrome.* lança "Extension context invalidated". Os ajustes da aba deixam
  // de ser salvos até ela ser recarregada; não há o que fazer além de não quebrar.
  const alive = () => { try { return !!chrome.runtime.id; } catch { return false; } };

  // A ordem de carga entre os dois scripts não é garantida: o inject.js pede "ready"
  // e a ponte também envia sozinha ao carregar. Receber "init" duas vezes é inofensivo.
  const sendInit = () => {
    if (!alive()) return;
    chrome.storage.local.get(KEY).then((r) => toPage('init', r[KEY] || null)).catch(() => {});
  };
  sendInit();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'toBridge') return;
    const { type, settings } = e.data;
    if (type === 'save' && settings && typeof settings === 'object') {
      if (alive()) chrome.storage.local.set({ [KEY]: settings }).catch(() => {});
    } else if (type === 'ready') {
      sendInit();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) toPage('changed', changes[KEY].newValue || null);
  });
})();
