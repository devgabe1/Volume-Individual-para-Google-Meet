// Ponte entre o inject.js (roda no "MAIN world" da página, sem acesso às APIs da
// extensão) e o chrome.storage, que a página de opções também usa.
//
//   inject.js  --postMessage-->  bridge.js  --chrome.storage.local-->  options.html
//              <--postMessage--             <--storage.onChanged--
(() => {
  'use strict';
  const TAG = 'meet-volume';
  const KEY = 'settings';

  const toPage = (type, settings) => window.postMessage({ [TAG]: 'toPage', type, settings }, location.origin);

  // A ordem de carga entre os dois scripts não é garantida: o inject.js pede "ready"
  // e a ponte também envia sozinha ao carregar. Receber "init" duas vezes é inofensivo.
  const sendInit = () => chrome.storage.local.get(KEY).then((r) => toPage('init', r[KEY] || null));
  sendInit();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'toBridge') return;
    const { type, settings } = e.data;
    if (type === 'save' && settings && typeof settings === 'object') {
      chrome.storage.local.set({ [KEY]: settings });
    } else if (type === 'ready') {
      sendInit();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) toPage('changed', changes[KEY].newValue || null);
  });
})();
