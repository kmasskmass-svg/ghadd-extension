const api = globalThis.browser ?? chrome;
const DEFAULTS = {
  enabled: true, mode: 'auto', style: 'blur', strength: 80, target: 'women',
  sensitivity: 'mid', prehide: true, failCover: true, disabledSites: []
};
const toArabicDigits = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
let S = { ...DEFAULTS };
let host = '';

const $ = (s) => document.querySelector(s);
const save = (patch) => { Object.assign(S, patch); api.storage.sync.set(patch); render(); };

function render() {
  const siteOff = host && S.disabledSites.includes(host);
  const on = S.enabled && !siteOff;
  $('#enabled').setAttribute('aria-checked', String(S.enabled));
  $('#powerCard').classList.toggle('off', !on);
  $('#powerTitle').textContent = on ? 'الحماية مفعّلة' : 'الحماية متوقفة';
  $('#powerSub').textContent = !S.enabled ? 'اضغط المفتاح لتفعيل التغطية'
    : siteOff ? 'موقوفة في هذا الموقع فقط' : 'تعمل على كل المواقع';
  document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === S.mode)));
  document.querySelectorAll('.seg').forEach((g) => {
    g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.val === S[g.dataset.key])));
  });
  $('#strength').value = S.strength;
  $('#strengthOut').textContent = toArabicDigits(S.strength) + '٪';
  document.querySelectorAll('.trow .switch[data-key]').forEach((b) => b.setAttribute('aria-checked', String(!!S[b.dataset.key])));
  $('#siteOff').setAttribute('aria-checked', String(!!siteOff));
}

async function init() {
  S = { ...DEFAULTS, ...(await api.storage.sync.get(null)) };
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const u = tab && tab.url ? new URL(tab.url) : null;
    if (u && /^https?:$/.test(u.protocol)) {
      host = u.hostname;
      $('#siteName').textContent = host;
      $('#siteRow').hidden = false;
    }
  } catch { /* لا يوجد تبويب */ }

  $('#enabled').addEventListener('click', () => save({ enabled: !S.enabled }));
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => save({ mode: b.dataset.mode })));
  document.querySelectorAll('.seg').forEach((g) => {
    g.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => save({ [g.dataset.key]: b.dataset.val })));
  });
  $('#strength').addEventListener('input', (e) => {
    $('#strengthOut').textContent = toArabicDigits(e.target.value) + '٪';
  });
  $('#strength').addEventListener('change', (e) => save({ strength: Number(e.target.value) }));
  document.querySelectorAll('.trow .switch[data-key]').forEach((b) =>
    b.addEventListener('click', () => save({ [b.dataset.key]: !S[b.dataset.key] })));
  $('#siteOff').addEventListener('click', () => {
    const list = new Set(S.disabledSites);
    if (list.has(host)) list.delete(host); else list.add(host);
    save({ disabledSites: [...list] });
  });
  render();
}
init();
