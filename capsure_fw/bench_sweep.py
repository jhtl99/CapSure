#!/usr/bin/env python3
"""Wi-Fi throughput sweep for capsure_fw.

First, with no Wi-Fi involved:
  sd-read    the hat reads N MB of a clip off SD and sends nothing
Then, for each channel x bandwidth, the hat moves its AP there, the Mac
rejoins, and it downloads N MB (default 8) four ways:
  httpd-sd   :80/api/clips/{id} with Range   real clip bytes, esp_http_server
  web-sd     :8080/clip?id=..&mb=N           same bytes, Arduino WebServer
  httpd-ram  :80/bench/ram?mb=N              no SD, esp_http_server
  web-ram    :8080/ram?mb=N                  no SD, Arduino WebServer
After each one it asks the hat where the time went (/admin/last): reading the
SD card vs waiting on the socket, plus any frames the recorder dropped.

Usage (only the Mac on CapSure-1234 -- disconnect your phone):
  python3 bench_sweep.py
  python3 bench_sweep.py --channels 1,6,11 --bw 20 --runs 3 --mb 8 --iface en0
Results: table below, every run in bench_results.csv next to this file.
"""
import argparse, csv, json, os, statistics, subprocess, sys, time, urllib.request

HOST = "192.168.4.1"
SSID, PASSWORD = "CapSure-1234", "capsure123"
MB = 1024 * 1024


def get(path, port=80, method="GET", timeout=5):
    req = urllib.request.Request(f"http://{HOST}:{port}{path}", method=method,
                                 data=b"" if method == "POST" else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def try_get(path, **kw):
    try:
        return get(path, **kw)
    except Exception:
        return None


def rejoin(iface, timeout=60):
    t0, last_nudge = time.time(), 0
    while time.time() - t0 < timeout:
        if try_get("/api/status", timeout=2):
            return time.time() - t0
        if time.time() - last_nudge > 8:
            subprocess.run(["networksetup", "-setairportnetwork", iface, SSID, PASSWORD],
                           capture_output=True)
            last_nudge = time.time()
        time.sleep(1)
    return None


def curl(url, max_time, headers=()):
    cmd = ["curl", "-s", "-o", "/dev/null", "--max-time", str(max_time),
           "-w", "%{http_code} %{size_download} %{time_total}"]
    for h in headers:
        cmd += ["-H", h]
    out = subprocess.run(cmd + [url], capture_output=True, text=True).stdout.split()
    if len(out) != 3:
        return 0, 0, 0.0
    return int(out[0]), int(float(out[1])), float(out[2])


def split(last):
    """'SD 40% / send 58%' from the hat's own timing of the transfer."""
    if not last or not last.get("total_ms"):
        return "", None, None
    tot = last["total_ms"]
    sd, send = 100 * last["sd_ms"] / tot, 100 * last["send_ms"] / tot
    txt = f"SD {sd:3.0f}% / send {send:3.0f}%  (worst send chunk {last['max_send_ms']:.0f} ms"
    if last["sd_ms"]:
        txt += f", worst SD chunk {last['max_sd_ms']:.0f} ms"
    return txt + ")", sd, send


def ensure_clip(mb):
    st = get("/api/status")
    if st["uptime_s"] < 65:
        wait = 65 - st["uptime_s"]
        print(f"hat has only been recording {st['uptime_s']} s; waiting {wait} s for a full buffer")
        time.sleep(wait)
    print("listing clips (first listing after a flash may take a minute)...")
    clips = get("/api/clips", timeout=180)["clips"]
    # prefer a clip recorded at the current frame cap, so its size is representative
    fresh = [c for c in clips if 20 <= c["fps"] <= 28 and c["duration_ms"] > 50000]
    if not fresh:
        print("no 24 fps clip yet; saving one on the hat...")
        get("/admin/save", method="POST")
        time.sleep(5)
        clips = get("/api/clips", timeout=180)["clips"]
        fresh = [c for c in clips if c["bytes"] >= mb * MB] or clips
    if not fresh:
        sys.exit("hat has no clips; press the button or send 's' on serial and retry")
    c = fresh[0]
    print(f"using clip {c['id']}: {c['bytes'] / 1e6:.1f} MB, {c['duration_ms'] / 1000:.1f} s, {c['fps']} fps")
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channels", default="1,6,11")
    ap.add_argument("--bw", default="20", help="channel widths in MHz: 20, 40, or 20,40")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--mb", type=int, default=8, help="MB per download")
    ap.add_argument("--iface", default="en0", help="Mac Wi-Fi port (networksetup -listallhardwareports)")
    ap.add_argument("--tests", default="httpd-sd,httpd-ram", help="add web-sd,web-ram only with ENABLE_WEB8080 1")
    a = ap.parse_args()

    if not try_get("/api/status"):
        sys.exit(f"can't reach {HOST}; join {SSID} first")
    clip = ensure_clip(a.mb)
    n = min(a.mb * MB, clip["bytes"])
    cid = clip["id"]

    print(f"\n=== SD read only ({n / 1e6:.1f} MB, nothing sent) ===")
    sd_only = []
    for r in range(a.runs):
        x = try_get(f"/bench/sd?id={int(cid)}&mb={a.mb}", timeout=120)
        if x and x["total_ms"]:
            rate = x["bytes"] / 1e6 / (x["total_ms"] / 1000)
            sd_only.append(rate)
            print(f"  run {r + 1}: {rate:5.2f} MB/s  (worst chunk {x['max_sd_ms']:.0f} ms, dropped +{x['dropped']})")
        else:
            print(f"  run {r + 1}: failed")

    tests = {
        "httpd-sd": (f"http://{HOST}/api/clips/{cid}", [f"Range: bytes=0-{n - 1}"], n),
        "web-sd": (f"http://{HOST}:8080/clip?id={int(cid)}&mb={a.mb}", [], n),
        "httpd-ram": (f"http://{HOST}/bench/ram?mb={a.mb}", [], a.mb * MB),
        "web-ram": (f"http://{HOST}:8080/ram?mb={a.mb}", [], a.mb * MB),
    }
    names = [t for t in a.tests.split(",") if t in tests]

    rows = []
    for ch in [int(x) for x in a.channels.split(",")]:
        for bw in [int(x) for x in a.bw.split(",")]:
            print(f"\n=== channel {ch}, {bw} MHz ===")
            try_get(f"/admin/radio?ch={ch}&bw={bw}", method="POST")
            time.sleep(3)
            took = rejoin(a.iface)
            if took is None:
                print("  hat did not come back; skipping")
                continue
            radio = try_get("/admin/radio") or {}
            rssi = [s["rssi"] for s in radio.get("stations", [])]
            got_bw = radio.get("bw")
            warn = "  <-- other devices are sharing the air; disconnect them" if len(rssi) > 1 else ""
            print(f"  rejoined in {took:.0f} s; hat on ch {radio.get('channel')} / {got_bw} MHz, "
                  f"{len(rssi)} station(s), RSSI {rssi} dBm{warn}")
            for t in names:
                url, hdrs, expect = tests[t]
                for r in range(a.runs):
                    code, size, secs = curl(url, max_time=120, headers=hdrs)
                    last = try_get("/admin/last")
                    txt, sd_pct, send_pct = split(last)
                    mbps = size / 1e6 / secs if secs else 0
                    ok = code in (200, 206) and size == expect
                    drop = (last or {}).get("dropped", 0)
                    print(f"  {t:9s} run {r + 1}: {mbps:5.2f} MB/s  {txt}"
                          f"{'' if ok else f'  !! HTTP {code}, got {size} of {expect} bytes'}"
                          f"{f'  !! recorder dropped {drop} frames' if drop else ''}")
                    rows.append(dict(channel=ch, bw_asked=bw, bw_got=got_bw, stations=len(rssi),
                                     rssi=rssi[0] if rssi else "", test=t, run=r + 1,
                                     mb_per_s=round(mbps, 3), bytes=size, seconds=round(secs, 2),
                                     sd_pct=round(sd_pct, 1) if sd_pct is not None else "",
                                     send_pct=round(send_pct, 1) if send_pct is not None else "",
                                     ok=ok, dropped=drop))

    if not rows:
        sys.exit("no results")
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bench_results.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader(); w.writerows(rows)

    print(f"\nmedian MB/s ({a.mb} MB downloads, complete runs only)")
    print(f"{'config':14s}" + "".join(f"{t:>11s}" for t in names) + "   httpd-sd time on SD")
    for ch, bw, got in sorted({(r["channel"], r["bw_asked"], r["bw_got"]) for r in rows}):
        label = f"ch {ch} / {bw}" + ("" if got in (bw, None) else f"->{got}")
        cells, sdp = [], []
        for t in names:
            mine = [r for r in rows if (r["channel"], r["bw_asked"], r["test"]) == (ch, bw, t) and r["ok"]]
            cells.append(f"{statistics.median([r['mb_per_s'] for r in mine]):11.2f}" if mine else f"{'fail':>11s}")
            if t == "httpd-sd":
                sdp = [r["sd_pct"] for r in mine if r["sd_pct"] != ""]
        print(f"{label:14s}" + "".join(cells) + (f"   {statistics.median(sdp):.0f}%" if sdp else ""))

    if sd_only:
        print(f"\nSD read alone: {statistics.median(sd_only):.2f} MB/s median")
    drops = sum(r["dropped"] for r in rows)
    print(f"frames dropped by the recorder during transfers: {drops}"
          f"{'  (recording kept up)' if not drops else '  <-- transfers are starving the recorder'}")
    best = max([r["mb_per_s"] for r in rows if r["test"] == "httpd-sd" and r["ok"]] or [0])
    if best:
        est = clip["bytes"] * 24 / max(clip["fps"], 1) * 60000 / max(clip["duration_ms"], 1)
        print(f"a 60 s clip at 24 fps is ~{est / 1e6:.0f} MB -> {est / 1e6 / best:.0f} s at the best httpd-sd run "
              f"({best:.2f} MB/s)")
    print(f"saved {path}")


if __name__ == "__main__":
    main()
