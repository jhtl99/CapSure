# Mock CapSure device

A stand-in for the ESP32 that speaks [`docs/api.md`](../docs/api.md) exactly.

It exists so the app can be built and tested before the firmware works, and so
the firmware has a known-good reference to be diffed against. No dependencies
beyond `pillow` and `numpy`, and those are only needed to *generate* clips.

## Quick start

```bash
pip install pillow numpy          # one time
python3 gen_clips.py              # 3 clips x 10 s
python3 serve.py                  # http://localhost:8080
```

Then point the app at `http://localhost:8080` (simulator) or
`http://<your-laptop-ip>:8080` (a real phone on the same Wi-Fi).

## Files

| File | What it is |
|---|---|
| `capsfile.py` | The **normative** CAPS1 reader/writer. Must match `app/src/device/clip.ts`. |
| `gen_clips.py` | Makes fake clips with a clapper flash + beep for sync testing. |
| `serve.py` | The HTTP server. Implements every endpoint in `docs/api.md`. |
| `validate.py` | Checks a `.cap` file and reports A/V drift. Run it on real device output. |

## Simulating a bad day

The point of a mock is not to be perfect — it is to be worse than reality on
demand, so the app's error handling is exercised before the demo.

```bash
python3 serve.py --throttle 2000        # 2 MB/s, roughly real ESP32 Wi-Fi
python3 serve.py --fail-after 3000000   # drop the socket mid-clip (tests resume)
python3 serve.py --offline-after 30     # stop answering, as if the AP timed out
python3 serve.py --unhealthy            # report dropped frames
```

## A realistic clip

The default 10-second clips keep iteration fast. For a real one:

```bash
python3 gen_clips.py --count 1 --duration 60
# ~28 MB, which is what a real 60 s press produces
```

## Checking device output

As soon as the firmware writes its first segment:

```bash
curl -s http://192.168.4.1/api/clips/0042 -o /tmp/0042.cap
python3 validate.py /tmp/0042.cap
```

`validate.py` walks every packet, checks JPEG markers and PCM alignment,
confirms `pts_us` is monotonic, and reports measured fps, measured audio rate,
and A/V drift across the clip.
