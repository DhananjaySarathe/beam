'use strict';
// Takes the site's screenshots from the real Beam: a Mac-sized page and a phone-sized page
// find each other and the phone sends two files. Run:  node tools/shots.cjs <path to beam-file-transfer>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BEAM = path.resolve(process.argv[2] || '../beam-file-transfer');
const OUT = path.join(__dirname, '..', 'assets');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { createApp } = require(path.join(BEAM, 'server.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILES = [{ name: 'Goa trip.mp4', size: 48 * 1024 * 1024 }, { name: 'IMG_2041.jpg', size: 3_400_000 }];

async function main() {
  setTimeout(() => { console.error('gave up after 120 s'); process.exit(2); }, 120000).unref();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-shots-'));
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${tmp}/profile`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = fs.readFileSync(`${tmp}/profile/DevToolsActivePort`, 'utf8').split('\n')[0]; } catch {} }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 1; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const n = id++; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params, sessionId })); });
  const ev = async (s, expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, s); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const until = async (s, expression, label) => { for (let i = 0; i < 200; i++) { if (await ev(s, expression)) return; await sleep(100); } throw new Error('timed out: ' + label); };
  const open = async (name, width, height, mobile) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile }, sessionId);
    if (mobile) await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l' }, sessionId);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('beam.name', ${JSON.stringify(name)}); } catch {}` }, sessionId);
    await send('Page.navigate', { url: base }, sessionId);
    return sessionId;
  };
  const shot = async (s, file) => {
    await sleep(450);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, s);
    fs.writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
    console.log('->', file);
  };
  try {
    fs.mkdirSync(OUT, { recursive: true });
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: `${tmp}/downloads` });
    const mac = await open('MacBook Air', 1120, 700, false);
    await sleep(600);
    const phone = await open('Pixel 8', 390, 760, true);
    await until(mac, `document.querySelectorAll('.peer:not(.add)').length === 1`, 'mac sees phone');
    await until(phone, `document.querySelectorAll('.peer:not(.add)').length === 1`, 'phone sees mac');
    console.log('names:', await ev(mac, `document.getElementById('me-name').textContent`), '|', await ev(phone, `document.getElementById('me-name').textContent`));
    await shot(mac, 'shot-mac-devices.png');
    await ev(phone, `document.querySelector('.peer:not(.add)').click()`);
    await until(phone, `document.getElementById('send-dialog').open`, 'send sheet');
    await shot(phone, 'shot-phone-send.png');
    await ev(phone, `(() => {
      const dt = new DataTransfer();
      for (const f of ${JSON.stringify(FILES)}) dt.items.add(new File([new Uint8Array(f.size)], f.name));
      const input = document.getElementById('file-input'); input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(mac, `document.getElementById('offer-dialog').open`, 'offer on the mac');
    await shot(mac, 'shot-mac-offer.png');
    await ev(mac, `document.getElementById('offer-accept').click()`);
    await until(mac, `(document.querySelector('#activity .item') || { dataset: {} }).dataset.state === 'done'`, 'files arrive');
    await sleep(2500);
    await shot(mac, 'shot-mac-done.png');
    await shot(phone, 'shot-phone-done.png');
  } finally {
    chrome.kill(); server.close(); server.closeAllConnections();
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0), (e) => { console.error('ERROR:', e.message); process.exit(1); });
