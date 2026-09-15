// 3D scan viewer. A lighthouse scanned as a Gaussian splat (many photos → COLMAP → splat training, see
// scripts/splat/README.md) opens in the pop-up viewer: drag to orbit, scroll or pinch to zoom, right-drag
// to pan. Spark (World Labs, MIT) renders the splat inside three.js and is only downloaded when a scan
// is opened (2.7 MB). Scans are listed in data/splats.json; stations without one show no button.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { openViewer } from './viewer.js?v=2';

export function openSplat(station, scan, name = station.name) {
  return openViewer({
    title: `${name} · 3D scan`,
    subtitle: `Gaussian splat from ${scan.photos} photo${scan.photos === 1 ? '' : 's'}${scan.built ? ` · built ${scan.built}` : ''}`,
    credit: `Reconstructed from photos by ${scan.authors} (${scan.licenses}). <a href="${scan.attribution}" target="_blank" rel="noopener">Every photo and licence</a>. Drag to orbit, scroll or pinch to zoom.`,
    mount(stage, say) {
      let stopped = false, renderer = null, observer = null;
      say('Loading the 3D scan…');
      (async () => {
        const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
        if (stopped) return;
        renderer = new THREE.WebGLRenderer({ antialias: false });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        stage.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#05070c');
        const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
        camera.position.set(...(scan.camera || [0, 1.2, 6]));
        scene.add(new SparkRenderer({ renderer }));
        const mesh = new SplatMesh({ url: scan.url });
        // COLMAP-based reconstructions are y-down; a per-scan view.json can override the orientation
        if (scan.quaternion) mesh.quaternion.set(...scan.quaternion); else mesh.quaternion.set(1, 0, 0, 0);
        scene.add(mesh);
        Promise.resolve(mesh.initialized).then(() => say(''), () => say('The 3D scan could not be loaded.'));
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(...(scan.target || [0, 0, 0]));
        controls.enableDamping = true;
        controls.update();
        const size = () => {
          const r = stage.getBoundingClientRect();
          renderer.setSize(Math.max(1, r.width - 6), Math.max(1, r.height - 6), false);
          camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
          camera.updateProjectionMatrix();
        };
        observer = new ResizeObserver(size);
        observer.observe(stage);
        size();
        renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
      })().catch(() => say('This browser could not open the 3D scan.'));
      return () => {
        stopped = true;
        observer?.disconnect();
        if (renderer) { renderer.setAnimationLoop(null); renderer.dispose(); }
      };
    },
  });
}
