# CapSure design decisions

This document overrides the preliminary architecture in the proposal script.
The requirements are unchanged: 480p15 and 16 kHz audio, a 60-second buffer that
keeps at least 99% of clips, a clip on the phone in under 60 seconds from about
3 meters, under 100 g, at least 2 hours of runtime, playback on the phone, a
light on whenever the device is recording, and contact temperature under 43°C.

Numbers below are planning figures from chip datasheets and the budgets in
`docs/api.md`. Clarence still measures the real board.

---

## 1. Controller — Seeed XIAO ESP32-S3 Sense

**Choice.** One module that already has dual cores, 8 MB of PSRAM, Wi-Fi, a
camera connector, a PDM microphone, and a microSD slot.

**Why it meets the requirements.** A saved minute is about 24 MB, so the link
has to sustain at least 3.2 Mbps to finish inside 60 seconds. The ESP32-S3's
Wi-Fi does that at a few meters (a realistic SoftAP transfer is about 2 MB/s,
or about 12 seconds). The second core serves that transfer while the first
keeps the camera running. Eight megabytes of PSRAM is the shock absorber in
front of the SD card: at 407 KB/s of audio plus video, 4 MB of it is about 10
seconds of slack, which is what keeps a slow card write from dropping frames.
The board is small enough to live on a brim.

**Rejected.**

- **Raspberry Pi Zero 2 W.** Linux can record and mux a normal video file, and
  Wi-Fi throughput is fine. The board plus camera draws several times what this
  hat can afford, runs hot against a forehead, and is heavier. Two hours under
  100 g stops being realistic.
- **A Bluetooth-first chip (nRF5340 or similar).** Better low-energy radio,
  no Wi-Fi. Bluetooth cannot move 24 MB in 60 seconds. See the link section.
- **Original ESP32-CAM.** Same vendor family and a JPEG camera, but a larger
  board, less PSRAM, and no microphone on the module. The XIAO Sense is the
  same approach in the shape we can actually mount.
- **STM32 plus a separate Wi-Fi module.** Two chips to power, clock, and
  debug. Nothing it does is missing from the ESP32-S3.

---

## 2. Camera — OV2640 at 480p, 15 fps, JPEG

**Choice.** The OV2640 already on the Sense board, configured for 480p15. The
sensor outputs JPEG. The ESP32 never touches pixels.

**Why it meets the requirements.** 480p is enough to recognize a face and read
text, which is the quality bar. Fifteen frames a second and a ~25 KB JPEG keep
the stream near 375 KB/s, so a minute fits in 24 MB and the SD card can keep
up. On-sensor JPEG is the reason a small microcontroller can record at all.
Software compression of raw frames would miss 15 fps and blow the power budget.

**Rejected.**

- **OV5640 or a higher resolution.** More detail than the requirement, larger
  frames, more SD bandwidth, more power.
- **A raw sensor, compressed on the ESP32.** The chip cannot JPEG-encode 480p15
  and still write audio and run Wi-Fi.
- **A USB webcam.** Needs a Linux host. That is the Pi path above.

---

## 3. Microphone — onboard PDM, 16 kHz, 16-bit mono

**Choice.** The PDM microphone on the Sense board, read over I2S. 16 kHz mono
is 32 KB/s.

**Why it meets the requirements.** Speech has to be understandable, not
studio quality. 16 kHz mono is enough for that and is a small fraction of the
video rate. It is already on the board, so there is no second module, no extra
analog front end, and no extra weight.

**Rejected.**

- **I2S or analog microphone on a separate board.** Another part to mount and
  power, for quality the requirement does not ask for.
- **8 kHz.** Smaller files, worse speech. Not worth it; audio is already only
  about 8% of the clip.

---

## 4. Storage — PSRAM queue in front of a microSD ring

**Choice.** Video and audio land in a PSRAM queue, then a writer task flushes
2-second segment files onto the microSD card. The card holds a ring of those
segments, a bit more than 60 seconds. A save press marks the segments that make
up the last minute and protects them from being overwritten. It does not copy
them.

**Why it meets the requirements.** The 60-second buffer has to survive a card
that occasionally stalls for hundreds of milliseconds. The PSRAM queue absorbs
that stall so `dropped_frames` stays at zero, which is the 99% requirement.
The SD card is the only memory on the board big enough for a full minute:
8 MB of PSRAM holds about 20 seconds at 407 KB/s, not 60.

**Rejected.**

- **PSRAM only.** Not deep enough for 60 seconds, and it vanishes on power loss.
- **One growing file on the card.** A stall in that file drops frames, and
  saving a minute means copying data at the moment the user presses the button.

---

## 5. Clip file — CAPS1, not MP4

**Choice.** A 32-byte header plus length-prefixed JPEG and PCM packets, each
stamped from one microsecond clock. Specified in `docs/api.md`. The phone draws
the JPEGs on the audio clock.

**Why it meets the requirements.** The device writes the same bytes it already
has from the camera and the microphone. A save is a header plus an index, so
it cannot drop a frame by spending time muxing. Audio/video drift is a
subtraction of the two timestamps, which is the clapperboard test in the
proposal. The phone can play it without a codec.

**Rejected.**

- **MP4 or AVI on the device.** Muxing costs CPU and power we are spending on
  the camera. iOS will not play MJPEG-in-AVI anyway.
- **Transcode on the phone only, after a proprietary dump.** That is what CAPS1
  already is, with timestamps kept so sync is measurable.

---

## 6. Link — Wi-Fi SoftAP, not Bluetooth

**Choice.** The hat hosts `CapSure-XXXX` (WPA2, device at `192.168.4.1`). The
phone joins that network and downloads the clip over HTTP. The recording core
keeps running during the download. A dropped transfer resumes with HTTP Range.

**Why it meets the requirements.** About 2 MB/s finishes a 24 MB clip in about
12 seconds. A bad link at 500 KB/s still finishes in about 48 seconds, inside
the 60-second line, from a few meters, with no router nearby. WPA2 keeps a
bystander from pulling clips off a camera, which matches the ethics requirement
already expressed by the recording light.

**Rejected.**

- **Bluetooth Low Energy.** The ESP32-S3's Bluetooth tops out at a 2 Mbps air
  rate. A phone typically delivers 0.7–1.4 Mbps of file data, so 24 MB takes
  about two minutes or more. An antenna, amplifier, or different Bluetooth chip
  cannot raise that air rate, and the phone will not speak a private faster mode.
- **Classic Bluetooth.** The ESP32-S3 does not have it. Real throughput is still
  short of 3.2 Mbps, and an iPhone will not open a classic serial link without
  Apple's MFi program.
- **Joining the user's home Wi-Fi.** Throughput is fine. There is no router on
  the walk, the court, or the water.
- **Phone hotspot, hat joins the phone.** Also fast, and it works outdoors.
  Someone has to turn the hotspot on and get its password into the hat first.
  That is a harder setup than joining `CapSure-XXXX`.

**Phone side.** The user joins the hat's network themselves. In Expo Go that
means Wi-Fi settings. A later install of our own app can raise the system
"Join network" alert; iOS will not switch Wi-Fi with no confirmation either
way. The app then uses `http://192.168.4.1`. Cellular still works. The hat's
network has no internet and does not need any.

---

## 7. Radio control — a switch, not Bluetooth, not the save button

**Choice.** A latching switch. Wi-Fi is on only while the switch is on. The
save button does not touch the radio. While the switch is on, the access point
runs and the phone can join. While it is off, the radio is powered down.

This replaces the proposal's plan that a save press wakes Wi-Fi for a few
minutes, and it replaces a Bluetooth "doorbell" that would tell the hat to
turn Wi-Fi on.

**Why it meets the requirements.** Two hours and the forehead temperature both
depend on the radio being off while the hat is worn. A save often happens in
the moment; the transfer happens later, when the phone is already out. One
switch makes that split obvious: flip it on, join `CapSure-XXXX`, download,
flip it off. Firmware is a GPIO read. Leaving the switch on will miss the
battery and heat targets — that is the point of a switch the wearer can see
and turn off, not a radio that runs by itself.

**Rejected.**

- **Bluetooth connected during recording, used only as a doorbell.** An idle
  Bluetooth link is cheap next to the camera (a few milliamps if it is only
  checking in a few times a second). The phone is the problem: iOS drops
  background connections, so the app still has to scan and reconnect at the
  moment of transfer. That reconnect is the whole doorbell. Bluetooth also
  needs a custom app build, a second protocol, and it has to go quiet before
  the Wi-Fi transfer because both radios share one antenna. It does not remove
  the Wi-Fi join.
- **Always-on Wi-Fi.** Being merely visible costs on the order of 80–120 mA
  extra, about 200 mAh over two hours, plus roughly 0.3–0.4 W of heat. A
  larger cell can supply the charge (about 8–12 g more) and still fit under
  100 g. It does not remove the heat, and a phone will not stay joined all
  afternoon to a network that has no internet.
- **The save button also starts Wi-Fi.** Couples an in-the-moment capture to
  the radio. If the wearer transfers later, they would need a second press
  anyway. The switch is that second control, and its state is visible.

---

## 8. Save button and recording light

**Choice.** One button, interrupt on GPIO. It marks the last 60 seconds as a
kept clip and nothing else. One LED, on whenever recording is running, wired
so the light tracks the camera rather than the Wi-Fi switch.

**Why it meets the requirements.** The capture action stays a single press.
The light is the ethics requirement: on whenever the device is active,
including when Wi-Fi is off. Tying the light to the switch would hide the
camera during normal wear.

---

## 9. Battery — sized for recording, not for a live radio

**Choice.** One rechargeable cell sized for two hours of camera, microphone,
ESP32, SD card, and LED, plus short Wi-Fi transfers. The worn state is switch
off. A transfer of about 15 seconds is under 1 mAh. The cell is not sized to
hold an access point up for the whole wear.

**Why it meets the requirements.** Recording dominates the budget. Duty-cycling
the radio with the switch is what makes two hours fit a small pack, and what
keeps the extra tenths of a watt off the forehead. Clarence confirms the pack
against measured current, including a run with the switch left on so we know
how fast that failure is.

**Rejected.** A larger pack so Wi-Fi can stay up all session. The grams fit;
the heat requirement and the phone's unwillingness to camp on a no-internet
network do not.

---

## 10. What the wearer actually does

1. Switch off. The hat records the last minute and the light is on.
2. Something happens. One press on the save button. That minute is kept.
3. Phone out. Switch on. Join `CapSure-XXXX`. The app downloads the clip.
4. Switch off. The light is still on, because the camera is still recording.
