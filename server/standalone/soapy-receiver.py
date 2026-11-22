"""Receive-only SoapySDR bridge for the local GEV server."""

import base64
import json
import os
import sys

# Driver diagnostics can go to stdout. Keep the protocol on its own descriptor.
PROTOCOL = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8')
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
try:
    import numpy as np
    import SoapySDR as soapy
except ImportError as error:
    IMPORT_ERROR = str(error)
else:
    IMPORT_ERROR = None

RX = soapy.SOAPY_SDR_RX if IMPORT_ERROR is None else None
SAMPLES = 32768


class Receiver:
    def __init__(self, args):
        self.device = soapy.Device(args)
        self.stream = None
        if not self.device.getNumChannels(RX):
            raise ValueError('The SDR has no receive channel')
        self.default_gain = self.device.getGain(RX, 0)
        self.iq = np.empty(SAMPLES, np.complex64)

    def reset(self):
        if self.stream is not None:
            stream, self.stream = self.stream, None
            try:
                self.device.deactivateStream(stream)
            finally:
                self.device.closeStream(stream)

    def command(self, operation, value):
        if operation == 'rate':
            self.reset()
            self.device.setSampleRate(RX, 0, value)
            return float(self.device.getSampleRate(RX, 0))
        if operation == 'tune':
            ranges = self.device.getFrequencyRange(RX, 0)
            if ranges and not any(r.minimum() <= value <= r.maximum() for r in ranges):
                raise ValueError(f'This SDR cannot tune to {value / 1e6:g} MHz')
            self.reset()
            self.device.setFrequency(RX, 0, value)
            return float(self.device.getFrequency(RX, 0))
        if operation == 'gain':
            auto = self.device.hasGainMode(RX, 0)
            if auto:
                self.device.setGainMode(RX, 0, value is None)
            if not auto or value is not None:
                limits = self.device.getGainRange(RX, 0)
                gain = self.default_gain if value is None else value
                self.device.setGain(RX, 0, min(max(gain, limits.minimum()), limits.maximum()))
            return None
        if operation == 'reset':
            self.reset()
            return None
        if operation == 'read':
            return self.read()
        raise ValueError('Unknown operation')

    def read(self):
        if self.stream is None:
            self.stream = self.device.setupStream(RX, soapy.SOAPY_SDR_CF32, [0])
            if self.device.activateStream(self.stream) != 0:
                raise RuntimeError('Could not activate the SoapySDR receive stream')
        received = 0
        # Native drivers may return partial reads. Bound the number of calls
        # so a receiver supplying short reads or timeouts cannot stall forever.
        for _ in range(128):
            result = self.device.readStream(self.stream, [self.iq[received:]],
                                            SAMPLES - received, timeoutUs=100000)
            if result.ret in (soapy.SOAPY_SDR_TIMEOUT, soapy.SOAPY_SDR_OVERFLOW):
                received = 0
                continue
            if result.ret <= 0:
                raise RuntimeError(f'SoapySDR read failed: {soapy.errToStr(result.ret)}')
            received += result.ret
            if received == SAMPLES:
                # The browser DSP accepts interleaved unsigned 8-bit I/Q.
                iq = np.clip(self.iq.view(np.float32) * 128 + 127.5, 0, 255)
                return base64.b64encode(iq.astype(np.uint8)).decode('ascii')
        raise RuntimeError('SoapySDR did not supply a complete IQ block')


def reply(**payload):
    print(json.dumps(payload, allow_nan=False), file=PROTOCOL, flush=True)


def main():
    receiver = None
    try:
        for line in sys.stdin:
            try:
                command = json.loads(line)
                operation = command['operation']
                value = command.get('value')
                if IMPORT_ERROR is not None:
                    raise RuntimeError(f'Install the SoapySDR Python bindings and NumPy ({IMPORT_ERROR})')
                if operation == 'discover':
                    result = [dict(device) for device in soapy.Device.enumerate(value or '')][:32]
                elif operation == 'open':
                    receiver = Receiver(value)
                    result = None
                else:
                    result = receiver.command(operation, value)
                reply(value=result)
            except Exception as error:
                reply(error=str(error) or type(error).__name__)
    finally:
        if receiver is not None:
            receiver.reset()


if __name__ == '__main__':
    main()
