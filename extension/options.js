// Página de opções: lê e grava as mesmas configurações que o inject.js usa
// (chrome.storage.local, chave "settings"). As abas do Meet recebem as mudanças na hora.
(() => {
  'use strict';
  const KEY = 'settings';
  const DEFAULTS = { master: 1, normalize: false, autoName: true, dock: true, ui: null, people: {} };
  const ICONS = {
    volumeUp: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    volumeOff: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  };

  const $ = (id) => document.getElementById(id);
  let settings = { ...DEFAULTS };
  let lastSaved = '';

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el[k] = v;
    }
    el.append(...children);
    return el;
  }

  function save() {
    lastSaved = JSON.stringify(settings);
    chrome.storage.local.set({ [KEY]: settings });
  }

  // ---- geral
  const master = $('master');
  master.addEventListener('input', () => {
    settings.master = Number(master.value) / 100;
    $('masterPct').textContent = master.value + '%';
    save();
  });
  $('normalize').addEventListener('change', (e) => { settings.normalize = e.target.checked; save(); });
  $('autoName').addEventListener('change', (e) => { settings.autoName = e.target.checked; save(); });
  $('dock').addEventListener('change', (e) => { settings.dock = e.target.checked; save(); });
  $('resetPos').addEventListener('click', (e) => {
    settings.ui = null;
    save();
    e.target.textContent = 'Restaurado';
    setTimeout(() => { e.target.textContent = 'Restaurar'; }, 1500);
  });

  // ---- pessoas
  $('filter').addEventListener('input', renderPeople);
  $('clearAll').addEventListener('click', () => {
    const n = Object.keys(settings.people).length;
    if (!n || !confirm(`Apagar os volumes salvos de ${n} pessoa(s)?`)) return;
    settings.people = {};
    save();
    renderPeople();
  });

  function personRow(key, p) {
    const pct = h('span', { className: 'pct', textContent: Math.round(p.volume * 100) + '%' });
    const range = h('input', {
      type: 'range', min: 0, max: 200, step: 5, value: Math.round(p.volume * 100),
      ariaLabel: `Volume de ${p.name}`,
      oninput: () => {
        p.volume = Number(range.value) / 100;
        pct.textContent = range.value + '%';
        save();
      },
    });
    const mute = h('button', {
      className: 'icon-btn',
      onclick: () => { p.muted = !p.muted; paintMute(); save(); },
    });
    const paintMute = () => {
      mute.replaceChildren(icon(p.muted ? 'volumeOff' : 'volumeUp'));
      mute.classList.toggle('on', p.muted);
      mute.title = p.muted ? 'Ativar som' : 'Silenciar';
    };
    paintMute();
    const del = h('button', {
      className: 'icon-btn', title: 'Esquecer esta pessoa',
      onclick: () => { delete settings.people[key]; save(); renderPeople(); },
    }, icon('delete'));

    return h('div', { className: 'item person' },
      h('div', { className: 'text name', textContent: p.name, title: p.name }),
      h('div', { className: 'range' }, range, pct),
      mute,
      del,
    );
  }

  function renderPeople() {
    const q = $('filter').value.trim().toLocaleLowerCase();
    const entries = Object.entries(settings.people)
      .sort((a, b) => a[1].name.localeCompare(b[1].name, 'pt-BR'));
    const shown = entries.filter(([key]) => !q || key.includes(q));
    $('people').replaceChildren(...shown.map(([key, p]) => personRow(key, p)));
    $('people').hidden = shown.length === 0;
    $('empty').hidden = entries.length > 0;
    $('empty').textContent = 'Ninguém salvo ainda. Ajuste o volume de alguém numa chamada e a pessoa aparece aqui.';
    if (entries.length && !shown.length) {
      $('empty').hidden = false;
      $('empty').textContent = 'Nenhum nome encontrado.';
    }
    $('count').textContent = entries.length ? `(${entries.length})` : '';
    $('clearAll').hidden = entries.length === 0;
  }

  function render() {
    master.value = Math.round(settings.master * 100);
    $('masterPct').textContent = master.value + '%';
    $('normalize').checked = !!settings.normalize;
    $('autoName').checked = settings.autoName !== false;
    $('dock').checked = settings.dock !== false;
    renderPeople();
  }

  function load(value) {
    settings = { ...DEFAULTS, ...value, people: { ...(value && value.people) } };
    render();
  }

  // Mudanças feitas no Meet aparecem aqui também (sem atrapalhar quem está mexendo).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    const value = changes[KEY].newValue;
    if (JSON.stringify(value) === lastSaved) return;
    if (document.activeElement && document.activeElement.type === 'range') return;
    load(value);
  });

  $('version').textContent = chrome.runtime.getManifest().version;
  chrome.storage.local.get(KEY).then((r) => load(r[KEY]));
})();
