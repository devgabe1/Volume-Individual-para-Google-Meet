// Meet Volume Individual
// Roda no "MAIN world" da página do Meet, antes dos scripts do próprio Meet.
//
// Como funciona:
// 1. Interceptamos o RTCPeerConnection para saber quais faixas de áudio são remotas
//    e qual RTCRtpReceiver as entrega.
// 2. Interceptamos o setter de `srcObject` dos elementos <audio>. Quando o Meet
//    tenta tocar um stream remoto, trocamos por: stream -> GainNode -> stream novo.
//    O Meet continua tocando no mesmo elemento (respeita o dispositivo de saída escolhido).
// 3. O Meet não usa um stream por pessoa: ele mistura em poucos canais e troca quem
//    está em cada canal conforme quem fala. A identidade de quem está falando vem nos
//    CSRCs do RTP (receiver.getContributingSources()). Consultamos isso a cada ~20ms
//    e ajustamos o ganho do canal para o volume da pessoa que está nele.
// 4. Para saber o nome de cada voz, cruzamos "voz ativa" com "quadro do participante
//    animando" (indicador de fala do Meet). Volumes ficam salvos por nome.
(() => {
  'use strict';
  if (window.__meetVolume) return;

  const LOG = '[MeetVolume]';
  const POLL_MS = 10;
  const HANDOFF_MS = 60;  // janela em que duas vozes no mesmo canal contam como "trocando"
  const ACTIVE_MS = 400;
  const LEARN_MS = 150;         // frequência da amostragem voz x quadro
  const LEARN_WINDOW_MS = 300;  // "ativo agora" = mudou nos últimos 300ms
  const MIN_SAMPLES = 8;        // amostras mínimas antes de dar nome a uma voz
  const BRIDGE = 'meet-volume'; // marcador das mensagens trocadas com bridge.js
  const LEGACY_KEYS = { store: 'meetVolume:v1', ui: 'meetVolume:ui' };

  const receiversByTrack = new Map(); // track.id -> RTCRtpReceiver
  const pipes = new Set();            // canais de áudio sendo processados
  const pending = new Set();          // elementos aguardando o AudioContext liberar
  const voices = new Map();           // voiceId -> { label, name, volume, muted, lastActive, level }
  let master = 1;
  let ctx = null;
  let voiceCounter = 0;

  // ---------------------------------------------------------------- RTCPeerConnection
  const OrigPC = window.RTCPeerConnection;
  if (OrigPC) {
    const PCProxy = new Proxy(OrigPC, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget);
        pc.addEventListener('track', (e) => {
          if (e.track && e.track.kind === 'audio') {
            receiversByTrack.set(e.track.id, e.receiver);
            e.track.addEventListener('ended', () => receiversByTrack.delete(e.track.id));
          }
        });
        return pc;
      },
    });
    window.RTCPeerConnection = PCProxy;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PCProxy;
  }

  // ---------------------------------------------------------------- AudioContext
  function getCtx() {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'running') flushPending();
      });
      const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
      for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, true);
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }

  // ---------------------------------------------------------------- srcObject hook
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  const ORIG = Symbol('meetVolumeOrig');

  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get() {
      // O Meet continua enxergando o stream original que ele mesmo definiu.
      return ORIG in this ? this[ORIG] : srcDesc.get.call(this);
    },
    set(value) {
      this[ORIG] = value;
      pending.delete(this);
      let out = value;
      try {
        out = maybeProcess(this, value);
      } catch (err) {
        console.warn(LOG, 'falha ao processar áudio, usando original', err);
      }
      srcDesc.set.call(this, out);
    },
  });

  function findReceiver(stream) {
    if (!(stream instanceof MediaStream)) return null;
    if (stream.getVideoTracks().length) return null;
    const track = stream.getAudioTracks()[0];
    return track ? receiversByTrack.get(track.id) || null : null;
  }

  function maybeProcess(el, stream) {
    const receiver = findReceiver(stream);
    if (!receiver) return stream;
    const c = getCtx();
    if (c.state !== 'running') {
      // Sem gesto do usuário ainda: toca o original e troca assim que liberar.
      pending.add(el);
      return stream;
    }
    return createPipe(stream, receiver).output;
  }

  function flushPending() {
    for (const el of pending) {
      pending.delete(el);
      const stream = el[ORIG];
      const receiver = findReceiver(stream);
      if (receiver) srcDesc.set.call(el, createPipe(stream, receiver).output);
    }
  }

  function createPipe(stream, receiver) {
    const c = getCtx();

    // Bug conhecido do Chrome: stream WebRTC remoto só entrega áudio ao WebAudio
    // se também estiver ligado a um elemento de mídia. Elemento mudo resolve.
    const keepAlive = new Audio();
    keepAlive.muted = true;
    srcDesc.set.call(keepAlive, stream);
    keepAlive.play().catch(() => {});

    // source -> gain -> dry --------------------------> dest
    //                \-> compressor -> limiter -> wet -/
    // "Igualar volumes" (opcional) só troca dry/wet; o caminho comprimido existe sempre
    // para a troca ser instantânea e sem clique.
    const source = c.createMediaStreamSource(stream);
    const gain = c.createGain();
    const dest = c.createMediaStreamDestination();
    const dry = c.createGain();
    const wet = c.createGain();

    const comp = c.createDynamicsCompressor();
    // O compressor do Chrome já aplica ganho de compensação automático: quem fala
    // alto desce um pouco e quem fala baixo sobe bastante.
    comp.threshold.value = -28;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;
    const limiter = c.createDynamicsCompressor(); // teto contra estouro (volume > 100%)
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    source.connect(gain);
    gain.connect(dry).connect(dest);
    gain.connect(comp).connect(limiter).connect(wet).connect(dest);
    dry.gain.value = store.normalize ? 0 : 1;
    wet.gain.value = store.normalize ? 1 : 0;

    const pipe = { receiver, gain, dry, wet, source, keepAlive, output: dest.stream, currentVoice: null };
    pipes.add(pipe);

    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      pipes.delete(pipe);
      try { source.disconnect(); gain.disconnect(); } catch {}
      srcDesc.set.call(keepAlive, null);
    });
    return pipe;
  }

  // ---------------------------------------------------------------- configurações
  // Ficam no chrome.storage.local (via bridge.js), compartilhadas com a página de
  // opções. Volumes são salvos por nome da pessoa (IDs de áudio mudam a cada
  // chamada; o nome não).
  const DEFAULTS = { master: 1, normalize: false, autoName: true, ui: null, people: {} };
  const store = { ...DEFAULTS, people: {} };
  const storeListeners = new Set(); // a UI se inscreve para refletir mudanças vindas das opções
  const ownSaves = [];              // ecos dos nossos próprios saves, para ignorar
  let bridgeReady = false;

  function saveStore() {
    if (!bridgeReady) return; // antes de carregar, salvar apagaria o que está guardado
    const json = JSON.stringify(store);
    ownSaves.push(json);
    if (ownSaves.length > 30) ownSaves.shift();
    window.postMessage({ [BRIDGE]: 'toBridge', type: 'save', settings: JSON.parse(json) }, location.origin);
  }

  function applySettings(s) {
    const prevNormalize = store.normalize;
    Object.assign(store, DEFAULTS, s, { people: { ...(s.people || {}) } });
    master = store.master;
    for (const v of voices.values()) {
      const p = v.name.trim() && personOf(v.name);
      if (p) { v.volume = p.volume; v.muted = p.muted; v.dirty = true; }
    }
    if (store.normalize !== prevNormalize) applyNormalize();
    for (const fn of storeListeners) fn();
  }

  // Versões anteriores salvavam no localStorage do meet.google.com: migra uma vez.
  function migrateLegacy() {
    try {
      const old = JSON.parse(localStorage.getItem(LEGACY_KEYS.store));
      const ui = JSON.parse(localStorage.getItem(LEGACY_KEYS.ui));
      if (!old && !ui) return;
      applySettings({ ...old, ui: ui || null });
      saveStore();
      localStorage.removeItem(LEGACY_KEYS.store);
      localStorage.removeItem(LEGACY_KEYS.ui);
    } catch {}
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[BRIDGE] !== 'toPage') return;
    const { type, settings } = e.data;
    if (type === 'init') {
      if (bridgeReady) return; // a ponte pode mandar "init" duas vezes
      bridgeReady = true;
      if (settings) applySettings(settings);
      else migrateLegacy();
    } else if (type === 'changed' && settings) {
      if (ownSaves.includes(JSON.stringify(settings))) return;
      applySettings(settings);
    }
  });
  window.postMessage({ [BRIDGE]: 'toBridge', type: 'ready' }, location.origin);

  function applyNormalize() {
    if (!ctx) return;
    const on = store.normalize;
    for (const p of pipes) {
      p.dry.gain.setTargetAtTime(on ? 0 : 1, ctx.currentTime, 0.03);
      p.wet.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.03);
    }
  }

  function setNormalize(on) {
    store.normalize = on;
    saveStore();
    applyNormalize();
  }

  const nameKey = (name) => name.trim().toLocaleLowerCase();

  const personOf = (name) => store.people[nameKey(name)] || null;

  // Salva o volume de uma pessoa e aplica em todas as vozes com esse nome.
  function setPerson(name, patch) {
    const key = nameKey(name);
    if (!key) return;
    const p = { name: name.trim(), volume: 1, muted: false, ...store.people[key], ...patch };
    store.people[key] = p;
    saveStore();
    for (const v of voices.values()) {
      if (v.name.trim() && nameKey(v.name) === key) {
        v.volume = p.volume;
        v.muted = p.muted;
        v.dirty = true;
      }
    }
  }

  // Ajuste feito pelo usuário numa voz (painel). Se ela tem nome, vale para a pessoa.
  function adjust(v, patch) {
    Object.assign(v, patch);
    v.touched = true;
    v.dirty = true;
    if (v.name.trim()) setPerson(v.name, { volume: v.volume, muted: v.muted });
  }

  function setName(v, name, source) {
    const renaming = v.name.trim() !== '';
    v.name = name;
    v.nameSource = name.trim() ? source : '';
    v.dirty = true;
    if (!name.trim()) return;
    const saved = store.people[nameKey(name)];
    // Se o usuário mexeu no volume de uma voz ainda sem nome, esse ajuste vale mais
    // que o salvo. Numa renomeação, o volume ajustado era da pessoa antiga.
    if (saved && !(v.touched && !renaming)) {
      v.volume = saved.volume;
      v.muted = saved.muted;
    } else if (v.touched) {
      setPerson(name, { volume: v.volume, muted: v.muted });
    }
  }

  // ---------------------------------------------------------------- quem está falando
  function getVoice(id) {
    let v = voices.get(id);
    if (!v) {
      v = {
        id, label: `Voz ${++voiceCounter}`, name: '', nameSource: '',
        volume: 1, muted: false, touched: false, lastActive: 0, level: 0, dirty: true,
      };
      voices.set(id, v);
    }
    return v;
  }

  function currentVoiceOf(receiver) {
    // CSRC = participante original misturado neste canal. Pega o mais recente.
    const csrcs = receiver.getContributingSources ? receiver.getContributingSources() : [];
    let best = null;
    for (const s of csrcs) if (!best || s.timestamp > best.timestamp) best = s;
    if (best) {
      // Vozes que tocaram neste canal nos últimos HANDOFF_MS: durante uma troca de
      // pessoa, as duas aparecem aqui.
      const recent = csrcs.filter((s) => best.timestamp - s.timestamp < HANDOFF_MS).map((s) => 'c' + s.source);
      return { id: 'c' + best.source, level: best.audioLevel ?? 0, timestamp: best.timestamp, recent };
    }

    // Sem CSRC: o canal em si representa uma fonte (SSRC).
    const ssrcs = receiver.getSynchronizationSources ? receiver.getSynchronizationSources() : [];
    if (ssrcs.length) {
      const id = 's' + ssrcs[0].source;
      return { id, level: ssrcs[0].audioLevel ?? 0, timestamp: ssrcs[0].timestamp, recent: [id] };
    }
    return null;
  }

  const targetOf = (v) => (v.muted ? 0 : v.volume * master);

  function tick() {
    const now = performance.now();
    for (const pipe of pipes) {
      const info = currentVoiceOf(pipe.receiver);
      if (!info) continue;
      const v = getVoice(info.id);
      v.level = info.level;
      if (info.timestamp !== pipe.lastTimestamp && info.level > 0.01) v.lastActive = now;
      pipe.lastTimestamp = info.timestamp;

      // Na troca de pessoa no canal, o volume novo chega alguns ms atrasado. Para não
      // tocar o começo da fala de alguém com o volume alto de quem falava antes,
      // usamos o MENOR volume entre as vozes que acabaram de passar pelo canal.
      let target = targetOf(v);
      for (const id of info.recent) {
        const other = voices.get(id);
        if (other && other !== v) target = Math.min(target, targetOf(other));
      }

      const switched = pipe.currentVoice !== info.id;
      pipe.currentVoice = info.id;
      if (switched || Math.abs(pipe.gain.gain.value - target) > 0.001) {
        // Rampa curta na troca (sem clique), mais suave em ajustes normais.
        if (switched) pipe.gain.gain.cancelScheduledValues(ctx.currentTime);
        pipe.gain.gain.setTargetAtTime(target, ctx.currentTime, switched ? 0.004 : 0.02);
      }
    }
  }
  setInterval(tick, POLL_MS);

  // ---------------------------------------------------------------- identificação automática
  // Os quadros dos participantes têm [data-participant-id]. Quando alguém fala, o Meet
  // anima o indicador de áudio do quadro dela (muda class/style). Não dependemos de
  // nenhuma classe específica: só observamos "o quadro X está mudando agora" e cruzamos
  // estatisticamente com "a voz Y está ativa agora".
  //
  // Para cada voz, medimos a taxa de vezes em que cada quadro estava animado enquanto
  // SÓ aquela voz falava, e subtraímos a taxa de base do quadro (quando nenhuma voz
  // remota fala). Isso elimina quadros que vivem mudando e o seu próprio quadro.
  const tileLastChange = new Map(); // participantId -> performance.now()
  const stats = new Map();          // voiceId -> { n, hits: Map<pid, count> }
  const baseline = { n: 0, hits: new Map() };

  function watchTiles() {
    new MutationObserver((mutations) => {
      const now = performance.now();
      for (const m of mutations) {
        const el = m.target;
        if (el.nodeName === 'VIDEO') continue;
        const tile = el.closest && el.closest('[data-participant-id]');
        if (tile) tileLastChange.set(tile.getAttribute('data-participant-id'), now);
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  const ICON_TEXT = /^[a-z0-9_]+$/; // ícones Material são texto tipo "mic_off"

  function tileName(pid) {
    for (const tile of document.querySelectorAll(`[data-participant-id="${CSS.escape(pid)}"]`)) {
      const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.trim();
        if (!text || text.length > 60 || ICON_TEXT.test(text)) continue;
        const parent = node.parentElement;
        if (!parent || !parent.getClientRects().length) continue; // tooltips escondidos
        return text;
      }
    }
    return null;
  }

  function bump(bucket, activeTiles) {
    bucket.n++;
    bucket.total = (bucket.total || 0) + 1; // sem decaimento, usado pelos avisos
    for (const pid of activeTiles) bucket.hits.set(pid, (bucket.hits.get(pid) || 0) + 1);
    // Decaimento: o modelo se adapta se a pessoa sair e outra entrar.
    if (bucket.n > (bucket === baseline ? 300 : 80)) {
      bucket.n /= 2;
      for (const [k, c] of bucket.hits) bucket.hits.set(k, c / 2);
    }
  }

  function learn() {
    const now = performance.now();
    const activeVoices = [];
    for (const v of voices.values()) if (now - v.lastActive < LEARN_WINDOW_MS) activeVoices.push(v);
    if (activeVoices.length > 1) return; // ambíguo, ignora

    const pids = new Set();
    for (const el of document.querySelectorAll('[data-participant-id]')) pids.add(el.getAttribute('data-participant-id'));
    const activeTiles = [...pids].filter((pid) => now - (tileLastChange.get(pid) || 0) < LEARN_WINDOW_MS);

    if (activeVoices.length === 0) {
      bump(baseline, activeTiles);
      return;
    }

    const v = activeVoices[0];
    let s = stats.get(v.id);
    if (!s) stats.set(v.id, (s = { n: 0, hits: new Map() }));
    bump(s, activeTiles);
    if (s.n < MIN_SAMPLES || v.nameSource === 'manual' || !store.autoName) return;

    let best = null, second = null;
    for (const pid of pids) {
      const rate = (s.hits.get(pid) || 0) / s.n;
      const base = baseline.n ? (baseline.hits.get(pid) || 0) / baseline.n : 0;
      const cand = { pid, rate, lift: rate - base };
      if (!best || cand.lift > best.lift) { second = best; best = cand; }
      else if (!second || cand.lift > second.lift) second = cand;
    }
    if (!best || best.rate < 0.5 || best.lift < 0.3) return;
    if (second && best.lift - second.lift < 0.15) return;

    v.pid = best.pid;
    const name = tileName(best.pid);
    if (name && name !== v.name) {
      console.info(LOG, `${v.label} identificada como "${name}"`);
      setName(v, name, 'auto');
    }
  }

  // ---------------------------------------------------------------- avisos
  // Detecta quando o Meet mudou algo por dentro e a extensão deixou de funcionar.
  let remoteSince = 0;      // primeira vez que vimos áudio remoto (RTCPeerConnection)
  let unknownAudioSince = 0; // <audio> tocando stream que não passou pelo nosso hook

  function health() {
    const now = performance.now();
    const issues = []; // { level: 'error' | 'info', text }

    if (pending.size) {
      issues.push({ level: 'error', text: 'Clique em qualquer lugar da página para ativar o controle de volume.' });
    }

    if (receiversByTrack.size && !remoteSince) remoteSince = now;
    if (remoteSince && !pipes.size && !pending.size && now - remoteSince > 10000) {
      issues.push({ level: 'error', text: 'O áudio da chamada não está passando pela extensão. O Meet pode ter mudado; o volume individual não está funcionando.' });
    }

    let unknown = false;
    if (!receiversByTrack.size) {
      for (const el of document.querySelectorAll('audio')) {
        const s = srcDesc.get.call(el);
        if (s instanceof MediaStream && s.getAudioTracks().some((t) => t.readyState === 'live')) { unknown = true; break; }
      }
    }
    if (!unknown) unknownAudioSince = 0;
    else if (!unknownAudioSince) unknownAudioSince = now;
    if (unknownAudioSince && now - unknownAudioSince > 15000) {
      issues.push({ level: 'error', text: 'Não consegui interceptar a conexão de áudio do Meet. Recarregue a página; se continuar, o Meet mudou.' });
    }

    const hasTiles = !!document.querySelector('[data-participant-id]');
    let learned = false, unnamed = false;
    for (const [id, s] of stats) {
      const v = voices.get(id);
      if (s.total >= 40) learned = true;
      if (s.total >= 60 && v && !v.nameSource) unnamed = true;
    }
    if (learned && !hasTiles) {
      issues.push({ level: 'error', text: 'Não encontrei os quadros dos participantes. Nomes automáticos indisponíveis: digite os nomes à mão.' });
    } else if (unnamed) {
      issues.push({ level: 'info', text: 'Algumas vozes não foram identificadas automaticamente. Digite o nome delas à mão.' });
    }
    return issues;
  }

  // ---------------------------------------------------------------- API para depuração
  window.__meetVolume = {
    voices,
    store,
    stats,
    baseline,
    health,
    get master() { return master; },
    get active() { return pipes.size; },
  };

  // ---------------------------------------------------------------- UI
  // Meet usa Trusted Types: nada de innerHTML, só createElement/textContent.
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v; // input.list é só leitura
      else el.setAttribute(k, v);
    }
    for (const c of children) el.append(c);
    return el;
  }

  // Ícones Material (mesmo conjunto usado pelo Meet), viewBox 24x24.
  const ICONS = {
    volumeUp: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    volumeOff: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  };

  function icon(name, size = 20) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  // Botão de silenciar: alto-falante normal ou cortado (vermelho, como no Meet).
  function setMuteIcon(btn, muted) {
    btn.replaceChildren(icon(muted ? 'volumeOff' : 'volumeUp', 18));
    btn.classList.toggle('on', muted);
    btn.title = muted ? 'Ativar som' : 'Silenciar';
  }

  const FAB = 40;
  const PANEL_W = 320;
  const HIDE_SILENT_MS = 10 * 60e3; // some da lista quem não fala há 10 min
  const HIDE_GONE_MS = 2 * 60e3;    // ...ou há 2 min, se o quadro dela sumiu

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: 'Google Sans', Roboto, Arial, sans-serif; }
    [hidden] { display: none !important; }
    .fab {
      position: fixed; z-index: 2147483647; touch-action: none;
      width: ${FAB}px; height: ${FAB}px; border-radius: 50%; border: none; cursor: grab;
      background: #3c4043; color: #e8eaed; padding: 0; display: grid; place-items: center;
      box-shadow: 0 2px 8px rgba(0,0,0,.4);
    }
    .fab:hover { background: #5f6368; }
    .fab.dragging { cursor: grabbing; }
    .behind { visibility: hidden !important; }
    .fab.alert::after {
      content: ''; position: absolute; top: 2px; right: 2px; width: 10px; height: 10px;
      border-radius: 50%; background: #ea4335; border: 2px solid #3c4043;
    }
    .panel {
      position: fixed; z-index: 2147483647;
      width: ${PANEL_W}px; max-height: 60vh; overflow: auto; padding: 12px;
      background: #202124; color: #e8eaed; border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,.5); font-size: 13px;
    }
    h3 { margin: 0 0 4px; font-size: 15px; font-weight: 500; cursor: grab; user-select: none; touch-action: none; }
    .hint { color: #9aa0a6; font-size: 12px; margin: 0 0 10px; }
    .warn { margin: 0 0 8px; padding: 6px 8px; border-radius: 6px; font-size: 12px; line-height: 1.4; }
    .warn.error { background: #5c2b29; color: #f6aea9; }
    .warn.info { background: #2d3a4f; color: #aecbfa; }
    .row { padding: 8px 0; border-top: 1px solid #3c4043; }
    .top { display: flex; align-items: center; gap: 8px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #5f6368; flex: none; transition: background .1s; }
    .dot.on { background: #34a853; box-shadow: 0 0 6px #34a853; }
    input[type=text] {
      flex: 1; min-width: 0; background: #303134; color: #e8eaed;
      border: 1px solid #5f6368; border-radius: 6px; padding: 4px 6px; font-size: 13px;
    }
    .auto { font-size: 10px; color: #8ab4f8; border: 1px solid #8ab4f8; border-radius: 4px; padding: 0 4px; flex: none; }
    .mute {
      flex: none; width: 28px; height: 28px; padding: 0; border: none; border-radius: 50%;
      display: grid; place-items: center; cursor: pointer; background: none; color: #e8eaed;
    }
    .mute:hover { background: rgba(232,234,237,.12); }
    .mute.on { background: #ea4335; color: #fff; }
    .bottom { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    input[type=range] { flex: 1; min-width: 0; accent-color: #8ab4f8; }
    .pct { width: 42px; text-align: right; color: #9aa0a6; font-variant-numeric: tabular-nums; }
    .empty { color: #9aa0a6; padding: 8px 0; }
    .switch { display: flex; align-items: flex-start; gap: 10px; margin-top: 10px; cursor: pointer; }
    .switch input { position: absolute; opacity: 0; pointer-events: none; }
    .track {
      flex: none; position: relative; width: 32px; height: 18px; margin-top: 1px;
      border-radius: 9px; background: #5f6368; transition: background .15s;
    }
    .track::after {
      content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
      border-radius: 50%; background: #e8eaed; transition: transform .15s;
    }
    .switch input:checked + .track { background: #8ab4f8; }
    .switch input:checked + .track::after { transform: translateX(14px); background: #202124; }
    .switch input:focus-visible + .track { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    .switch .desc { color: #9aa0a6; font-size: 11px; margin-top: 2px; }
    .more { background: none; border: none; color: #8ab4f8; cursor: pointer; font-size: 12px; padding: 8px 0 0; }
    .tile {
      position: fixed; z-index: 2147483647; width: 220px; padding: 8px 10px;
      background: rgba(32,33,36,.92); color: #e8eaed; border-radius: 10px;
      box-shadow: 0 2px 10px rgba(0,0,0,.5); font-size: 12px;
    }
    .tile .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
    .tile .sub { color: #9aa0a6; font-size: 11px; }
    .tile .bottom { margin-top: 4px; }
  `;

  function slider(value, onChange) {
    const pct = h('span', { className: 'pct' });
    const range = h('input', {
      type: 'range', min: '0', max: '200', step: '5',
      oninput: () => {
        pct.textContent = range.value + '%';
        onChange(Number(range.value) / 100);
      },
    });
    const set = (x) => {
      range.value = String(Math.round(x * 100));
      pct.textContent = range.value + '%';
    };
    set(value);
    return { el: h('div', { className: 'bottom' }, range, pct), range, set };
  }

  function toggle(label, desc, checked, onChange) {
    const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
    return h('label', { className: 'switch' },
      input,
      h('span', { className: 'track' }),
      h('span', {}, h('div', { textContent: label }), h('div', { className: 'desc', textContent: desc })),
    );
  }

  function buildRow(v, datalistId) {
    const dot = h('span', { className: 'dot' });
    const auto = h('span', { className: 'auto', textContent: 'auto', title: 'Nome detectado automaticamente' });
    const name = h('input', {
      type: 'text', placeholder: v.label, list: datalistId,
      // "change" = ao sair do campo / Enter: aí aplica o volume salvo daquele nome.
      onchange: () => setName(v, name.value, 'manual'),
    });
    const mute = h('button', {
      className: 'mute', title: 'Silenciar',
      onclick: () => { adjust(v, { muted: !v.muted }); refresh(); },
    });
    const vol = slider(v.volume, (x) => adjust(v, { volume: x }));
    const row = h('div', { className: 'row' }, h('div', { className: 'top' }, dot, name, auto, mute), vol.el);

    const refresh = () => {
      if (name.getRootNode().activeElement !== name) name.value = v.name;
      auto.hidden = v.nameSource !== 'auto';
      setMuteIcon(mute, v.muted);
      vol.set(v.volume);
    };
    return { row, dot, refresh };
  }

  function savedPos() {
    const s = store.ui;
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return { x: s.x, y: s.y };
    return { x: 16, y: window.innerHeight - 96 - FAB };
  }

  function mountUI() {
    const host = h('div', { id: 'meet-volume-root' });
    const root = host.attachShadow({ mode: 'open' });
    root.append(h('style', { textContent: STYLE }));

    // Sugestões de nome para digitar manualmente: nomes vistos nos quadros.
    const datalistId = 'meet-volume-names';
    const datalist = h('datalist', { id: datalistId });

    const header = h('h3', { textContent: 'Volume individual', title: 'Arraste para mover' });
    const warnings = h('div');
    const list = h('div');
    const empty = h('div', { className: 'empty', textContent: 'Nenhuma voz detectada ainda. Entre na chamada e espere alguém falar.' });
    const masterSlider = slider(master, (x) => { master = x; store.master = x; saveStore(); });
    const normalizeToggle = toggle('Igualar volumes',
      'Aproxima o volume de quem fala alto e de quem fala baixo, e evita som estourado acima de 100%.',
      !!store.normalize, setNormalize);
    let showAll = false;
    const more = h('button', { className: 'more', onclick: () => { showAll = !showAll; render(); } });
    const panel = h('div', { className: 'panel', hidden: true },
      header,
      h('p', { className: 'hint', textContent: 'Nomes são detectados sozinhos e os volumes ficam salvos por nome. Passe o mouse sobre o vídeo de alguém para ajustar direto.' }),
      warnings,
      h('div', { className: 'row' },
        h('div', { className: 'top' }, h('strong', { textContent: 'Geral' })),
        masterSlider.el,
        normalizeToggle,
      ),
      empty,
      list,
      more,
      datalist,
    );
    const fab = h('button', { className: 'fab', title: 'Volume individual (arraste para mover)' }, icon('volumeUp', 22));
    const tile = buildTileControl();
    root.append(panel, fab, tile.el);
    document.documentElement.append(host);

    // ---- posição do botão e do painel (arrastáveis, posição salva)
    let pos = savedPos();

    // Mudanças feitas na página de opções (ou a carga inicial das configurações).
    storeListeners.add(() => {
      masterSlider.set(master);
      normalizeToggle.querySelector('input').checked = !!store.normalize;
      pos = savedPos();
      layout();
    });

    function layout() {
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      pos.x = Math.min(Math.max(pos.x, 4), vw - FAB - 4);
      pos.y = Math.min(Math.max(pos.y, 4), vh - FAB - 4);
      fab.style.left = pos.x + 'px';
      fab.style.top = pos.y + 'px';
      if (panel.hidden) return;
      // Painel abre acima do botão se couber; senão, abaixo. Alinhado pela esquerda.
      const ph = panel.offsetHeight;
      const above = pos.y - ph - 8;
      panel.style.top = (above >= 4 ? above : Math.min(pos.y + FAB + 8, vh - ph - 4)) + 'px';
      panel.style.left = Math.min(Math.max(pos.x, 4), vw - PANEL_W - 4) + 'px';
    }

    function draggable(handle, onClick) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y;
        let moved = false;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          fab.classList.add('dragging');
          pos.x = ox + dx;
          pos.y = oy + dy;
          layout();
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          fab.classList.remove('dragging');
          if (moved) {
            store.ui = { x: Math.round(pos.x), y: Math.round(pos.y) };
            saveStore();
          } else if (onClick) {
            onClick();
          }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    }

    draggable(fab, () => { panel.hidden = !panel.hidden; render(); layout(); });
    draggable(header);
    window.addEventListener('resize', layout);
    layout();

    // ---- lista: quem falou por último no topo; esconde quem saiu
    const rows = new Map();
    let interacting = false; // não reordena enquanto o usuário mexe na lista
    list.addEventListener('pointerenter', () => { interacting = true; });
    list.addEventListener('pointerleave', () => { interacting = false; });
    list.addEventListener('focusin', () => { interacting = true; });
    list.addEventListener('focusout', () => { interacting = false; });
    let lastOrder = '';
    let lastReorder = 0;

    function visible(v, now, pids) {
      if (showAll) return true;
      if (!v.lastActive) return false; // nunca falou: canal vazio/ruído
      if (now - v.lastActive > HIDE_SILENT_MS) return false;
      if (v.pid && !pids.has(v.pid) && now - v.lastActive > HIDE_GONE_MS) return false;
      return true;
    }

    function render() {
      const now = performance.now();
      const pids = new Set();
      for (const el of document.querySelectorAll('[data-participant-id]')) pids.add(el.getAttribute('data-participant-id'));

      let shown = 0;
      for (const v of voices.values()) {
        let r = rows.get(v.id);
        if (!r) {
          r = buildRow(v, datalistId);
          rows.set(v.id, r);
          list.append(r.row);
        }
        if (v.dirty) { v.dirty = false; r.refresh(); }
        r.dot.classList.toggle('on', now - v.lastActive < ACTIVE_MS);
        r.row.hidden = !visible(v, now, pids);
        if (!r.row.hidden) shown++;
      }

      if (!interacting && now - lastReorder > 1000) {
        lastReorder = now;
        const sorted = [...voices.values()].sort((a, b) => b.lastActive - a.lastActive);
        const order = sorted.map((v) => v.id).join();
        if (order !== lastOrder) {
          lastOrder = order;
          list.replaceChildren(...sorted.map((v) => rows.get(v.id).row));
        }
      }

      const hiddenCount = voices.size - shown;
      empty.hidden = shown > 0;
      more.hidden = !showAll && hiddenCount === 0;
      more.textContent = showAll ? 'Esconder inativos' : `Mostrar todos (${hiddenCount} ocultos)`;

      const names = new Set();
      for (const pid of pids) {
        const n = tileName(pid);
        if (n) names.add(n);
      }
      for (const p of Object.values(store.people)) names.add(p.name);
      datalist.replaceChildren(...[...names].map((n) => h('option', { value: n })));
    }

    setInterval(() => { if (!panel.hidden) { render(); layout(); } }, 250);

    // ---- nunca cobrir menus e janelas do Meet
    // Nossa UI fica no z-index máximo para não sumir atrás dos vídeos. Quando o Meet
    // abre um menu/diálogo (identificado pelo papel de acessibilidade, que é estável)
    // e ele encosta em algo nosso, escondemos só o que está por cima até ele fechar.
    const MEET_POPUPS = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

    function yieldToMeetPopups() {
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      const popups = [];
      for (const el of document.querySelectorAll(MEET_POPUPS)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.width >= vw * 0.95 && r.height >= vh * 0.95) continue; // contêiner de página, não um menu
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
        popups.push(r);
      }
      for (const el of [fab, panel, tile.el]) {
        if (el.hidden) { el.classList.remove('behind'); continue; }
        const r = el.getBoundingClientRect();
        el.classList.toggle('behind', popups.some((p) => overlaps(r, p)));
      }
    }
    setInterval(yieldToMeetPopups, 150);

    // ---- avisos
    const warned = new Set();
    setInterval(() => {
      const issues = health();
      fab.classList.toggle('alert', issues.some((i) => i.level === 'error'));
      warnings.replaceChildren(...issues.map((i) => h('div', { className: `warn ${i.level}`, textContent: i.text })));
      for (const i of issues) {
        if (!warned.has(i.text)) { warned.add(i.text); console.warn(LOG, i.text); }
      }
    }, 1000);

    // ---- controle ao passar o mouse sobre o quadro de alguém
    let frame = 0, lastEvent = null, hideTimer = 0;
    document.addEventListener('pointermove', (e) => {
      lastEvent = e;
      if (!frame) frame = requestAnimationFrame(onHover);
    }, { capture: true, passive: true });

    function onHover() {
      frame = 0;
      const e = lastEvent;
      if (e.composedPath().includes(host)) { clearTimeout(hideTimer); return; }
      const t = findTile(e);
      if (t && tile.showFor(t)) clearTimeout(hideTimer);
      else { clearTimeout(hideTimer); hideTimer = setTimeout(tile.hide, 400); }
    }
  }

  // Quadro (o elemento mais externo com [data-participant-id]) sob o ponteiro.
  function findTile(e) {
    let t = e.target instanceof Element ? e.target.closest('[data-participant-id]') : null;
    if (!t) {
      // Camadas transparentes do Meet podem ficar por cima do vídeo.
      t = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.matches('[data-participant-id]')) || null;
    }
    if (!t) return null;
    const pid = t.getAttribute('data-participant-id');
    for (let p = t.parentElement?.closest('[data-participant-id]'); p && p.getAttribute('data-participant-id') === pid;
      p = p.parentElement?.closest('[data-participant-id]')) t = p;
    return t;
  }

  function buildTileControl() {
    const name = h('div', { className: 'name' });
    const sub = h('div', { className: 'sub' });
    let current = null; // nome da pessoa no quadro
    const vol = slider(1, (x) => current && setPerson(current, { volume: x }));
    const mute = h('button', {
      className: 'mute', title: 'Silenciar',
      onclick: () => {
        if (!current) return;
        setPerson(current, { muted: !(personOf(current)?.muted) });
        refresh();
      },
    });
    vol.el.prepend(mute);
    const el = h('div', { className: 'tile', hidden: true }, name, sub, vol.el);

    function refresh() {
      const p = personOf(current) || { volume: 1, muted: false };
      if (el.getRootNode().activeElement !== vol.range) vol.set(p.volume);
      setMuteIcon(mute, p.muted);
      const key = nameKey(current);
      const heard = [...voices.values()].some((v) => v.name.trim() && nameKey(v.name) === key);
      sub.textContent = heard ? '' : 'Voz ainda não identificada — o volume vale quando for.';
      sub.hidden = heard;
    }

    function showFor(tileEl) {
      const n = tileName(tileEl.getAttribute('data-participant-id'));
      if (!n) return false;
      current = n;
      name.textContent = n;
      refresh();
      el.hidden = false;

      const r = tileEl.getBoundingClientRect();
      // Quadro grande (vídeo): o controle fica dentro dele, encolhendo se preciso.
      const inside = r.width >= 176 && r.height >= 96;
      el.style.width = (inside ? Math.min(220, r.width - 16) : 220) + 'px';
      const w = el.offsetWidth, hgt = el.offsetHeight;
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      let x, y;
      if (inside) {
        x = r.left + 8; y = r.top + 8;          // dentro do vídeo, canto superior esquerdo
      } else {
        x = r.left - w - 8 >= 4 ? r.left - w - 8 : r.right + 8; // item pequeno (lista de pessoas)
        y = r.top + (r.height - hgt) / 2;
      }
      el.style.left = Math.min(Math.max(x, 4), vw - w - 4) + 'px';
      el.style.top = Math.min(Math.max(y, 4), vh - hgt - 4) + 'px';
      return true;
    }

    return { el, showFor, hide: () => { el.hidden = true; } };
  }

  function start() {
    watchTiles();
    setInterval(learn, LEARN_MS);
    mountUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
