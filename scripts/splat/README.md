# 3D scans of lighthouses (Gaussian splatting)

The site shows a **3D scan** button on a lighthouse card when `web/data/splats.json` lists one. Scans
are built on a machine with a GPU (the **mi6** laptop), not on the server (a VM with no GPU).

## Which lighthouses can be scanned

A splat needs many overlapping photos of the same tower from around it (30+; more is better, taken in
similar light). The one DGLL photo per station is not enough. Wikimedia Commons has enough for a few:

| Station id | Commons category | Photos (Sept 2026) |
|---|---|---|
| `mahabalipuram-lighthouse` | Mahabalipuram Lighthouse | 73 |
| `chennai-lighthouse` | Chennai Lighthouse | 44 |
| `thangasseripoint-lighthouse` | Tangasseri Lighthouse | 13 + subcategories |

Better still: walk around a public-access lighthouse filming a slow 4K orbit (two heights), extract
~150 frames (`ffmpeg -i orbit.mp4 -vf fps=2 images/%04d.jpg`) and use those instead of Commons photos.
Write your own `attribution.json` (`{"photos":[{"file":"0001.jpg","artist":"…","license":"CC BY 4.0"}]}`).

## Steps (on mi6)

```bash
git clone <this repo> && cd lighthouses            # or rsync ~/projects/lighthouses/scripts from the server
python3 scripts/splat/fetch_views.py mahabalipuram-lighthouse "Mahabalipuram Lighthouse"
scripts/splat/run_on_mi6.sh mahabalipuram-lighthouse
# review in SuperSplat (https://superspl.at/editor): delete floaters and sky, re-export SOG
LH_SERVER=user@server scripts/splat/publish.sh mahabalipuram-lighthouse
```

### OpenSplat on macOS (Apple Silicon, Metal)
```bash
brew install cmake opencv pytorch colmap
git clone https://github.com/pierotofy/OpenSplat && cd OpenSplat && mkdir build && cd build
cmake -DCMAKE_PREFIX_PATH=$(brew --prefix pytorch) -DGPU_RUNTIME=MPS .. && make -j8
sudo cp opensplat /usr/local/bin/
```

### nerfstudio on Linux (NVIDIA, CUDA)
```bash
python3 -m venv ~/ns && . ~/ns/bin/activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
pip install nerfstudio && sudo apt install colmap ffmpeg
```

Expect roughly 20–60 min per lighthouse at 30,000 iterations on a laptop GPU. Commons photos are taken
years apart, in different light and with different lenses; COLMAP may register only part of them.
If fewer than ~25 photos register, the scan will be patchy: prefer a filmed orbit.

## Other methods for stations with a single photo
Image-to-3D models (TRELLIS, Hunyuan3D-2) produce a mesh or splat from one photo. They need a CUDA GPU
with ~16 GB, and they invent the hidden sides, so label such a model an AI reconstruction, not a scan.
The voxel towers (built from each ledger's tower type, height and colours) remain the default.

## Licences
Commons photos are mostly CC BY-SA. A splat built from them is a derivative work: `manifest.py`
publishes the attribution list next to the scan and the viewer links to it. Keep the same licence.
