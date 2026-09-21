# CapSure

18-500 capstone, Team A6 — Jayden, Ankita, Clarence.

A wearable that clips to a hat brim and is always holding the **last 60 seconds**
of what it saw and heard. Press the button and it keeps the minute that just
happened, then sends it to your phone.

This repo is the software half: the phone app, the device-to-phone link, and the
contract between them.

---

## Layout

```
docs/api.md        The device <-> phone HTTP contract. The seam between our halves.
docs/firmware.md   How the ESP32 firmware is set up (Ankita).
app/               The phone app. Expo + TypeScript.
mock-device/       A fake device in Python that speaks the same contract.
firmware/          (Ankita's, when she wants it here)
```

## Getting started

You do not need the hardware. You do not need to wait for the firmware.

```bash
# terminal 1 -- the fake device
cd mock-device
pip install pillow numpy
python3 gen_clips.py
python3 serve.py                       # http://localhost:8080

# terminal 2 -- the app
cd app
npm install
npm start                              # scan the QR with Expo Go
```

In the app, set the device address to your laptop's LAN IP on port 8080
(`ipconfig getifaddr en0`), or `localhost:8080` on a simulator. Connect, and
you have a working gallery of clips.

When the real device exists, the only thing that changes is the address:
`http://192.168.4.1`.

## Checks

```bash
cd app
npm test            # parser, WAV builder, and the client against a running mock
npm run typecheck
```

The test suite includes a cross-check that the TypeScript parser and the Python
writer agree on real bytes. If those two ever disagree, the format has drifted
and the firmware has no stable target.

## How it works

The device's camera compresses to JPEG on the sensor, and the mic produces raw
PCM. Muxing those into a standard container on an ESP32 costs power we do not
have, and iOS will not play MJPEG-in-AVI anyway. So we defined **CAPS1**: a
32-byte header and then length-prefixed packets, each stamped with a
microsecond timestamp from one clock.

That choice pays off three times:

- the firmware writes packets straight from the camera and I2S buffers, with no
  transcoding
- a button press is a flag and a 200-byte index file, not a copy, so it cannot
  drop a frame
- the app plays it by drawing JPEGs on the audio player's clock, so A/V sync is
  a lookup rather than a guess — and the drift is a number we can measure

Full format in [`docs/api.md`](docs/api.md).

## Who owns what

| | |
|---|---|
| Jayden | phone app, device-to-phone transfer, this repo |
| Ankita | device firmware — camera, mic, timestamping, ring buffer ([`docs/firmware.md`](docs/firmware.md)) |
| Clarence | hardware — battery, power, wiring, 3D-printed mount |

The seam is `docs/api.md`. Changes to it are a PR both Jayden and Ankita approve.
