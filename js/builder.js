// Car Builder workshop — Three.js block placement with materials, symmetry, save → drivable car.
import * as THREE from 'three';
import { registerCustomCar } from './cars.js';

const MAT_DEFS = [
  { id: 'body',   label: 'BODY',   color: 0x1a4fa8, rough: 0.14, metal: 0.82, cc: 1.0 },
  { id: 'glass',  label: 'GLASS',  color: 0x88ccff, rough: 0.05, metal: 0.05, opacity: 0.35 },
  { id: 'carbon', label: 'CARBON', color: 0x111111, rough: 0.18, metal: 0.55 },
  { id: 'wheel',  label: 'WHEEL',  color: 0x151515, rough: 0.90, metal: 0.00 },
];
const WHEEL_R = 0.33, WHEEL_W = 0.24;
const GRID = 0.125;
const DEFAULT_SIZE = 0.5; // BoxGeometry base size (scale applied separately)

function _makeMat(def) {
  const opts = { color: def.color, roughness: def.rough, metalness: def.metal };
  if (def.cc) {
    return new THREE.MeshPhysicalMaterial({ ...opts, clearcoat: def.cc, clearcoatRoughness: 0.05, envMapIntensity: 3.0 });
  }
  if (def.opacity != null) { opts.transparent = true; opts.opacity = def.opacity; }
  return new THREE.MeshStandardMaterial(opts);
}

function snap(v) { return Math.round(v / GRID) * GRID; }

// ── Car Garage — pick existing car to edit or create new ────────────────────

export function showCarGarage({ onNew, onEdit, onBack }) {
  let cars;
  try { cars = JSON.parse(localStorage.getItem('ns-custom-cars') || '[]'); }
  catch { cars = []; }

  const el = document.createElement('div');
  el.id = 'garage';
  el.innerHTML = `
    <div id="gar-inner">
      <div id="gar-top">
        <button id="gar-back">&#8592; BACK</button>
        <span id="gar-title">MY CARS</span>
      </div>
      <div id="gar-list">
        <button id="gar-new">＋ CREATE NEW CAR</button>
        ${!cars.length ? '<p id="gar-empty">No cars yet — tap CREATE to build your first!</p>' : ''}
        ${cars.map((c, i) => `<div class="gar-item" data-i="${i}">
          <div class="gar-item-name">${c.name || 'Untitled'}</div>
          <div class="gar-item-sub">${(c.blocks || []).length} blocks</div>
          <div class="gar-item-arr">EDIT →</div>
        </div>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(el);

  el.querySelector('#gar-back').addEventListener('click', () => { el.remove(); if (onBack) onBack(); });
  el.querySelector('#gar-new').addEventListener('click', () => { el.remove(); onNew(); });
  el.querySelectorAll('.gar-item').forEach(item => {
    item.addEventListener('click', () => { el.remove(); onEdit(cars[+item.dataset.i]); });
  });
}

export class CarBuilder {
  constructor(editData = null) {
    this._editData = editData; // null = new car, object = editing existing
    this._blocks     = [];
    this._selected   = null;
    this._selWire    = null;
    this._handles    = [];        // scene-level (not mesh children) — fixed apparent size
    this._handleMode = 'scale';
    this._mode       = 'select'; // 'select' | 'place' | 'delete'
    this._pendingMat = null;
    this._mirrorMode = false;
    this._dragHandle = null;
    this._dragStartMouse = null;
    this._dragStartPos   = null;
    this._dragStartSize  = null;
    this._orbitActive = false;
    this._orbitLast   = null;
    this._orbitTheta  = 0.75;
    this._orbitPhi    = 0.40;
    this._orbitR      = 7.0;
    this._pointers    = new Map();   // pointerId → {x,y} for pinch-zoom tracking
    this._pinchDist   = null;
    this._longTimer   = null;
    this._running     = false;
    this.onDestroy    = null;
    this._init();
  }

  // ── init ──────────────────────────────────────────────────────────────────

  _init() {
    // DOM
    this._el = document.createElement('div');
    this._el.id = 'builder';
    this._el.innerHTML = `
      <canvas id="bl-canvas"></canvas>
      <div id="bl-ui">
        <div id="bl-top">
          <button id="bl-back">&#8592; BACK</button>
          <span id="bl-title">MAKE YOUR CAR</span>
          <button id="bl-save">SAVE &amp; DRIVE</button>
        </div>
        <div id="bl-hint">Select a material below, then tap the floor to place a block.</div>
        <div id="bl-gap"></div>
        <div id="bl-bar">
          ${MAT_DEFS.map(m => `<button class="bl-mat" data-mat="${m.id}"
              style="background:#${m.color.toString(16).padStart(6,'0')}">${m.label}</button>`).join('')}
          <div class="bl-sep"></div>
          <button class="bl-mat" id="bl-mirror">MIRROR</button>
          <button class="bl-mat" id="bl-delete">DELETE</button>
        </div>
      </div>`;
    document.body.appendChild(this._el);

    // Wire canvas + buttons NOW, before Three.js which might throw on low-end devices.
    this._canvas = this._el.querySelector('#bl-canvas');
    this._bindEvents();

    // Three.js — initialise after buttons are wired so BACK always works.
    this._initGL();
  }

  _initGL() {
    const cv = this._canvas;
    try {
      this._renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
    } catch (e) {
      this._hint('WebGL unavailable — try reloading. (' + e.message + ')');
      return;
    }

    this._renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.1;
    this._renderer.shadowMap.enabled = true;

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x2a2a2a);
    this._scene.fog = new THREE.FogExp2(0x2a2a2a, 0.03);

    this._camera = new THREE.PerspectiveCamera(50, 1, 0.05, 80);
    this._updateCam();

    // Lights
    this._scene.add(new THREE.AmbientLight(0xffffff, 0.80));
    const sun = new THREE.DirectionalLight(0xfffaf0, 1.2);
    sun.position.set(5, 14, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 35;
    sun.shadow.camera.left = sun.shadow.camera.bottom = -8;
    sun.shadow.camera.right = sun.shadow.camera.top = 8;
    this._scene.add(sun);
    const fill = new THREE.DirectionalLight(0xb0d8f0, 0.35);
    fill.position.set(-4, 3, -5);  // fixed: Object.assign would replace Vector3 with plain object
    this._scene.add(fill);

    // Floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.85, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.001;
    floor.receiveShadow = true;
    floor.userData.isFloor = true;
    this._floorMesh = floor;
    this._scene.add(floor);

    // Grid
    const grid = new THREE.GridHelper(16, 32, 0x999999, 0xbbbbbb);
    grid.position.y = 0.001;
    this._scene.add(grid);

    this._ray = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    this._load();

    this._resizeCb = () => this._resize();
    window.addEventListener('resize', this._resizeCb);
    this._resize();

    this._running = true;
    this._animate();
  }

  // ── mesh helpers ──────────────────────────────────────────────────────────

  // All regular blocks: BoxGeometry(DEFAULT_SIZE), scale to real size separately.
  // Wheels: CylinderGeometry, fixed size, only position changes.
  _newMesh(matId) {
    const def = MAT_DEFS.find(m => m.id === matId) || MAT_DEFS[0];
    let geo;
    if (matId === 'wheel') {
      geo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 22);
    } else {
      geo = new THREE.BoxGeometry(DEFAULT_SIZE, DEFAULT_SIZE, DEFAULT_SIZE);
    }
    const mesh = new THREE.Mesh(geo, _makeMat(def));
    if (matId === 'wheel') mesh.rotation.z = Math.PI / 2; // axis along X (side-facing)
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.block = true;
    mesh.userData.matId = matId;
    this._scene.add(mesh);
    return mesh;
  }

  _applySize(block) {
    if (block.matId === 'wheel') return; // fixed geometry
    const [sx, sy, sz] = block.size;
    block.mesh.scale.set(sx / DEFAULT_SIZE, sy / DEFAULT_SIZE, sz / DEFAULT_SIZE);
    if (this._selWire && this._selected === block) {
      this._selWire.scale.copy(block.mesh.scale);
    }
  }

  // ── block add / overlap / delete ──────────────────────────────────────────

  _addBlock(matId, pos, skipMirror = false) {
    const size = matId === 'wheel'
      ? [WHEEL_W, WHEEL_R * 2, WHEEL_R * 2]
      : [DEFAULT_SIZE, DEFAULT_SIZE, DEFAULT_SIZE];
    pos = pos.clone();
    pos.y = Math.max(size[1] / 2, pos.y);

    if (this._overlaps(pos, size, null)) {
      this._hint('Cannot place here — blocks overlap.');
      return null;
    }
    const mesh = this._newMesh(matId);
    mesh.position.copy(pos);
    const block = { mesh, matId, size: [...size], pos: pos.clone() };
    this._blocks.push(block);

    // Mirror across X axis
    if (this._mirrorMode && !skipMirror && Math.abs(pos.x) > 0.01) {
      const mp = pos.clone(); mp.x = -mp.x;
      if (!this._overlaps(mp, size, null)) {
        this._addBlock(matId, mp, true);
      }
    }
    return block;
  }

  _overlaps(pos, size, exclude) {
    for (const b of this._blocks) {
      if (b === exclude) continue;
      if (Math.abs(b.pos.x - pos.x) < (b.size[0] + size[0]) / 2 - 0.01 &&
          Math.abs(b.pos.y - pos.y) < (b.size[1] + size[1]) / 2 - 0.01 &&
          Math.abs(b.pos.z - pos.z) < (b.size[2] + size[2]) / 2 - 0.01) return true;
    }
    return false;
  }

  _deleteBlock(block) {
    this._scene.remove(block.mesh);
    this._blocks.splice(this._blocks.indexOf(block), 1);
    if (this._selected === block) this._deselect();
    this._hint('Block deleted.');
  }

  // ── selection ─────────────────────────────────────────────────────────────

  _deselect() {
    if (this._selWire) { this._scene.remove(this._selWire); this._selWire = null; }
    this._clearHandles();
    this._selected = null;
  }

  _select(block) {
    this._deselect();
    this._selected = block;

    // Wireframe outline (scene-level, same size as block)
    const geo = block.matId === 'wheel'
      ? new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 22)
      : new THREE.BoxGeometry(DEFAULT_SIZE, DEFAULT_SIZE, DEFAULT_SIZE);
    this._selWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x44aaff })
    );
    if (block.matId === 'wheel') this._selWire.rotation.z = Math.PI / 2;
    this._selWire.position.copy(block.pos);
    if (block.matId !== 'wheel') this._selWire.scale.copy(block.mesh.scale);
    this._scene.add(this._selWire);

    if (block.matId === 'wheel') {
      this._showMoveHandles(block);
      this._hint('Drag handles to move wheel. Long-press to move.');
    } else {
      this._showScaleHandles(block);
      this._hint('Drag colored handles to scale. Long-press for move mode.');
    }
  }

  _clearHandles() {
    for (const h of this._handles) this._scene.remove(h);
    this._handles = [];
    this._handleMode = 'scale';
  }

  _showScaleHandles(block) {
    this._clearHandles();
    this._handleMode = 'scale';
    const defs = [
      { a: 0, d: +1, c: 0xff3322 }, { a: 0, d: -1, c: 0xff3322 },
      { a: 1, d: +1, c: 0x44cc44 }, { a: 1, d: -1, c: 0x44cc44 },
      { a: 2, d: +1, c: 0x3388ff }, { a: 2, d: -1, c: 0x3388ff },
    ];
    const hGeo = new THREE.SphereGeometry(0.07, 8, 8);
    for (const { a, d, c } of defs) {
      const h = new THREE.Mesh(hGeo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.1, metalness: 0.7 }));
      h.userData.handle = true; h.userData.axis = a; h.userData.dir = d; h.userData.mode = 'scale';
      this._scene.add(h);
      this._handles.push(h);
    }
    this._updateHandlePos();
  }

  _showMoveHandles(block) {
    this._clearHandles();
    this._handleMode = 'move';
    const defs = [
      { a: 0, d: +1 }, { a: 0, d: -1 },
      { a: 1, d: +1 }, { a: 1, d: -1 },
      { a: 2, d: +1 }, { a: 2, d: -1 },
    ];
    const hGeo = new THREE.SphereGeometry(0.075, 8, 8);
    for (const { a, d } of defs) {
      const h = new THREE.Mesh(hGeo, new THREE.MeshStandardMaterial({ color: 0x44aaff, roughness: 0.1, metalness: 0.6 }));
      h.userData.handle = true; h.userData.axis = a; h.userData.dir = d; h.userData.mode = 'move';
      this._scene.add(h);
      this._handles.push(h);
    }
    if (this._selWire) this._selWire.material.color.set(0x44ffcc);
    this._updateHandlePos();
    this._hint('Drag handles to reposition. Tap block again for scale mode.');
  }

  _updateHandlePos() {
    if (!this._selected || !this._handles.length) return;
    const { pos, size } = this._selected;
    const offsets = [
      [size[0]/2, 0, 0], [-size[0]/2, 0, 0],
      [0, size[1]/2, 0], [0, -size[1]/2, 0],
      [0, 0, size[2]/2], [0, 0, -size[2]/2],
    ];
    for (let i = 0; i < this._handles.length; i++) {
      this._handles[i].position.set(pos.x + offsets[i][0], pos.y + offsets[i][1], pos.z + offsets[i][2]);
    }
    if (this._selWire) this._selWire.position.copy(pos);
  }

  // ── drag projection ───────────────────────────────────────────────────────

  _projAxis(worldPos, dir) {
    const from = worldPos.clone().project(this._camera);
    const to   = worldPos.clone().addScaledVector(dir, 0.8).project(this._camera);
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  // ── pointer events ────────────────────────────────────────────────────────

  _raycast(e) {
    const r = this._canvas.getBoundingClientRect();
    this._mouse.x = ((e.clientX - r.left) / r.width)  * 2 - 1;
    this._mouse.y = -((e.clientY - r.top)  / r.height) * 2 + 1;
    this._ray.setFromCamera(this._mouse, this._camera);
    return this._ray;
  }

  _pd(e) {
    e.preventDefault();
    this._canvas.setPointerCapture(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two-finger pinch: initialise and skip all other interactions
    if (this._pointers.size === 2) {
      const pts = [...this._pointers.values()];
      this._pinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      this._dragHandle = null;
      this._orbitActive = false;
      clearTimeout(this._longTimer);
      return;
    }

    const ray = this._raycast(e);

    // 1. Handle spheres
    if (this._handles.length) {
      const hits = ray.intersectObjects(this._handles, false);
      if (hits.length) {
        this._dragHandle = hits[0].object;
        this._dragStartMouse = { x: e.clientX, y: e.clientY };
        this._dragStartPos   = this._selected.pos.clone();
        this._dragStartSize  = [...this._selected.size];
        return;
      }
    }

    // 2. Existing block hit
    const bMeshes = this._blocks.map(b => b.mesh);
    const bHits = ray.intersectObjects(bMeshes, false);
    if (bHits.length) {
      const block = this._blocks.find(b => b.mesh === bHits[0].object);
      if (!block) return;

      if (this._mode === 'delete') { this._deleteBlock(block); return; }
      if (this._mode === 'place') this._exitPlace();

      if (this._selected === block) {
        // tap same block → toggle scale/move
        if (block.matId !== 'wheel' && this._handleMode === 'scale') this._showMoveHandles(block);
        else if (block.matId !== 'wheel') this._showScaleHandles(block);
      } else {
        this._select(block);
      }

      clearTimeout(this._longTimer);
      if (block.matId !== 'wheel') {
        this._longTimer = setTimeout(() => {
          if (this._selected === block && this._handleMode !== 'move') this._showMoveHandles(block);
        }, 480);
      }
      return;
    }

    // 3. Place on floor or top of block
    if (this._mode === 'place' && this._pendingMat) {
      const plHits = ray.intersectObjects([this._floorMesh, ...bMeshes], false);
      if (plHits.length) {
        const pt = plHits[0].point.clone();
        pt.x = snap(pt.x);
        pt.z = snap(pt.z);
        const szHalf = this._pendingMat === 'wheel' ? WHEEL_R : DEFAULT_SIZE / 2;
        pt.y = plHits[0].point.y + szHalf;
        const blk = this._addBlock(this._pendingMat, pt);
        if (blk) { this._select(blk); this._exitPlace(); }
        return;
      }
    }

    // 4. Orbit
    clearTimeout(this._longTimer);
    if (this._mode !== 'delete') this._deselect();
    this._mode = 'select';
    this._orbitActive = true;
    this._orbitLast = { x: e.clientX, y: e.clientY };
  }

  _pm(e) {
    // Keep pointer map current for pinch calculations
    if (this._pointers.has(e.pointerId)) {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Two-finger pinch zoom
    if (this._pointers.size === 2 && this._pinchDist !== null) {
      const pts = [...this._pointers.values()];
      const newDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      this._orbitR = Math.max(2.5, Math.min(18, this._orbitR + (this._pinchDist - newDist) * 0.025));
      this._pinchDist = newDist;
      this._updateCam();
      return;
    }

    if (this._dragHandle) {
      clearTimeout(this._longTimer);
      const block = this._selected;
      if (!block) return;

      const rect = this._canvas.getBoundingClientRect();
      const dxS = (e.clientX - this._dragStartMouse.x) / rect.width  * 2;
      const dyS = -(e.clientY - this._dragStartMouse.y) / rect.height * 2;

      const AXES = [new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1)];
      const axis = this._dragHandle.userData.axis;
      const dir  = this._dragHandle.userData.dir;
      const mode = this._dragHandle.userData.mode;
      const proj = this._projAxis(block.pos.clone(), AXES[axis].clone().multiplyScalar(dir));
      const scalar = dxS * proj.x + dyS * proj.y;

      if (mode === 'scale') {
        const ns = [...this._dragStartSize];
        ns[axis] = Math.max(0.12, this._dragStartSize[axis] + scalar * 4.0);
        // Y: don't let the bottom penetrate the floor
        if (axis === 1) ns[1] = Math.min(ns[1], this._dragStartPos.y * 2);
        block.size = ns;
        this._applySize(block);
      } else {
        const np = this._dragStartPos.clone();
        const mv = scalar * 5.5;
        if (axis === 0) np.x += mv * dir;
        else if (axis === 1) np.y += mv * dir;
        else np.z += mv * dir;
        np.x = snap(np.x);
        np.y = Math.max(block.size[1] / 2, snap(np.y));
        np.z = snap(np.z);
        if (!this._overlaps(np, block.size, block)) {
          block.pos.copy(np);
          block.mesh.position.copy(np);
        }
      }
      this._updateHandlePos();
      return;
    }

    if (this._orbitActive && this._orbitLast) {
      clearTimeout(this._longTimer);
      const dx = e.clientX - this._orbitLast.x;
      const dy = e.clientY - this._orbitLast.y;
      this._orbitTheta -= dx * 0.009;
      this._orbitPhi = Math.max(0.05, Math.min(1.45, this._orbitPhi + dy * 0.006));
      this._orbitLast = { x: e.clientX, y: e.clientY };
      this._updateCam();
    }
  }

  _pu(e) {
    if (e) this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinchDist = null;
    clearTimeout(this._longTimer);
    this._dragHandle  = null;
    this._orbitActive = false;
    this._orbitLast   = null;
  }

  _exitPlace() {
    this._mode = 'select';
    this._pendingMat = null;
    this._el.querySelectorAll('.bl-mat').forEach(b => b.classList.remove('active'));
  }

  _hint(msg) {
    const el = this._el.querySelector('#bl-hint');
    if (el) el.textContent = msg;
  }

  // ── button wiring ─────────────────────────────────────────────────────────

  _bindEvents() {
    const cv = this._canvas;
    this._pdCb = this._pd.bind(this); this._pmCb = this._pm.bind(this); this._puCb = this._pu.bind(this);
    cv.addEventListener('pointerdown',  this._pdCb);
    cv.addEventListener('pointermove',  this._pmCb);
    cv.addEventListener('pointerup',    this._puCb);
    cv.addEventListener('pointercancel',this._puCb);

    for (const btn of this._el.querySelectorAll('.bl-mat[data-mat]')) {
      btn.addEventListener('click', () => {
        this._deselect();
        this._mode       = 'place';
        this._pendingMat = btn.dataset.mat;
        this._el.querySelectorAll('.bl-mat').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._el.querySelector('#bl-delete').classList.remove('active');
        this._hint(`Tap a surface to place a ${btn.textContent} block.`);
      });
    }

    const mirBtn = this._el.querySelector('#bl-mirror');
    mirBtn.addEventListener('click', () => {
      this._mirrorMode = !this._mirrorMode;
      mirBtn.classList.toggle('active', this._mirrorMode);
      this._hint(this._mirrorMode
        ? 'Mirror ON — blocks placed on one side are copied to the other.'
        : 'Mirror OFF.');
    });

    const delBtn = this._el.querySelector('#bl-delete');
    delBtn.addEventListener('click', () => {
      const on = this._mode !== 'delete';
      this._deselect();
      this._mode = on ? 'delete' : 'select';
      delBtn.classList.toggle('active', on);
      this._el.querySelectorAll('.bl-mat[data-mat]').forEach(b => b.classList.remove('active'));
      this._hint(on ? 'Tap a block to delete it.' : 'Select a material to place.');
    });

    this._el.querySelector('#bl-back').addEventListener('click', () => this.destroy());
    this._el.querySelector('#bl-save').addEventListener('click', () => this._save());
  }

  // ── camera ────────────────────────────────────────────────────────────────

  _updateCam() {
    const r = this._orbitR, phi = this._orbitPhi, theta = this._orbitTheta;
    this._camera.position.set(
      r * Math.cos(phi) * Math.sin(theta),
      r * Math.sin(phi),
      r * Math.cos(phi) * Math.cos(theta)
    );
    this._camera.lookAt(0, 0.6, 0);
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return;
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  // ── render loop ───────────────────────────────────────────────────────────

  _animate() {
    if (!this._running) return;
    requestAnimationFrame(() => this._animate());

    // Keep handles same apparent size regardless of camera distance
    if (this._handles.length) {
      const camPos = this._camera.position;
      for (const h of this._handles) {
        const d = Math.max(0.5, camPos.distanceTo(h.position));
        h.scale.setScalar((d * 0.022) / 0.075);
      }
    }
    this._renderer.render(this._scene, this._camera);
  }

  // ── save / load ───────────────────────────────────────────────────────────

  _computeWheelSpec() {
    const ws = this._blocks.filter(b => b.matId === 'wheel');
    if (ws.length !== 4) return null;
    const sorted = [...ws].sort((a, b) => a.pos.z - b.pos.z);
    const front = sorted.slice(0, 2), rear = sorted.slice(2);
    return {
      fz: (front[0].pos.z + front[1].pos.z) / 2,
      rz: (rear[0].pos.z  + rear[1].pos.z)  / 2,
      htF: Math.max(0.5, (Math.abs(front[0].pos.x) + Math.abs(front[1].pos.x)) / 2),
      htR: Math.max(0.5, (Math.abs(rear[0].pos.x)  + Math.abs(rear[1].pos.x))  / 2),
    };
  }

  _save() {
    if (!this._blocks.length) { this._hint('Add some blocks first!'); return; }
    const name = window.prompt('이름을 입력하세요 / Enter car name:',
      this._editData?.name || 'My Car');
    if (!name?.trim()) return;

    const data = {
      id: this._editData?.id ?? ('custom_' + Date.now()),
      name: name.trim(),
      blocks: this._blocks.map(b => ({
        matId: b.matId, size: [...b.size], pos: [b.pos.x, b.pos.y, b.pos.z],
      })),
      wheelSpec: this._computeWheelSpec(),
    };
    registerCustomCar(data);
    this._editData = data; // update so future saves keep the same ID
    localStorage.setItem('ns-builder-draft', JSON.stringify(data.blocks));
    this._hint(`"${data.name}" saved! Select it in the menu to drive.`);
  }

  _addDefaultSkeleton() {
    const WR = WHEEL_R, WW = WHEEL_W;
    // Verified non-overlapping positions (AABB checked)
    const defs = [
      { matId: 'body',  pos: [0,    0.25,  0],     size: [1.6,  0.5,  4.0]       },
      { matId: 'body',  pos: [0,    0.75, -0.3],   size: [1.3,  0.5,  2.2]       },
      { matId: 'glass', pos: [0,    0.75,  1.0],   size: [1.3,  0.5,  0.3]       },
      { matId: 'wheel', pos: [-1.05, WR,   1.25],  size: [WW, WR*2, WR*2]        },
      { matId: 'wheel', pos: [ 1.05, WR,   1.25],  size: [WW, WR*2, WR*2]        },
      { matId: 'wheel', pos: [-1.05, WR,  -1.35],  size: [WW, WR*2, WR*2]        },
      { matId: 'wheel', pos: [ 1.05, WR,  -1.35],  size: [WW, WR*2, WR*2]        },
    ];
    for (const d of defs) {
      const pos = new THREE.Vector3(...d.pos);
      const mesh = this._newMesh(d.matId);
      mesh.position.copy(pos);
      const block = { mesh, matId: d.matId, size: [...d.size], pos: pos.clone() };
      if (d.matId !== 'wheel') {
        block.mesh.scale.set(d.size[0] / DEFAULT_SIZE, d.size[1] / DEFAULT_SIZE, d.size[2] / DEFAULT_SIZE);
      }
      this._blocks.push(block);
    }
  }

  _loadBlocks(list) {
    for (const b of list) {
      const pos = new THREE.Vector3(b.pos[0], b.pos[1], b.pos[2]);
      const mesh = this._newMesh(b.matId);
      mesh.position.copy(pos);
      const block = { mesh, matId: b.matId, size: [...b.size], pos: pos.clone() };
      if (b.matId !== 'wheel') {
        block.mesh.scale.set(b.size[0] / DEFAULT_SIZE, b.size[1] / DEFAULT_SIZE, b.size[2] / DEFAULT_SIZE);
      }
      this._blocks.push(block);
    }
  }

  _load() {
    // Edit mode: load the car's saved blocks
    if (this._editData?.blocks?.length) {
      this._loadBlocks(this._editData.blocks);
      return;
    }
    // New car: always start with the default skeleton (never restore a previous draft)
    this._addDefaultSkeleton();
  }

  // ── cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    this._running = false;
    clearTimeout(this._longTimer);
    if (this._resizeCb) window.removeEventListener('resize', this._resizeCb);
    if (this._canvas) {
      this._canvas.removeEventListener('pointerdown',  this._pdCb);
      this._canvas.removeEventListener('pointermove',  this._pmCb);
      this._canvas.removeEventListener('pointerup',    this._puCb);
      this._canvas.removeEventListener('pointercancel',this._puCb);
    }
    if (this._renderer) this._renderer.dispose();
    this._el.remove();
    if (this.onDestroy) this.onDestroy();
  }
}
