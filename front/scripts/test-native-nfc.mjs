import assert from 'node:assert/strict';
import { getNfcReader } from '../src/app/shared/nfc-reader.ts';

const win = new EventTarget();
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;
globalThis.window = win;
assert.equal(getNfcReader(), undefined);
class BrowserReader {}
win.NDEFReader = BrowserReader;
assert.equal(getNfcReader(), BrowserReader);
let pending;
let cancelled;
win.ScanakiNfc = {
  scan(id) { pending = {id, mode:'scan'}; },
  write(id, url) { pending = {id, mode:'write', url}; },
  cancel(id) { cancelled = id; },
};
const reply = (id, status, url) => win.dispatchEvent(new CustomEvent('scanaki:nfc-result',
  {detail:{requestId:id,status,url}}));
const Reader = getNfcReader();
const reader = new Reader();
let scanned;
reader.onreading = e => { scanned = new TextDecoder().decode(e.message.records[0].data); };
let task = reader.scan();
reply('unrelated', 'success', 'https://scanaki.uk/p/wrong');
assert.equal(scanned, undefined);
reply(pending.id, 'success', 'https://scanaki.uk/p/test-tag');
await task;
assert.equal(scanned, 'https://scanaki.uk/p/test-tag');
task = reader.scan();
reply(pending.id, 'success', 'https://other.invalid/');
await assert.rejects(task, /Unsupported NFC URL/);
task = reader.scan();
reply(pending.id, 'error');
await assert.rejects(task, /unavailable/);
task = reader.scan();
const id = pending.id;
reader.abort();
await assert.rejects(task, /cancelled/);
assert.equal(cancelled, id);
for (const url of ['javascript:alert(1)', 'https://scanaki.uk:444/', 'https://user@scanaki.uk/', 'https://scanaki.uk.evil.invalid/']) {
  await assert.rejects(reader.write({records:[{recordType:'url',data:url}]}));
}
task = reader.write({records:[{recordType:'url',data:'https://scanaki.uk/p/test-tag'}]});
assert.equal(pending.mode, 'write');
reply(pending.id, 'success');
await task;
console.log('PASS native NFC adapter: browser fallback, scan/write, URL restrictions, cancellation and errors');
