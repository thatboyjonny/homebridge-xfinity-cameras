#!/usr/bin/env node
/**
 * Scrub a Proxyman/Charles HAR capture of the Xfinity Home app so it can be shared
 * for analysis. Removes tokens, cookies, session headers, PINs, personal details,
 * and query-string secrets; drops binary/image bodies; keeps hosts, paths, methods,
 * status codes and JSON structure. WebSocket frames (live-video signalling) are kept as text with
 * session keys masked and public IP addresses replaced by stand-ins (same IP -> same stand-in).
 *
 *   node har-scrub.mjs ~/Downloads/xfinity.har ~/Downloads/xfinity-scrubbed.har
 *
 * Then review the output yourself before sharing it.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: node har-scrub.mjs <in.har> <out.har>');
  process.exit(2);
}

const SECRET_HEADER = /^(authorization|cookie|set-cookie|xh-auth|x-.*token.*|x-api-key|proxy-authorization)$/i;
const SECRET_KEY = /(token|secret|password|passwd|^code$|^pin$|^xhauth$|sessionheadervalue|^authorization$|^cookie$|signature|^key$|^sig$|credential|^pwd$|ufrag|icepwd|fingerprint|srtp|masterkey)/i;
const PERSONAL_KEY = /(^email|^phone|mobile|firstname|lastname|^fullname$|street|address(line)?\d?$|^city$|^zip|postal|latitude|longitude|^lat$|^lon|^lng|accountnumber|^account$|customerid|^ssn|dob|birth)/i;

let masked = 0;
const mask = v => (masked++, typeof v === 'string' ? `[redacted:${v.length}]` : '[redacted]');

function scrubValue(key, v, depth = 0) {
  if (SECRET_KEY.test(key)) return mask(v);
  if (PERSONAL_KEY.test(key)) return mask(v);
  if (v && typeof v === 'object' && depth < 12) {
    if (Array.isArray(v)) return v.map(x => scrubValue('', x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubValue(k, x, depth + 1)]));
  }
  if (typeof v === 'string') return scrubText(v);
  return v;
}

// Public IPs (your home's WAN address shows up in WebRTC ICE candidates) -> stable stand-ins.
const ipMap = new Map();
const isPrivate4 = ip => /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(ip);
function scrubIps(t) {
  return t
    .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, ip => {
      if (isPrivate4(ip) || ip.split('.').some(n => +n > 255)) return ip;
      if (!ipMap.has(ip)) ipMap.set(ip, `203.0.113.${ipMap.size + 1}`);
      masked++;
      return ipMap.get(ip);
    })
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, ip => {
      if (/^(fe80|fd|fc)/i.test(ip)) return ip;
      if (!ipMap.has(ip)) ipMap.set(ip, `2001:db8::${ipMap.size + 1}`);
      masked++;
      return ipMap.get(ip);
    });
}

// SDP lines that carry keys/credentials
function scrubSdp(t) {
  return t.replace(/(a=(?:ice-pwd|ice-ufrag|fingerprint|crypto|key-mgmt)[: ])[^\r\n"\\]+/gi, (m, p) => (masked++, `${p}[redacted]`));
}

function scrubText(t) {
  return scrubSdp(scrubIps(t))
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (m, p) => (masked++, `${p} [redacted]`))
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, () => (masked++, '[redacted-jwt]'))
    .replace(/([?&](?:[^=&]*(?:token|code|sig|signature|key|auth|session|credential)[^=&]*))=([^&#\s"]+)/gi,
      (m, k) => (masked++, `${k}=[redacted]`))
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => (masked++, '[redacted-email]'));
}

function scrubBody(text, mime = '') {
  if (!text) return text;
  if (/^image\/|octet-stream|video\/|font\//.test(mime) || text.length > 200_000) {
    return `[dropped ${mime || 'binary'} body, ${text.length} chars]`;
  }
  try {
    return JSON.stringify(scrubValue('', JSON.parse(text)));
  } catch {
    if (/application\/x-www-form-urlencoded/.test(mime) || /^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(text.trim())) {
      const p = new URLSearchParams(text);
      for (const [k, v] of p) {
        p.set(k, SECRET_KEY.test(k) || PERSONAL_KEY.test(k) ? mask(v) : scrubText(v));
      }
      return p.toString();
    }
    return scrubText(text);
  }
}

function scrubFrame(data, opcode) {
  if (typeof data !== 'string') return data;
  if (opcode === 2) return `[binary frame, ${data.length} chars base64]`;
  try {
    return JSON.stringify(scrubValue('', JSON.parse(data)));
  } catch {
    return scrubText(data);
  }
}

const har = JSON.parse(readFileSync(input, 'utf8'));
let frames = 0, binaryFrames = 0;
const entries = har.log?.entries ?? [];
const summary = new Map();

for (const e of entries) {
  const req = e.request, res = e.response;
  for (const h of [...(req.headers ?? []), ...(res.headers ?? [])]) {
    if (SECRET_HEADER.test(h.name)) h.value = mask(h.value);
    else h.value = scrubText(String(h.value));
  }
  req.cookies = [];
  res.cookies = [];
  for (const q of req.queryString ?? []) {
    if (SECRET_KEY.test(q.name) || PERSONAL_KEY.test(q.name)) q.value = mask(q.value);
  }
  req.url = scrubText(req.url);
  if (req.postData) {
    req.postData.text = scrubBody(req.postData.text, req.postData.mimeType);
    if (req.postData.params) req.postData.params = req.postData.params.map(p => ({ ...p, value: SECRET_KEY.test(p.name) ? mask(p.value) : p.value }));
  }
  if (res.content) {
    let text = res.content.text;
    if (text && res.content.encoding === 'base64' && !/^image\//.test(res.content.mimeType ?? '')) {
      try { text = Buffer.from(text, 'base64').toString('utf8'); delete res.content.encoding; } catch { /* keep */ }
    }
    res.content.text = scrubBody(text, res.content.mimeType);
  }
  for (const list of [e._webSocketMessages, e.webSocketMessages, e._websocketMessages]) {
    for (const m of Array.isArray(list) ? list : []) {
      frames++;
      if (m.opcode === 2) binaryFrames++;
      for (const k of ['data', 'text', 'content']) {
        if (k in m) m[k] = scrubFrame(m[k], m.opcode);
      }
    }
  }
  try {
    const u = new URL(req.url);
    const key = `${req.method} ${u.host}${u.pathname.replace(/\/[0-9a-f-]{16,}|\/\d{4,}/gi, '/:id')}`;
    const s = summary.get(key) ?? { count: 0, statuses: new Set() };
    s.count++; s.statuses.add(res.status);
    summary.set(key, s);
  } catch { /* ignore */ }
}

writeFileSync(output, JSON.stringify(har, null, 1));
console.log(`Scrubbed ${entries.length} requests and ${frames} WebSocket frames` +
  `${binaryFrames ? ` (${binaryFrames} binary, contents dropped)` : ''}, masked ${masked} values -> ${output}\n`);
console.log('Endpoints seen:');
for (const [k, s] of [...summary].sort()) console.log(`  ${String(s.count).padStart(3)}x  ${k}  [${[...s.statuses].join(',')}]`);
console.log('\nOpen the output and search for anything personal before sharing it.');
