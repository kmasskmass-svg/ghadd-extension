// غضّ – خدمة الخلفية: تجلب الصور من نطاقات أخرى حتى يمكن تحليلها دون قيود CORS.
const api = globalThis.browser ?? chrome;

const DEFAULTS = {
  enabled: true,
  mode: 'auto',        // full | face | auto
  style: 'blur',       // blur | solid
  strength: 80,        // 20..100
  target: 'women',     // women | all
  sensitivity: 'mid',  // low | mid | high
  prehide: true,
  failCover: true,
  disabledSites: []
};

api.runtime.onInstalled.addListener(async () => {
  const cur = await api.storage.sync.get(null);
  await api.storage.sync.set({ ...DEFAULTS, ...cur });
});

const MAX_BYTES = 15 * 1024 * 1024;

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ghadd:fetchImage') return false;
  (async () => {
    try {
      const res = await fetch(msg.url, { credentials: 'omit', cache: 'force-cache' });
      if (!res.ok) throw new Error('status ' + res.status);
      const blob = await res.blob();
      if (blob.size > MAX_BYTES) throw new Error('too large');
      sendResponse({ ok: true, type: blob.type, data: toBase64(await blob.arrayBuffer()) });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
