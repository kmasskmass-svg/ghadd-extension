// غضّ – سكربت المحتوى: يكشف الوجوه وجنسها واليدين في الصور والمقاطع ويغطّيها.
(() => {
  if (window.__ghaddLoaded) return;
  window.__ghaddLoaded = true;

  const api = globalThis.browser ?? chrome;
  const DEFAULTS = {
    enabled: true, mode: 'auto', style: 'blur', strength: 80, target: 'women',
    sensitivity: 'mid', prehide: true, failCover: true, disabledSites: []
  };
  const MIN_SIZE = 40;          // تُتجاهل الصور الأصغر من هذا (أيقونات)
  const VIDEO_INTERVAL = 220;   // تحليل المقطع كل ~0.2 ثانية أثناء التشغيل
  const ATTR = 'data-ghadd';

  let S = { ...DEFAULTS };
  let human = null;
  let loading = null;
  let failedInit = false;

  const tracked = new Set();    // كل عناصر img/video المتابعة
  const covered = new Set();    // عناصر عليها أغطية جزئية
  const queue = [];
  const queued = new Set();
  let working = false;

  // ---------- الإعدادات ----------
  const host = location.hostname;
  const active = () => S.enabled && !(S.disabledSites || []).includes(host);

  function applyRootState() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle('ghadd-on', active());
    root.classList.toggle('ghadd-prehide', active() && S.prehide);
    root.style.setProperty('--ghadd-blur', Math.round(8 + (S.strength / 100) * 40) + 'px');
    root.style.setProperty('--ghadd-solid-alpha', String(0.55 + (S.strength / 100) * 0.45));
  }

  // ---------- الأنماط ----------
  function injectStyle() {
    if (document.getElementById('ghadd-style')) return;
    const st = document.createElement('style');
    st.id = 'ghadd-style';
    st.textContent = `
      html.ghadd-on.ghadd-prehide img:not([${ATTR}]),
      html.ghadd-on.ghadd-prehide video:not([${ATTR}]) { filter: blur(24px) !important; clip-path: inset(0) !important; }
      html.ghadd-on img[${ATTR}="full"], html.ghadd-on video[${ATTR}="full"] {
        filter: blur(var(--ghadd-blur, 40px)) !important; clip-path: inset(0) !important;
      }
      html.ghadd-on.ghadd-solid img[${ATTR}="full"], html.ghadd-on.ghadd-solid video[${ATTR}="full"] {
        filter: blur(var(--ghadd-blur, 40px)) brightness(0.35) saturate(0) !important; clip-path: inset(0) !important;
      }
      #ghadd-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; overflow: hidden; contain: strict; }
      #ghadd-layer > div { position: fixed; left: 0; top: 0; pointer-events: none; border-radius: 12px; will-change: transform; }
      html:not(.ghadd-on) #ghadd-layer { display: none !important; }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------- طبقة الأغطية ----------
  let layer = null;
  function getLayer() {
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'ghadd-layer';
      layer.setAttribute('aria-hidden', 'true');
    }
    const fs = document.fullscreenElement;
    const parent = fs && !/^(VIDEO|IMG)$/.test(fs.tagName) ? fs : document.documentElement;
    if (layer.parentNode !== parent) parent.appendChild(layer);
    return layer;
  }
  document.addEventListener('fullscreenchange', () => { getLayer(); kick(); });

  function coverStyle(div) {
    if (S.style === 'solid') {
      div.style.background = `rgba(14,107,95,var(--ghadd-solid-alpha,1))`;
      div.style.backdropFilter = 'blur(var(--ghadd-blur))';
    } else {
      div.style.background = 'rgba(14,107,95,0.25)';
      div.style.backdropFilter = 'blur(var(--ghadd-blur))';
    }
    div.style.webkitBackdropFilter = div.style.backdropFilter;
  }

  // ---------- محرك الكشف ----------
  async function initHuman() {
    if (human) return human;
    if (failedInit) return null;
    if (!loading) {
      loading = (async () => {
        try {
          const mod = await import(api.runtime.getURL('lib/human.esm.js'));
          const Human = mod.Human || mod.default;
          const h = new Human({
            modelBasePath: api.runtime.getURL('models/'),
            backend: 'webgl',
            debug: false,
            warmup: 'none',
            cacheSensitivity: 0,
            filter: { enabled: false },
            face: {
              enabled: true,
              detector: { rotation: false, maxDetected: 25, minConfidence: 0.3, skipFrames: 0, skipTime: 0, return: false },
              mesh: { enabled: false },
              iris: { enabled: false },
              emotion: { enabled: false },
              description: { enabled: true, skipFrames: 0, skipTime: 0, minConfidence: 0 },
              antispoof: { enabled: false },
              liveness: { enabled: false },
              attention: { enabled: false }
            },
            body: { enabled: false },
            hand: {
              enabled: false, rotation: false, maxDetected: 10, minConfidence: 0.3,
              skipFrames: 0, skipTime: 0, landmarks: true,
              detector: { modelPath: 'handtrack.json' },
              skeleton: { modelPath: 'handlandmark-lite.json' }
            },
            object: { enabled: false },
            gesture: { enabled: false },
            segmentation: { enabled: false }
          });
          await h.load();
          human = h;
          return h;
        } catch (e) {
          console.warn('[غضّ] تعذّر تحميل محرك الكشف:', e);
          failedInit = true;
          return null;
        }
      })();
    }
    return loading;
  }

  // ---------- قرار التغطية ----------
  function isTarget(face) {
    if (S.target === 'all') return true;
    // genderScore = ثقة النموذج (0 = غير متأكد، 1 = متأكد تمامًا)
    const g = face.gender, sc = typeof face.genderScore === 'number' ? face.genderScore : 0;
    if (S.sensitivity === 'low') return g === 'female' && sc >= 0.5;
    if (S.sensitivity === 'high') return !(g === 'male' && sc >= 0.6);
    // متوسطة: كل وجه أنثوي، وكل وجه لم يتأكد النموذج أنه لرجل
    return g === 'female' || g !== 'male' || sc < 0.2;
  }

  function pad(box, p, w, h) {
    const [x, y, bw, bh] = box;
    const px = bw * p, py = bh * p;
    const nx = Math.max(0, x - px), ny = Math.max(0, y - py * 1.3);
    return [nx, ny, Math.min(w, x + bw + px) - nx, Math.min(h, y + bh + py) - ny];
  }

  function decide(res) {
    if (!res) return { full: false, boxes: [] };
    if (res.failed) return { full: !!S.failCover, boxes: [] };
    const hits = res.faces.filter(isTarget);
    if (!hits.length) return { full: false, boxes: [] };
    if (S.mode === 'full') return { full: true, boxes: [] };
    let boxes = hits.map((f) => pad(f.box, 0.22, res.w, res.h));
    if (S.mode === 'auto') boxes = boxes.concat(res.hands.map((b) => pad(b, 0.18, res.w, res.h)));
    return { full: false, boxes };
  }

  function apply(el) {
    const st = el.__gh;
    if (!st || !st.res) return;
    const d = decide(st.res);
    st.full = d.full;
    st.boxes = d.boxes;
    el.setAttribute(ATTR, d.full ? 'full' : 'ok');
    if (d.boxes.length) covered.add(el); else { covered.delete(el); clearOverlays(el); }
    kick();
  }

  // ---------- جلب الصور من نطاق آخر ----------
  function isCrossOrigin(src) {
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return false;
    try { return new URL(src, location.href).origin !== location.origin; } catch { return true; }
  }

  async function imageToCanvas(url) {
    const r = await api.runtime.sendMessage({ type: 'ghadd:fetchImage', url });
    if (!r || !r.ok) throw new Error('fetch failed');
    const bin = atob(r.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: r.type || 'image/jpeg' }));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    return c;
  }

  // ---------- التحليل ----------
  async function analyze(el) {
    const st = el.__gh;
    if (!st || !el.isConnected || !active()) return;
    const isVideo = el.tagName === 'VIDEO';
    let input = el, w, h;

    if (isVideo) {
      if (el.readyState < 2 || !el.videoWidth) return;
      w = el.videoWidth; h = el.videoHeight;
    } else {
      if (!el.complete || !el.naturalWidth) return;
      w = el.naturalWidth; h = el.naturalHeight;
      if (w < MIN_SIZE || h < MIN_SIZE) { st.res = { faces: [], hands: [], w, h }; apply(el); return; }
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
      if (!el.hasAttribute(ATTR)) el.setAttribute(ATTR, 'ok');
      return;
    }

    const hm = await initHuman();
    if (!hm) { st.res = { failed: true }; apply(el); return; }

    const src = isVideo ? '' : (el.currentSrc || el.src);
    if (!isVideo && isCrossOrigin(src)) {
      try { input = await imageToCanvas(src); w = input.width; h = input.height; }
      catch { st.res = { failed: true }; st.src = src; apply(el); return; }
    }

    let result;
    try {
      result = await hm.detect(input, { hand: { enabled: S.mode === 'auto' } });
    } catch (e) {
      result = { error: String(e) };
    }
    if (!result || result.error) {
      st.res = { failed: true };
    } else {
      st.res = {
        w, h,
        faces: (result.face || []).map((f) => ({ box: f.box, gender: f.gender, genderScore: f.genderScore })),
        hands: (result.hand || []).map((x) => x.box)
      };
    }
    st.src = src;
    st.lastAt = performance.now();
    if (!isVideo) st.fit = getComputedStyle(el).objectFit;
    else st.fit = getComputedStyle(el).objectFit || 'contain';
    apply(el);
  }

  function enqueue(el, front) {
    if (!active() || queued.has(el)) return;
    queued.add(el);
    if (front) queue.unshift(el); else queue.push(el);
    pump();
  }

  async function pump() {
    if (working) return;
    working = true;
    while (queue.length) {
      const el = queue.shift();
      queued.delete(el);
      if (!el.isConnected || !el.__gh || !el.__gh.visible) continue;
      try { await analyze(el); } catch (e) { /* تجاهل */ }
      await new Promise((r) => setTimeout(r, 0));
    }
    working = false;
  }

  // ---------- متابعة العناصر ----------
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const el = en.target;
      if (!el.__gh) continue;
      el.__gh.visible = en.isIntersecting;
      if (en.isIntersecting && !el.__gh.res) enqueue(el, true);
    }
  }, { rootMargin: '400px' });

  function track(el) {
    if (el.__gh || el.closest && el.closest('#ghadd-layer')) return;
    el.__gh = { visible: false, res: null, boxes: [], overlays: [], full: false };
    tracked.add(el);
    io.observe(el);
    if (el.tagName === 'VIDEO') {
      const re = () => { if (el.__gh.visible) enqueue(el, true); };
      el.addEventListener('loadeddata', re);
      el.addEventListener('seeked', re);
      el.addEventListener('play', re);
    } else {
      el.addEventListener('load', () => { reset(el); if (el.__gh.visible) enqueue(el, true); });
    }
  }

  function reset(el) {
    if (!el.__gh) return;
    el.__gh.res = null;
    el.__gh.boxes = [];
    covered.delete(el);
    clearOverlays(el);
    el.removeAttribute(ATTR);
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.tagName === 'IMG' || root.tagName === 'VIDEO') track(root);
    root.querySelectorAll('img, video').forEach(track);
  }

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const el = m.target;
        if ((el.tagName === 'IMG' && (m.attributeName === 'src' || m.attributeName === 'srcset')) ||
            (el.tagName === 'VIDEO' && m.attributeName === 'src')) {
          if (!el.__gh) track(el);
          reset(el);
          if (el.__gh.visible) enqueue(el, true);
        }
      } else {
        m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); });
      }
    }
  });

  // تحليل مستمر للمقاطع أثناء التشغيل
  setInterval(() => {
    if (!active()) return;
    for (const el of tracked) {
      if (el.tagName !== 'VIDEO' || !el.__gh || !el.__gh.visible) continue;
      if (!el.isConnected) { tracked.delete(el); continue; }
      if (!el.paused && el.readyState >= 2) enqueue(el);
    }
  }, VIDEO_INTERVAL);

  // ---------- رسم الأغطية ----------
  function clearOverlays(el) {
    const st = el.__gh;
    if (!st) return;
    st.overlays.forEach((d) => d.remove());
    st.overlays = [];
  }

  function contentRect(el, rect, st) {
    const iw = st.res.w, ih = st.res.h;
    const W = rect.width, H = rect.height;
    const fit = st.fit || (el.tagName === 'VIDEO' ? 'contain' : 'fill');
    if (fit === 'fill' || !iw || !ih) return { x: rect.left, y: rect.top, sx: W / iw, sy: H / ih };
    let s;
    if (fit === 'cover') s = Math.max(W / iw, H / ih);
    else if (fit === 'none') s = 1;
    else if (fit === 'scale-down') s = Math.min(1, W / iw, H / ih);
    else s = Math.min(W / iw, H / ih);
    return { x: rect.left + (W - iw * s) / 2, y: rect.top + (H - ih * s) / 2, sx: s, sy: s };
  }

  let raf = 0;
  function kick() { if (!raf) raf = requestAnimationFrame(render); }

  function render() {
    raf = 0;
    if (!active() || !covered.size) return;
    const L = getLayer();
    const vw = innerWidth, vh = innerHeight;
    for (const el of covered) {
      const st = el.__gh;
      if (!el.isConnected || !st) { covered.delete(el); if (st) clearOverlays(el); continue; }
      // إن كان المقطع نفسه بملء الشاشة لا يمكن وضع طبقة فوقه: نطمسه كاملًا
      if (document.fullscreenElement === el) { el.setAttribute(ATTR, 'full'); clearOverlays(el); continue; }
      else if (!st.full && el.getAttribute(ATTR) === 'full') el.setAttribute(ATTR, 'ok');

      const rect = el.getBoundingClientRect();
      const offscreen = rect.width < 2 || rect.bottom < 0 || rect.right < 0 || rect.top > vh || rect.left > vw;
      while (st.overlays.length < st.boxes.length) {
        const d = document.createElement('div');
        L.appendChild(d);
        st.overlays.push(d);
      }
      while (st.overlays.length > st.boxes.length) st.overlays.pop().remove();
      const cr = contentRect(el, rect, st);
      st.boxes.forEach((b, i) => {
        const d = st.overlays[i];
        if (d.parentNode !== L) L.appendChild(d);
        if (offscreen) { d.style.display = 'none'; return; }
        let x = cr.x + b[0] * cr.sx, y = cr.y + b[1] * cr.sy;
        let w = b[2] * cr.sx, h = b[3] * cr.sy;
        const x2 = Math.min(x + w, rect.right), y2 = Math.min(y + h, rect.bottom);
        x = Math.max(x, rect.left); y = Math.max(y, rect.top);
        w = x2 - x; h = y2 - y;
        if (w <= 1 || h <= 1) { d.style.display = 'none'; return; }
        d.style.display = 'block';
        d.style.transform = `translate(${x}px, ${y}px)`;
        d.style.width = w + 'px';
        d.style.height = h + 'px';
        coverStyle(d);
      });
    }
    raf = requestAnimationFrame(render);
  }

  // ---------- تغيّر الإعدادات ----------
  function reapplyAll(reanalyze) {
    applyRootState();
    document.documentElement.classList.toggle('ghadd-solid', S.style === 'solid');
    if (!active()) {
      for (const el of covered) clearOverlays(el);
      return;
    }
    for (const el of tracked) {
      if (!el.__gh) continue;
      if (reanalyze) { reset(el); if (el.__gh.visible) enqueue(el); }
      else if (el.__gh.res) apply(el);
    }
    kick();
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const prevMode = S.mode, wasActive = active();
    for (const k in changes) S[k] = changes[k].newValue;
    const needHands = S.mode === 'auto' && prevMode !== 'auto';
    reapplyAll(needHands || (!wasActive && active()));
  });

  // ---------- البدء ----------
  async function start() {
    try { S = { ...DEFAULTS, ...(await api.storage.sync.get(null)) }; } catch { /* افتراضي */ }
    injectStyle();
    applyRootState();
    document.documentElement.classList.toggle('ghadd-solid', S.style === 'solid');
    const go = () => {
      scan(document.documentElement);
      mo.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset']
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  }

  // يُطبَّق الإخفاء المسبق فورًا قبل قراءة الإعدادات لمنع ظهور الصور لحظة التحميل
  if (document.documentElement) {
    document.documentElement.classList.add('ghadd-on', 'ghadd-prehide');
  }
  injectStyle();
  start();
})();
