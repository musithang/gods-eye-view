import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import { readRequestBody } from '../providers/common/request.js';

const BRIDGE = fileURLToPath(new URL('./soapy-receiver.py', import.meta.url));
const ROUTE = '/api/local-receivers/soapy';
const READ_BYTES = 65_536;
const SESSION_IDLE_MS = 15_000;
const MAX_COMMANDS = 5;

function openBridge(python, environment) {
  const child = spawn(python, ['-u', BRIDGE], {
    env: environment,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  let pending = null;
  let closing = false;
  let killTimer;
  const ended = new Promise((resolve) => child.once('close', resolve));

  function close() {
    if (!closing) {
      closing = true;
      pending?.reject(new Error('SoapySDR receiver closed'));
      child.stdin.end();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      killTimer.unref();
    }
    return ended;
  }

  child.on('error', () =>
    pending?.reject(new Error('SoapySDR Python could not start')),
  );
  child.stdin.on('error', () =>
    pending?.reject(new Error('SoapySDR bridge stopped')),
  );
  void ended.then(() => {
    closing = true;
    clearTimeout(killTimer);
    pending?.reject(
      new Error(
        'SoapySDR bridge stopped. Check the Python bindings, NumPy and driver.',
      ),
    );
    lines.close();
  });
  lines.on('line', (line) => {
    try {
      const reply = JSON.parse(line);
      if (typeof reply.error === 'string')
        pending?.reject(new Error(reply.error));
      else pending?.resolve(reply.value);
    } catch {
      pending?.reject(new Error('Invalid response from SoapySDR'));
    }
  });

  let queue = Promise.resolve();
  let queued = 0;
  function command(operation, value) {
    if (closing || queued >= MAX_COMMANDS)
      return Promise.reject(
        new Error('SoapySDR receiver is unavailable or busy'),
      );
    queued += 1;
    const run = queue.then(async () => {
      if (closing) throw new Error('SoapySDR receiver closed');
      const timeout = setTimeout(
        () => {
          pending?.reject(new Error(`SoapySDR ${operation} timed out`));
          void close();
        },
        operation === 'discover' ? 5_000 : 2_500,
      );
      try {
        return await new Promise((resolve, reject) => {
          pending = { resolve, reject };
          child.stdin.write(`${JSON.stringify({ operation, value })}\n`);
        });
      } finally {
        pending = null;
        clearTimeout(timeout);
      }
    });
    queue = run
      .catch(() => {})
      .finally(() => {
        queued -= 1;
      });
    return run;
  }
  return { command, close, ended };
}

function receiverList(values) {
  return new Map(
    values.map((args) => {
      const identity = JSON.stringify(Object.entries(args).sort());
      const id = createHash('sha256')
        .update(identity)
        .digest('hex')
        .slice(0, 24);
      const driver = String(args.driver || 'unknown');
      return [
        id,
        { args, id, driver, label: String(args.label || driver).slice(0, 150) },
      ];
    }),
  );
}

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function validValue(operation, value) {
  switch (operation) {
    case 'rate':
      return value === 2_000_000 || value === 2_048_000;
    case 'tune':
      return (
        Number.isInteger(value) &&
        ((value >= 87_500_000 && value <= 108_000_000) ||
          value === 1_090_000_000)
      );
    case 'gain':
      return (
        value === null ||
        (Number.isFinite(value) && value >= -100 && value <= 150)
      );
    case 'reset':
    case 'read':
      return value === undefined;
    default:
      return false;
  }
}

/** Local-only receiver control and binary IQ transport for the standalone app. */
export function soapyReceiverPlugin({
  python = process.env.GEV_SOAPY_PYTHON || 'python3',
  deviceArgs = process.env.GEV_SOAPY_DEVICE,
  startBridge = () =>
    openBridge(python, {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          /^(?:PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|LANG|LC_.*|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|SOAPY_SDR_.*)$/i.test(
            name,
          ),
        ),
      ),
    }),
} = {}) {
  function install(server) {
    let devices = new Map();
    let discovery = null;
    let session = null;
    let scanner = null;

    function renew(current) {
      clearTimeout(current.idle);
      current.idle = setTimeout(
        () => void current.bridge.close(),
        SESSION_IDLE_MS,
      );
      current.idle.unref();
    }

    async function discover() {
      if (session) return devices;
      if (!discovery) {
        const bridge = startBridge();
        scanner = bridge;
        discovery = bridge
          .command('discover', deviceArgs)
          .then((values) => {
            devices = receiverList(values);
            return devices;
          })
          .finally(() => {
            void bridge.close();
            scanner = null;
            discovery = null;
          });
      }
      return discovery;
    }

    server.httpServer?.once('close', () => {
      void scanner?.close();
      void session?.bridge.close();
    });

    server.middlewares.use(ROUTE, async (req, res) => {
      if (req.url !== '/')
        return json(res, 404, { error: 'Unknown receiver route' });
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
      const gate = admitKeySetupRequest({
        method: req.method,
        remoteAddress: req.socket?.remoteAddress,
        hostHeader: req.headers.host,
        protocol: req.socket?.encrypted ? 'https:' : 'http:',
        origin: req.headers.origin,
        contentType: req.headers['content-type'],
        proxyHeaders: req.headers,
        env: process.env,
      });
      if (!gate.ok)
        return json(res, gate.status, {
          error: 'Local SoapySDR requests require this app’s origin',
        });
      let request;
      try {
        const body = await readRequestBody(
          req,
          2048,
          AbortSignal.timeout(3000),
        );
        request = JSON.parse(body);
        if (!request || typeof request !== 'object') throw new Error();
      } catch {
        return json(res, 400, { error: 'Invalid receiver request' });
      }
      const { operation, value, id } = request;
      try {
        if (operation === 'discover') {
          const found = await discover();
          return json(res, 200, {
            devices: [...found.values()].map(({ id, label, driver }) => ({
              id,
              label,
              driver,
            })),
          });
        }
        if (operation === 'open') {
          const device = devices.get(id);
          if (!device)
            return json(res, 404, { error: 'Scan for SoapySDR devices again' });
          if (session || discovery)
            return json(res, 409, { error: 'SoapySDR receiver is busy' });
          if (res.destroyed) return;
          const current = {
            id: randomUUID(),
            bridge: startBridge(),
            idle: null,
          };
          session = current;
          void current.bridge.ended.then(() => {
            clearTimeout(current.idle);
            if (session === current) session = null;
          });
          res.once('close', () => {
            if (!res.writableFinished) void current.bridge.close();
          });
          renew(current);
          try {
            await current.bridge.command('open', device.args);
          } catch (error) {
            await current.bridge.close();
            throw error;
          }
          return json(res, 200, { id: current.id });
        }
        if (!session || id !== session.id)
          return json(res, 404, { error: 'SoapySDR session has closed' });
        const current = session;
        if (operation === 'close') {
          await current.bridge.close();
          return json(res, 200, {});
        }
        if (!validValue(operation, value))
          return json(res, 400, { error: 'Invalid receiver command' });
        renew(current);
        const result = await current.bridge.command(operation, value);
        if (operation !== 'read') return json(res, 200, { value: result });
        const iq = Buffer.from(result, 'base64');
        if (iq.length !== READ_BYTES)
          throw new Error('Invalid SoapySDR IQ block');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Content-Length': iq.length,
        });
        return res.end(iq);
      } catch (error) {
        if (!res.destroyed)
          json(res, 503, { error: `SoapySDR: ${error.message}` });
      }
    });
  }
  return {
    name: 'soapy-receivers',
    configureServer: install,
    configurePreviewServer: install,
  };
}
