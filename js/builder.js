// Car Builder workshop — Three.js 3D scene with block placement and transform gizmos.
import * as THREE from 'three';

const MATS = [
  { id: 'body',   label: 'BODY',   color: 0x1a4fa8, rough: 0.30, metal: 0.05 },
  { id: 'carbon', label: 'CARBON', color: 0x1a1a1a, rough: 0.20, metal: 0.40 },
  { id: 'glass',  label: 'GLASS',  color: 0x88ccff, rough: 0.05, metal: 0.10, opacity: 0.32 },
  { id: 'chrome', label: 'CHROME', color: 0xd0d0d0, rough: 0.04, metal: 1.00 },
  { id: 'rubber', label: 'RUBBER', color: 0x111111, rough: 0.90, metal: 0.00 },
  { id: 'red',    label: 'RED',    color: 0xcc1400, rough: 0.30, metal: 0.10 },
  { id: 'delete', label: 'DELETE', color: null },
];

const GRID = 0.125; // world-unit snap grid

export class CarBuilder {
  constructor() {
    this._blocks = [];
    this._selected = null;
    this._selWire = null;
    this._handles = [];
    this._mode = 'select';
    this._pendingMat = null;
    this._deleteMode = false;
    this._dragHandle = null;
    this._dragStartMouse = null;
    this._dragStartPos = null;
    this._dragStartSize = null;
    this._orbitActive = false;
    this._orbitLast = null;
    this._orbitTheta = 0.7;
    this._orbitPhi = 0.46;
    this._orbitR = 6.5;
    this._longPressTimer = null;
    this._baseMeshes = [];
    this.onDestroy = null;
    this._running = false;

    this._build();
  }

  _build() {
    // ---- DOM
    this._el = document.createElement('div');
    this._el.id = 'builder';
    this._el.innerHTML = `
      <div id="bl-top">
        <button id="bl-back">&#8592; BACK</button>
        <span id="bl-title">MAKE YOUR CAR</span>
        <button id="bl-save">SAVE</button>
      </div>
      <div id="bl-hint">Select a material below, then tap the floor to place a block.</div>
      <canvas id="bl-canvas"></canvas>
      <div id="bl-bar">
        ${MATS.map(m => {
          const bg = m.color ? `#${m.color.toString(16).padStart(6,'0')}` : '#8b0000';
          return `<button class="bl-mat" data-mat="${m.id}" style="background:${bg}">${m.label}</button>`;
        }).join('')}
      </div>`;
    document.body.appendChild(this._el);

    // ---- Three.js renderer
    const canvas = this._el.querySelector('#bl-canvas');
    this._canvas = canvas;
    this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this._renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFShadowMap;

    // ---- Scene
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x0c1320);
    this._scene.fog = new THREE.Fog(0x0c1320, 12, 24);

    // ---- Camera
    this._camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);
    this._updateCamera();

    // ---- Lights
    this._scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(4, 8, 5);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 0.5;
    dir.shadow.camera.far = 30;
    dir.shadow.camera.left = dir.shadow.camera.bottom = -6;
    dir.shadow.camera.right = dir.shadow.camera.top = 6;
    this._scene.add(dir);
    const fill = new THREE.DirectionalLight(0x8090b0, 0.35);
    fill.position.set(-3, 3, -4);
    this._scene.add(fill);

    // ---- Grid floor
    this._scene.add(new THREE.GridHelper(12, 24, 0x1e2e3e, 0x141e28));
    const fMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ color: 0x090e16, roughness: 1, metalness: 0 })
    );
    fMesh.rotation.x = -Math.PI / 2;
    fMesh.position.y = -0.001;
    fMesh.receiveShadow = true;
    fMesh.userData.floor = true;
    this._floor = fMesh;
    this._scene.add(fMesh);

    // ---- Build cockpit base
    this._buildBase();

    // ---- Raycaster
    this._ray = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // ---- Events
    this._bindEvents();

    // ---- Load saved blocks
    this._load();

    // ---- Resize observer
    this._resizeObs = new ResizeObserver(() => this._resize());
    this._resizeObs.observe(canvas);
    this._resize();

    // ---- Start render loop
    this._running = true;
    this._animate();
  }

  _buildBase() {
    const dark = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8, metalness: 0.25 });
    const panel = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7, metalness: 0.2 });
    const carpet = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 0.95, metalness: 0 });

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.base = true;
      this._scene.add(m);
      this._baseMeshes.push(m);
      return m;
    };

    // Floor plate
    add(new THREE.BoxGeometry(1.72, 0.05, 4.3), carpet, 0, 0.025, 0);
    // Left sill
    add(new THREE.BoxGeometry(0.06, 0.18, 4.3), dark, -0.89, 0.115, 0);
    // Right sill
    add(new THREE.BoxGeometry(0.06, 0.18, 4.3), dark, 0.89, 0.115, 0);

    // Dashboard
    add(new THREE.BoxGeometry(1.6, 0.14, 0.32), dark, 0, 0.57, -1.42);
    // Lower dash trim
    add(new THREE.BoxGeometry(1.6, 0.06, 0.22), panel, 0, 0.47, -1.30);
    // Center console
    add(new THREE.BoxGeometry(0.22, 0.16, 0.85), dark, 0, 0.13, -0.68);

    // Steering column
    add(new THREE.CylinderGeometry(0.024, 0.024, 0.42, 8), dark, 0, 0.35, -1.24, Math.PI * 0.18);
    // Steering wheel rim
    const swRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.175, 0.017, 8, 28),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.55, metalness: 0.1 })
    );
    swRim.position.set(0, 0.60, -1.50);
    swRim.rotation.x = Math.PI * 0.24;
    swRim.userData.base = true;
    this._scene.add(swRim);
    this._baseMeshes.push(swRim);
    // Steering wheel spokes
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Mesh(
        new THREE.BoxGeometry(0.025, 0.14, 0.017),
        new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 })
      );
      sp.position.set(0, 0.60, -1.50);
      sp.rotation.x = Math.PI * 0.24;
      sp.rotation.z = (i / 3) * Math.PI * 2;
      sp.userData.base = true;
      this._scene.add(sp);
      this._baseMeshes.push(sp);
    }

    // Seat cushion
    add(new THREE.BoxGeometry(0.58, 0.07, 0.55), carpet, 0, 0.185, 0.24);
    // Seat back
    add(new THREE.BoxGeometry(0.58, 0.68, 0.07), dark, 0, 0.54, -0.06);
    // Seat shoulder bolsters
    add(new THREE.BoxGeometry(0.58, 0.14, 0.06), dark, 0, 0.88, -0.04);
  }

  _makeMat(matId) {
    const spec = MATS.find(m => m.id === matId) || MATS[0];
    const opts = { color: spec.color, roughness: spec.rough, metalness: spec.metal };
    if (spec.opacity != null) { opts.transparent = true; opts.opacity = spec.opacity; }
    return new THREE.MeshStandardMaterial(opts);
  }

  _addBlock(matId, pos) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), this._makeMat(matId));
    mesh.position.copy(pos);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.block = true;
    this._scene.add(mesh);
    const block = { mesh, matId, size: [0.5, 0.5, 0.5], pos: pos.clone() };
    this._blocks.push(block);
    return block;
  }

  _deselect() {
    if (this._selWire) { this._selWire.parent?.remove(this._selWire); this._selWire = null; }
    this._clearHandles();
    this._selected = null;
  }

  _select(block) {
    this._deselect();
    this._selected = block;
    // blue wireframe outline
    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(block.mesh.geometry),
      new THREE.LineBasicMaterial({ color: 0x4488ff })
    );
    block.mesh.add(wire);
    this._selWire = wire;
    this._showScaleHandles(block);
    this._hint('Drag colored handles to scale. Long-press to switch to move mode.');
  }

  _showScaleHandles(block) {
    this._clearHandles();
    const defs = [
      { a: 0, d: +1, c: 0xff3322 }, { a: 0, d: -1, c: 0xff3322 },
      { a: 1, d: +1, c: 0x44cc44 }, { a: 1, d: -1, c: 0x44cc44 },
      { a: 2, d: +1, c: 0x3388ff }, { a: 2, d: -1, c: 0x3388ff },
    ];
    const hGeo = new THREE.SphereGeometry(0.068, 8, 8);
    for (const { a, d, c } of defs) {
      const h = new THREE.Mesh(hGeo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.15, metalness: 0.6 }));
      const off = [0, 0, 0]; off[a] = 0.25 * d;
      h.position.set(...off);
      h.userData.handle = true; h.userData.axis = a; h.userData.dir = d; h.userData.mode = 'scale';
      block.mesh.add(h);
      this._handles.push(h);
    }
  }

  _showMoveHandles(block) {
    this._clearHandles();
    const defs = [
      { a: 0, d: +1 }, { a: 0, d: -1 },
      { a: 1, d: +1 }, { a: 1, d: -1 },
      { a: 2, d: +1 }, { a: 2, d: -1 },
    ];
    const hGeo = new THREE.SphereGeometry(0.075, 8, 8);
    for (const { a, d } of defs) {
      const h = new THREE.Mesh(hGeo, new THREE.MeshStandardMaterial({ color: 0x44aaff, roughness: 0.15, metalness: 0.5 }));
      const off = [0, 0, 0]; off[a] = 0.25 * d;
      h.position.set(...off);
      h.userData.handle = true; h.userData.axis = a; h.userData.dir = d; h.userData.mode = 'move';
      block.mesh.add(h);
      this._handles.push(h);
    }
    if (this._selWire) this._selWire.material.color.set(0x44ddff);
    this._hint('Drag handles to reposition. Tap block again to return to scale mode.');
  }

  _clearHandles() {
    for (const h of this._handles) h.parent?.remove(h);
    this._handles = [];
  }

  _hint(msg) {
    const el = this._el.querySelector('#bl-hint');
    if (el) el.textContent = msg;
  }

  // Project a world-space unit vector onto normalised screen space (NDC) for drag sensitivity
  _projAxis(worldPos, dir) {
    const c = this._camera;
    const from = worldPos.clone().project(c);
    const to = worldPos.clone().addScaledVector(dir, 1.0).project(c);
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  _raycast(e) {
    const r = this._canvas.getBoundingClientRect();
    this._mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this._mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this._ray.setFromCamera(this._mouse, this._camera);
    return this._ray;
  }

  _pd(e) {
    e.preventDefault();
    const ray = this._raycast(e);

    // ---- handles first
    if (this._handles.length) {
      const hHits = ray.intersectObjects(this._handles, false);
      if (hHits.length) {
        this._dragHandle = hHits[0].object;
        this._dragStartMouse = { x: e.clientX, y: e.clientY };
        this._dragStartPos = this._selected.pos.clone();
        this._dragStartSize = [...this._selected.size];
        return;
      }
    }

    // ---- placed blocks
    const blockMeshes = this._blocks.map(b => b.mesh);
    const bHits = ray.intersectObjects(blockMeshes, false);
    if (bHits.length) {
      const hit = bHits[0].object;
      const block = this._blocks.find(b => b.mesh === hit);
      if (!block) return;

      if (this._deleteMode) { this._deleteBlock(block); return; }
      if (this._mode === 'place') {
        // cancel place mode and just select
        this._exitPlaceMode();
      }

      if (this._selected === block) {
        // tap same block → toggle between scale and move modes
        const isScale = this._handles.length > 0 && this._handles[0].userData.mode === 'scale';
        if (isScale) this._showMoveHandles(block); else this._showScaleHandles(block);
      } else {
        this._select(block);
      }

      // long-press → switch to move handles
      clearTimeout(this._longPressTimer);
      this._longPressTimer = setTimeout(() => {
        if (this._selected === block) this._showMoveHandles(block);
      }, 480);
      return;
    }

    // ---- place on surface (floor or base)
    if (this._mode === 'place' && this._pendingMat) {
      const planeHits = ray.intersectObjects([this._floor, ...this._baseMeshes, ...blockMeshes], false);
      if (planeHits.length) {
        const pt = planeHits[0].point.clone();
        pt.x = Math.round(pt.x / GRID) * GRID;
        pt.z = Math.round(pt.z / GRID) * GRID;
        pt.y += 0.25;
        const block = this._addBlock(this._pendingMat, pt);
        this._select(block);
        this._exitPlaceMode();
        return;
      }
    }

    // ---- orbit drag
    clearTimeout(this._longPressTimer);
    if (this._mode !== 'delete') this._deselect();
    this._orbitActive = true;
    this._orbitLast = { x: e.clientX, y: e.clientY };
  }

  _pm(e) {
    if (this._dragHandle) {
      clearTimeout(this._longPressTimer);
      const block = this._selected;
      if (!block) return;

      const rect = this._canvas.getBoundingClientRect();
      const dxScreen = (e.clientX - this._dragStartMouse.x) / rect.width * 2;
      const dyScreen = -(e.clientY - this._dragStartMouse.y) / rect.height * 2;

      const hAxis = this._dragHandle.userData.axis;
      const hDir  = this._dragHandle.userData.dir;
      const hMode = this._dragHandle.userData.mode;

      const AXES = [new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1)];
      const worldDir = AXES[hAxis].clone().multiplyScalar(hDir);
      const blockW = block.mesh.getWorldPosition(new THREE.Vector3());
      const proj = this._projAxis(blockW, worldDir);
      const scalar = dxScreen * proj.x + dyScreen * proj.y;

      if (hMode === 'scale') {
        const ns = [...this._dragStartSize];
        ns[hAxis] = Math.max(0.12, this._dragStartSize[hAxis] + scalar * 3.5);
        block.size = ns;
        block.mesh.scale.set(ns[0] / 0.5, ns[1] / 0.5, ns[2] / 0.5);
      } else {
        const np = this._dragStartPos.clone();
        const mv = scalar * 5.0 * hDir;
        if (hAxis === 0) np.x += mv;
        else if (hAxis === 1) np.y += mv;
        else np.z += mv;
        np.x = Math.round(np.x / GRID) * GRID;
        np.y = Math.max(0.06, Math.round(np.y / GRID) * GRID);
        np.z = Math.round(np.z / GRID) * GRID;
        block.pos.copy(np);
        block.mesh.position.copy(np);
      }
      return;
    }

    if (this._orbitActive && this._orbitLast) {
      clearTimeout(this._longPressTimer);
      const dx = e.clientX - this._orbitLast.x;
      const dy = e.clientY - this._orbitLast.y;
      this._orbitTheta -= dx * 0.009;
      this._orbitPhi = Math.max(0.06, Math.min(1.45, this._orbitPhi + dy * 0.006));
      this._orbitLast = { x: e.clientX, y: e.clientY };
      this._updateCamera();
    }
  }

  _pu() {
    clearTimeout(this._longPressTimer);
    this._dragHandle = null;
    this._orbitActive = false;
    this._orbitLast = null;
  }

  _deleteBlock(block) {
    this._scene.remove(block.mesh);
    this._blocks.splice(this._blocks.indexOf(block), 1);
    if (this._selected === block) this._deselect();
    this._hint('Block deleted.');
  }

  _exitPlaceMode() {
    this._mode = 'select';
    this._pendingMat = null;
    this._deleteMode = false;
    this._el.querySelectorAll('.bl-mat').forEach(b => b.classList.remove('active'));
  }

  _bindEvents() {
    const cv = this._canvas;
    this._pdCb = this._pd.bind(this);
    this._pmCb = this._pm.bind(this);
    this._puCb = this._pu.bind(this);
    cv.addEventListener('pointerdown', this._pdCb);
    cv.addEventListener('pointermove', this._pmCb);
    cv.addEventListener('pointerup', this._puCb);
    cv.addEventListener('pointercancel', this._puCb);

    for (const btn of this._el.querySelectorAll('.bl-mat')) {
      btn.addEventListener('click', () => {
        const mid = btn.dataset.mat;
        this._deselect();
        if (mid === 'delete') {
          this._deleteMode = true;
          this._mode = 'delete';
          this._pendingMat = null;
          this._hint('Tap a block to delete it.');
        } else {
          this._deleteMode = false;
          this._mode = 'place';
          this._pendingMat = mid;
          this._hint('Tap the floor or a surface to place a block.');
        }
        this._el.querySelectorAll('.bl-mat').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    }

    this._el.querySelector('#bl-back').addEventListener('click', () => this.destroy());
    this._el.querySelector('#bl-save').addEventListener('click', () => this._save());
  }

  _updateCamera() {
    const r = this._orbitR;
    const phi = this._orbitPhi;
    const theta = this._orbitTheta;
    this._camera.position.set(
      r * Math.cos(phi) * Math.sin(theta),
      r * Math.sin(phi),
      r * Math.cos(phi) * Math.cos(theta)
    );
    this._camera.lookAt(0, 0.45, 0);
  }

  _resize() {
    const w = this._canvas.clientWidth  || this._canvas.parentElement.clientWidth  || 300;
    const h = this._canvas.clientHeight || this._canvas.parentElement.clientHeight || 300;
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  _animate() {
    if (!this._running) return;
    requestAnimationFrame(() => this._animate());
    this._renderer.render(this._scene, this._camera);
  }

  _save() {
    const data = this._blocks.map(b => ({
      matId: b.matId,
      size: b.size,
      pos: [b.pos.x, b.pos.y, b.pos.z],
    }));
    localStorage.setItem('ns-car-blocks', JSON.stringify(data));
    this._hint('Saved!');
    setTimeout(() => this._hint('Select a material below, then tap the floor to place a block.'), 2000);
  }

  _load() {
    try {
      const raw = localStorage.getItem('ns-car-blocks');
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const b of data) {
        const pos = new THREE.Vector3(b.pos[0], b.pos[1], b.pos[2]);
        const block = this._addBlock(b.matId, pos);
        block.size = [...b.size];
        block.mesh.scale.set(b.size[0] / 0.5, b.size[1] / 0.5, b.size[2] / 0.5);
      }
    } catch { /* ignore corrupt save */ }
  }

  destroy() {
    this._running = false;
    clearTimeout(this._longPressTimer);
    if (this._resizeObs) this._resizeObs.disconnect();
    const cv = this._canvas;
    cv.removeEventListener('pointerdown', this._pdCb);
    cv.removeEventListener('pointermove', this._pmCb);
    cv.removeEventListener('pointerup', this._puCb);
    cv.removeEventListener('pointercancel', this._puCb);
    this._renderer.dispose();
    this._el.remove();
    if (this.onDestroy) this.onDestroy();
  }
}
