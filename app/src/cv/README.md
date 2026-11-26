# Shot analysis

Workspace for the planned Analyze action on saved CapSure clips and a top-down
pool shot replay.

## Layout

```text
cv/
  sample-videos/         Local recordings for evaluating shot visibility
  tools/
    inspect_video.py    Desktop helper that reads frames and reports their count
    requirements.txt    Dependencies for the desktop helper
```

Copy sample recordings into `app/src/cv/sample-videos/`. This folder's contents
are ignored by Git, except for the empty placeholder file. Generated analysis
artifacts can go in `outputs/`, which is also ignored.

## Manual analysis in the app

Open a downloaded clip and tap Analyze. Choose a frame by its time in seconds.
Movie clips use expo-video frame extraction on iOS and Android. CAPS clips reuse
the player's unpacked JPEG frames.

Place four landmarks and enter their known overhead coordinates in percent.
The default positions are the table's four corners in clockwise order from
top-left. For cropped footage, use visible landmarks with known positions on
the playing surface. Four arbitrary points require known table coordinates to
produce a meaningful reconstruction. Avoid three collinear landmarks.

Switch to Mark balls and tap the cloth contact point under each visible ball.
Show overhead view maps those marks onto a 2-to-1 table. Save analysis stores
the selected timestamp, calibration, and ball marks on the phone. Opening
Analyze again restores the saved marks. Choosing a new frame clears the current
marks because the camera may have moved.

This version creates a manually marked snapshot. Automated detection, motion
tracking, and animated replay are future work. Sample videos in this repository
folder are local development inputs. They are not automatically imported into
the phone's gallery.

`AnalysisScreen.tsx` manages the workflow, `CalibrationView.tsx` handles image
marks, and `OverheadView.tsx` draws the table. `geometry.ts` implements the
perspective mapping, `types.ts` defines saved data, and `storage.ts` persists it.

## Optional desktop inspection

The Python helper supports local experimentation. App integration will use the
React Native app's runtime and saved clips.

From the repository root, with Python 3 installed:

```powershell
py -3 -m venv app/src/cv/.venv
app/src/cv/.venv/Scripts/python.exe -m pip install -r app/src/cv/tools/requirements.txt
app/src/cv/.venv/Scripts/python.exe app/src/cv/tools/inspect_video.py "app/src/cv/sample-videos/shot.mp4"
```
