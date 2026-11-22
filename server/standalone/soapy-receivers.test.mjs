import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createSoapyReceiver } from '../../src/sdr/soapyReceiver.js';
import { soapyReceiverPlugin } from './soapy-receivers.js';

function fakeBridge(events) {
  let resolve;
  const ended = new Promise((done) => {
    resolve = done;
  });
  let read = 0;
  return {
    ended,
    async close() {
      resolve();
    },
    async command(operation, value) {
      events.push([operation, value]);
      if (operation === 'discover')
        return [{ driver: 'plutosdr', label: 'Pluto', serial: 'private' }];
      if (operation === 'read')
        return Buffer.alloc(65_536, ++read).toString('base64');
      return value ?? null;
    },
  };
}

test('the local SoapySDR route discovers and tunes a receiver, reads ordered IQ and releases it', async (t) => {
  const events = [];
  let handler;
  let route;
  const httpServer = http.createServer((req, res) => {
    if (req.url !== route) {
      res.writeHead(404).end();
      return;
    }
    req.url = '/'; // The mount prefix is stripped by Vite's middleware.
    void handler(req, res);
  });
  t.after(() => httpServer.close());
  soapyReceiverPlugin({
    startBridge: () => fakeBridge(events),
  }).configureServer({
    httpServer,
    middlewares: {
      use(path, handle) {
        route = path;
        handler = handle;
      },
    },
  });
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const receiver = createSoapyReceiver((path, options) =>
    fetch(origin + path, {
      ...options,
      headers: { ...options.headers, Origin: origin },
    }),
  );
  const blocked = await fetch(origin + route, {
    method: 'POST',
    headers: {
      Origin: 'https://example.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operation: 'discover' }),
  });
  assert.equal(blocked.status, 403);
  assert.deepEqual(events, []);
  const [device] = await receiver.discover();
  assert.deepEqual(Object.keys(device).sort(), ['driver', 'id', 'label']);
  await assert.rejects(receiver.open({ id: 'unknown' }), { status: 404 });
  const radio = await receiver.open(device);
  assert.equal(await radio.setSampleRate(2_000_000), 2_000_000);
  assert.equal(await radio.setCenterFrequency(1_090_000_000), 1_090_000_000);
  await assert.rejects(radio.setCenterFrequency(1), { status: 400 });
  await assert.rejects(receiver.open(device), { status: 409 });
  const samples = await Promise.all([
    radio.readSamples(32_768),
    radio.readSamples(32_768),
  ]);
  assert.deepEqual(
    samples.map(({ data }) => new Uint8Array(data)[0]),
    [1, 2],
  );
  await radio.close();
  const reopened = await receiver.open(device);
  await reopened.close();
});
