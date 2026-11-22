# Local receivers

The Local ADS-B layer draws aircraft heard by your own receivers. It has two
inputs, and it can use both at once.

| Input        | What it is                                                                                                                            | Bands                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Local SDR    | The Radio panel uses WebUSB for supported RTL-SDR devices and the local SoapySDR bridge for other devices. Decoding runs in the page. | 1090 MHz              |
| Decoder feed | The `aircraft.json` served by a decoder you run: dump1090-fa, readsb or tar1090 (1090 MHz), or dump978-fa + skyaware978 (978 MHz).    | 1090 MHz, 978 MHz UAT |

Aircraft from both inputs are merged by ICAO address. The newest position
wins, and the click card names every band and source that heard the aircraft
in the last 60 s. Aircraft heard only on 978 MHz UAT draw with a thin ring.

Local aircraft usually lead their public twins. The public Flights layer
renders positions about one poll interval (~30 s) behind so it can interpolate
smoothly between fixes, while local receiver aircraft are shown as heard. An
aircraft in both layers therefore draws twice, the magenta local marker ahead
of the public one; both markers are drawn on purpose.

## Which to use

- **One plain RTL-SDR dongle, desktop Chrome or Edge:** use the browser SDR.
  Nothing else to install.
- **A receiver with a SoapySDR driver:** run GEV and the driver on the same
  machine and select the receiver under **Radio → Local SDR**.
- **A dual-band board, a Raspberry Pi feeder, or a dongle already used by a
  decoder:** use a decoder feed. A USB dongle can be opened by only one program
  at a time, so a dongle that dump1090 or dump978 owns cannot also be opened by
  the browser.

## SoapySDR receivers

Install SoapySDR, the matching driver, and the SoapySDR Python bindings and
NumPy in the Python environment used by the GEV server. `SoapySDRUtil --find`
shows the devices the local drivers can discover. Set `GEV_SOAPY_PYTHON` in
`.env` if the bindings live in a different Python installation. For drivers that
need discovery arguments, `GEV_SOAPY_DEVICE` passes an optional driver argument
string to discovery. Restart the server after changing these settings.

Open the local GEV address and go to **Radio → Local SDR**. Use **Scan Devices**
after plugging in or starting a receiver. **Auto** prefers an already authorized
WebUSB RTL-SDR on supporting browsers, then the first SoapySDR device found. For
a new RTL-SDR use **RTL-SDR · WebUSB** to open the browser picker. Choose a listed
SoapySDR device to connect to a specific receiver.

Select **FM** or **ADS-B · 1090** before connecting. The receiver needs to cover
the frequency and provide the sample rate for that mode. FM requests 2.048 MS/s.
The browser ADS-B decoder uses 2 MS/s. The bridge opens the first RX channel and
delivers unsigned 8-bit I/Q to the same decoder as the WebUSB path. The current
Radio card operates one local tuner at a time and uses its existing gain presets.
The SoapySDR service runs through the local GEV server, including Vite preview.
It needs access to the hardware and native drivers in that server's environment.

## Configuring feeds

Feeds are set in the server environment only (`.env`), never in the browser:

```sh
LOCAL_RECEIVER_FEEDS=1090=http://localhost:8080/data/aircraft.json,978=http://localhost:8978/data/aircraft.json
```

Each entry is `band=url`, where `band` is `1090` or `978`. The URL must:

- use `http` or `https`;
- point at loopback, a private (RFC1918) address, `localhost` or a `*.local`
  name. Public addresses, link-local addresses (including `169.254.169.254`),
  IPv6 and other host names are refused;
- have a path ending in `aircraft.json`, with no credentials, query or
  fragment.

An entry that breaks a rule is logged when the server starts, shown as
`invalid` and never fetched. Restart the server after changing the value.

The server reads every feed about once a second while the Local ADS-B layer is
on. A feed is `live`, `stale` (its own `now` is more than 10 s old, usually a
stopped decoder), `unreachable` or `invalid`. The Layers panel row and the
Local RTL-SDR card show these states.

## Example: dump1090-fa and dump978-fa on macOS or Linux

Write each decoder's JSON to a directory, then serve the directory on
localhost. Each command keeps running, so start each in its own terminal:

```sh
# 1090 MHz
dump1090-fa --device-index 0 --write-json /tmp/adsb1090
python3 -m http.server 8080 --bind 127.0.0.1 --directory /tmp/adsb1090

# 978 MHz UAT: dump978-fa decodes, skyaware978 writes aircraft.json
dump978-fa --sdr driver=rtlsdr,rtl=1 --raw-port 30978
skyaware978 --connect localhost:30978 --json-dir /tmp/adsb978
python3 -m http.server 8978 --bind 127.0.0.1 --directory /tmp/adsb978
```

```sh
LOCAL_RECEIVER_FEEDS=1090=http://localhost:8080/aircraft.json,978=http://localhost:8978/aircraft.json
```

A board with two identical-serial channels, such as the Nooelec FlyCatcher,
cannot be told apart by serial number. Select each channel by index:
`--device-index <n>` for dump1090-fa and `--sdr driver=rtlsdr,rtl=<n>` for
dump978-fa. `rtl_test` lists the indexes.

A tar1090 or readsb install on a Raspberry Pi already serves
`http://<pi-address>/tar1090/data/aircraft.json`. Use the Pi's private address
or its `.local` name.
