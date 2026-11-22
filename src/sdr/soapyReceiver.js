const ROUTE = '/api/local-receivers/soapy';
const SAMPLES = 32_768;

/** Receiver provider for the standalone server's SoapySDR bridge. */
export function createSoapyReceiver(
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  async function request(operation, { id, value } = {}) {
    const response = await fetchImpl(ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, id, value }),
      signal: AbortSignal.timeout(operation === 'discover' ? 6000 : 4500),
      keepalive: operation === 'close',
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const error = new Error(
        body?.error || `SoapySDR bridge returned HTTP ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }
    if (operation === 'read') {
      const data = await response.arrayBuffer();
      if (data.byteLength !== SAMPLES * 2)
        throw new Error('Invalid SoapySDR IQ block');
      return { data };
    }
    return response.json();
  }

  return {
    async discover() {
      const { devices } = await request('discover');
      return devices;
    },
    async open(receiver) {
      const { id } = await request('open', { id: receiver.id });
      const command = async (operation, value) =>
        (await request(operation, { id, value })).value;
      let readTail = Promise.resolve();
      let closed = false;
      return {
        backend: 'soapy',
        label: receiver.label,
        setSampleRate: (value) => command('rate', value),
        setFrequencyCorrection: async () => {},
        setCenterFrequency: (value) => command('tune', value),
        setGain: (value) => command('gain', value),
        resetBuffer: () => command('reset'),
        readSamples(count) {
          if (count !== SAMPLES)
            throw new Error('Unsupported SoapySDR IQ block size');
          // Preserve RF sample order across HTTP connections.
          const read = readTail.then(() => {
            if (closed) throw new Error('SoapySDR receiver closed');
            return request('read', { id });
          });
          readTail = read.catch(() => {});
          return read;
        },
        async close() {
          if (closed) return;
          closed = true;
          await request('close', { id }).catch((error) => {
            if (error.status !== 404) throw error;
          });
        },
      };
    },
  };
}
