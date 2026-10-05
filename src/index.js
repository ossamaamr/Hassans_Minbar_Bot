// ============================================================
// منبر حسان — Cloudflare Worker (الإصدار 8.6)
// التخزين: Filebase (S3-compatible)
// تدفق رفع ملفات مبسّط: افتح المقرر → رفع ملف → اسم → جاهز
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const e = { ...env, ctx };
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/webhook') {
      const given = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (!safeEq(given, env.WEBHOOK_SECRET)) return new Response('Forbidden', { status: 403 });
      try {
        const update = await request.json();
        ctx.waitUntil(handleUpdate(update, e));
      } catch (err) { console.error('Webhook parse error:', err.message); }
      return new Response('OK');
    }

    if (path === '/set-webhook' || path === '/webhook-info' || path === '/delete-webhook') {
      const key = request.headers.get('X-Admin-Key') || url.searchParams.get('k');
      if (!safeEq(key, env.ADMIN_KEY)) return new Response('Forbidden', { status: 403 });
      let result;
      if (path === '/set-webhook') result = await setWebhook(e);
      else if (path === '/webhook-info') result = await tg('getWebhookInfo', {}, e);
      else result = await tg('deleteWebhook', { drop_pending_updates: true }, e);
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Minbar Hassan Bot v' + CFG.VERSION, { status: 200 });
  },

  async scheduled(event, env, ctx) {
    const e = { ...env, ctx };
    ctx.waitUntil((async () => {
      const r = await syncStatuses(e, true);
      if (r.changed) {
        await send(adminId(e), card('<b>مزامنة يومية</b>', [
          `تغيّرت حالة <b>${r.changed}</b> من ${r.checked}، وأُرسل <b>${r.notified}</b> إشعار.`
        ]), null, e);
      }
    })().catch(err => console.error('CRON-ERR:', err && err.message)));
  }
};

// ============================================================
// الإعدادات
// ============================================================
const CFG = {
  VERSION: '8.6',
  PAGE_SIZE: 8,
  BROADCAST_BATCH: 25,
  MAX_VERIFY_ATTEMPTS: 5,
  STATE_TTL: 1800,
  CACHE_TTL: 20000,
  WEEKS: 13,
  ATT_BLOCK: 25,
  SEEN_TTL: 900,
  LINE: '──────────────'
};

const FILEBASE = {
  BUCKET: 'mnabar-files',
  REGION: 'us-east-1',
  HOST: 'mnabar-files.s3.filebase.com'
};

const adminId = env => String(env.ADMIN_CHAT_ID || '');

const STATE_LABEL = { active: 'نشط', suspended: 'موقوف', deleted: 'محذوف' };
const STATE_ICON = { active: '🟢', suspended: '🟡', deleted: '🔴' };
const STATUS_DELETED = ['محذوف', 'منسحب', 'معتزل'];
const STATUS_SUSPENDED = ['موقوف', 'متوقف', 'غير نشط'];
const TYPE_LABEL = { document: 'مستند', photo: 'صورة', video: 'فيديو', audio: 'ملف صوتي', voice: 'تسجيل صوتي' };
const TYPE_EMOJI = { document: '📄', photo: '🖼️', video: '🎬', audio: '🎧', voice: '🎙️' };

const SHEETS = {
  BASE: ['قاعدة_طلاب', 'قاعدة_الطلاب'],
  USERS: 'بوت_المستخدمين',
  STAFF: 'قائمة_الأدمن',
  FILES: 'الرسائل_المرفوعة',
  COURSES: 'المقررات',
  LOG: 'سجل_الإدارة',
  CALENDAR: 'التقويم_العرض',
  PARTICIPATIONS: 'المشاركات',
  ATTENDANCE_IN: 'إدخال_التقويم',
  LISTEN: 'سجل_الاستماع',
  SUMMARY: 'ملخص_الاستماع'
};

// ============================================================
// أدوات أمنية
// ============================================================
function safeEq(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a || '')), y = enc.encode(String(b || ''));
  if (!x.length || !y.length) return false;
  let d = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

// ============================================================
// ذاكرة مؤقتة
// ============================================================
const MEM = new Map();

function cached(key, ttl, loader, fresh) {
  const now = Date.now();
  const hit = MEM.get(key);
  if (!fresh && hit && hit.exp > now) return hit.p;
  const entry = { exp: now + ttl, val: hit ? hit.val : undefined };
  entry.p = Promise.resolve().then(loader).then(v => { entry.val = v; return v; }, err => {
    if (entry.val !== undefined) { entry.exp = Date.now() + 3000; return entry.val; }
    if (MEM.get(key) === entry) MEM.delete(key);
    throw err;
  });
  MEM.set(key, entry);
  return entry.p;
}

function bustSheet(name) {
  const prefix = `r:${name}!`;
  for (const k of MEM.keys()) if (k.startsWith(prefix)) MEM.delete(k);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function bg(env, promise) {
  const safe = Promise.resolve(promise).catch(err => console.error('BG-ERR:', err && err.message));
  try { env.ctx.waitUntil(safe); } catch (e) { /* ignore */ }
}

// ============================================================
// Telegram API
// ============================================================
async function tg(method, payload, env, quiet) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  try {
    let data = await (await fetch(url, init)).json();
    if (!data.ok && data.error_code === 429) {
      const wait = (data.parameters && data.parameters.retry_after) || 1;
      if (wait <= 5) { await sleep(wait * 1000); data = await (await fetch(url, init)).json(); }
    }
    if (!data.ok && !quiet) console.error(`TG-FAIL ${method}:`, JSON.stringify(data).substring(0, 300));
    return data;
  } catch (e) {
    console.error(`TG-ERR ${method}:`, e.message);
    return { ok: false, description: e.message };
  }
}

async function setWebhook(env) {
  const secret = String(env.WEBHOOK_SECRET || '');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    return { ok: false, description: 'WEBHOOK_SECRET يجب أن يكون 16 حرفاً على الأقل' };
  }
  return tg('setWebhook', {
    url: `${env.WORKER_URL}/webhook`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  }, env);
}

function toMarkup(kb) {
  if (!kb) return undefined;
  return Array.isArray(kb) ? { inline_keyboard: kb } : kb;
}

async function send(chatId, text, kb, env) {
  return tg('sendMessage', {
    chat_id: String(chatId), text: clip(text), parse_mode: 'HTML',
    disable_web_page_preview: true, reply_markup: toMarkup(kb)
  }, env);
}

async function show(chatId, mid, text, kb, env) {
  if (!mid || (kb && !Array.isArray(kb))) return send(chatId, text, kb, env);
  const r = await tg('editMessageText', {
    chat_id: String(chatId), message_id: mid, text: clip(text), parse_mode: 'HTML',
    disable_web_page_preview: true, reply_markup: { inline_keyboard: kb || [] }
  }, env, true);
  if (r.ok || /not modified/i.test(r.description || '')) return r;
  return send(chatId, text, kb, env);
}

// ============================================================
// Google Sheets API
// ============================================================
let _tok = { token: null, exp: 0 };
let _tokPromise = null;
let _keyPromise = null;

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_tok.token && _tok.exp > now + 60) return _tok.token;
  if (_tokPromise) return _tokPromise;

  _tokPromise = (async () => {
    try {
      const shared = await env.KV.get('gtoken', 'json');
      if (shared && shared.token && shared.exp > now + 120) { _tok = shared; return shared.token; }
      const header = { alg: 'RS256', typ: 'JWT' };
      const payload = {
        iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600, iat: now
      };
      const sigInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
      _keyPromise = _keyPromise || importKey(env.GOOGLE_PRIVATE_KEY);
      const key = await _keyPromise;
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sigInput));
      const jwt = `${sigInput}.${b64url(sig)}`;
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
      });
      const data = await res.json();
      if (!data.access_token) throw new Error('فشل الحصول على access token');
      _tok = { token: data.access_token, exp: now + 3500 };
      await env.KV.put('gtoken', JSON.stringify(_tok), { expirationTtl: 3300 });
      return _tok.token;
    } finally { _tokPromise = null; }
  })();
  return _tokPromise;
}

async function importKey(pem) {
  const clean = String(pem).replace(/\\n/g, '\n')
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gfetch(url, init, env) {
  init = init || {};
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await getAccessToken(env);
    res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401 && attempt === 0) {
      _tok = { token: null, exp: 0 };
      await env.KV.delete('gtoken');
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(600 * (attempt + 1) + Math.floor(Math.random() * 300));
      continue;
    }
    break;
  }
  return res;
}

const sheetOf = range => String(range).split('!')[0];
const sheetsBase = env => `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}`;

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function readSheet(range, env, opt) {
  opt = opt || {};
  return cached(`r:${range}`, opt.ttl || CFG.CACHE_TTL, async () => {
    const res = await gfetch(`${sheetsBase(env)}/values/${encodeURIComponent(range)}`, {}, env);
    const data = await res.json();
    if (data.error) throw new Error('Sheets read: ' + data.error.message);
    return data.values || [];
  }, opt.fresh);
}

async function warm(env) {
  bg(env, ensureFilesHeaders(env));
  const ranges = [`${SHEETS.USERS}!A3:F`, `${SHEETS.STAFF}!A3:D`];
  if (_baseName) ranges.push(`${_baseName}!A2:E`);
  const now = Date.now();
  const need = ranges.filter(r => { const h = MEM.get('r:' + r); return !(h && h.exp > now); });
  if (need.length < 2) return;
  try {
    const qs = need.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
    const res = await gfetch(`${sheetsBase(env)}/values:batchGet?${qs}`, {}, env);
    const data = await res.json();
    if (data.error) return;
    (data.valueRanges || []).forEach((vr, i) => {
      const vals = vr.values || [];
      MEM.set('r:' + need[i], { p: Promise.resolve(vals), exp: Date.now() + CFG.CACHE_TTL, val: vals });
    });
  } catch (e) { /* ignore */ }
}

async function writeSheet(range, values, env) {
  const res = await gfetch(
    `${sheetsBase(env)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }, env
  );
  const data = await res.json();
  bustSheet(sheetOf(range));
  if (data.error) throw new Error('Sheets write: ' + data.error.message);
  return data;
}

async function batchWrite(data, env) {
  if (!data.length) return;
  const res = await gfetch(
    `${sheetsBase(env)}/values:batchUpdate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) }, env
  );
  const out = await res.json();
  data.forEach(d => bustSheet(sheetOf(d.range)));
  if (out.error) throw new Error('Sheets batch: ' + out.error.message);
}

async function appendRow(sheetName, values, env) {
  const res = await gfetch(
    `${sheetsBase(env)}/values/${encodeURIComponent(sheetName + '!A:Z')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [values] }) }, env
  );
  const data = await res.json();
  bustSheet(sheetName);
  if (data.error) throw new Error('Sheets append: ' + data.error.message);
  return data;
}

async function guardRow(sheetName, row, expect, env) {
  if (!expect) return;
  const res = await gfetch(`${sheetsBase(env)}/values/${encodeURIComponent(`${sheetName}!${expect.col}${row}`)}`, {}, env);
  const data = await res.json();
  const cur = String(data.values && data.values[0] && data.values[0][0] || '').trim();
  const norm = expect.phone ? normPhone : (x => String(x).trim());
  if (norm(cur) !== norm(expect.val)) throw new Error('تغيّر الجدول أثناء العملية، أعد المحاولة');
}

async function updateCell(sheetName, row, col, value, env, expect) {
  await guardRow(sheetName, row, expect, env);
  return writeSheet(`${sheetName}!${colLetter(col)}${row}`, [[value]], env);
}

async function sheetIdOf(name, env) {
  const find = meta => (meta.sheets || []).find(s => s.properties.title === name);
  let sheet = find(await getSheetMeta(env, false));
  if (!sheet) sheet = find(await getSheetMeta(env, true));
  if (!sheet) throw new Error('الورقة غير موجودة: ' + name);
  return sheet.properties.sheetId;
}

function getSheetMeta(env, fresh) {
  return cached('meta', 600000, async () => {
    const res = await gfetch(`${sheetsBase(env)}?fields=sheets(properties(sheetId,title))`, {}, env);
    return res.json();
  }, fresh);
}

async function deleteSheetRow(sheetName, rowIndex, env, expect) {
  await guardRow(sheetName, rowIndex, expect, env);
  const sheetId = await sheetIdOf(sheetName, env);
  const res = await gfetch(`${sheetsBase(env)}:batchUpdate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }]
    })
  }, env);
  const data = await res.json();
  bustSheet(sheetName);
  if (data.error) throw new Error('Sheets delete: ' + data.error.message);
  return data;
}

// ============================================================
// Filebase Storage (S3-compatible)
// ============================================================
async function hmacSha256(key, data) {
  const raw = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const ck = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const d = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign('HMAC', ck, d));
}

async function sha256Hex(data) {
  const d = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest('SHA-256', d);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function filebaseSign(method, objectKey, payloadBytes, contentType, env) {
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
  const url = `https://${FILEBASE.HOST}/${encodedKey}`;
  const payloadHash = await sha256Hex(payloadBytes);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);

  const headers = {
    host: FILEBASE.HOST,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  if (contentType) headers['content-type'] = contentType;

  const sortedKeys = Object.keys(headers).sort();
  const signedHeaders = sortedKeys.join(';');
  const canonicalHeaders = sortedKeys.map(h => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = [method, '/' + encodedKey, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${FILEBASE.REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmacSha256('AWS4' + env.FILEBASE_SECRET, dateStamp);
  const kRegion = await hmacSha256(kDate, FILEBASE.REGION);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const sigBytes = await hmacSha256(kSigning, stringToSign);
  const sig = [...sigBytes].map(b => b.toString(16).padStart(2, '0')).join('');

  const auth = `AWS4-HMAC-SHA256 Credential=${env.FILEBASE_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

  return { url, headers: { ...headers, 'Authorization': auth } };
}

async function uploadToFilebase(objectKey, fileName, blob, env) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const contentType = blob.type || 'application/octet-stream';
    const { url, headers } = await filebaseSign('PUT', objectKey, bytes, contentType, env);
    const res = await fetch(url, { method: 'PUT', headers, body: bytes });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${txt.substring(0, 200)}` };
    }
    return { id: objectKey, url: `https://${FILEBASE.HOST}/${objectKey}`, name: fileName };
  } catch (e) {
    return { error: 'استثناء في الرفع: ' + e.message };
  }
}

async function deleteFromFilebase(objectKey, env) {
  try {
    const { url, headers } = await filebaseSign('DELETE', objectKey, new Uint8Array(0), null, env);
    await fetch(url, { method: 'DELETE', headers });
  } catch (e) { /* ignore */ }
}

async function downloadFromFilebase(objectKey, env) {
  try {
    const { url, headers } = await filebaseSign('GET', objectKey, new Uint8Array(0), null, env);
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      console.error('FILEBASE-GET-FAIL:', res.status);
      return null;
    }
    return await res.blob();
  } catch (e) {
    console.error('FILEBASE-GET-EXC:', e.message);
    return null;
  }
}

async function downloadTelegramFile(fileId, env) {
  const info = await tg('getFile', { file_id: fileId }, env);
  if (!info.ok) return null;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.result.file_path}`);
  if (!fileRes.ok) return null;
  const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';
  const blob = await fileRes.blob();
  return { blob: new Blob([blob], { type: contentType }), path: info.result.file_path };
}

// ============================================================
// أدوات عامة
// ============================================================
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(s) {
  s = String(s);
  if (s.length <= 4000) return s;
  let c = s.substring(0, 3990);
  const lt = c.lastIndexOf('<');
  if (lt > c.lastIndexOf('>')) c = c.substring(0, lt);
  const am = c.lastIndexOf('&');
  if (am > c.lastIndexOf(';') && c.length - am < 8) c = c.substring(0, am);
  return c + '…';
}

function trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.substring(0, n - 1) + '…' : s;
}

function nowRiyadh() {
  const riyadh = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return riyadh.toISOString().slice(0, 16).replace('T', ' ');
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

const LABEL_EMOJI = {
  'نقاطي': '⭐', 'ترتيبي': '🏆', 'مشاركاتي': '🙋', 'حضوري': '📅', 'غياباتي': '📝',
  'المقررات': '📚', 'ملفي': '👤', 'تواصل': '💬', 'مساعدة': '❓', 'لوحة الإدارة': '⚙️',
  'الطلاب': '👥', 'البث': '📢', 'الاستماع': '🎧', 'الإحصاء': '📊', 'مطابقة': '🔄',
  'المشرفون': '🛡️', 'الإعدادات': '⚙️', 'وضع الطالب': '🎓', 'مدير': '👑', 'مشرف': '🛡️'
};

const BTN_ICONS = [
  [/^(الرئيسية|القائمة)$/, '🏠'], [/^رجوع/, '🔙'],
  [/^إلغاء تعيين/, '🗑️'], [/^إلغاء$/, '❌'], [/^تراجع$/, '↩️'],
  [/^تأكيد/, '✅'], [/^موافقة$/, '✅'], [/^رفض$/, '❌'], [/^اعتماد/, '✅'],
  [/^نعم، (احذف|أزِله)/, '🗑️'],
  [/^إنهاء وإشعار/, '🔔'], [/^إنهاء$/, '🏁'], [/^🏁/, '🏁'],
  [/^بحث/, '🔍'], [/^(إضافة|مقرر جديد)/, '➕'],
  [/^الكل$/, '📋'], [/^النشطون$/, '🟢'], [/^عن بعد/, '🔵'], [/^الموقوفون$/, '🟡'], [/^المحذوفون$/, '🔴'], [/^لم يدخلوا البوت/, '📵'],
  [/^تنشيط$/, '✅'],
  [/^إيقاف الإشعار/, '🔕'], [/^تشغيل الإشعار/, '🔔'],
  [/^إيقاف.*(تتبع|التتبع)/, '⏹️'], [/^تفعيل.*(تتبع|التتبع)/, '🎯'],
  [/^إيقاف/, '⏸️'], [/^تشغيل البوت/, '▶️'],
  [/^حذف/, '🗑️'], [/^إزالة/, '🗑️'],
  [/^(تعديل|إعادة تسمية)/, '✏️'],
  [/^(رسالة خاصة|رد|تواصل)/, '💬'],
  [/^فك ربط/, '🔓'],
  [/^(سجل الاستماع|متابعة الاستماع|من استمع)/, '🎧'], [/^كل المقرر$/, '📚'],
  [/^مشاركة رقمي$/, '📱'],
  [/^استلام الملف/, '📥'], [/^فتح (الملف|التسجيل)/, '📂'], [/^فتح المقرر/, '📁'],
  [/^(سمعته|سمعتها|شاهدته|اطلعت عليه)/, '✅'],
  [/^رفع للأعلى/, '⬆️'], [/^إنزال للأسفل/, '⬇️'], [/^رفع ملفات/, '📤'], [/^📤/, '📤'],
  [/^إعدادات المقرر/, '⚙️'], [/^إخفاء$/, '🙈'], [/^إظهار$/, '👁️'], [/^نقل إلى/, '📦'],
  [/^إشعار الطلاب/, '🔔'],
  [/^(تغيير الأسبوع|الأسبوع \d|الأسابيع$|عدد الأسابيع|أ\d|بدون أسبوع|بدون تقسيم)/, '📅'],
  [/^درجة الاجتياز/, '🎯'], [/^نقاط كل تسجيل/, '⭐'],
  [/^(تذكير|إرسال التذكير)/, '⏰'],
  [/^رسالة نصية$/, '📝'], [/^ملف \//, '📎'],
  [/^الجميع/, '👥'], [/^الحضوري/, '🏫'], [/^حفظ في المكتبة/, '💾'], [/^تغيير الفئة/, '🔄'],
  [/^تحديث/, '🔄'],
  [/^السابق$/, '▶️'], [/^التالي$/, '◀️'],
  [/^سجل الإدارة/, '📋'], [/^تخطي$/, '⏭️'],
  [/^المقرر$/, '📁'], [/^بطاقة الطالب/, '👤'], [/^بطاقة الملف/, '📄'],
  [/^تغيير إلى أسبوع/, '📅'], [/^متابعة/, '🎧']
];

const CARD_ICONS = [
  [/^أهلاً بك/, '👋'], [/^منبر حسان$/, '🕌'], [/^لوحة الإدارة/, '⚙️'], [/^المساعدة/, '❓'],
  [/^البوت تحت الصيانة/, '🛠️'], [/^حسابك موقوف/, '⏸️'], [/^حسابك محذوف/, '🚫'],
  [/^نقاطك/, '⭐'], [/^ترتيبك/, '🏆'], [/^مشاركاتك/, '🙋'], [/^حضورك/, '📅'], [/^غياباتك/, '📝'], [/^ملفي$/, '👤'],
  [/^المقررات والملفات/, '📚'], [/^(رفع إلى|لرفع ملفات)/, '📤'], [/^(ملف جديد|ملفات جديدة)/, '🆕'],
  [/^(تسجيل الإنجاز)/, '🎧'], [/^لم تنتهِ المدة/, '⏳'], [/^تذكير|^تأكيد التذكير/, '⏰'],
  [/^(متابعة الاستماع|ملخص الاستماع)/, '🎧'],
  [/^عدد أسابيع/, '📅'], [/^(درجة الاجتياز|نقاط كل تسجيل)/, '🎯'], [/^(إعدادات:|الإعدادات)/, '⚙️'],
  [/^تغيير الأسبوع/, '📅'], [/^نقل الملف/, '📦'], [/^إعادة تسمية/, '✏️'],
  [/^(المشرفون|صلاحية|إضافة مشرف|إزالة مشرف)/, '🛡️'],
  [/^(حذف)/, '🗑️'], [/^(مقرر جديد|إضافة|نتيجة الإضافة)/, '➕'],
  [/^الطلاب$/, '👥'], [/^(كل الطلاب|النشطون|عن بعد|الموقوفون|المحذوفون|لم يدخلوا)/, '📋'],
  [/^(بحث|نتائج البحث)/, '🔍'], [/^تعديل/, '✏️'],
  [/^(البث|اسم البث)/, '📢'], [/^اختيار الفئة/, '🎯'],
  [/^الإحصاء/, '📊'], [/^آخر العمليات/, '📋'], [/^الأوائل/, '🏆'],
  [/^(رسالة|التواصل)/, '💬'], [/^(طلب دخول|طلب ربط)/, '🔐'], [/^طالب جديد/, '🆕'],
  [/^(تمت المطابقة|مزامنة)/, '🔄'], [/^اسم الملف/, '✏️']
];

const LINE_ICONS = [
  [/^الجوال:/, '📱'], [/^المستوى:/, '🎓'], [/^الحالة:/, '📌'], [/^الرمز:/, '🆔'],
  [/^(الاسم|الطالب):/, '👤'], [/^المقرر:/, '📚'], [/^الأسبوع/, '📅'], [/^المدة:/, '⏱️'],
  [/^(الملف|الملفات المتتبَّعة|عدد الملفات|إجمالي الملفات):/, '📎'],
  [/^(التاريخ|آخر استخدام|رُفع في):/, '🕒'], [/^البوت:/, '🤖'], [/^النوع:/, '🗂️'],
  [/^مرات الاستلام:/, '📥'], [/^تتبع الاستماع/, '🎧'], [/^الفئة:/, '🎯'], [/^عدد المستلمين:/, '👥'],
  [/^اسم البث:/, '📝'], [/^دخلوا البوت:/, '📲'], [/^لم يدخلوا بعد:/, '⏳'], [/^المقررات:/, '📚'],
  [/^الإداريون:/, '🛡️'], [/^وصل:/, '✅'], [/^حالة البوت:/, '🤖'], [/^الإصدار:/, '🏷️'],
  [/^النظام:/, '🖥️'], [/^عدد المفحوصين:/, '🔎'], [/^تغيّرت حالتهم:/, '🔄'], [/^رسائل أُرسلت:/, '📨'],
  [/^الطلاب (في القاعدة|النشطون):/, '👥'], [/^إشعار الطلاب/, '🔔'], [/^استمعوا:/, '✅'], [/^لم يستمعوا:/, '⏳'],
  [/^استمع:/, '🎧'], [/^عدد الأسابيع:|^عدد من سيصلهم/, '📅'], [/^درجة الاجتياز:/, '🎯'], [/^نقاط كل تسجيل:/, '⭐'],
  [/^المسجَّل لك:/, '🎧'], [/^الدرجة الكاملة/, '🎯'], [/^ملفات بتتبع/, '🎯'], [/^الاسم المقترح:/, '💡']
];

const ICON_CACHE = new Map();

function ico(text) {
  const key = String(text);
  const cached = ICON_CACHE.get(key);
  if (cached !== undefined) return cached;
  let r = key;
  if (!/^[^\p{L}\p{N}]/u.test(r)) {
    if (LABEL_EMOJI[r]) r = `${LABEL_EMOJI[r]} ${r}`;
    else {
      for (const [re, e] of BTN_ICONS) if (re.test(r)) { r = `${e} ${r}`; break; }
    }
  }
  ICON_CACHE.set(key, r);
  if (ICON_CACHE.size > 500) ICON_CACHE.clear();
  return r;
}

function titleIcon(title) {
  const t = String(title);
  if (/^[^\p{L}\p{N}<]/u.test(t)) return t;
  const plain = t.replace(/<[^>]+>/g, '').trim();
  for (const [re, e] of CARD_ICONS) if (re.test(plain)) return `${e} ${t}`;
  return t;
}

function decorateLine(line) {
  const l = String(line);
  if (!l || /^[^\p{L}\p{N}<]/u.test(l)) return l;
  const b = l.match(/^<b>([^<]+?):?<\/b>/);
  if (b && LABEL_EMOJI[b[1].trim()]) return `${LABEL_EMOJI[b[1].trim()]} ${l}`;
  const plain = l.replace(/^<b>/, '');
  for (const [re, e] of LINE_ICONS) if (re.test(plain)) return `${e} ${l}`;
  return l;
}

function card(title, lines) {
  return titleIcon(title) + '\n' + CFG.LINE + '\n' + (lines || []).map(decorateLine).join('\n');
}

const btn = (text, data) => ({ text: ico(text), callback_data: data });
const replyKb = rows => ({ keyboard: rows.map(r => r.map(text => ({ text: ico(text) }))), resize_keyboard: true });
const CANCEL_KB = [[btn('إلغاء', 'cancel')]];
const HOME_ROW = [btn('الرئيسية', 'home')];

function cleanLabel(text) {
  return String(text || '').replace(/^[^\p{L}\p{N}\/]+/u, '').trim();
}

function normPhone(raw) {
  let s = String(raw ?? '')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 1776))
    .replace(/[^0-9]/g, '');
  if (s.startsWith('966')) s = s.substring(3);
  if (s.startsWith('0')) s = s.substring(1);
  return s.length >= 9 ? s.slice(-9) : '';
}

function normAr(s) {
  return String(s || '').toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ').trim();
}

function statusIcon(s) {
  if (!s) return '⚪';
  if (s.state === 'deleted') return '🔴';
  if (s.state === 'suspended') return '🟡';
  if (s.statusText === 'عن بعد') return '🔵';
  return '🟢';
}

function classifyStatus(text) {
  text = String(text || '').trim();
  if (STATUS_DELETED.includes(text)) return 'deleted';
  if (STATUS_SUSPENDED.includes(text)) return 'suspended';
  return 'active';
}

const EXT_RE = /\.(pdf|docx?|pptx?|xlsx?|mp3|mp4|m4a|ogg|wav|jpe?g|png|zip|txt)$/i;
const stripExt = n => String(n || '').replace(EXT_RE, '');

function isCancel(t) { return ['/cancel', 'إلغاء', 'الغاء'].includes(t); }
function isHome(t) { return ['/start', '/menu', 'start', 'قائمة', '/قائمة', 'القائمة', 'بدء', 'ادارة', '/ادارة', 'الرئيسية'].includes(t); }
function isHelp(t) { return ['/help', 'help', 'مساعدة'].includes(t); }

// ============================================================
// تخزين الحالات (KV)
// ============================================================
async function setState(chatId, action, data, env, ttl = CFG.STATE_TTL) {
  await env.KV.put(`state_${chatId}`, JSON.stringify({ a: action, d: data || {} }), { expirationTtl: ttl });
}
const getState = (chatId, env) => env.KV.get(`state_${chatId}`, 'json');
const clearState = (chatId, env) => env.KV.delete(`state_${chatId}`);
const isPaused = env => cached('paused', 8000, async () => (await env.KV.get('bot_paused')) === '1');

// ============================================================
// قواعد البيانات
// ============================================================
let _baseName = null;

async function loadBase(env, fresh) {
  const names = _baseName ? [_baseName, ...SHEETS.BASE.filter(n => n !== _baseName)] : SHEETS.BASE;
  for (const name of names) {
    try {
      const rows = await readSheet(`${name}!A2:E`, env, { fresh });
      if (!rows.length) continue;
      _baseName = name;
      const list = [], byPhone = {};
      rows.forEach((r, idx) => {
        const phone = normPhone(r[4]);
        const studentName = String(r[3] || '').trim();
        if (!phone || !studentName) return;
        const s = {
          code: r[0] || '',
          level: String(r[1] || '').trim(),
          statusText: String(r[2] || '').trim(),
          name: studentName, phone, row: 2 + idx
        };
        s.state = classifyStatus(s.statusText);
        list.push(s);
        const prev = byPhone[phone];
        if (!prev || (prev.state !== 'active' && s.state === 'active')) byPhone[phone] = s;
      });
      return { list, byPhone, sheetName: name };
    } catch (e) { continue; }
  }
  return { list: [], byPhone: {}, sheetName: null };
}

async function findStudent(phone, env, fresh) {
  if (!phone) return null;
  return (await loadBase(env, fresh)).byPhone[phone] || null;
}

async function loadUsers(env, fresh) {
  const rows = await readSheet(`${SHEETS.USERS}!A3:F`, env, { fresh });
  const list = [], byChat = {}, byPhone = {};
  rows.forEach((r, i) => {
    const id = String(r[0] || '').trim();
    if (!id) return;
    const u = {
      chatId: id, phone: normPhone(r[1]), name: r[2] || '',
      registered: r[3] || '', last: r[4] || '', state: r[5] || '', row: 3 + i
    };
    list.push(u); byChat[id] = u;
    if (u.phone) (byPhone[u.phone] = byPhone[u.phone] || []).push(u);
  });
  return { list, byChat, byPhone };
}

async function saveUser(chatId, phone, studentName, env) {
  const users = await loadUsers(env, true);
  const u = users.byChat[String(chatId)];
  const t = nowRiyadh();
  if (u) {
    await batchWrite([
      { range: `${SHEETS.USERS}!B${u.row}:C${u.row}`, values: [[phone, studentName]] },
      { range: `${SHEETS.USERS}!E${u.row}:F${u.row}`, values: [[t, STATE_LABEL.active]] }
    ], env);
  } else {
    await appendRow(SHEETS.USERS, [String(chatId), phone, studentName, t, t, STATE_LABEL.active], env);
  }
}

async function markSeen(chatId, state, env) {
  const key = `seen_${chatId}_${state}`;
  if (await env.KV.get(key)) return;
  await env.KV.put(key, '1', { expirationTtl: CFG.SEEN_TTL });
  const u = (await loadUsers(env)).byChat[chatId];
  if (!u) return;
  const t = nowRiyadh();
  const label = STATE_LABEL[state];
  const data = [{ range: `${SHEETS.USERS}!E${u.row}`, values: [[t]] }];
  if (u.state !== label) data.push({ range: `${SHEETS.USERS}!F${u.row}`, values: [[label]] });
  await batchWrite(data, env);
}

async function unlinkPhone(phone, env) {
  const users = await loadUsers(env, true);
  const rows = (users.byPhone[phone] || []).slice().sort((a, b) => b.row - a.row);
  for (const u of rows) await deleteSheetRow(SHEETS.USERS, u.row, env, { col: 'A', val: u.chatId });
}

const normalizeRole = txt =>
  ['admin', 'مدير', 'المشرف العام', 'أدمن', 'ادمن'].includes(String(txt || '').trim().toLowerCase()) ? 'admin' : 'supervisor';
const roleLabel = role => (role === 'admin' ? 'مدير' : 'مشرف');

const PENDING_RE = /^p\d{9}$/;

async function loadPending(env, fresh) {
  const rows = await readSheet(`${SHEETS.STAFF}!A3:D`, env, { fresh });
  const out = [];
  rows.forEach((r, i) => {
    const id = String(r[0] || '').trim();
    if (!PENDING_RE.test(id)) return;
    out.push({ id, phone: id.slice(1), name: r[1] || 'مشرف', role: normalizeRole(r[2]), studentPhone: normPhone(r[3]), row: 3 + i });
  });
  return out;
}

async function activatePending(chatId, phone, env) {
  const p = (await loadPending(env, true)).find(x => x.phone === phone);
  if (!p) return false;
  await updateCell(SHEETS.STAFF, p.row, 1, chatId, env, { col: 'A', val: p.id });
  await clearState(chatId, env);
  bg(env, logAction(p.name, 'تفعيل مشرف', `${p.name} (${p.role})`, env));
  if (adminId(env) && adminId(env) !== chatId) {
    bg(env, send(adminId(env), `<b>${esc(p.name)}</b> فعّل حسابه بصلاحية ${roleLabel(p.role)}.`, null, env));
  }
  const staff = await loadStaff(env, true);
  if (!staff[chatId]) return false;
  await staffHome(chatId, { kind: 'staff', staff: staff[chatId] }, env, `✅ تم تفعيل صلاحية <b>${roleLabel(p.role)}</b> لحسابك.`);
  return true;
}

async function loadStaff(env, fresh) {
  const rows = await readSheet(`${SHEETS.STAFF}!A3:D`, env, { fresh });
  const map = {};
  rows.forEach((r, i) => {
    const id = String(r[0] || '').trim();
    if (!id || PENDING_RE.test(id)) return;
    map[id] = { chatId: id, name: r[1] || 'مشرف', role: normalizeRole(r[2]), studentPhone: normPhone(r[3]), row: 3 + i };
  });
  const main = adminId(env);
  if (main) {
    if (!map[main]) map[main] = { chatId: main, name: 'المشرف العام', role: 'admin', studentPhone: '', row: 0 };
    map[main].role = 'admin';
    if (!map[main].studentPhone && env.ADMIN_STUDENT_PHONE) map[main].studentPhone = normPhone(env.ADMIN_STUDENT_PHONE);
  }
  return map;
}

async function loadCourses(env, fresh) {
  const rows = await readSheet(`${SHEETS.COURSES}!A3:I`, env, { fresh });
  const list = rows.map((r, i) => ({
    id: String(r[0] || '').trim(),
    name: r[1] || '',
    visible: String(r[2] || '').trim() !== 'مخفي',
    order: Number(r[3]) || 0,
    track: String(r[5] || '').trim() === 'تتبع',
    pass: Number(r[6]) || 0,
    weeks: Number(r[7]) || 0,
    ppf: Number(r[8]) || 1,
    row: 3 + i
  })).filter(c => c.id);
  list.sort((a, b) => a.order - b.order || a.row - b.row);
  return list;
}

async function courseName(id, env) {
  if (!id || id === '0') return 'عام';
  const c = (await loadCourses(env)).find(x => x.id === id);
  return c ? c.name : 'غير معروف';
}

const FILES_HEADERS = [
  'التاريخ', 'المرسل', 'نوع_المحتوى', 'النص_أو_الوصف', 'اسم_الملف',
  'رابط_الملف', 'معرف_الملف', 'Telegram_file_id', 'معرف_المقرر', 'المفتاح',
  'تتبع_الاستماع', 'المدة_بالثواني', 'الأسبوع'
];

async function ensureFilesHeaders(env) {
  const key = 'files_headers_v4';
  if (await env.KV.get(key)) return;
  try {
    const rows = await readSheet(`${SHEETS.FILES}!A2:M2`, env, { fresh: true });
    const cur = (rows[0] || []).slice();
    while (cur.length < FILES_HEADERS.length) cur.push('');
    let changed = false;
    for (let i = 0; i < FILES_HEADERS.length; i++) {
      if (!String(cur[i] || '').trim()) { cur[i] = FILES_HEADERS[i]; changed = true; }
    }
    if (changed) {
      await writeSheet(`${SHEETS.FILES}!A2:M2`, [cur], env);
      console.log('Files headers fixed:', cur);
    }
    await env.KV.put(key, '1', { expirationTtl: 86400 });
  } catch (e) { console.error('ensureFilesHeaders:', e.message); }
}

async function loadFiles(env, fresh) {
  const rows = await readSheet(`${SHEETS.FILES}!A3:M`, env, { fresh });
  const list = [];
  rows.forEach((r, i) => {
    const type = String(r[2] || '').trim();
    if (!type || type === 'text') return;
    const key = String(r[9] || '').trim() || String(r[6] || '').trim();
    if (!key) return;
    list.push({
      row: 3 + i, date: r[0], by: r[1] || '', type,
      caption: r[3], name: r[4] || 'ملف', url: r[5],
      driveId: String(r[6] || '').trim(), tgId: String(r[7] || '').trim(),
      course: String(r[8] || '').trim() || '0', key,
      track: String(r[10] || '').trim() === 'تتبع',
      duration: Number(r[11]) || 0,
      week: Number(r[12]) || 0
    });
  });
  return list;
}

async function findFile(key, env, fresh) {
  return (await loadFiles(env, fresh)).find(f => f.key === key) || null;
}

async function fileCounts(env) {
  const c = {};
  (await loadFiles(env)).forEach(f => { c[f.course] = (c[f.course] || 0) + 1; });
  return c;
}

async function logAction(who, action, details, env) {
  try { await appendRow(SHEETS.LOG, [nowRiyadh(), who, action, details || ''], env); } catch (e) { /* ignore */ }
}

// ============================================================
// تحديد هوية المستخدم
// ============================================================
async function getActor(chatId, env) {
  const [staff, users] = await Promise.all([loadStaff(env), loadUsers(env)]);
  const st = staff[chatId];
  if (st) {
    const asStudent = !!st.studentPhone && (await env.KV.get(`sm_${chatId}`)) === '1';
    return { kind: asStudent ? 'student' : 'staff', staff: st, asStaffStudent: asStudent, phone: asStudent ? st.studentPhone : null };
  }
  let user = users.byChat[chatId];
  if (!user) user = (await loadUsers(env, true)).byChat[chatId];
  if (user) return { kind: 'student', phone: user.phone, asStaffStudent: false };
  return { kind: 'guest' };
}

// ============================================================
// المعالج الرئيسي
// ============================================================
const _seen = new Map();
let _lastErrAt = 0;

async function handleUpdate(update, env) {
  const uid = update.update_id;
  if (uid != null) {
    if (_seen.has(uid)) return;
    _seen.set(uid, Date.now());
    if (_seen.size > 500) {
      const cutoff = Date.now() - 60000;
      for (const [k, t] of _seen) { if (t < cutoff) _seen.delete(k); if (_seen.size < 400) break; }
    }
  }
  const chat = (update.callback_query && update.callback_query.message && update.callback_query.message.chat)
    || (update.message && update.message.chat) || {};
  try {
    await warm(env);
    if (update.callback_query) {
      bg(env, tg('answerCallbackQuery', { callback_query_id: update.callback_query.id }, env, true));
      await handleCallback(update.callback_query, env);
    } else if (update.message) {
      await handleMessage(update.message, env);
    }
  } catch (err) {
    await reportError(env, chat.type === 'private' ? String(chat.id) : null, err);
  }
}

async function reportError(env, chatId, err) {
  console.error('HANDLER-ERR:', (err && err.stack) || err);
  if (chatId) {
    const known = err && /تغيّر الجدول/.test(err.message || '');
    await send(chatId, known ? '⚠️ تغيّرت البيانات أثناء العملية، أعد المحاولة.' : '⚠️ <b>حصل خلل مؤقت</b>\nحاول مرة ثانية بعد لحظات.', null, env);
  }
  const now = Date.now();
  if (now - _lastErrAt > 60000 && adminId(env)) {
    _lastErrAt = now;
    await send(adminId(env), `<b>خطأ في البوت</b>\n<code>${esc(trunc(err && err.message, 300))}</code>`, null, env);
  }
}

const maintenanceText = () => card('<b>البوت تحت الصيانة</b>', [
  'نعمل على تحسين الخدمة حالياً.', 'سيعود البوت للعمل قريباً إن شاء الله.'
]);

async function handleMessage(msg, env) {
  if (!msg.chat || msg.chat.type !== 'private' || (msg.from && msg.from.is_bot)) return;
  const chatId = String(msg.chat.id);
  const text = String(msg.text || '').trim();

  if (text === '/id') return send(chatId, `رقم محادثتك: <code>${chatId}</code>`, null, env);

  const [actor, state] = await Promise.all([getActor(chatId, env), getState(chatId, env)]);
  const asStaff = actor.kind === 'staff';

  if (!asStaff && !actor.asStaffStudent && await isPaused(env)) return send(chatId, maintenanceText(), null, env);
  if (asStaff) return handleStaff(msg, text, actor, state, env);
  if (actor.kind === 'student') return handleStudent(msg, text, actor, state, env);
  return handleGuest(msg, text, state, env);
}

async function handleCallback(cb, env) {
  if (!cb.message) return;
  const chatId = String(cb.message.chat.id);
  const mid = cb.message.message_id;
  const actor = await getActor(chatId, env);
  const parts = String(cb.data || '').split(':');
  const act = parts[0];

  if (actor.kind === 'staff') return staffAction(chatId, actor, act, parts, env, mid);
  if (!actor.asStaffStudent && await isPaused(env)) return send(chatId, maintenanceText(), null, env);
  if (actor.kind === 'student') return handleStudentCallback(chatId, mid, act, parts, actor, env);
  return handleGuestCallback(chatId, mid, act, env);
}

// ============================================================
// لوحات الأزرار
// ============================================================
function studentMainKb(asStaff) {
  const rows = [
    ['نقاطي', 'ترتيبي'], ['مشاركاتي', 'حضوري'],
    ['غياباتي', 'المقررات'], ['ملفي', 'تواصل'], ['مساعدة']
  ];
  if (asStaff) rows.push(['لوحة الإدارة']);
  return replyKb(rows);
}

function staffMainKb(actor) {
  const rows = [
    ['الطلاب', 'البث'], ['المقررات', 'الاستماع'],
    ['الإحصاء', 'مطابقة'], ['مساعدة']
  ];
  if (actor.staff.role === 'admin') rows.push(['المشرفون', 'الإعدادات']);
  if (actor.staff.studentPhone) rows.push(['وضع الطالب']);
  return replyKb(rows);
}

const guestMainKb = () => ({
  keyboard: [
    [{ text: ico('مشاركة رقمي'), request_contact: true }],
    [{ text: ico('تواصل مع المشرف') }, { text: ico('مساعدة') }]
  ],
  resize_keyboard: true
});

// ============================================================
// المساعدة
// ============================================================
function helpContent(actor) {
  const tip = ['', 'اكتب «إلغاء» لإيقاف أي عملية، أو /start للرجوع للقائمة.'];
  const idTip = 'لمعرفة رقم محادثتك: اكتب /id';

  if (actor.kind === 'guest') {
    return {
      title: '<b>المساعدة</b> — زائر',
      lines: [
        'لن تظهر لك الخدمات إلا بعد التحقق من رقمك.', '',
        '<b>كيف أسجّل؟</b>',
        '1. اضغط «مشاركة رقمي» ويتم التحقق تلقائياً.',
        '2. أو اكتب رقم جوالك كما هو عند المشرف، مثل: <code>570456492</code> (يحتاج موافقة المشرف).',
        '', '<b>لم يُقبل رقمك؟</b>', 'تأكد من صحة الرقم، أو تواصل مع المشرف.',
        idTip, ...tip.slice(1)
      ],
      kb: [[btn('تواصل مع المشرف', 'contact')]]
    };
  }

  if (actor.kind === 'staff') {
    const isAdmin = actor.staff.role === 'admin';
    const lines = [
      `صلاحيتك: <b>${roleLabel(actor.staff.role)}</b>`, '',
      '<b>الطلاب</b>', 'عرض وبحث وإضافة وتعديل الطلاب وتغيير حالاتهم ومراسلتهم.', '',
      '<b>البث</b>', 'إرسال نص أو ملف لفئة محددة.', '',
      '<b>المقررات</b>', 'إضافة المقررات وترتيبها وإعادة تسميتها، ورفع الملفات ونقلها وإشعار الطلاب.', '',
      '<b>الاستماع</b>', 'قسّم المقرر إلى أسابيع، وحدّد درجة الاجتياز، وفعّل «تتبع الاستماع».'
    ];
    if (isAdmin) lines.push('', '<b>المشرفون</b>', 'تعيين مشرف برقم جواله وإزالته.', '', '<b>الإعدادات</b>', 'إيقاف البوت مؤقتاً للصيانة.');
    if (actor.staff.studentPhone) lines.push('', '<b>وضع الطالب</b>', 'تجرّب البوت كما يراه الطالب.');
    lines.push('', idTip, ...tip);
    return { title: `<b>المساعدة</b> — ${roleLabel(actor.staff.role)}`, lines, kb: [HOME_ROW] };
  }

  const lines = [
    'استخدم الأزرار في أسفل الشاشة:', '',
    '<b>نقاطي</b> — تفاصيل نقاطك ومجموعك',
    '<b>ترتيبي</b> — مركزك وفرق النقاط عن المتصدّر',
    '<b>مشاركاتي</b> — مشاركاتك ونقاطها',
    '<b>حضوري</b> — أسابيع الحضور ونسبتك',
    '<b>غياباتي</b> — أسابيع الغياب',
    '<b>المقررات</b> — ملفات البرنامج، وعلى الملفات المطلوبة (○) حمّلها واستمع، ثم اضغط «سمعته الآن»',
    '<b>ملفي</b> — بياناتك المسجّلة',
    '<b>تواصل</b> — رسالة للمشرف',
    ...tip
  ];
  const kb = [[btn('تواصل مع المشرف', 'contact')]];
  if (actor.asStaffStudent) kb.push([btn('لوحة الإدارة', 'toadmin')]);
  return { title: '<b>المساعدة</b> — طالب', lines, kb };
}

async function viewHelp(chatId, actor, env, mid) {
  const h = helpContent(actor);
  await show(chatId, mid, card(h.title, h.lines), h.kb, env);
}

// ============================================================
// الطالب
// ============================================================
const STUDENT_TEXT_MAP = {
  'نقاطي': 'pts', 'ترتيبي': 'rank', 'مشاركاتي': 'part', 'حضوري': 'att', 'غياباتي': 'abs', 'غيابي': 'abs',
  'الملفات': 'courses', 'المقررات': 'courses', 'ملفي': 'me', 'مساعدة': 'help',
  'تواصل': 'contact', 'contact': 'contact', 'لوحة الإدارة': 'toadmin'
};

function resolveStudentCommand(label) {
  if (!label) return null;
  if (isHome(label)) return 'home';
  if (isHelp(label)) return 'help';
  return STUDENT_TEXT_MAP[label.replace(/^\//, '').trim()] || null;
}

async function handleStudent(msg, text, actor, state, env) {
  const chatId = String(msg.chat.id);
  const label = cleanLabel(text);

  if (isCancel(label)) { await clearState(chatId, env); return studentHome(chatId, actor, env); }
  const cmd = resolveStudentCommand(label);
  if (cmd) {
    await clearState(chatId, env);
    if (cmd === 'contact') return startContact(chatId, env);
    if (cmd === 'toadmin') return switchToStaff(chatId, env);
    return studentAction(chatId, actor, cmd, [], env);
  }
  if (state && state.a === 'contact') return relayToStaff(msg, actor, env);
  return studentHome(chatId, actor, env);
}

async function handleStudentCallback(chatId, mid, act, parts, actor, env) {
  if (act === 'contact') return startContact(chatId, env);
  if (act === 'toadmin') return switchToStaff(chatId, env);
  if (act === 'cancel') { await clearState(chatId, env); return studentHome(chatId, actor, env); }
  return studentAction(chatId, actor, act, parts, env, mid);
}

async function studentAction(chatId, actor, act, parts, env, mid) {
  if (act === 'help') return viewHelp(chatId, actor, env, mid);

  const student = await findStudent(actor.phone, env);
  if (!student || student.state !== 'active') {
    const st = student ? student.state : 'deleted';
    bg(env, markSeen(chatId, st, env));
    return showBlocked(chatId, student, st, actor, env, mid);
  }
  bg(env, markSeen(chatId, 'active', env));

  switch (act) {
    case 'pts': return viewPoints(chatId, student, env);
    case 'rank': return viewRank(chatId, student, env);
    case 'part': return viewParticipations(chatId, student, env);
    case 'att': return viewAttendance(chatId, student, false, env);
    case 'abs': return viewAttendance(chatId, student, true, env);
    case 'hear': return confirmListen(chatId, student, parts[1], env, mid);
    case 'fview': return viewFileStudent(chatId, student, parts[1], env, mid);
    case 'me': return viewProfile(chatId, student, env);
    case 'courses': return viewCourses(chatId, false, env, mid);
    case 'files': return viewFiles(chatId, parts[1] || '0', parseInt(parts[2]) || 0, false, env, mid, parts[3]);
    case 'file': return deliverFile(chatId, parts[1], env, true);
    default: return studentHome(chatId, actor, env);
  }
}

async function studentHome(chatId, actor, env) {
  const student = await findStudent(actor.phone, env);
  const lines = [`<b>${esc(student ? student.name : 'طالب')}</b>`];
  if (student && student.level) lines.push('المستوى: ' + esc(student.level));
  if (student && student.statusText === 'عن بعد') lines.push('<i>طالب عن بعد</i>');
  lines.push('', 'اختر ما تريد من الأزرار في الأسفل.');
  await send(chatId, card('<b>منبر حسان</b>', lines), studentMainKb(actor.asStaffStudent), env);
}

async function showBlocked(chatId, student, state, actor, env, mid) {
  const text = blockedText(student, state);
  const kb = [[btn('تواصل مع المشرف', 'contact')]];
  if (actor.asStaffStudent) kb.push([btn('لوحة الإدارة', 'toadmin')]);
  await show(chatId, mid, text, kb, env);
}

function blockedText(student, state) {
  const st = student && student.statusText ? ` (الحالة: <b>${esc(student.statusText)}</b>)` : '';
  if (state === 'suspended') {
    return card('<b>حسابك موقوف</b>', [`تم إيقاف وصولك مؤقتاً${st}.`, '', 'إن كنت ترى أن هذا خطأ، تواصل مع المشرف.']);
  }
  return card('<b>حسابك محذوف</b>', [`لم تعد مسجّلاً في برنامج منبر حسان${st}.`, '', 'إن كنت ترى أن هذا خطأ، تواصل مع المشرف.']);
}

// ============================================================
// النقاط والترتيب
// ============================================================
async function loadCalendar(env) {
  try {
    const rows = await readSheet(`${SHEETS.CALENDAR}!A2:AZ`, env, { ttl: 30000 });
    if (!rows.length) return null;
    const header = rows[0];
    let totalIdx = header.length - 1;
    header.forEach((h, i) => { if (String(h).includes('المجموع الكلي')) totalIdx = i; });
    const data = rows.slice(1).map(r => ({
      key: normAr(r[1]), cells: r, total: Number(r[totalIdx]) || 0
    })).filter(x => x.key);
    return { header, rows: data, totalIdx };
  } catch (e) { return null; }
}

async function rankings(env) {
  const [cal, base] = await Promise.all([loadCalendar(env), loadBase(env)]);
  if (!cal) return [];
  const active = {};
  base.list.forEach(s => { if (s.state === 'active') active[normAr(s.name)] = true; });
  const arr = cal.rows.filter(r => active[r.key]).sort((a, b) => b.total - a.total);
  arr.forEach((r, i) => { r.rank = (i > 0 && r.total === arr[i - 1].total) ? arr[i - 1].rank : i + 1; });
  return arr;
}

async function viewPoints(chatId, student, env) {
  const cal = await loadCalendar(env);
  if (!cal) return send(chatId, '❌ جدول النقاط غير متوفر الآن.', null, env);
  const key = normAr(student.name);
  const mine = cal.rows.find(r => r.key === key);
  if (!mine) return send(chatId, 'لا توجد نقاط مسجّلة لك حتى الآن.', null, env);
  const lines = [];
  for (let c = 2; c < cal.header.length; c++) {
    const label = String(cal.header[c] || '').trim();
    const val = String(mine.cells[c] ?? '0').trim();
    if (label && c !== cal.totalIdx) lines.push(`• ${esc(label)}: <b>${esc(val)}</b>`);
  }
  lines.push(CFG.LINE, `المجموع الكلي: <b>${mine.total}</b>`);
  await send(chatId, card('<b>نقاطك حتى الآن</b>', lines), null, env);
}

async function viewRank(chatId, student, env) {
  const lb = await rankings(env);
  const key = normAr(student.name);
  const mine = lb.find(r => r.key === key);
  if (!mine) return send(chatId, 'لا يوجد ترتيب لك حتى الآن.', null, env);
  const lines = [`مركزك: <b>${mine.rank}</b> من ${lb.length}`, `مجموع نقاطك: <b>${mine.total}</b>`];
  if (mine.rank > 1) lines.push(`الفرق بينك وبين المركز الأول: <b>${lb[0].total - mine.total}</b> نقطة`);
  else lines.push('ما شاء الله، أنت في المركز الأول.');
  await send(chatId, card('<b>ترتيبك</b>', lines), null, env);
}

async function viewParticipations(chatId, student, env) {
  const rows = await readSheet(`${SHEETS.PARTICIPATIONS}!A2:E`, env, { ttl: 30000 });
  const key = normAr(student.name);
  const mine = rows.filter(r => normAr(r[2]) === key).map(r => ({ desc: r[3], pts: r[4] }));
  if (!mine.length) return send(chatId, 'لا توجد مشاركات مسجّلة باسمك.', null, env);
  let total = 0;
  mine.forEach(m => total += Number(m.pts) || 0);
  const lines = mine.slice(-10).reverse().map(m => `• ${esc(m.desc)} — ${esc(m.pts)} نقاط`);
  if (mine.length > 10) lines.push('<i>… ويظهر هنا آخر 10 مشاركات فقط</i>');
  lines.push(CFG.LINE, `مجموع النقاط: <b>${total}</b>`, `عدد المشاركات: <b>${mine.length}</b>`);
  await send(chatId, card('<b>مشاركاتك</b>', lines), null, env);
}

async function getAttendance(studentName, env) {
  try {
    const rows = await readSheet(`${SHEETS.ATTENDANCE_IN}!A2:B100`, env, { ttl: 30000 });
    const key = normAr(studentName);
    const out = {};
    for (let w = 1; w <= CFG.WEEKS; w++) {
      const start = 2 + (w - 1) * CFG.ATT_BLOCK;
      const end = Math.min(start + CFG.ATT_BLOCK - 2, rows.length - 1);
      if (start > rows.length - 1) break;
      for (let r = start; r <= end; r++) {
        if (rows[r] && normAr(rows[r][0]) === key) { out[w] = String(rows[r][1] || '').trim(); break; }
      }
    }
    return out;
  } catch (e) { return null; }
}

async function viewAttendance(chatId, student, absencesOnly, env) {
  const att = await getAttendance(student.name, env);
  if (!att) return send(chatId, '❌ جدول الحضور غير متوفر الآن.', null, env);
  const g = { 'حاضر': [], 'غائب': [], 'عن بعد': [] };
  Object.keys(att).forEach(w => { if (g[att[w]]) g[att[w]].push(w); });

  if (absencesOnly) {
    if (!g['غائب'].length) return send(chatId, '<b>ممتاز.</b> لا توجد عليك غيابات.', null, env);
    return send(chatId, card('<b>غياباتك</b>', [
      `الأسابيع: ${g['غائب'].join('، ')}`, `العدد: <b>${g['غائب'].length}</b>`
    ]), null, env);
  }
  const recorded = g['حاضر'].length + g['غائب'].length + g['عن بعد'].length;
  if (!recorded) return send(chatId, 'لا يوجد حضور مسجّل حتى الآن.', null, env);
  const lines = [];
  if (g['حاضر'].length) lines.push(`حاضر: ${g['حاضر'].join('، ')}`);
  if (g['عن بعد'].length) lines.push(`عن بعد: ${g['عن بعد'].join('، ')}`);
  if (g['غائب'].length) lines.push(`غائب: ${g['غائب'].join('، ')}`);
  const pct = Math.round((g['حاضر'].length + g['عن بعد'].length) / recorded * 100);
  lines.push(CFG.LINE, `نسبة حضورك: <b>${pct}%</b>`);
  await send(chatId, card('<b>حضورك</b>', lines), null, env);
}

async function viewProfile(chatId, student, env) {
  const user = (await loadUsers(env)).byChat[chatId];
  const ph = student.phone;
  const lines = [
    `الاسم: <b>${esc(student.name)}</b>`,
    `الرمز: ${esc(student.code || '—')}`,
    `المستوى: ${esc(student.level || '—')}`,
    `الجوال: ${ph.substring(0, 2)}•••••${ph.slice(-2)}`,
    `الحالة: ${esc(student.statusText || 'نشط')}`
  ];
  if (user) lines.push(`التسجيل في البوت: ${esc(user.registered)}`);
  await send(chatId, card('<b>ملفي</b>', lines), null, env);
}

// ============================================================
// المقررات والملفات (عرض)
// ============================================================
async function viewCourses(chatId, staff, env, mid) {
  const [counts, courses] = await Promise.all([fileCounts(env), loadCourses(env)]);
  const kb = [];
  const general = counts['0'] || 0;
  if (general || staff) kb.push([btn(`📁 عام (${general})`, 'files:0:0')]);
  courses.forEach(c => {
    if (!staff && !c.visible) return;
    kb.push([btn(`${c.visible ? '📁' : '🙈'} ${trunc(c.name, 32)} (${counts[c.id] || 0})`, `files:${c.id}:0`)]);
  });
  let total = 0;
  Object.keys(counts).forEach(k => total += counts[k]);

  if (staff) {
    kb.push([btn('مقرر جديد', 'cadd')]);
    kb.push(HOME_ROW);
    return show(chatId, mid, card('<b>المقررات والملفات</b>', [
      `إجمالي الملفات: <b>${total}</b>`, '', 'افتح المقرر لرفع الملفات وترتيبها وإدارتها.'
    ]), kb, env);
  }
  if (!kb.length) return show(chatId, mid, 'لا توجد مقررات أو ملفات حتى الآن.', null, env);
  await show(chatId, mid, card('<b>المقررات والملفات</b>', ['اختر المقرر:']), kb, env);
}

const weekQ = w => (w === undefined || w === null || w === '' ? '' : ':' + w);

async function heardKeysOf(chatId, env) {
  const set = new Set();
  const u = (await loadUsers(env)).byChat[chatId];
  if (u) (await loadListens(env)).forEach(l => { if (l.phone === u.phone) set.add(l.key); });
  return set;
}

function countLine(tracked, heard) {
  return `المسجَّل لك: <b>${tracked.filter(f => heard.has(f.key)).length}</b> من ${tracked.length}`;
}

function staffCourseRows(course, courses, tracked, courseId) {
  const kb = [[btn('📤 رفع ملف إلى هذا المقرر', `cupl:${courseId}`)]];
  if (tracked.length) kb.push([btn('متابعة الاستماع', `lcourse:${courseId}`)]);
  if (courseId !== '0' && course) {
    kb.push([btn('إعدادات المقرر', `cset:${courseId}`)]);
    const idx = courses.indexOf(course);
    const mv = [];
    if (idx > 0) mv.push(btn('رفع للأعلى', `cup:${courseId}`));
    if (idx < courses.length - 1) mv.push(btn('إنزال للأسفل', `cdown:${courseId}`));
    if (mv.length) kb.push(mv);
    kb.push([btn('إعادة تسمية', `cren:${courseId}`), btn(course.visible ? 'إخفاء' : 'إظهار', `ctoggle:${courseId}`)]);
    kb.push([btn('حذف المقرر', `cdel:${courseId}`)]);
  }
  return kb;
}

async function viewFiles(chatId, courseId, page, staff, env, mid, week) {
  const [courses, allFiles] = await Promise.all([loadCourses(env), loadFiles(env)]);
  const course = courses.find(c => c.id === courseId);
  const courseFiles = allFiles.filter(f => f.course === courseId);
  const tracked = courseFiles.filter(f => f.track);
  const heard = (!staff && tracked.length) ? await heardKeysOf(chatId, env) : new Set();
  const weeks = course ? course.weeks : 0;
  const cname = await courseName(courseId, env);

  if (weeks > 0 && week === undefined) {
    const usedWeeks = courseFiles.map(f => f.week || 0);
    const maxWeek = Math.max(weeks, ...usedWeeks, 0);
    const kb = [];
    for (let w = 1; w <= maxWeek; w++) {
      const list = courseFiles.filter(f => f.week === w);
      if (!list.length && !staff) continue;
      const tl = list.filter(f => f.track);
      const prog = (!staff && tl.length) ? ` — ${tl.filter(f => heard.has(f.key)).length}/${tl.length}` : '';
      kb.push([btn(`الأسبوع ${w} (${list.length})${prog}`, `files:${courseId}:0:${w}`)]);
    }
    const none = courseFiles.filter(f => !f.week);
    if (none.length) kb.push([btn(`بدون أسبوع (${none.length})`, `files:${courseId}:0:n`)]);
    if (staff) staffCourseRows(course, courses, tracked, courseId).forEach(r => kb.push(r));
    kb.push([btn('المقررات', 'courses')]);
    const lines = [courseFiles.length ? 'اختر الأسبوع:' : 'لا توجد ملفات في هذا المقرر بعد.'];
    if (!staff && tracked.length) lines.push(countLine(tracked, heard));
    if (staff && tracked.length) lines.push(`🎯 ملفات بتتبع الاستماع: <b>${tracked.length}</b>`);
    if (staff && maxWeek > weeks) lines.push(`💡 ملفات في أسابيع أكبر من ${weeks} (المقرر معروض على ${weeks}).`);
    return show(chatId, mid, card(`📁 <b>${esc(cname)}</b>`, lines), kb, env);
  }

  let files = courseFiles.slice();
  if (week !== undefined) files = files.filter(f => (week === 'n' ? !f.week : f.week === Number(week)));
  if (weeks === 0) files.reverse();

  const pages = Math.max(1, Math.ceil(files.length / CFG.PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const wq = weekQ(week);
  const kb = [];
  files.slice(page * CFG.PAGE_SIZE, (page + 1) * CFG.PAGE_SIZE).forEach(f => {
    const mark = (f.track ? (staff ? '🎯' : (heard.has(f.key) ? '✅' : '⭕')) : (TYPE_EMOJI[f.type] || '📄')) + ' ';
    const data = staff ? `fcard:${f.key}` : (f.track ? `fview:${f.key}` : `file:${f.key}`);
    kb.push([btn(`${mark}${trunc(stripExt(f.name), 32)}`, data)]);
  });
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push(btn('السابق', `files:${courseId}:${page - 1}${wq}`));
    nav.push(btn(`${page + 1}/${pages}`, `files:${courseId}:${page}${wq}`));
    if (page < pages - 1) nav.push(btn('التالي', `files:${courseId}:${page + 1}${wq}`));
    kb.push(nav);
  }
  if (staff) {
    if (week !== undefined && week !== 'n') {
      kb.push([btn(`رفع ملفات إلى الأسبوع ${week}`, `uwk:${courseId}:${week}`)]);
      if (tracked.length) kb.push([btn('متابعة الاستماع لهذا الأسبوع', `lcourse:${courseId}:${week}`)]);
    } else if (week === undefined && weeks === 0) {
      staffCourseRows(course, courses, tracked, courseId).forEach(r => kb.push(r));
    }
  }
  kb.push(week !== undefined ? [btn('الأسابيع', `files:${courseId}:0`)] : [btn('المقررات', 'courses')]);

  const lines = [files.length ? `عدد الملفات: <b>${files.length}</b> — اضغط على الملف ${staff ? 'لإدارته' : 'لفتحه'}:` : 'لا توجد ملفات هنا بعد.'];
  if (tracked.length) {
    lines.push(staff ? `🎯 ملفات بتتبع الاستماع: <b>${tracked.length}</b>` : countLine(tracked, heard) + '\n✅ تم تسجيله   ⭕ مطلوب تسجيله');
  }
  const title = week === undefined ? esc(cname) : `${esc(cname)} — ${week === 'n' ? 'بدون أسبوع' : 'الأسبوع ' + esc(week)}`;
  await show(chatId, mid, card(`📁 <b>${title}</b>`, lines), kb, env);
}

async function viewFileCard(chatId, key, env, mid) {
  const f = await findFile(key, env);
  if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
  const dl = Number(await env.KV.get(`dl_${key}`) || 0);
  const fcourse = (await loadCourses(env)).find(c => c.id === f.course);
  const lines = [
    `النوع: ${TYPE_LABEL[f.type] || 'ملف'}`,
    `المقرر: ${esc(await courseName(f.course, env))}`,
    `رُفع في: ${esc(f.date || '—')}${f.by ? ' بواسطة ' + esc(f.by) : ''}`,
    `مرات الاستلام: <b>${dl}</b>`
  ];
  if (fcourse && fcourse.weeks > 0) lines.push(`الأسبوع: <b>${f.week || '—'}</b>`);
  lines.push(`تتبع الاستماع: <b>${f.track ? 'مفعّل' : 'متوقف'}</b>`);
  if (f.url) lines.push(`<a href="${esc(f.url)}">فتح في Filebase</a>`);
  const kb = [
    [btn('استلام الملف', `file:${key}`), btn('إشعار الطلاب', `cnotify:${key}`)],
    [btn('إعادة تسمية', `fren:${key}`), btn('نقل إلى مقرر', `fmove:${key}`)]
  ];
  if (fcourse && fcourse.weeks > 0) kb.push([btn('تغيير الأسبوع', `fweek:${key}`)]);
  kb.push([btn(f.track ? 'إيقاف تتبع الاستماع' : 'تفعيل تتبع الاستماع', `ftrack:${key}`)]);
  if (f.track) kb.push([btn('من استمع ومن لم يستمع', `lfile:${key}`)]);
  kb.push([btn('حذف الملف', `fdel:${key}`)], [btn('رجوع', `files:${f.course}:0`)]);
  await show(chatId, mid, card(`${TYPE_EMOJI[f.type] || '📄'} <b>${esc(stripExt(f.name))}</b>`, lines), kb, env);
}

async function deliverFile(chatId, key, env, count) {
  const f = await findFile(key, env);
  if (!f) return send(chatId, '❌ الملف غير موجود.', null, env);

  const methodMap = {
    document: ['sendDocument', 'document'], photo: ['sendPhoto', 'photo'], video: ['sendVideo', 'video'],
    audio: ['sendAudio', 'audio'], voice: ['sendVoice', 'voice']
  };
  const m = methodMap[f.type] || methodMap.document;
  const caption = f.caption ? esc(f.caption) : '';

  const bump = async () => {
    if (!count) return;
    bg(env, (async () => {
      const k = `dl_${key}`;
      await env.KV.put(k, String(Number(await env.KV.get(k) || 0) + 1));
    })());
    if (f.track) await promptListen(chatId, f, env);
  };

  if (f.tgId) {
    const payload = { chat_id: chatId };
    payload[m[1]] = f.tgId;
    if (caption) { payload.caption = caption; payload.parse_mode = 'HTML'; }
    const r = await tg(m[0], payload, env);
    if (r.ok) return await bump();
  }
  if (!f.driveId) return send(chatId, '❌ تعذّر إرسال الملف.', null, env);

  bg(env, tg('sendChatAction', { chat_id: chatId, action: 'upload_document' }, env, true));
  const blob = await downloadFromFilebase(f.driveId, env);
  if (!blob) return send(chatId, '❌ تعذّر تحميل الملف من Filebase.', null, env);
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append(m[1], blob, f.name);
  if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${m[0]}`, { method: 'POST', body: form });
  const data = await res.json();
  if (data.ok) {
    const r = data.result;
    const fid = (r.document && r.document.file_id) || (r.video && r.video.file_id) ||
      (r.audio && r.audio.file_id) || (r.voice && r.voice.file_id) ||
      (r.photo ? r.photo[r.photo.length - 1].file_id : '');
    if (fid) bg(env, updateCell(SHEETS.FILES, f.row, 8, fid, env, { col: 'J', val: f.key }));
    await bump();
  } else {
    await send(chatId, '❌ تعذّر إرسال الملف.', null, env);
  }
}

// ============================================================
// تتبع الاستماع
// ============================================================
const LISTEN_HEADER = ['التاريخ', 'الاسم', 'الجوال', 'المقرر', 'الملف', 'الأسبوع', 'النقاط', 'معرّف المحادثة', 'مفتاح الملف', 'رمز المقرر'];
const doneLabel = type => (type === 'video' ? 'شاهدته الآن' : (type === 'voice' || type === 'audio') ? 'سمعته الآن' : 'اطلعت عليه الآن');
const isMedia = type => type === 'voice' || type === 'audio' || type === 'video';

async function ensureListenSheet(env) {
  const res = await gfetch(`${sheetsBase(env)}:batchUpdate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEETS.LISTEN } } }] })
  }, env);
  const data = await res.json();
  MEM.delete('meta');
  if (!data.error || /already exists/i.test(data.error.message || '')) {
    await writeSheet(`${SHEETS.LISTEN}!A1:J1`, [LISTEN_HEADER], env);
  }
}

async function migrateListenSheet(rows, env) {
  const [files, courses] = await Promise.all([loadFiles(env), loadCourses(env)]);
  const out = [LISTEN_HEADER];
  rows.slice(1).forEach(r => {
    const f = files.find(x => x.key === String(r[4] || '').trim());
    const c = courses.find(x => x.id === String(r[5] || '').trim());
    out.push([r[0] || '', r[3] || '', r[2] || '', c ? c.name : (String(r[5]) === '0' ? 'عام' : ''), f ? f.name : '',
      f && f.week ? f.week : '', c ? c.ppf : 1, r[1] || '', r[4] || '', r[5] || '']);
  });
  await writeSheet(`${SHEETS.LISTEN}!A1:J${out.length}`, out, env);
  return out;
}

let _listensReady = false;
async function loadListens(env, fresh) {
  let rows;
  try {
    rows = await readSheet(`${SHEETS.LISTEN}!A1:J`, env, { fresh, ttl: 15000 });
    _listensReady = true;
  } catch (e) {
    if (!_listensReady) {
      await ensureListenSheet(env);
      _listensReady = true;
      rows = [LISTEN_HEADER];
    } else {
      return [];
    }
  }
  if (!rows.length) {
    await writeSheet(`${SHEETS.LISTEN}!A1:J1`, [LISTEN_HEADER], env);
    rows = [LISTEN_HEADER];
  } else if (String(rows[0][1] || '') === 'معرّف المحادثة') {
    rows = await migrateListenSheet(rows, env);
  }
  return rows.slice(1).map((r, i) => ({
    date: String(r[0] || ''), name: r[1] || '', phone: normPhone(r[2]), week: Number(r[5]) || 0,
    points: Number(r[6]) || 0, chat: String(r[7] || ''), key: String(r[8] || '').trim(),
    course: String(r[9] || '').trim(), row: i + 2
  })).filter(l => l.key && l.phone);
}

const backTo = (f, course) => `files:${f.course}:0${course && course.weeks > 0 ? ':' + (f.week || 'n') : ''}`;

async function viewFileStudent(chatId, student, key, env, mid) {
  const [f, listens, courses] = await Promise.all([findFile(key, env), loadListens(env), loadCourses(env)]);
  if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
  const course = courses.find(c => c.id === f.course);
  const done = listens.some(l => l.phone === student.phone && l.key === key);
  const lines = [`المقرر: ${esc(await courseName(f.course, env))}`];
  if (course && course.weeks > 0) lines.push(`الأسبوع: ${f.week || '—'}`);
  if (f.duration) lines.push(`المدة: نحو ${Math.max(1, Math.round(f.duration / 60))} دقيقة`);
  if (f.track) {
    lines.push(`الحالة: <b>${done ? '✓ سُجّل إنجازك' : 'لم يُسجَّل بعد'}</b>`);
    if (!done) lines.push('', 'حمّل الملف الآن واستمع في الوقت الذي يناسبك، ثم اضغط الزر بعد أن تنهيه.');
  }
  const kb = [[btn('استلام الملف', `file:${key}`)]];
  if (f.track && !done) kb.push([btn(doneLabel(f.type), `hear:${key}`)]);
  kb.push([btn('رجوع', backTo(f, course))]);
  await show(chatId, mid, card(`${TYPE_EMOJI[f.type] || '📄'} <b>${esc(stripExt(f.name))}</b>`, lines), kb, env);
}

async function promptListen(chatId, f, env) {
  const u = (await loadUsers(env)).byChat[chatId];
  if (!u) return;
  const heard = (await loadListens(env)).some(l => l.phone === u.phone && l.key === f.key);
  if (heard) return send(chatId, '✅ سبق أن سجّلت إنجازك لهذا الملف.', null, env);
  const k = `lt_${chatId}_${f.key}`;
  if (await env.KV.get(k)) return;
  await env.KV.put(k, String(Date.now()), { expirationTtl: 2592000 });
  await send(chatId, card('<b>تسجيل الإنجاز</b>', [
    'استمع في الوقت الذي يناسبك، وبعد أن تنهيه اضغط الزر.',
    'الزر يبقى متاحاً من قائمة المقرر في أي وقت.'
  ]), [[btn(doneLabel(f.type), `hear:${f.key}`)]], env);
}

async function confirmListen(chatId, student, key, env, mid) {
  const f = await findFile(key, env);
  if (!f || !f.track) return show(chatId, mid, 'هذا الملف غير مطلوب تسجيله حالياً.', null, env);

  const listens = await loadListens(env, true);
  if (listens.some(l => l.phone === student.phone && l.key === key)) {
    return show(chatId, mid, '✅ سبق تسجيل إنجازك لهذا الملف.', null, env);
  }
  if (f.duration && isMedia(f.type)) {
    const t = Number(await env.KV.get(`lt_${chatId}_${key}`));
    if (!t) return show(chatId, mid, 'استلم الملف أولاً، ثم اضغط الزر بعد إنهائه.', [[btn('استلام الملف', `file:${key}`)]], env);
    const left = f.duration * 0.85 * 1000 - (Date.now() - t);
    if (left > 0) {
      const mins = Math.max(1, Math.ceil(left / 60000));
      return show(chatId, mid, card('<b>لم تنتهِ المدة بعد</b>', [
        `أكمل الاستماع، وبعد نحو ${mins} دقيقة اضغط الزر مرة أخرى.`
      ]), [[btn(doneLabel(f.type), `hear:${key}`)]], env);
    }
  }
  const [courses, files] = await Promise.all([loadCourses(env), loadFiles(env)]);
  const course = courses.find(c => c.id === f.course);
  const ppf = course ? course.ppf : 1;
  await appendRow(SHEETS.LISTEN, [
    nowRiyadh(), student.name, student.phone, await courseName(f.course, env), f.name,
    f.week || '', ppf, chatId, key, f.course
  ], env);

  bg(env, upsertSummary(env, student, f.course));
  const mine = new Set(listens.filter(l => l.phone === student.phone).map(l => l.key));
  mine.add(key);
  const tracked = files.filter(x => x.course === f.course && x.track);
  await show(chatId, mid, card('✅ <b>سُجّل إنجازك</b>', [`<b>${esc(stripExt(f.name))}</b>`, countLine(tracked, mine)]),
    [[btn('رجوع إلى المقرر', backTo(f, course))]], env);
}

async function toggleFileTrack(chatId, key, actor, env, mid) {
  const f = await findFile(key, env, true);
  if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
  await updateCell(SHEETS.FILES, f.row, 11, f.track ? '' : 'تتبع', env, { col: 'J', val: f.key });
  bg(env, logAction(actor.staff.name, f.track ? 'إيقاف تتبع' : 'تفعيل تتبع', f.name, env));
  bg(env, rebuildSummary(env).then(n => console.log('Summary rows:', n)).catch(e => console.error('Summary err:', e.message)));
  await viewFileCard(chatId, key, env, mid);
}

async function toggleCourseTrack(chatId, id, actor, env, mid) {
  const c = (await loadCourses(env, true)).find(x => x.id === id);
  if (c) {
    await updateCell(SHEETS.COURSES, c.row, 6, c.track ? '' : 'تتبع', env, { col: 'A', val: c.id });
    bg(env, logAction(actor.staff.name, c.track ? 'إيقاف تتبع مقرر' : 'تفعيل تتبع مقرر', c.name, env));
  }
  await viewCourseSettings(chatId, id, env, mid);
}

async function showFileWeekPicker(chatId, key, env, mid) {
  const f = await findFile(key, env);
  if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
  const c = (await loadCourses(env)).find(x => x.id === f.course);
  if (!c || !c.weeks) return show(chatId, mid, 'حدّد عدد أسابيع المقرر أولاً من «إعدادات المقرر».', [[btn('رجوع', `fcard:${key}`)]], env);
  const nums = [];
  for (let w = 1; w <= CFG.WEEKS; w++) nums.push(btn(`الأسبوع ${w}`, `fweekset:${key}:${w}`));
  const kb = chunk(nums, 4);
  kb.push([btn('بدون أسبوع', `fweekset:${key}:0`)], [btn('رجوع', `fcard:${key}`)]);
  await show(chatId, mid, card('<b>تغيير الأسبوع</b>', [`الملف: ${esc(stripExt(f.name))}`, 'اختر الأسبوع:']), kb, env);
}

async function setFileWeek(chatId, key, w, actor, env, mid) {
  const f = await findFile(key, env, true);
  if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
  await updateCell(SHEETS.FILES, f.row, 13, w || '', env, { col: 'J', val: f.key });
  bg(env, logAction(actor.staff.name, 'تغيير أسبوع ملف', `${f.name} → ${w || 'بدون'}`, env));
  bg(env, rebuildSummary(env).catch(e => console.error('Rebuild:', e.message)));
  await viewFileCard(chatId, key, env, mid);
}

async function viewListenMenu(chatId, env, mid) {
  const [files, courses] = await Promise.all([loadFiles(env), loadCourses(env)]);
  const counts = {};
  files.forEach(f => { if (f.track) counts[f.course] = (counts[f.course] || 0) + 1; });
  const kb = [];
  if (counts['0']) kb.push([btn(`📁 عام (${counts['0']})`, 'lcourse:0')]);
  courses.forEach(c => { if (counts[c.id]) kb.push([btn(`📁 ${trunc(c.name, 30)} (${counts[c.id]})`, `lcourse:${c.id}`)]); });
  const lines = kb.length
    ? ['اختر المقرر لعرض من استمع ومن لم يستمع:']
    : ['لا توجد ملفات بتتبع الاستماع بعد.', '', 'فعّل التتبع من «إعدادات المقرر» (للملفات الجديدة) أو من بطاقة أي ملف.'];
  if (kb.length) kb.push([btn('تحديث ملخص الإكسل', 'lsum')]);
  kb.push(HOME_ROW);
  await show(chatId, mid, card('<b>متابعة الاستماع</b>', lines), kb, env);
}

async function viewListenCourse(chatId, cid, week, env, mid) {
  const [files, base, listens, courses, cname] = await Promise.all([
    loadFiles(env), loadBase(env), loadListens(env, true), loadCourses(env), courseName(cid, env)
  ]);
  const course = courses.find(c => c.id === cid);
  const allT = files.filter(f => f.course === cid && f.track);
  if (!allT.length) return show(chatId, mid, 'لا توجد ملفات بتتبع الاستماع في هذا المقرر.', [[btn('الاستماع', 'lmenu')]], env);
  const wk = week ? Number(week) : 0;
  const tf = wk ? allT.filter(f => f.week === wk) : allT;
  if (!tf.length) return show(chatId, mid, 'لا توجد ملفات متتبَّعة في هذا الأسبوع.', [[btn('المقرر', `lcourse:${cid}`)]], env);

  const ppf = course ? course.ppf : 1;
  const pass = !wk && course ? course.pass : 0;
  const keys = new Set(tf.map(f => f.key));
  const heardBy = {};
  listens.forEach(l => { if (keys.has(l.key)) (heardBy[l.phone] = heardBy[l.phone] || new Set()).add(l.key); });
  const students = base.list.filter(s => s.state === 'active').sort((a, b) => a.name.localeCompare(b.name, 'ar'));

  let passed = 0, none = 0;
  const total = tf.length * ppf;
  const rows = students.map(s => {
    const n = heardBy[s.phone] ? heardBy[s.phone].size : 0;
    const earned = n * ppf;
    if (!n) none++;
    let mark;
    if (pass > 0) { mark = earned >= pass ? '✓' : (n ? '•' : '○'); if (earned >= pass) passed++; }
    else mark = n === tf.length ? '✓' : (n ? '•' : '○');
    return `${mark} ${esc(s.name)} — <b>${earned}</b>/${total}`;
  });
  const lines = [`الملفات المتتبَّعة: <b>${tf.length}</b> — الدرجة الكاملة: <b>${total}</b>`];
  if (pass > 0) lines.push(`درجة الاجتياز: <b>${pass}</b> — اجتاز: <b>${passed}</b> من ${students.length}`);
  lines.push(`لم يبدأ: <b>${none}</b>`, pass > 0 ? '✓ اجتاز   • لم يجتز بعد   ○ لم يبدأ' : '✓ أكمل   • جزئي   ○ لم يبدأ', CFG.LINE, ...rows);

  const kb = [];
  if (course && course.weeks > 0) {
    const nums = [btn('كل المقرر', `lcourse:${cid}`)];
    for (let w = 1; w <= course.weeks; w++) if (allT.some(f => f.week === w)) nums.push(btn(`أ${w}`, `lcourse:${cid}:${w}`));
    chunk(nums, 4).forEach(r => kb.push(r));
  }
  tf.slice(-10).reverse().forEach(f => kb.push([btn(trunc(stripExt(f.name), 34), `lfile:${f.key}`)]));
  kb.push([btn('الاستماع', 'lmenu'), btn('المقرر', `files:${cid}:0`)]);
  await show(chatId, mid, card(`🎧 <b>${esc(cname)}</b>${wk ? ` — الأسبوع ${wk}` : ''}`, lines), kb, env);
}

async function viewListenFile(chatId, key, env, mid) {
  const f = await findFile(key, env);
  if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('الاستماع', 'lmenu')]], env);
  const [base, listens, users] = await Promise.all([loadBase(env), loadListens(env, true), loadUsers(env)]);
  const when = {};
  listens.forEach(l => { if (l.key === key) when[l.phone] = l.date; });
  const students = base.list.filter(s => s.state === 'active').sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  const yes = students.filter(s => when[s.phone]);
  const no = students.filter(s => !when[s.phone]);
  const lines = [];
  if (f.week) lines.push(`الأسبوع: ${f.week}`);
  lines.push(`استمع: <b>${yes.length}</b> من ${students.length}`, '', '<b>استمعوا:</b>');
  lines.push(...(yes.length ? yes.map(s => `✓ ${esc(s.name)} <i>(${esc(String(when[s.phone]).slice(5))})</i>`) : ['—']));
  lines.push('', '<b>لم يستمعوا:</b>');
  lines.push(...(no.length ? no.map(s => `○ ${esc(s.name)}${users.byPhone[s.phone] ? '' : ' <i>(لم يدخل البوت)</i>'}`) : ['—']));
  const kb = [];
  if (no.some(s => users.byPhone[s.phone])) kb.push([btn('تذكير من لم يستمع', `lremind:${key}`)]);
  kb.push([btn('المقرر', `lcourse:${f.course}`), btn('الاستماع', 'lmenu')]);
  await show(chatId, mid, card(`${TYPE_EMOJI[f.type] || '📄'} <b>${esc(stripExt(f.name))}</b>`, lines), kb, env);
}

async function remindListen(chatId, key, confirmed, actor, env, mid) {
  const f = await findFile(key, env);
  if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('الاستماع', 'lmenu')]], env);
  const [base, listens, users, staff] = await Promise.all([loadBase(env), loadListens(env, true), loadUsers(env), loadStaff(env)]);
  const done = new Set(listens.filter(l => l.key === key).map(l => l.phone));
  const ids = [];
  base.list.forEach(s => {
    if (s.state !== 'active' || done.has(s.phone)) return;
    (users.byPhone[s.phone] || []).forEach(u => { if (!staff[u.chatId]) ids.push(u.chatId); });
  });
  if (!ids.length) return show(chatId, mid, 'لا يوجد من يحتاج تذكيراً.', [[btn('رجوع', `lfile:${key}`)]], env);
  if (!confirmed) {
    return show(chatId, mid, card('<b>تأكيد التذكير</b>', [
      `الملف: ${esc(stripExt(f.name))}`, `عدد من سيصلهم التذكير: <b>${ids.length}</b>`
    ]), [[btn('إرسال التذكير', `lremindok:${key}`), btn('تراجع', `lfile:${key}`)]], env);
  }
  const body = card('<b>تذكير</b>', [`لم يُسجَّل لك إنجاز الملف: <b>${esc(stripExt(f.name))}</b>`, 'افتحه، واستمع في الوقت المناسب، ثم سجّل إنجازك.']);
  bg(env, (async () => {
    const r = await massSend(ids, 'sendMessage', id => ({
      chat_id: id, text: body, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[btn('فتح الملف', `fview:${key}`)]] }
    }), env);
    await logAction(actor.staff.name, 'تذكير استماع', `${f.name} (${r.ok})`, env);
  })());
  await show(chatId, mid, `⏳ جاري إرسال التذكير إلى <b>${ids.length}</b> طالب…`, [[btn('رجوع', `lfile:${key}`)]], env);
}

async function viewListenStudent(chatId, phone, env, mid) {
  const [s, files, listens, courses] = await Promise.all([findStudent(phone, env), loadFiles(env), loadListens(env, true), loadCourses(env)]);
  if (!s) return show(chatId, mid, '❌ الطالب غير موجود.', [[btn('الطلاب', 'students')]], env);
  const mine = new Set(listens.filter(l => l.phone === phone).map(l => l.key));
  const tf = files.filter(f => f.track);
  const lines = [];
  if (!tf.length) lines.push('لا توجد ملفات بتتبع الاستماع.');
  const groups = [{ id: '0', name: 'عام', ppf: 1, pass: 0 }, ...courses.map(c => ({ id: c.id, name: c.name, ppf: c.ppf, pass: c.pass }))];
  groups.forEach(g => {
    const list = tf.filter(f => f.course === g.id);
    if (!list.length) return;
    const n = list.filter(f => mine.has(f.key)).length;
    const earned = n * g.ppf;
    lines.push(`<b>${esc(g.name)}</b>: ${earned}/${list.length * g.ppf}${g.pass > 0 ? (earned >= g.pass ? ' (اجتاز)' : ` (الاجتياز ${g.pass})`) : ''}`);
    list.filter(f => !mine.has(f.key)).slice(0, 8).forEach(f => lines.push(`   ○ ${esc(trunc(stripExt(f.name), 36))}`));
  });
  await show(chatId, mid, card(`🎧 <b>${esc(s.name)}</b> — الاستماع`, lines), [[btn('بطاقة الطالب', `scard:${phone}`)]], env);
}

// ============================================================
// ملخص_الاستماع
// ============================================================
const ORD = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر', 'الحادي عشر', 'الثاني عشر', 'الثالث عشر'];
const SUMMARY_HEADER = ['الطالب', 'الجوال', 'المقرر', 'المسموع', ...ORD.map(o => `الأسبوع ${o}`), 'الدرجة', 'النتيجة', 'رمز المقرر'];
const SUMMARY_LAST = colLetter(SUMMARY_HEADER.length);

function summaryRow(student, group, tracked, heard) {
  const n = tracked.filter(f => heard.has(f.key)).length;
  const row = [student.name, student.phone, group.name, `${n} من ${tracked.length}`];
  const wks = Math.min(ORD.length, Math.max(12, group.weeks || 12));
  for (let w = 1; w <= wks; w++) {
    const list = tracked.filter(f => f.week === w);
    if (!list.length) { row.push(''); continue; }
    const k = list.filter(f => heard.has(f.key)).length;
    row.push(k === list.length ? `تم سماع الأسبوع ${ORD[w - 1]}` : (k ? `سمع ${k} من ${list.length}` : 'لم يسمع'));
  }
  for (let w = wks + 1; w <= 12; w++) row.push('');
  const ppf = group.ppf || 1, pass = group.pass || 0;
  row.push(`${n * ppf} من ${tracked.length * ppf}`);
  row.push(pass > 0 ? (n * ppf >= pass ? 'اجتاز' : 'لم يجتز') : '');
  row.push(group.id);
  return row;
}

const generalGroup = { id: '0', name: 'عام', ppf: 1, pass: 0, weeks: 0 };

async function ensureSummarySheet(env) {
  const meta = await getSheetMeta(env, true);
  if ((meta.sheets || []).some(s => s.properties.title === SHEETS.SUMMARY)) return;
  await gfetch(`${sheetsBase(env)}:batchUpdate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEETS.SUMMARY } } }] })
  }, env);
  MEM.delete('meta');
}

async function rebuildSummary(env) {
  const [base, files, listens, courses] = await Promise.all([
    loadBase(env, true), loadFiles(env, true), loadListens(env, true), loadCourses(env, true)
  ]);
  const students = base.list.filter(s => s.state === 'active').sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  const heardBy = {};
  listens.forEach(l => { (heardBy[l.phone] = heardBy[l.phone] || new Set()).add(l.key); });
  const rows = [];
  [generalGroup, ...courses].forEach(g => {
    const tracked = files.filter(f => f.course === g.id && f.track);
    if (!tracked.length) return;
    students.forEach(s => rows.push(summaryRow(s, g, tracked, heardBy[s.phone] || new Set())));
  });
  await ensureSummarySheet(env);
  await gfetch(`${sheetsBase(env)}/values/${encodeURIComponent(`${SHEETS.SUMMARY}!A2:${SUMMARY_LAST}`)}:clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  }, env);
  bustSheet(SHEETS.SUMMARY);
  await writeSheet(`${SHEETS.SUMMARY}!A1:${SUMMARY_LAST}${rows.length + 1}`, [SUMMARY_HEADER, ...rows], env);
  return rows.length;
}

async function upsertSummary(env, student, courseId) {
  const [files, listens, courses] = await Promise.all([loadFiles(env), loadListens(env, true), loadCourses(env)]);
  const g = courseId === '0' ? generalGroup : courses.find(c => c.id === courseId);
  if (!g) return;
  const tracked = files.filter(f => f.course === courseId && f.track);
  if (!tracked.length) return;
  const heard = new Set(listens.filter(l => l.phone === student.phone).map(l => l.key));
  const row = summaryRow(student, g, tracked, heard);
  let rows;
  try { rows = await readSheet(`${SHEETS.SUMMARY}!A2:${SUMMARY_LAST}`, env, { fresh: true }); }
  catch (e) { await rebuildSummary(env); return; }
  if (!rows.length) { await rebuildSummary(env); return; }
  const last = SUMMARY_HEADER.length - 1;
  const idx = rows.findIndex(r => normPhone(r[1]) === student.phone && String(r[last] || '').trim() === courseId);
  if (idx >= 0) await writeSheet(`${SHEETS.SUMMARY}!A${idx + 2}:${SUMMARY_LAST}${idx + 2}`, [row], env);
  else await appendRow(SHEETS.SUMMARY, row, env);
}

// ============================================================
// ⭐ رفع الملفات (تدفق مبسّط: زر واحد → ملف → اسم → جاهز)
// ============================================================
async function beginCourseUpload(chatId, courseId, env, mid, week) {
  const course = (await loadCourses(env)).find(c => c.id === courseId);
  const cname = await courseName(courseId, env);

  // إذا المقرر مقسّم لأسابيع ولم يُختر الأسبوع بعد، اعرض قائمة الأسابيع
  if (course && course.weeks > 0 && week === undefined) {
    const nums = [];
    for (let w = 1; w <= CFG.WEEKS; w++) nums.push(btn(`الأسبوع ${w}`, `uwk:${courseId}:${w}`));
    const kb = chunk(nums, 4);
    kb.push([btn('بدون أسبوع', `uwk:${courseId}:0`)], [btn('إلغاء', 'cancel')]);
    return show(chatId, mid, card(`<b>رفع إلى: ${esc(cname)}</b>`, [
      'اختر الأسبوع الذي ستُضاف إليه الملفات:'
    ]), kb, env);
  }

  const prev = await getState(chatId, env);
  const since = prev && prev.a === 'upl' && prev.d.courseId === courseId && prev.d.since ? prev.d.since : Date.now();
  await setState(chatId, 'upl', { courseId, since, week: week || 0 }, env, 3600);

  const lines = ['📤 <b>أرسل الملف الآن.</b>'];
  lines.push('', 'صوت، صورة، فيديو، مستند، أو تسجيل صوتي.');
  if (course && course.track) lines.push('🎧 سيُضاف تلقائياً لتتبع الاستماع.');
  lines.push('', 'بعد الإرسال ستكتب اسمه، ثم يُحفظ فوراً.');
  const kb = [];
  if (course && course.weeks > 0) kb.push([btn('تغيير الأسبوع', `cupl:${courseId}`)]);
  kb.push([btn('إلغاء', 'cancel')]);
  await show(chatId, mid, card(`📁 <b>رفع إلى: ${esc(cname)}</b>`, lines), kb, env);
}

async function courseUploadReceived(msg, state, actor, env) {
  const chatId = String(msg.chat.id);
  const media = extractMedia(msg);
  if (!media) return send(chatId, '❌ نوع الملف غير مدعوم. أرسل صوتاً أو صورة أو فيديو أو مستنداً.', null, env);

  const caption = (msg.caption || '').split('\n')[0].trim().slice(0, 80);
  const defaultName = caption || stripExt(media.fileName) || TYPE_LABEL[media.btype];

  await setState(chatId, 'upl_name', {
    courseId: state.d.courseId,
    week: state.d.week || 0,
    since: state.d.since,
    media,
    caption: caption ? '' : (msg.caption || ''),
    defaultName,
    staffName: actor.staff.name
  }, env, 3600);

  await send(chatId, card('✏️ <b>اسم الملف</b>', [
    `النوع: ${TYPE_LABEL[media.btype] || 'ملف'}`,
    `الاسم المقترح: <i>${esc(trunc(defaultName, 60))}</i>`,
    '',
    'اكتب اسماً للملف، أو اضغط الزر لاعتماد المقترح.'
  ]), [
    [btn(`✅ اعتماد: ${trunc(defaultName, 28)}`, 'upl_default')],
    [btn('❌ إلغاء', 'cancel')]
  ], env);
}

async function courseUploadNameReceived(chatId, text, state, actor, env) {
  const name = String(text).trim().slice(0, 80);
  if (!name) return send(chatId, '❌ الاسم مطلوب، اكتبه من فضلك.', CANCEL_KB, env);
  await saveUploadedFile(chatId, name, state, env);
}

async function courseUploadDefaultName(chatId, state, env) {
  await saveUploadedFile(chatId, state.d.defaultName, state, env);
}

async function saveUploadedFile(chatId, name, state, env) {
  const d = state.d;
  const media = d.media;
  const course = (await loadCourses(env)).find(c => c.id === d.courseId);
  const track = !!(course && course.track);
  const week = d.week || 0;

  const ext = (media.fileName.match(EXT_RE) || [''])[0];
  const finalName = name.includes('.') ? name : (name + ext);

  await send(chatId, '⏳ جاري الحفظ…', null, env);

  const saved = await saveCourseFile({
    ...media, fileName: finalName, caption: d.caption || '',
    staffName: d.staffName, course: d.courseId, track, week
  }, env);

  // العودة لحالة الرفع للسماح برفع ملف آخر
  await setState(chatId, 'upl', { courseId: d.courseId, since: d.since, week: week }, env, 3600);

  const lines = [`<b>${esc(stripExt(finalName))}</b>`];
  if (course && course.weeks > 0) lines.push(`الأسبوع: ${week || '—'}`);
  lines.push(`تتبع الاستماع: ${track ? 'مفعّل' : 'متوقف'}`);
  if (saved.note) lines.push(`⚠️ ${esc(saved.note)}`);
  else lines.push('✅ الملف جاهز داخل المقرر.');

  const kb = [
    [btn('📤 رفع ملف آخر', `cupl:${d.courseId}`)],
    [btn(track ? 'إيقاف التتبع' : 'تفعيل التتبع', `ftrack:${saved.key}`), btn('إعادة تسمية', `fren:${saved.key}`)],
    [btn('🏁 إنهاء', `cdone:${d.courseId}`)]
  ];
  await send(chatId, card('✅ <b>تم الحفظ</b>', lines), kb, env);
  bg(env, logAction(d.staffName, 'رفع ملف', `${finalName} → ${await courseName(d.courseId, env)}`, env));
}

async function saveCourseFile(d, env) {
  const key = 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  let filebaseKey = '', filebaseUrl = '', note = '';

  try {
    const dl = await downloadTelegramFile(d.fileId, env);
    if (dl) {
      const fb = await uploadToFilebase(key, d.fileName, dl.blob, env);
      if (fb.id) {
        filebaseKey = fb.id;
        filebaseUrl = fb.url;
      } else {
        note = 'فشل Filebase: ' + (fb.error || 'خطأ غير معروف');
        console.error('FILEBASE-FAIL:', fb.error);
      }
    } else {
      note = 'تعذّر تنزيل الملف من تيليجرام (الحد 20 ميجابايت).';
    }
  } catch (e) {
    note = 'خطأ في Filebase: ' + trunc(e.message, 120);
    console.error('FILEBASE-EXC:', e.message);
  }

  await appendRow(SHEETS.FILES, [
    nowRiyadh(), d.staffName, d.btype, d.caption || '', d.fileName,
    filebaseUrl, filebaseKey, d.fileId, d.course || '0', key,
    d.track ? 'تتبع' : '', d.duration || '', d.week || ''
  ], env);
  return { key, driveId: filebaseKey, driveUrl: filebaseUrl, note };
}

function extractMediaBase(msg, fallbackName) {
  const t = Date.now();
  if (msg.voice) return { btype: 'voice', fileId: msg.voice.file_id, fileName: (fallbackName || 'voice_' + t) + '.ogg' };
  if (msg.audio) return { btype: 'audio', fileId: msg.audio.file_id, fileName: msg.audio.file_name || ((fallbackName || msg.audio.title || 'audio_' + t) + '.mp3') };
  if (msg.document) {
    const isAudio = (msg.document.mime_type || '').startsWith('audio/');
    return { btype: isAudio ? 'audio' : 'document', fileId: msg.document.file_id, fileName: msg.document.file_name || fallbackName || ('file_' + t) };
  }
  if (msg.video) return { btype: 'video', fileId: msg.video.file_id, fileName: msg.video.file_name || ((fallbackName || 'video_' + t) + '.mp4') };
  if (msg.photo) return { btype: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, fileName: (fallbackName || 'photo_' + t) + '.jpg' };
  return null;
}

function extractMedia(msg, fallbackName) {
  const m = extractMediaBase(msg, fallbackName);
  if (!m) return m;
  const src = msg.voice || msg.audio || msg.video;
  m.duration = (src && src.duration) || 0;
  return m;
}

// ============================================================
// الزائر والتحقق
// ============================================================
async function handleGuestCallback(chatId, mid, act, env) {
  if (act === 'contact') return startContact(chatId, env);
  if (act === 'help') return viewHelp(chatId, { kind: 'guest' }, env, mid);
  await clearState(chatId, env);
  return guestWelcome(chatId, env);
}

async function handleGuest(msg, text, state, env) {
  const chatId = String(msg.chat.id);
  const label = cleanLabel(text);

  if (isCancel(label) || isHome(label)) { await clearState(chatId, env); return guestWelcome(chatId, env); }
  if (isHelp(label)) { await clearState(chatId, env); return viewHelp(chatId, { kind: 'guest' }, env); }
  if (label === 'تواصل مع المشرف' || label === 'تواصل' || label === '/contact') return startContact(chatId, env);

  if (msg.contact) {
    if (String(msg.contact.user_id) !== String(msg.from.id)) {
      return send(chatId, '❌ شارك رقمك أنت بالضغط على زر «مشاركة رقمي».', null, env);
    }
    await clearState(chatId, env);
    if (await activatePending(chatId, normPhone(msg.contact.phone_number), env)) return;
    return verifyPhone(chatId, msg.contact.phone_number, true, msg.from, env);
  }
  if (state && state.a === 'contact') return relayToStaff(msg, null, env);
  if (!text) return guestWelcome(chatId, env);

  if (/^[0-9٠-٩۰-۹+\s-]+$/.test(text) && normPhone(text)) {
    const ph = normPhone(text);
    if ((await loadPending(env)).some(p => p.phone === ph)) {
      return send(chatId, 'للتحقق من هويتك اضغط زر «مشاركة رقمي» في الأسفل.', guestMainKb(), env);
    }
    return verifyPhone(chatId, text, false, msg.from, env);
  }
  return guestWelcome(chatId, env, '<b>يجب التحقق من رقمك أولاً</b>');
}

async function guestWelcome(chatId, env, note) {
  const lines = [
    'للدخول، تحقق من هويتك بإحدى طريقتين:',
    '• اضغط «مشاركة رقمي» للتحقق الفوري، أو',
    '• اكتب رقم جوالك كما هو مسجّل (يُرسل طلبك للمشرف للموافقة)',
    '', '<i>مثال: 570456492 أو 0570456492</i>'
  ];
  await send(chatId, (note ? note + '\n\n' : '') + card('<b>أهلاً بك في منبر حسان</b>', lines), guestMainKb(), env);
}

async function verifyPhone(chatId, rawPhone, shared, from, env) {
  if (!shared) {
    const triesKey = `va_${chatId}`;
    const tries = Number(await env.KV.get(triesKey) || 0) + 1;
    await env.KV.put(triesKey, String(tries), { expirationTtl: 3600 });
    if (tries > CFG.MAX_VERIFY_ATTEMPTS) {
      return send(chatId, '⛔ <b>تجاوزت عدد المحاولات.</b>\nحاول بعد ساعة أو تواصل مع المشرف.', [[btn('تواصل مع المشرف', 'contact')]], env);
    }
  }
  const phone = normPhone(rawPhone);
  const student = phone ? await findStudent(phone, env, true) : null;
  if (!student) {
    return send(chatId, '❌ <b>لم أجد هذا الرقم</b>\n\nتأكد من كتابته بشكل صحيح، أو تواصل مع المشرف.', [[btn('تواصل مع المشرف', 'contact')]], env);
  }
  if (student.state !== 'active') {
    return send(chatId, blockedText(student, student.state), [[btn('تواصل مع المشرف', 'contact')]], env);
  }

  if (!shared) {
    const pk = `vp_${phone}`;
    const pn = Number(await env.KV.get(pk) || 0) + 1;
    await env.KV.put(pk, String(pn), { expirationTtl: 86400 });
    if (pn > 10) return send(chatId, '⛔ تم تجاوز عدد المحاولات لهذا الرقم. تواصل مع المشرف.', [[btn('تواصل مع المشرف', 'contact')]], env);
  }

  const users = await loadUsers(env, true);
  const bound = (users.byPhone[phone] || []).filter(u => u.chatId !== chatId);
  const staffIds = Object.keys(await loadStaff(env));

  if (bound.length) {
    await Promise.all(staffIds.map(id => send(id, card('<b>طلب ربط من حساب آخر</b>', [
      `الطالب: ${esc(student.name)}`, `الجوال: ${phone}`, `الحساب الجديد: <code>${chatId}</code>`,
      '', 'إن كان الطالب غيّر حسابه، اضغط «فك الربط» ثم يعيد التسجيل.'
    ]), [[btn('فك الربط', `sunlink:${phone}`)]], env)));
    return send(chatId, '🔒 <b>هذا الرقم مرتبط بحساب آخر.</b>\nأبلغنا المشرف بطلبك.', [[btn('تواصل مع المشرف', 'contact')]], env);
  }

  if (shared) return completeLink(chatId, student, env);

  if (await env.KV.get(`rq_${chatId}`)) {
    return send(chatId, 'طلبك قيد المراجعة عند المشرفين، سيصلك إشعار عند الموافقة.', null, env);
  }
  await env.KV.put(`rq_${chatId}`, '1', { expirationTtl: 600 });
  const tgName = esc(`${from.first_name || ''} ${from.last_name || ''}`.trim()) + (from.username ? ` @${esc(from.username)}` : '');
  await Promise.all(staffIds.map(id => send(id, card('<b>طلب دخول جديد</b>', [
    `الطالب: <b>${esc(student.name)}</b>`, `الجوال: ${phone}`, `حساب تيليجرام: ${tgName}`,
    '', 'وافق فقط إن كنت تعرف صاحب الحساب.'
  ]), [[btn('موافقة', `sappr:${chatId}:${phone}`), btn('رفض', `srej:${chatId}`)]], env)));
  await send(chatId, '✅ <b>أُرسل طلبك للمشرفين.</b>\nسيصلك إشعار فور الموافقة.\n\nللتحقق الفوري اضغط «مشاركة رقمي».', guestMainKb(), env);
}

async function completeLink(chatId, student, env) {
  await saveUser(chatId, student.phone, student.name, env);
  await env.KV.delete(`va_${chatId}`);
  await env.KV.delete(`rq_${chatId}`);
  await studentHome(chatId, { kind: 'student', phone: student.phone, asStaffStudent: false }, env);
  const staffIds = Object.keys(await loadStaff(env));
  await Promise.all(staffIds.map(id => send(id, card('<b>طالب جديد دخل البوت</b>', [
    esc(student.name), `الجوال: ${student.phone}`,
    student.statusText === 'عن بعد' ? 'عن بعد' : 'حضوري'
  ]), null, env)));
}

async function approveLink(staffChat, studentChat, phone, actor, env, mid) {
  const student = await findStudent(phone, env, true);
  if (!student || student.state !== 'active') return show(staffChat, mid, '❌ الطالب غير موجود أو غير نشط.', [HOME_ROW], env);
  const users = await loadUsers(env, true);
  if ((users.byPhone[phone] || []).some(u => u.chatId !== studentChat)) {
    return show(staffChat, mid, 'هذا الرقم مرتبط بحساب آخر. فك الربط أولاً من بطاقة الطالب.', [[btn('بطاقة الطالب', `scard:${phone}`)]], env);
  }
  await completeLink(studentChat, student, env);
  bg(env, logAction(actor.staff.name, 'موافقة دخول', student.name, env));
  await show(staffChat, mid, `✅ تمت الموافقة على دخول <b>${esc(student.name)}</b>.`, [HOME_ROW], env);
}

// ============================================================
// التواصل
// ============================================================
async function startContact(chatId, env) {
  await setState(chatId, 'contact', {}, env);
  await send(chatId, card('<b>التواصل مع المشرف</b>', [
    'اكتب رسالتك الآن وستصل مباشرة.', 'تقدر ترسل نصاً أو صورة أو ملفاً أو تسجيلاً صوتياً.'
  ]), CANCEL_KB, env);
}

async function relayToStaff(msg, actor, env) {
  const chatId = String(msg.chat.id);
  const rk = `ct_${chatId}`;
  const n = Number(await env.KV.get(rk) || 0);
  if (n >= 10) return send(chatId, '⛔ أرسلت رسائل كثيرة، حاول لاحقاً.', null, env);
  await env.KV.put(rk, String(n + 1), { expirationTtl: 3600 });

  const student = actor ? await findStudent(actor.phone, env) : null;
  const who = student
    ? `<b>${esc(student.name)}</b>\nالجوال: ${student.phone}\nالحالة: ${statusIcon(student)} ${esc(student.statusText || 'نشط')}`
    : 'غير مسجّل في البوت';
  const from = msg.from || {};
  const tgName = esc(`${from.first_name || ''} ${from.last_name || ''}`.trim()) + (from.username ? ` @${esc(from.username)}` : '');
  const content = msg.text || msg.caption || '[ملف — يظهر في الرسالة التالية]';
  const body = card('<b>رسالة جديدة</b>', [who, `تيليجرام: ${tgName}`, CFG.LINE, esc(trunc(content, 1500))]);

  const staff = await loadStaff(env);
  const results = await Promise.all(Object.keys(staff).map(async id => {
    const r = await send(id, body, [[btn('رد', `reply:${chatId}`)]], env);
    if (r.ok && !msg.text) await tg('copyMessage', { chat_id: id, from_chat_id: chatId, message_id: msg.message_id }, env);
    return r.ok;
  }));

  await clearState(chatId, env);
  const kb = actor ? studentMainKb(actor.asStaffStudent) : guestMainKb();
  if (!results.some(Boolean)) return send(chatId, '❌ تعذّر إيصال رسالتك، حاول لاحقاً.', kb, env);
  await send(chatId, '✅ <b>وصلت رسالتك للمشرف.</b>', kb, env);
}

// ============================================================
// الإدارة
// ============================================================
const STAFF_TEXT_MAP = {
  'الطلاب': 'students', 'البث': 'bmenu', 'المقررات': 'courses', 'الاستماع': 'lmenu', 'الإحصاء': 'stats',
  'مطابقة': 'sync', 'مساعدة': 'help', 'المشرفون': 'team', 'الفريق': 'team',
  'الإعدادات': 'settings', 'وضع الطالب': 'tostudent'
};

async function handleStaff(msg, text, actor, state, env) {
  const chatId = String(msg.chat.id);
  const label = cleanLabel(text);

  if (isCancel(label)) { await clearState(chatId, env); return staffHome(chatId, actor, env, '✅ تم الإلغاء.'); }
  if (isHome(label)) { await clearState(chatId, env); return staffHome(chatId, actor, env); }
  if (msg.document || msg.photo || msg.video || msg.audio || msg.voice) {
    return handleMediaMessage(msg, actor, state, env);
  }
  const mapped = STAFF_TEXT_MAP[label] || (isHelp(label) ? 'help' : null);
  if (mapped) { await clearState(chatId, env); return staffAction(chatId, actor, mapped, [], env); }
  if (state && text) return handleStaffInput(msg, text, actor, state, env);
  return staffHome(chatId, actor, env);
}

async function handleStaffInput(msg, text, actor, state, env) {
  const chatId = String(msg.chat.id);
  switch (state.a) {
    case 'upl': return send(chatId, '📤 أرسل الملف، أو اضغط «إنهاء».', [[btn('إنهاء', `cdone:${state.d.courseId}`)]], env);
    case 'upl_name': return courseUploadNameReceived(chatId, text, state, env);
    case 'btext_name': return broadcastNameReceived(chatId, text, actor, env);
    case 'btext_content': return broadcastTextReceived(chatId, text, actor, env);
    case 'ssearch': return runStudentSearch(chatId, text, env);
    case 'sadd': return addStudents(chatId, text, actor, env);
    case 'sedit': return applyStudentEdit(chatId, text, state, actor, env);
    case 'pm': return deliverStaffMessage(chatId, state.d.target, msg, actor, env);
    case 'cadd': return addCourse(chatId, text, actor, env);
    case 'cren': return renameCourse(chatId, text, state, actor, env);
    case 'fren': return renameFile(chatId, text, state, actor, env);
    case 'cpass': return applyCourseNumber(chatId, text, state, 'cpass', env);
    case 'cppf': return applyCourseNumber(chatId, text, state, 'cppf', env);
    case 'tadd': return teamAddStep1(chatId, text, actor, env);
    default: await clearState(chatId, env); return staffHome(chatId, actor, env);
  }
}

async function staffHome(chatId, actor, env, note) {
  const [base, users, paused] = await Promise.all([loadBase(env), loadUsers(env), isPaused(env)]);
  let active = 0, reg = 0, remote = 0;
  base.list.forEach(s => {
    if (s.state !== 'active') return;
    active++;
    if (s.statusText === 'عن بعد') remote++;
    if (users.byPhone[s.phone]) reg++;
  });
  const lines = [
    `أهلاً <b>${esc(actor.staff.name)}</b>`,
    `الطلاب النشطون: <b>${active}</b>${remote ? ` (منهم ${remote} عن بعد)` : ''}`,
    `دخلوا البوت: <b>${reg}</b>`
  ];
  if (paused) lines.push('<b>البوت متوقف للطلاب حالياً</b>');
  lines.push('', 'اختر من القائمة السفلية.');
  const text = (note ? note + '\n\n' : '') + card(`<b>لوحة الإدارة</b> — ${roleLabel(actor.staff.role)}`, lines);
  await send(chatId, text, staffMainKb(actor), env);
}

async function staffAction(chatId, actor, act, parts, env, mid) {
  const adminOnly = ['team', 'tadd', 'trole', 'tdel', 'tdelok', 'settings', 'tpause', 'tcache'];
  if (adminOnly.includes(act) && actor.staff.role !== 'admin') {
    return send(chatId, '🚫 هذه الميزة للمدير فقط.', null, env);
  }

  switch (act) {
    case 'home': await clearState(chatId, env); return staffHome(chatId, actor, env);
    case 'cancel': await clearState(chatId, env); return staffHome(chatId, actor, env, '✅ تم الإلغاء.');
    case 'help': return viewHelp(chatId, actor, env, mid);
    case 'tostudent': return switchToStudent(chatId, actor, env);
    case 'toadmin': return switchToStaff(chatId, env);

    case 'students': return viewStudentsMenu(chatId, env, mid);
    case 'slist': return viewStudentList(chatId, parts[1] || 'all', parseInt(parts[2]) || 0, env, mid);
    case 'scard': return viewStudentCard(chatId, parts[1], actor, env, mid);
    case 'ssearch':
      await setState(chatId, 'ssearch', {}, env);
      return show(chatId, mid, card('<b>بحث عن طالب</b>', ['اكتب جزءاً من الاسم أو الرمز أو رقم الجوال:']), CANCEL_KB, env);
    case 'sadd':
      await setState(chatId, 'sadd', {}, env);
      return show(chatId, mid, card('<b>إضافة طلاب</b>', [
        'أرسل طالباً في كل سطر بالصيغة:', '<code>الاسم، الجوال، المستوى</code>', '',
        'المستوى اختياري. يمكنك لصق عدة أسطر دفعة واحدة (حتى 30).',
        '<i>مثال: محمد أحمد، 570456492، المستوى الأول</i>'
      ]), CANCEL_KB, env);
    case 'sedit': return beginStudentEdit(chatId, parts[1], parts[2], env, mid);
    case 'sset': return confirmStatusChange(chatId, parts[1], parts[2], env, mid);
    case 'sapply': return applyStatusChange(chatId, parts[1], parts[2], actor, env, mid);
    case 'sappr': return approveLink(chatId, parts[1], parts[2], actor, env, mid);
    case 'srej':
      await send(parts[1], '❌ تعذّر قبول طلب دخولك. تواصل مع المشرف للتأكد من بياناتك.', [[btn('تواصل مع المشرف', 'contact')]], env);
      await env.KV.delete(`rq_${parts[1]}`);
      return show(chatId, mid, 'تم رفض الطلب.', [HOME_ROW], env);
    case 'sunlink':
      await unlinkPhone(parts[1], env);
      bg(env, logAction(actor.staff.name, 'فك ربط', parts[1], env));
      return show(chatId, mid, `تم فك ربط الرقم <b>${esc(parts[1])}</b>.\nيقدر الطالب الآن يسجّل من حسابه الجديد.`,
        [[btn('بطاقة الطالب', `scard:${parts[1]}`)]], env);
    case 'spm': {
      const u = ((await loadUsers(env)).byPhone[parts[1]] || [])[0];
      if (!u) return send(chatId, '❌ هذا الطالب لم يدخل البوت بعد.', null, env);
      return promptStaffMessage(chatId, u.chatId, u.name, env, mid);
    }
    case 'reply': return promptStaffMessage(chatId, parts[1], 'المستخدم', env, mid);
    case 'lstudent': return viewListenStudent(chatId, parts[1], env, mid);

    case 'bmenu': return viewBroadcastMenu(chatId, env, mid);
    case 'btype': return chooseBroadcastType(chatId, parts[1], env, mid);
    case 'baud': return chooseAudience(chatId, parts[1], env, mid);
    case 'bpick': return showAudiencePicker(chatId, env, mid);
    case 'bgo': return runBroadcast(chatId, env, mid);

    case 'courses': return viewCourses(chatId, true, env, mid);
    case 'files': return viewFiles(chatId, parts[1] || '0', parseInt(parts[2]) || 0, true, env, mid, parts[3]);
    case 'file': return deliverFile(chatId, parts[1], env, false);
    case 'fcard': return viewFileCard(chatId, parts[1], env, mid);
    case 'cupl': return beginCourseUpload(chatId, parts[1], env, mid);
    case 'uwk': return beginCourseUpload(chatId, parts[1], env, mid, parseInt(parts[2]) || 0);
    case 'upl_default': {
      const st = await getState(chatId, env);
      if (st && st.a === 'upl_name') await courseUploadDefaultName(chatId, st, env);
      return;
    }
    case 'cdone': return finishUpload(chatId, parts[1] || '0', actor, env, mid);
    case 'cadd':
      await setState(chatId, 'cadd', {}, env);
      return show(chatId, mid, card('<b>مقرر جديد</b>', ['اكتب اسم المقرر:']), CANCEL_KB, env);
    case 'cset': return viewCourseSettings(chatId, parts[1], env, mid);
    case 'cren':
      await setState(chatId, 'cren', { id: parts[1] }, env);
      return show(chatId, mid, card('<b>إعادة تسمية المقرر</b>', [`الاسم الحالي: ${esc(await courseName(parts[1], env))}`, 'اكتب الاسم الجديد:']), CANCEL_KB, env);
    case 'cup': return moveCourse(chatId, parts[1], -1, env, mid);
    case 'cdown': return moveCourse(chatId, parts[1], 1, env, mid);
    case 'ctoggle': return toggleCourse(chatId, parts[1], env, mid);
    case 'ctrack': return toggleCourseTrack(chatId, parts[1], actor, env, mid);
    case 'csetw': return showWeekPicker(chatId, parts[1], env, mid);
    case 'csetws': return setCourseWeeks(chatId, parts[1], parseInt(parts[2]) || 0, actor, env, mid);
    case 'cpass':
      await setState(chatId, 'cpass', { id: parts[1] }, env);
      return show(chatId, mid, card('<b>درجة الاجتياز</b>', [`المقرر: ${esc(await courseName(parts[1], env))}`, 'اكتب الدرجة (0 لإلغاء الشرط):']), CANCEL_KB, env);
    case 'cppf':
      await setState(chatId, 'cppf', { id: parts[1] }, env);
      return show(chatId, mid, card('<b>نقاط كل تسجيل</b>', [`المقرر: ${esc(await courseName(parts[1], env))}`, 'اكتب النقاط لكل ملف يُسمع:']), CANCEL_KB, env);
    case 'cdel':
      return show(chatId, mid, card('<b>حذف مقرر</b>', [
        `هل تريد حذف «${esc(await courseName(parts[1], env))}»؟`, 'ستنتقل ملفاته إلى قسم «عام».'
      ]), [[btn('نعم، احذف', `cdelok:${parts[1]}`), btn('تراجع', `files:${parts[1]}:0`)]], env);
    case 'cdelok': return deleteCourse(chatId, parts[1], actor, env, mid);
    case 'fren': {
      const f = await findFile(parts[1], env);
      if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
      await setState(chatId, 'fren', { key: parts[1] }, env);
      return show(chatId, mid, card('<b>إعادة تسمية الملف</b>', [`الاسم الحالي: ${esc(stripExt(f.name))}`, 'اكتب الاسم الجديد:']), CANCEL_KB, env);
    }
    case 'fmove': return showMoveTargets(chatId, parts[1], env, mid);
    case 'fmoveto': return moveFile(chatId, parts[1], parts[2], actor, env, mid);
    case 'ftrack': return toggleFileTrack(chatId, parts[1], actor, env, mid);
    case 'fweek': return showFileWeekPicker(chatId, parts[1], env, mid);
    case 'fweekset': return setFileWeek(chatId, parts[1], parseInt(parts[2]) || 0, actor, env, mid);
    case 'cnotify': return notifyNewFile(chatId, parts[1], actor, env, mid);
    case 'fdel': {
      const f = await findFile(parts[1], env);
      if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
      return show(chatId, mid, card('<b>حذف ملف</b>', [`سيُحذف «${esc(stripExt(f.name))}» من المكتبة ومن Filebase.`]),
        [[btn('نعم، احذف', `fdelok:${parts[1]}`), btn('تراجع', `fcard:${parts[1]}`)]], env);
    }
    case 'fdelok': return deleteFile(chatId, parts[1], actor, env, mid);

    case 'lmenu': return viewListenMenu(chatId, env, mid);
    case 'lcourse': return viewListenCourse(chatId, parts[1], parts[2], env, mid);
    case 'lfile': return viewListenFile(chatId, parts[1], env, mid);
    case 'lremind': return remindListen(chatId, parts[1], false, actor, env, mid);
    case 'lremindok': return remindListen(chatId, parts[1], true, actor, env, mid);
    case 'lsum':
      await show(chatId, mid, '⏳ جاري تحديث ملخص الإكسل…', null, env);
      {
        const n = await rebuildSummary(env);
        return show(chatId, mid, `✅ تم تحديث «ملخص_الاستماع» — عدد الصفوف: <b>${n}</b>.`, [[btn('الاستماع', 'lmenu')]], env);
      }

    case 'stats': return viewStats(chatId, env, mid);
    case 'log': return viewLog(chatId, env, mid);
    case 'sync': {
      await show(chatId, mid, '⏳ جاري مطابقة الحالات…', null, env);
      const r = await syncStatuses(env, true);
      bg(env, logAction(actor.staff.name, 'مطابقة', `فُحص ${r.checked} / تغيّر ${r.changed}`, env));
      return show(chatId, mid, card('<b>تمت المطابقة</b>', [
        `عدد المفحوصين: <b>${r.checked}</b>`, `تغيّرت حالتهم: <b>${r.changed}</b>`, `رسائل أُرسلت: <b>${r.notified}</b>`
      ]), [HOME_ROW], env);
    }

    case 'team': return viewTeam(chatId, env, mid);
    case 'tadd':
      await setState(chatId, 'tadd', {}, env);
      return show(chatId, mid, card('<b>إضافة مشرف</b>', [
        'أرسل رقم جوال المشرف، ويمكنك إضافة الاسم بعده.',
        '<i>مثال: 570456492 محمد أحمد</i>', '',
        'بعد التعيين يفتح البوت ويضغط «مشاركة رقمي» فتُفعَّل صلاحيته تلقائياً.'
      ]), CANCEL_KB, env);
    case 'trole': return teamAddStep2(chatId, parts[1], actor, env);
    case 'tdel':
      return show(chatId, mid, card('<b>إزالة مشرف</b>', ['هل تريد إزالة هذا العضو من الإدارة؟']),
        [[btn('نعم، أزِله', `tdelok:${parts[1]}`), btn('تراجع', 'team')]], env);
    case 'tdelok': return teamRemove(chatId, parts[1], actor, env, mid);
    case 'settings': return viewSettings(chatId, env, mid);
    case 'tpause': {
      if (await env.KV.get('bot_paused')) await env.KV.delete('bot_paused');
      else await env.KV.put('bot_paused', '1');
      MEM.delete('paused');
      return viewSettings(chatId, env, mid);
    }
    case 'tcache':
      MEM.clear();
      ICON_CACHE.clear();
      return viewSettings(chatId, env, mid);
    default: return staffHome(chatId, actor, env);
  }
}

// ============================================================
// الطلاب (عرض وإدارة)
// ============================================================
async function viewStudentsMenu(chatId, env, mid) {
  await show(chatId, mid, card('<b>الطلاب</b>', ['اختر طريقة العرض:']), [
    [btn('بحث', 'ssearch'), btn('إضافة طلاب', 'sadd')],
    [btn('الكل', 'slist:all:0'), btn('النشطون', 'slist:inhouse:0')],
    [btn('عن بعد', 'slist:rem:0'), btn('لم يدخلوا البوت', 'slist:unreg:0')],
    [btn('الموقوفون', 'slist:sus:0'), btn('المحذوفون', 'slist:del:0')],
    HOME_ROW
  ], env);
}

const studentRow = (s, users) => [btn(`${statusIcon(s)} ${trunc(s.name, 30)}${users.byPhone[s.phone] ? ' ✓' : ''}`, `scard:${s.phone}`)];

async function viewStudentList(chatId, filter, page, env, mid) {
  const [base, users] = await Promise.all([loadBase(env), loadUsers(env)]);
  const titles = { all: 'كل الطلاب', inhouse: 'النشطون', rem: 'عن بعد', sus: 'الموقوفون', del: 'المحذوفون', unreg: 'لم يدخلوا البوت' };
  const list = base.list.filter(s => {
    if (filter === 'inhouse') return s.state === 'active' && s.statusText !== 'عن بعد';
    if (filter === 'rem') return s.state === 'active' && s.statusText === 'عن بعد';
    if (filter === 'sus') return s.state === 'suspended';
    if (filter === 'del') return s.state === 'deleted';
    if (filter === 'unreg') return s.state === 'active' && !users.byPhone[s.phone];
    return true;
  });
  const pages = Math.max(1, Math.ceil(list.length / CFG.PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const kb = list.slice(page * CFG.PAGE_SIZE, (page + 1) * CFG.PAGE_SIZE).map(s => studentRow(s, users));
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push(btn('السابق', `slist:${filter}:${page - 1}`));
    nav.push(btn(`${page + 1}/${pages}`, `slist:${filter}:${page}`));
    if (page < pages - 1) nav.push(btn('التالي', `slist:${filter}:${page + 1}`));
    kb.push(nav);
  }
  kb.push([btn('الطلاب', 'students')]);
  await show(chatId, mid, card(`<b>${titles[filter] || 'الطلاب'}</b> (${list.length})`, [
    '🟢 نشط   🔵 عن بعد   🟡 موقوف   🔴 محذوف   ✓ دخل البوت'
  ]), kb, env);
}

async function runStudentSearch(chatId, text, env) {
  await clearState(chatId, env);
  const [base, users] = await Promise.all([loadBase(env), loadUsers(env)]);
  const q = normAr(text);
  const digits = normPhone(text);
  const found = base.list.filter(s =>
    (digits && s.phone === digits) || normAr(s.name).includes(q) || (s.code && String(s.code).trim() === text.trim())
  ).slice(0, 10);
  const kb = found.map(s => studentRow(s, users));
  kb.push([btn('بحث جديد', 'ssearch'), btn('الطلاب', 'students')]);
  const body = found.length ? card(`<b>نتائج البحث</b> (${found.length})`, ['اختر الطالب:']) : 'لم أجد نتائج. جرّب جزءاً آخر من الاسم.';
  await send(chatId, body, kb, env);
}

async function viewStudentCard(chatId, phone, actor, env, mid) {
  const [s, users] = await Promise.all([findStudent(phone, env), loadUsers(env)]);
  if (!s) return show(chatId, mid, '❌ الطالب غير موجود.', [[btn('الطلاب', 'students')]], env);
  const u = (users.byPhone[phone] || [])[0];
  const lines = [
    `الرمز: ${esc(s.code || '—')}`,
    `المستوى: ${esc(s.level || '—')}`,
    `الجوال: ${s.phone}`,
    `الحالة: ${statusIcon(s)} ${esc(s.statusText || 'نشط')}`,
    `البوت: ${u ? `دخل في ${esc(u.registered)}` : 'لم يدخل بعد'}`
  ];
  if (u) lines.push(`آخر استخدام: ${esc(u.last)}`);
  const kb = [];
  if (u) kb.push([btn('رسالة خاصة', `spm:${phone}`)]);
  const row = [];
  if (s.state !== 'active') row.push(btn('تنشيط', `sset:${phone}:a`));
  if (s.state === 'active') row.push(btn('إيقاف', `sset:${phone}:s`));
  if (s.state !== 'deleted') row.push(btn('حذف', `sset:${phone}:d`));
  if (row.length) kb.push(row);
  kb.push([btn('تعديل الاسم', `sedit:${phone}:n`), btn('تعديل المستوى', `sedit:${phone}:l`)]);
  kb.push([btn('تعديل الجوال', `sedit:${phone}:p`)]);
  kb.push([btn('سجل الاستماع', `lstudent:${phone}`)]);
  if (u) kb.push([btn('فك ربط تيليجرام', `sunlink:${phone}`)]);
  kb.push([btn('الطلاب', 'students')]);
  await show(chatId, mid, card(`<b>${esc(s.name)}</b>`, lines), kb, env);
}

async function confirmStatusChange(chatId, phone, code, env, mid) {
  const s = await findStudent(phone, env);
  const st = { a: 'active', s: 'suspended', d: 'deleted' }[code];
  if (!s || !st) return show(chatId, mid, '❌ تعذّر إيجاد الطالب.', [[btn('الطلاب', 'students')]], env);
  await show(chatId, mid, card('⚠️ <b>تأكيد تغيير الحالة</b>', [
    `الطالب: <b>${esc(s.name)}</b>`,
    `الحالة الجديدة: ${STATE_ICON[st]} <b>${STATE_LABEL[st]}</b>`
  ]), [[btn('تأكيد', `sapply:${phone}:${code}`), btn('تراجع', `scard:${phone}`)]], env);
}

async function applyStatusChange(chatId, phone, code, actor, env, mid) {
  const st = { a: 'active', s: 'suspended', d: 'deleted' }[code];
  const base = await loadBase(env, true);
  const s = base.byPhone[phone];
  if (!s || !st || !base.sheetName) return show(chatId, mid, '❌ تعذّر تغيير الحالة.', [[btn('الطلاب', 'students')]], env);
  await updateCell(base.sheetName, s.row, 3, STATE_LABEL[st], env, { col: 'E', val: phone, phone: true });
  bg(env, logAction(actor.staff.name, 'تغيير حالة', `${s.name} → ${STATE_LABEL[st]}`, env));
  const r = await syncStatuses(env, true, phone);
  await viewStudentCard(chatId, phone, actor, env, mid);
  if (r.notified) await send(chatId, 'تم إبلاغ الطالب بالتغيير.', null, env);
}

async function addStudents(chatId, text, actor, env) {
  await clearState(chatId, env);
  const base = await loadBase(env, true);
  const sheet = base.sheetName || SHEETS.BASE[0];
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean).slice(0, 30);
  let nextCode = 0;
  base.list.forEach(s => { const n = parseInt(s.code); if (n > nextCode) nextCode = n; });
  const seen = new Set(Object.keys(base.byPhone));
  const added = [], skipped = [];

  for (const line of lines) {
    const f = line.split(/[،,|\t]+/).map(x => x.trim());
    const name = f[0], phone = normPhone(f[1]), level = f[2] || '';
    if (!name || !phone) { skipped.push(`${trunc(line, 30)} (بيانات ناقصة)`); continue; }
    if (seen.has(phone)) { skipped.push(`${trunc(name, 20)} (الجوال مسجّل مسبقاً)`); continue; }
    seen.add(phone);
    nextCode = nextCode ? nextCode + 1 : 0;
    await appendRow(sheet, [nextCode || '', level, 'نشط', name, phone], env);
    added.push(name);
  }
  bg(env, logAction(actor.staff.name, 'إضافة طلاب', `${added.length} طالب`, env));
  const out = [`✅ أُضيف: <b>${added.length}</b>`];
  if (skipped.length) out.push(`⚠️ تخطّي: <b>${skipped.length}</b>`, ...skipped.map(s => '• ' + esc(s)));
  await send(chatId, card('<b>نتيجة الإضافة</b>', out), [[btn('إضافة المزيد', 'sadd'), btn('الطلاب', 'students')]], env);
}

async function beginStudentEdit(chatId, phone, field, env, mid) {
  const s = await findStudent(phone, env);
  if (!s) return show(chatId, mid, '❌ الطالب غير موجود.', [[btn('الطلاب', 'students')]], env);
  const label = { n: 'الاسم', l: 'المستوى', p: 'الجوال' }[field];
  if (!label) return show(chatId, mid, '❌ حقل غير معروف.', [[btn('الطلاب', 'students')]], env);
  await setState(chatId, 'sedit', { phone, field }, env);
  await show(chatId, mid, card(`<b>تعديل ${label}</b>`, [`الطالب: ${esc(s.name)}`, `اكتب ${label} الجديد:`]), CANCEL_KB, env);
}

async function applyStudentEdit(chatId, text, state, actor, env) {
  const { phone, field } = state.d;
  const base = await loadBase(env, true);
  const s = base.byPhone[phone];
  if (!s || !base.sheetName) { await clearState(chatId, env); return send(chatId, '❌ الطالب غير موجود.', [[btn('الطلاب', 'students')]], env); }
  const guard = { col: 'E', val: phone, phone: true };
  const value = String(text).trim();
  if (!value) return send(chatId, '❌ القيمة مطلوبة.', CANCEL_KB, env);

  let newPhone = phone;
  if (field === 'n') {
    await updateCell(base.sheetName, s.row, 4, value.slice(0, 80), env, guard);
    const users = await loadUsers(env, true);
    await batchWrite((users.byPhone[phone] || []).map(u => ({ range: `${SHEETS.USERS}!C${u.row}`, values: [[value.slice(0, 80)]] })), env);
  } else if (field === 'l') {
    await updateCell(base.sheetName, s.row, 2, value.slice(0, 60), env, guard);
  } else {
    newPhone = normPhone(value);
    if (!newPhone) return send(chatId, '❌ رقم غير صالح، أعد الكتابة.', CANCEL_KB, env);
    if (base.byPhone[newPhone] && newPhone !== phone) return send(chatId, '❌ هذا الرقم مسجّل لطالب آخر.', CANCEL_KB, env);
    await updateCell(base.sheetName, s.row, 5, newPhone, env, guard);
    const users = await loadUsers(env, true);
    await batchWrite((users.byPhone[phone] || []).map(u => ({ range: `${SHEETS.USERS}!B${u.row}`, values: [[newPhone]] })), env);
  }
  await clearState(chatId, env);
  bg(env, logAction(actor.staff.name, 'تعديل طالب', `${s.name} (${{ n: 'الاسم', l: 'المستوى', p: 'الجوال' }[field]})`, env));
  await viewStudentCard(chatId, newPhone, actor, env);
}

async function promptStaffMessage(chatId, targetChat, name, env, mid) {
  await setState(chatId, 'pm', { target: targetChat }, env);
  await show(chatId, mid, card(`<b>رسالة إلى ${esc(name)}</b>`, ['اكتب الرسالة الآن (نص أو ملف):']), CANCEL_KB, env);
}

async function deliverStaffMessage(chatId, target, msg, actor, env) {
  await clearState(chatId, env);
  const r = await send(target, card('<b>رسالة من المشرف</b>', [esc(msg.text || '')]), [[btn('رد', 'contact')]], env);
  bg(env, logAction(actor.staff.name, 'رسالة خاصة', target, env));
  await send(chatId, r.ok ? '✅ تم إرسال رسالتك.' : '❌ تعذّر الإرسال.', [HOME_ROW], env);
}

async function syncStatuses(env, notify, onlyPhone) {
  const [users, base, staff] = await Promise.all([loadUsers(env, true), loadBase(env, true), loadStaff(env)]);
  const res = { checked: 0, changed: 0, notified: 0 };
  const updates = [], toNotify = [];
  for (const u of users.list) {
    if (onlyPhone && u.phone !== onlyPhone) continue;
    res.checked++;
    const s = base.byPhone[u.phone];
    const state = s ? s.state : 'deleted';
    const label = STATE_LABEL[state];
    if (u.state === label) continue;
    updates.push({ range: `${SHEETS.USERS}!F${u.row}`, values: [[label]] });
    res.changed++;
    if (notify && !staff[u.chatId]) toNotify.push({ chatId: u.chatId, s, state });
  }
  await batchWrite(updates, env);
  const sent = await Promise.all(toNotify.map(n => n.state === 'active'
    ? send(n.chatId, '✅ <b>تم تنشيط حسابك</b>\nأهلاً بعودتك.', [[btn('القائمة', 'home')]], env)
    : send(n.chatId, blockedText(n.s, n.state), [[btn('تواصل مع المشرف', 'contact')]], env)));
  res.notified = sent.filter(r => r.ok).length;
  return res;
}

// ============================================================
// البث
// ============================================================
async function viewBroadcastMenu(chatId, env, mid) {
  await show(chatId, mid, card('<b>البث والإشعارات</b>', [
    'اختر نوع البث:', '', '<b>رسالة نصية</b>', '<b>ملف</b>: صوت، صورة، فيديو، مستند'
  ]), [
    [btn('رسالة نصية', 'btype:text')],
    [btn('ملف / صوت / صورة / فيديو', 'btype:file')],
    HOME_ROW
  ], env);
}

async function chooseBroadcastType(chatId, type, env, mid) {
  const btype = type === 'text' ? 'text' : 'file';
  await setState(chatId, 'btext_name', { btype }, env);
  await show(chatId, mid, card('<b>اسم البث</b>', ['اكتب اسماً للبث الآن.', 'يظهر للطلاب في أول الرسالة.']), CANCEL_KB, env);
}

async function broadcastNameReceived(chatId, name, actor, env) {
  name = String(name).trim().slice(0, 100);
  if (!name) return send(chatId, '❌ الاسم مطلوب، اكتبه من فضلك.', CANCEL_KB, env);
  const st = await getState(chatId, env);
  const btype = st.d.btype;
  await setState(chatId, 'btext_content', { btype, bname: name }, env);
  if (btype === 'text') {
    await send(chatId, card(`<b>اسم البث:</b> ${esc(name)}`, ['اكتب نص البث الآن:']), CANCEL_KB, env);
  } else {
    await send(chatId, card(`<b>اسم البث:</b> ${esc(name)}`, ['أرسل الآن ملفاً واحداً: تسجيل صوتي، ملف صوتي، صورة، فيديو، أو مستند.']), CANCEL_KB, env);
  }
}

async function broadcastTextReceived(chatId, text, actor, env) {
  const st = await getState(chatId, env);
  if (!st || st.a !== 'btext_content') return;
  if (st.d.btype !== 'text') return send(chatId, '⚠️ هذا بث ملفات. أرسل ملفاً، أو اضغط «إلغاء».', CANCEL_KB, env);
  await setState(chatId, 'bpend', { kind: 'text', bname: st.d.bname, staffName: actor.staff.name, text }, env);
  await showAudiencePicker(chatId, env);
}

async function handleMediaMessage(msg, actor, state, env) {
  const chatId = String(msg.chat.id);

  if (state && state.a === 'btext_content') {
    if (state.d.btype === 'file') return broadcastFileReceived(msg, state, actor, env);
    return send(chatId, '⚠️ هذا بث نصي. اكتب النص، أو اضغط «إلغاء».', CANCEL_KB, env);
  }
  if (state && state.a === 'upl') return courseUploadReceived(msg, state, actor, env);
  if (state && state.a === 'pm') {
    const r = await tg('copyMessage', { chat_id: state.d.target, from_chat_id: chatId, message_id: msg.message_id }, env);
    await clearState(chatId, env);
    return send(chatId, r.ok ? '✅ تم إرسال الملف.' : '❌ تعذّر الإرسال.', [HOME_ROW], env);
  }
  if (state && state.a === 'bpend') return send(chatId, '⚠️ أكمل الخطوة السابقة، أو اضغط «إلغاء».', CANCEL_KB, env);
  if (state && state.a === 'upl_name') return send(chatId, '✏️ اكتب اسم الملف، أو اضغط «✅ اعتماد».', [[btn('❌ إلغاء', 'cancel')]], env);

  return send(chatId, card('<b>لرفع ملفات</b>', [
    'افتح «المقررات»، اختر المقرر، ثم اضغط «📤 رفع ملف إلى هذا المقرر».'
  ]), [[btn('المقررات', 'courses'), btn('الرئيسية', 'home')]], env);
}

async function broadcastFileReceived(msg, state, actor, env) {
  const chatId = String(msg.chat.id);
  const media = extractMedia(msg, state.d.bname);
  if (!media) return send(chatId, '❌ نوع الملف غير مدعوم.', CANCEL_KB, env);
  await setState(chatId, 'bpend', {
    kind: 'file', ...media, bname: state.d.bname, caption: msg.caption || '', staffName: actor.staff.name
  }, env);
  return showAudiencePicker(chatId, env);
}

async function showAudiencePicker(chatId, env, mid) {
  const st = await getState(chatId, env);
  if (!st || st.a !== 'bpend') return show(chatId, mid, '⌛ انتهت الجلسة، ابدأ من جديد.', [HOME_ROW], env);

  const d = st.d;
  const rec = await liveRecipients(env);
  const levels = audienceLevels(rec);
  const preview = d.kind === 'text' ? esc(trunc(d.text, 200)) : `${TYPE_LABEL[d.btype] || 'ملف'}: ${esc(d.fileName)}`;

  const kb = [[btn(`الجميع (${rec.length})`, 'baud:all')]];
  const remote = rec.filter(r => r.remote).length;
  if (remote) kb.push([btn(`عن بعد (${remote})`, 'baud:remote')]);
  const inhouse = rec.length - remote;
  if (inhouse && remote) kb.push([btn(`الحضوري (${inhouse})`, 'baud:inhouse')]);
  levels.names.forEach((n, i) => kb.push([btn(`${trunc(n, 24)} (${levels.counts[n]})`, `baud:L${i}`)]));
  if (d.kind === 'file') kb.push([btn('حفظ في المكتبة فقط', 'baud:none')]);
  kb.push([btn('إلغاء', 'cancel')]);

  await show(chatId, mid, card('<b>اختيار الفئة</b>', [
    `<b>اسم البث:</b> ${esc(d.bname)}`, `<i>${preview}</i>`, '', 'لمن تريد الإرسال؟'
  ]), kb, env);
}

async function chooseAudience(chatId, aud, env, mid) {
  const st = await getState(chatId, env);
  if (!st || st.a !== 'bpend') return show(chatId, mid, '⌛ انتهت الجلسة.', [HOME_ROW], env);
  const rec = await liveRecipients(env);
  const levels = audienceLevels(rec).names;
  st.d.aud = aud;
  st.d.audLabel = audienceTitle(aud, levels);
  await setState(chatId, 'bpend', st.d, env);
  if (aud === 'none') return runBroadcast(chatId, env, mid);

  const count = audienceFilter(aud, rec, levels).length;
  if (!count) {
    return show(chatId, mid, 'لا يوجد طلاب في هذه الفئة حالياً.', [[btn('تغيير الفئة', 'bpick'), btn('إلغاء', 'cancel')]], env);
  }
  await show(chatId, mid, card('⚠️ <b>تأكيد الإرسال</b>', [
    `اسم البث: <b>${esc(st.d.bname)}</b>`,
    `الفئة: <b>${esc(st.d.audLabel)}</b>`,
    `عدد المستلمين: <b>${count}</b>`
  ]), [
    [btn('تأكيد الإرسال', 'bgo')],
    [btn('تغيير الفئة', 'bpick'), btn('إلغاء', 'cancel')]
  ], env);
}

async function liveRecipients(env) {
  const [users, base, staff] = await Promise.all([loadUsers(env), loadBase(env), loadStaff(env)]);
  const out = [];
  for (const u of users.list) {
    if (staff[u.chatId]) continue;
    const s = base.byPhone[u.phone];
    if (s && s.state === 'active') out.push({ chatId: u.chatId, level: s.level, remote: s.statusText === 'عن بعد' });
  }
  return out;
}

function audienceLevels(recips) {
  const counts = {};
  recips.forEach(r => { if (r.level) counts[r.level] = (counts[r.level] || 0) + 1; });
  return { names: Object.keys(counts).sort(), counts };
}

function audienceFilter(aud, rec, levelNames) {
  if (aud === 'all') return rec.map(r => r.chatId);
  if (aud === 'remote') return rec.filter(r => r.remote).map(r => r.chatId);
  if (aud === 'inhouse') return rec.filter(r => !r.remote).map(r => r.chatId);
  const lv = levelNames[parseInt(String(aud).substring(1))];
  return lv ? rec.filter(r => r.level === lv).map(r => r.chatId) : [];
}

function audienceTitle(aud, levelNames) {
  if (aud === 'none') return 'حفظ في المكتبة فقط';
  if (aud === 'all') return 'جميع الطلاب';
  if (aud === 'remote') return 'الطلاب عن بعد';
  if (aud === 'inhouse') return 'الطلاب الحضوريون';
  return 'مستوى: ' + (levelNames[parseInt(String(aud).substring(1))] || '—');
}

async function runBroadcast(chatId, env, mid) {
  const st = await getState(chatId, env);
  if (!st || st.a !== 'bpend') return show(chatId, mid, '⌛ انتهت الجلسة.', [HOME_ROW], env);
  await clearState(chatId, env);

  const d = st.d;
  const rec = d.aud === 'none' ? [] : await liveRecipients(env);
  const ids = d.aud === 'none' ? [] : audienceFilter(d.aud, rec, audienceLevels(rec).names);
  await show(chatId, mid, `⏳ جاري التنفيذ… (${ids.length} مستلم)`, null, env);

  const lines = [`<b>اسم البث:</b> ${esc(d.bname)}`];
  const report = r => {
    lines.push(`الفئة: <b>${esc(d.audLabel || '')}</b>`);
    lines.push(`وصل: <b>${r.ok}</b>   فشل: <b>${r.fail}</b>`);
    if (r.blocked) lines.push(`أوقفوا البوت: <b>${r.blocked}</b>`);
  };

  if (d.kind === 'text') {
    const body = `📢 <b>${esc(d.bname)}</b>\n${CFG.LINE}\n${esc(d.text)}`;
    const r = await massSend(ids, 'sendMessage', id => ({
      chat_id: id, text: clip(body), parse_mode: 'HTML', disable_web_page_preview: true
    }), env);
    bg(env, appendRow(SHEETS.FILES, [nowRiyadh(), d.staffName, 'text', d.text, d.bname, '', '', '', '', ''], env));
    report(r);
  } else {
    d.course = d.course || '0';
    const methodMap = {
      voice: ['sendVoice', 'voice'], audio: ['sendAudio', 'audio'], photo: ['sendPhoto', 'photo'],
      video: ['sendVideo', 'video'], document: ['sendDocument', 'document']
    };
    const m = methodMap[d.btype] || methodMap.document;
    const caption = `📢 <b>${esc(d.bname)}</b>${d.caption ? '\n' + CFG.LINE + '\n' + esc(d.caption) : ''}`;

    const [saved, r] = await Promise.all([
      saveCourseFile(d, env),
      ids.length ? massSend(ids, m[0], id => {
        const p = { chat_id: id, caption, parse_mode: 'HTML' };
        p[m[1]] = d.fileId;
        if (d.btype === 'audio') p.title = d.bname;
        return p;
      }, env) : Promise.resolve(null)
    ]);

    lines.push(`الملف: ${esc(d.fileName)}`);
    if (saved.driveUrl) lines.push(`<a href="${esc(saved.driveUrl)}">رابط Filebase</a>`);
    if (saved.note) lines.push(`⚠️ ${esc(saved.note)}`);
    if (r) report(r);
    else lines.push('حُفظ في المكتبة دون إرسال.');
  }
  bg(env, logAction(d.staffName, 'بث', `${d.bname} → ${d.audLabel || ''}`, env));
  await show(chatId, mid, card('✅ <b>تمت العملية</b>', lines), [HOME_ROW], env);
}

async function sendOne(url, payload, res, canRetry) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (r.ok) { res.ok++; return; }
    if (r.status === 429 && canRetry) {
      const j = await r.json().catch(() => ({}));
      await sleep((((j.parameters && j.parameters.retry_after) || 3) + 0.5) * 1000);
      return sendOne(url, payload, res, false);
    }
    res.fail++;
    if (r.status === 403) res.blocked++;
  } catch (e) { res.fail++; }
}

async function massSend(chatIds, method, makePayload, env) {
  const res = { ok: 0, fail: 0, blocked: 0 };
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  for (let i = 0; i < chatIds.length; i += CFG.BROADCAST_BATCH) {
    const t0 = Date.now();
    const batch = chatIds.slice(i, i + CFG.BROADCAST_BATCH);
    await Promise.all(batch.map(id => sendOne(url, makePayload(id), res, true)));
    if (i + CFG.BROADCAST_BATCH < chatIds.length) await sleep(Math.max(0, 1000 - (Date.now() - t0)));
  }
  return res;
}

// ============================================================
// إدارة المقررات والملفات
// ============================================================
async function addCourse(chatId, text, actor, env) {
  await clearState(chatId, env);
  const name = trunc(text.trim(), 60);
  if (!name) return staffHome(chatId, actor, env);
  const courses = await loadCourses(env, true);
  let max = 0;
  courses.forEach(c => { const n = parseInt(c.id.replace(/\D/g, '')) || 0; if (n > max) max = n; });
  const id = `c${max + 1}`;
  await appendRow(SHEETS.COURSES, [id, name, 'ظاهر', courses.length + 1, nowRiyadh()], env);
  bg(env, logAction(actor.staff.name, 'إضافة مقرر', name, env));
  await send(chatId, `✅ تمت إضافة المقرر <b>${esc(name)}</b>.`, [
    [btn('📤 رفع ملف إليه', `cupl:${id}`)], [btn('إعدادات المقرر', `cset:${id}`)],
    [btn('المقررات', 'courses')]
  ], env);
}

async function renameCourse(chatId, text, state, actor, env) {
  const name = trunc(text.trim(), 60);
  if (!name) return send(chatId, '❌ الاسم مطلوب.', CANCEL_KB, env);
  const c = (await loadCourses(env, true)).find(x => x.id === state.d.id);
  await clearState(chatId, env);
  if (!c) return send(chatId, '❌ المقرر غير موجود.', [[btn('المقررات', 'courses')]], env);
  await updateCell(SHEETS.COURSES, c.row, 2, name, env, { col: 'A', val: c.id });
  bg(env, logAction(actor.staff.name, 'إعادة تسمية مقرر', `${c.name} → ${name}`, env));
  await send(chatId, `✅ أصبح اسم المقرر <b>${esc(name)}</b>.`, [[btn('فتح المقرر', `files:${c.id}:0`)]], env);
}

async function moveCourse(chatId, id, dir, env, mid) {
  const list = await loadCourses(env, true);
  const i = list.findIndex(c => c.id === id);
  const j = i + dir;
  if (i >= 0 && j >= 0 && j < list.length) {
    [list[i], list[j]] = [list[j], list[i]];
    await batchWrite(list.map((c, idx) => ({ range: `${SHEETS.COURSES}!D${c.row}`, values: [[idx + 1]] })), env);
  }
  await viewFiles(chatId, id, 0, true, env, mid);
}

async function toggleCourse(chatId, id, env, mid) {
  const c = (await loadCourses(env, true)).find(x => x.id === id);
  if (c) await updateCell(SHEETS.COURSES, c.row, 3, c.visible ? 'مخفي' : 'ظاهر', env, { col: 'A', val: c.id });
  await viewFiles(chatId, id, 0, true, env, mid);
}

async function deleteCourse(chatId, id, actor, env, mid) {
  const c = (await loadCourses(env, true)).find(x => x.id === id);
  if (c) {
    const files = (await loadFiles(env, true)).filter(f => f.course === id);
    await batchWrite(files.map(f => ({ range: `${SHEETS.FILES}!I${f.row}`, values: [['0']] })), env);
    await deleteSheetRow(SHEETS.COURSES, c.row, env, { col: 'A', val: c.id });
    bg(env, logAction(actor.staff.name, 'حذف مقرر', c.name, env));
  }
  await viewCourses(chatId, true, env, mid);
}

async function renameFile(chatId, text, state, actor, env) {
  const f = await findFile(state.d.key, env, true);
  await clearState(chatId, env);
  if (!f) return send(chatId, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
  let name = trunc(text.trim(), 80);
  if (!name) return send(chatId, '❌ الاسم مطلوب.', [[btn('المقررات', 'courses')]], env);
  const ext = (f.name.match(EXT_RE) || [''])[0];
  if (!EXT_RE.test(name)) name += ext;
  await updateCell(SHEETS.FILES, f.row, 5, name, env, { col: 'J', val: f.key });
  bg(env, logAction(actor.staff.name, 'إعادة تسمية ملف', `${f.name} → ${name}`, env));
  await send(chatId, `✅ تم تغيير الاسم إلى <b>${esc(stripExt(name))}</b>.`, [[btn('بطاقة الملف', `fcard:${f.key}`)]], env);
}

async function showMoveTargets(chatId, key, env, mid) {
  const f = await findFile(key, env);
  if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
  const courses = await loadCourses(env);
  const kb = [];
  if (f.course !== '0') kb.push([btn('عام', `fmoveto:${key}:0`)]);
  courses.filter(c => c.id !== f.course).forEach(c => kb.push([btn(trunc(c.name, 34), `fmoveto:${key}:${c.id}`)]));
  kb.push([btn('تراجع', `fcard:${key}`)]);
  await show(chatId, mid, card('<b>نقل الملف</b>', [`«${esc(stripExt(f.name))}»`, 'اختر المقرر الوجهة:']), kb, env);
}

async function moveFile(chatId, key, courseId, actor, env, mid) {
  const f = await findFile(key, env, true);
  if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
  await updateCell(SHEETS.FILES, f.row, 9, courseId, env, { col: 'J', val: f.key });
  bg(env, logAction(actor.staff.name, 'نقل ملف', `${f.name} → ${await courseName(courseId, env)}`, env));
  bg(env, rebuildSummary(env).catch(e => console.error('Rebuild:', e.message)));
  await viewFileCard(chatId, key, env, mid);
}

async function notifyNewFile(chatId, key, actor, env, mid) {
  const f = await findFile(key, env);
  if (!f) return show(chatId, mid, '❌ الملف غير موجود.', [[btn('المقررات', 'courses')]], env);
  const r = await notifyNewFiles([f], f.course, env);
  bg(env, logAction(actor.staff.name, 'إشعار ملف', `${f.name} (${r.ok})`, env));
  await send(chatId, `✅ أُرسل الإشعار إلى <b>${r.ok}</b> طالب${r.fail ? ` (فشل ${r.fail})` : ''}.`, [[btn('رجوع', `files:${f.course}:0`)]], env);
}

async function deleteFile(chatId, key, actor, env, mid) {
  const f = await findFile(key, env, true);
  if (f) {
    if (f.driveId) await deleteFromFilebase(f.driveId, env);
    await deleteSheetRow(SHEETS.FILES, f.row, env, { col: 'J', val: f.key });
    bg(env, logAction(actor.staff.name, 'حذف ملف', f.name, env));
  }
  await viewFiles(chatId, f ? f.course : '0', 0, true, env, mid);
}

const fileTs = key => parseInt(String(key).slice(1, 9), 36) || 0;

async function finishUpload(chatId, cid, actor, env, mid) {
  const st = await getState(chatId, env);
  await clearState(chatId, env);
  let note = '';
  if (st && st.a === 'upl' && st.d.since && (await env.KV.get('auto_notify')) !== '0') {
    const files = (await loadFiles(env, true)).filter(f => f.course === cid && fileTs(f.key) >= st.d.since);
    if (files.length) {
      const r = await notifyNewFiles(files, cid, env);
      note = `✅ أُرسل إشعار بـ ${files.length} ملف إلى <b>${r.ok}</b> طالب${r.fail ? ` (فشل ${r.fail})` : ''}.`;
      bg(env, logAction(actor.staff.name, 'إشعار رفع', `${files.length} ملف (${r.ok})`, env));
    }
    if (files.some(f => f.track)) {
      bg(env, rebuildSummary(env).then(n => console.log('Summary rows:', n)).catch(e => console.error('Summary rebuild:', e.message)));
    }
  }
  await viewFiles(chatId, cid, 0, true, env, mid);
  if (note) await send(chatId, note, null, env);
}

async function notifyNewFiles(files, cid, env) {
  const ids = (await liveRecipients(env)).map(r => r.chatId);
  if (!ids.length) return { ok: 0, fail: 0, blocked: 0 };
  const cname = await courseName(cid, env);
  const lines = [`المقرر: <b>${esc(cname)}</b>`];
  const wks = [...new Set(files.map(f => f.week).filter(Boolean))];
  if (wks.length) lines.push(`الأسبوع: ${wks.join('، ')}`);
  files.slice(0, 8).forEach(f => lines.push(`• ${esc(trunc(stripExt(f.name), 40))}`));
  if (files.length > 8) lines.push(`… و${files.length - 8} أخرى`);
  if (files.some(f => f.track)) {
    lines.push('', 'يمكنك تحميله الآن والاستماع في الوقت الذي يناسبك، ثم اضغط «سمعته الآن» ليُسجَّل لك.');
  }
  const kb = [];
  if (files.length === 1) {
    const f = files[0];
    kb.push([btn(f.track ? 'فتح التسجيل' : 'استلام الملف', f.track ? `fview:${f.key}` : `file:${f.key}`)]);
  }
  kb.push([btn('فتح المقرر', `files:${cid}:0`)]);
  const text = card(`<b>${files.length === 1 ? 'ملف جديد' : 'ملفات جديدة'}</b>`, lines);
  return massSend(ids, 'sendMessage', id => ({
    chat_id: id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb }
  }), env);
}

// ============================================================
// إعدادات المقرر
// ============================================================
async function viewCourseSettings(chatId, id, env, mid) {
  const c = (await loadCourses(env)).find(x => x.id === id);
  if (!c) return show(chatId, mid, '❌ المقرر غير موجود.', [[btn('المقررات', 'courses')]], env);
  const files = await loadFiles(env);
  const tf = files.filter(f => f.course === id && f.track);
  const lines = [
    `المقرر: <b>${esc(c.name)}</b>`,
    `عدد الأسابيع: <b>${c.weeks || 'غير محدد'}</b>`,
    `درجة الاجتياز: <b>${c.pass || 'غير محددة'}</b>`,
    `نقاط كل تسجيل: <b>${c.ppf || 1}</b>`,
    `تتبع الاستماع: <b>${c.track ? 'مفعّل للملفات الجديدة' : 'متوقف'}</b>`,
    `ملفات بتتبع الاستماع: <b>${tf.length}</b>`
  ];
  const kb = [
    [btn('عدد الأسابيع', `csetw:${id}`), btn('درجة الاجتياز', `cpass:${id}`)],
    [btn('نقاط كل تسجيل', `cppf:${id}`)],
    [btn(c.track ? 'إيقاف تتبع المقرر' : 'تفعيل تتبع المقرر', `ctrack:${id}`)],
    [btn('رجوع', `files:${id}:0`)]
  ];
  await show(chatId, mid, card('<b>إعدادات المقرر</b>', lines), kb, env);
}

async function showWeekPicker(chatId, id, env, mid) {
  const c = (await loadCourses(env)).find(x => x.id === id);
  if (!c) return show(chatId, mid, '❌ المقرر غير موجود.', [[btn('المقررات', 'courses')]], env);
  const all = [];
  for (let w = 1; w <= CFG.WEEKS; w++) all.push(btn(`أ${w}`, `csetws:${id}:${w}`));
  all.push(btn('بدون تقسيم', `csetws:${id}:0`));
  const kb = chunk(all, 5);
  kb.push([btn('رجوع', `cset:${id}`)]);
  await show(chatId, mid, card('<b>عدد أسابيع المقرر</b>', ['اختر عدد الأسابيع لتقسيم الملفات:']), kb, env);
}

async function setCourseWeeks(chatId, id, weeks, actor, env, mid) {
  const c = (await loadCourses(env, true)).find(x => x.id === id);
  if (!c) return;
  await updateCell(SHEETS.COURSES, c.row, 8, weeks || '', env, { col: 'A', val: c.id });
  bg(env, logAction(actor.staff.name, 'تغيير أسابيع', `${c.name} → ${weeks || 'بدون'}`, env));
  bg(env, rebuildSummary(env).catch(e => console.error('Rebuild:', e.message)));
  await viewCourseSettings(chatId, id, env, mid);
}

async function applyCourseNumber(chatId, text, state, field, env) {
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return send(chatId, '❌ اكتب رقماً صحيحاً (0 أو أكثر).', CANCEL_KB, env);
  const c = (await loadCourses(env, true)).find(x => x.id === state.d.id);
  await clearState(chatId, env);
  if (!c) return send(chatId, '❌ المقرر غير موجود.', null, env);
  const col = field === 'cpass' ? 7 : 9;
  await updateCell(SHEETS.COURSES, c.row, col, n, env, { col: 'A', val: c.id });
  bg(env, rebuildSummary(env).catch(e => console.error('Rebuild:', e.message)));
  await viewCourseSettings(chatId, c.id, env);
}

// ============================================================
// الإحصاء والسجل
// ============================================================
async function viewStats(chatId, env, mid) {
  const [base, users, counts, courses, staff] = await Promise.all([
    loadBase(env), loadUsers(env), fileCounts(env), loadCourses(env), loadStaff(env)
  ]);
  const c = { active: 0, suspended: 0, deleted: 0 };
  let reg = 0, unreg = 0, remote = 0;
  base.list.forEach(s => {
    c[s.state]++;
    if (s.state === 'active') {
      if (s.statusText === 'عن بعد') remote++;
      if (users.byPhone[s.phone]) reg++; else unreg++;
    }
  });
  let files = 0;
  Object.keys(counts).forEach(k => files += counts[k]);
  const lines = [
    `الطلاب في القاعدة: <b>${base.list.length}</b>`,
    `🟢 نشط ${c.active}${remote ? ` (منهم ${remote} عن بعد)` : ''}   🟡 موقوف ${c.suspended}   🔴 محذوف ${c.deleted}`,
    `دخلوا البوت: <b>${reg}</b>`,
    `لم يدخلوا بعد: <b>${unreg}</b>`,
    CFG.LINE,
    `المقررات: <b>${courses.length}</b>   |   الملفات: <b>${files}</b>`,
    `الإداريون: <b>${Object.keys(staff).length}</b>`
  ];
  await show(chatId, mid, card('<b>الإحصاء العام</b>', lines), [
    [btn('سجل الإدارة', 'log')], HOME_ROW
  ], env);
}

async function viewLog(chatId, env, mid) {
  const rows = await readSheet(`${SHEETS.LOG}!A2:D`, env, { ttl: 10000 });
  const last = rows.filter(r => /^\d{4}-/.test(String(r[0] || ''))).slice(-15).reverse();
  const lines = last.length
    ? last.map(r => `<code>${esc(String(r[0]).slice(5))}</code> ${esc(r[1])}: ${esc(r[2])}${r[3] ? ' — ' + esc(trunc(r[3], 40)) : ''}`)
    : ['لا توجد سجلات.'];
  await show(chatId, mid, card('<b>آخر العمليات الإدارية</b>', lines), [[btn('الإحصاء', 'stats')]], env);
}

// ============================================================
// المشرفون
// ============================================================
async function viewTeam(chatId, env, mid) {
  const [staff, pending] = await Promise.all([loadStaff(env, true), loadPending(env, true)]);
  const kb = [], lines = [];
  Object.keys(staff).forEach(id => {
    const s = staff[id];
    lines.push(`${s.role === 'admin' ? '👑' : '🛡️'} ${esc(s.name)} — <code>${id}</code>`);
    if (id !== adminId(env)) kb.push([btn(`إزالة ${trunc(s.name, 22)}`, `tdel:${id}`)]);
  });
  pending.forEach(p => {
    lines.push(`${p.role === 'admin' ? '👑' : '🛡️'} ${esc(p.name)} — ${p.phone} <i>(بانتظار أول دخول)</i>`);
    kb.push([btn(`إلغاء تعيين ${trunc(p.name, 20)}`, `tdel:${p.id}`)]);
  });
  kb.push([btn('إضافة مشرف', 'tadd')], HOME_ROW);
  await show(chatId, mid, card('<b>المشرفون</b>', lines), kb, env);
}

async function teamAddStep1(chatId, text, actor, env) {
  const phone = normPhone(text);
  if (!phone) return send(chatId, '❌ رقم الجوال غير صحيح.\nمثال: <code>570456492 محمد أحمد</code>', CANCEL_KB, env);
  const typed = text.replace(/[0-9٠-٩۰-۹+\-]+/g, ' ').replace(/\s+/g, ' ').trim();

  const [staff, pending, base, users] = await Promise.all([
    loadStaff(env, true), loadPending(env, true), loadBase(env), loadUsers(env, true)
  ]);
  const dup = Object.values(staff).some(s => s.studentPhone === phone) || pending.some(p => p.phone === phone);
  const bound = (users.byPhone[phone] || [])[0];
  if (dup || (bound && staff[bound.chatId])) {
    return send(chatId, '⚠️ هذا الرقم معيَّن مشرفاً من قبل.', [[btn('المشرفون', 'team')]], env);
  }
  const student = base.byPhone[phone];
  const name = trunc(typed || (student && student.name) || 'مشرف', 40);
  await setState(chatId, 'tadd2', { phone, name, student: !!student, chat: bound ? bound.chatId : '' }, env);
  await send(chatId, card(`<b>صلاحية ${esc(name)}</b>`, [
    `الجوال: ${phone}`, '<b>مدير</b>: كل الصلاحيات', '<b>مشرف</b>: الطلاب، المراسلة، البث، رفع الملفات'
  ]), [[btn('مدير', 'trole:admin'), btn('مشرف', 'trole:supervisor')], [btn('إلغاء', 'cancel')]], env);
}

async function teamAddStep2(chatId, role, actor, env) {
  const st = await getState(chatId, env);
  if (!st || st.a !== 'tadd2') return send(chatId, '⌛ انتهت الجلسة.', [[btn('المشرفون', 'team')]], env);
  await clearState(chatId, env);
  const d = st.d;
  role = role === 'admin' ? 'admin' : 'supervisor';
  const studentPhone = d.student ? d.phone : '';

  if (d.chat) {
    await appendRow(SHEETS.STAFF, [d.chat, d.name, role, studentPhone], env);
    await send(d.chat, `تمت إضافتك إلى إدارة منبر حسان بصلاحية <b>${roleLabel(role)}</b>.\nاكتب /start لتبدأ.`, null, env);
  } else {
    await appendRow(SHEETS.STAFF, ['p' + d.phone, d.name, role, studentPhone], env);
  }
  bg(env, logAction(actor.staff.name, 'تعيين مشرف', `${d.name} (${role})`, env));
  await viewTeam(chatId, env);
  if (!d.chat) {
    await send(chatId, 'اطلب من المشرف فتح البوت والضغط على «مشاركة رقمي»، وتُفعَّل صلاحيته تلقائياً.', null, env);
  }
}

async function teamRemove(chatId, id, actor, env, mid) {
  if (id !== adminId(env)) {
    const staff = await loadStaff(env, true);
    const target = staff[id] || (await loadPending(env, true)).find(p => p.id === id);
    if (target && target.row) {
      await deleteSheetRow(SHEETS.STAFF, target.row, env, { col: 'A', val: id });
      bg(env, logAction(actor.staff.name, 'إزالة مشرف', target.name, env));
      if (staff[id]) bg(env, send(id, 'تمت إزالة صلاحياتك الإدارية.', null, env));
    }
  }
  await viewTeam(chatId, env, mid);
}

// ============================================================
// الإعدادات
// ============================================================
async function viewSettings(chatId, env, mid) {
  const paused = await isPaused(env);
  await show(chatId, mid, card('<b>الإعدادات</b>', [
    `حالة البوت: ${paused ? '🟡 <b>متوقف للصيانة</b>' : '🟢 <b>يعمل</b>'}`,
    paused ? 'الطلاب يرون رسالة صيانة، والإدارة تعمل بشكل طبيعي.' : 'عند الإيقاف يرى الطلاب رسالة صيانة فقط.',
    '', 'النظام: Cloudflare Workers + Google Sheets + Filebase', `الإصدار: ${CFG.VERSION}`
  ]), [
    [btn(paused ? 'تشغيل البوت' : 'إيقاف البوت مؤقتاً', 'tpause')],
    [btn('تحديث الذاكرة المؤقتة', 'tcache')],
    HOME_ROW
  ], env);
}

// ============================================================
// التحويل بين الأوضاع
// ============================================================
async function switchToStudent(chatId, actor, env) {
  if (!actor.staff.studentPhone) return send(chatId, '❌ لا يوجد رقم طالب مرتبط بحسابك.', null, env);
  const student = await findStudent(actor.staff.studentPhone, env);
  if (!student) return send(chatId, '❌ لم أجد الطالب المرتبط بحسابك في القاعدة.', null, env);
  await saveUser(chatId, actor.staff.studentPhone, student.name, env);
  await env.KV.put(`sm_${chatId}`, '1');
  await studentHome(chatId, { kind: 'student', phone: actor.staff.studentPhone, asStaffStudent: true }, env);
}

async function switchToStaff(chatId, env) {
  await env.KV.delete(`sm_${chatId}`);
  const actor = await getActor(chatId, env);
  if (actor.kind === 'staff') await staffHome(chatId, actor, env, '<b>عدت إلى لوحة الإدارة</b>');
}