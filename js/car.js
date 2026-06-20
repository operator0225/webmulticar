// Car visuals v2: spec-driven exterior (color/wing/profile), detailed cockpit
// (layered dash, center stack, bolstered seats, visors, paddles), gloved hands
// on a wheel that now turns with the real steering angle, working mirror.
import * as THREE from 'three';

function dialTexture(label, maxVal, major, redFrom) {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#101216'; g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, 7); g.fill();
  g.strokeStyle = '#2a2e36'; g.lineWidth = 6;
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 4, 0, 7); g.stroke();
  const a0 = Math.PI * 200 / 180, a1 = -Math.PI * 20 / 180;
  const ticks = maxVal / major;
  for (let i = 0; i <= ticks; i++) {
    const f = i / ticks;
    const a = a0 + (a1 - a0) * f;
    const val = i * major;
    const inRed = redFrom != null && val >= redFrom;
    g.strokeStyle = inRed ? '#e03b30' : '#dfe3ea';
    g.lineWidth = 4;
    const r1 = S / 2 - 12, r2 = S / 2 - 30;
    g.beginPath();
    g.moveTo(S / 2 + Math.cos(a) * r1, S / 2 - Math.sin(a) * r1);
    g.lineTo(S / 2 + Math.cos(a) * r2, S / 2 - Math.sin(a) * r2);
    g.stroke();
    g.fillStyle = inRed ? '#e03b30' : '#cfd4dc';
    g.font = 'bold 26px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const rt = S / 2 - 52;
    g.fillText(String(val), S / 2 + Math.cos(a) * rt, S / 2 - Math.sin(a) * rt);
  }
  g.fillStyle = '#8a919c'; g.font = 'bold 20px Arial';
  g.fillText(label, S / 2, S / 2 + 56);
  return new THREE.CanvasTexture(c);
}

function screenTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#0a0e14'; g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#1d2733'; g.lineWidth = 2; g.strokeRect(3, 3, 250, 122);
  g.strokeStyle = '#2f86c9'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(30, 100); g.bezierCurveTo(90, 30, 150, 110, 226, 40); g.stroke();
  g.fillStyle = '#46e6a0'; g.beginPath(); g.arc(96, 78, 5, 0, 7); g.fill();
  g.fillStyle = '#8a93a0'; g.font = '12px Arial';
  g.fillText('Nürburgring', 14, 20);
  return new THREE.CanvasTexture(c);
}

export class CarVisual {
  constructor(scene, renderer, spec) {
    this.scene = scene;
    this.renderer = renderer;
    this.spec = spec;
    this.root = new THREE.Group();
    scene.add(this.root);

    this.cockpit = new THREE.Group();
    this.exterior = new THREE.Group();
    this.root.add(this.cockpit, this.exterior);

    this.type = (spec.visual && spec.visual.type) || 'road';
    // eye position must be known before the cockpit builds (open cars place the
    // wheel/cluster relative to it)
    this.eyeLocal = this.type === 'kart' ? new THREE.Vector3(0, 0.52, 0.10)
                  : this.type === 'formula' ? new THREE.Vector3(0, 0.62, 0.30)
                  : new THREE.Vector3(-0.37, 0.82, -0.24);
    if (this.type === 'kart') this._buildKart();
    else if (this.type === 'formula') this._buildFormula();
    else this._buildExterior();
    this._buildCockpit();

    this.mirrorRT = new THREE.WebGLRenderTarget(384, 112);
    this.mirrorCam = new THREE.PerspectiveCamera(26, 384 / 112, 0.5, 1500);
    this.mirrorMat.map = this.mirrorRT.texture;
    this.mirrorMat.map.repeat.x = -1;
    this.mirrorMat.map.offset.x = 1;
    this.mirrorMat.needsUpdate = true;

    this.mode = 0;

    // headlights (night): two spots casting a pool down the road
    this.headlights = [];
    for (const sgn of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff0d0, 0, 170, 0.46, 0.55, 1.5);
      spot.position.set(sgn * 0.62, 0.05, -2.0);
      spot.target.position.set(sgn * 1.4, -1.6, -42);
      spot.visible = false;
      this.root.add(spot, spot.target);
      this.headlights.push(spot);
    }
    this._headlightMat = null;          // set in _buildExterior
  }

  setHeadlights(on) {
    for (const s of this.headlights) { s.visible = on; s.intensity = on ? 380 : 0; }
    if (this._headlightMat) this._headlightMat.emissiveIntensity = on ? 3.2 : 0.5;
  }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
    this.mirrorRT.dispose();
  }

  // ---------------------------------------------------------------- exterior
  _buildExterior() {
    const V = this.spec.visual;
    const roofY = V.roofY, rearY = V.rearY;
    const e = this.exterior;

    const paint = new THREE.MeshPhysicalMaterial({
      color: V.color, metalness: 0.72, roughness: 0.16,
      clearcoat: 1.0, clearcoatRoughness: 0.04, envMapIntensity: 3.2, reflectivity: 1.0,
    });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0c1420, metalness: 0.05, roughness: 0.06,
      transparent: true, opacity: 0.62, envMapIntensity: 2.4,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.55, metalness: 0.15 });

    const mk = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; e.add(m); return m;
    };

    // ── LOWER SILL (widest, full length) ─────────────────────────────
    mk(new THREE.BoxGeometry(1.64, 0.28, 4.30), paint, 0, -0.16, 0);

    // ── DOOR PANELS (between fenders) ────────────────────────────────
    mk(new THREE.BoxGeometry(1.50, 0.56, 2.20), paint, 0, 0.08, 0);

    // ── FRONT FENDERS (flared over front wheels) ──────────────────────
    for (const sx of [-1, 1]) {
      mk(new THREE.BoxGeometry(0.32, 0.58, 1.32), paint, sx * 0.74, 0.05, -1.34);
    }

    // ── REAR FENDERS (wider GT wide-body) ─────────────────────────────
    for (const sx of [-1, 1]) {
      mk(new THREE.BoxGeometry(0.36, 0.64, 1.50), paint, sx * 0.76, 0.08, 1.26);
    }

    // ── HOOD (sloped from windshield to nose) ─────────────────────────
    mk(new THREE.BoxGeometry(1.78, 0.05, 1.90), paint, 0, 0.38, -1.18, 0.09);

    // ── CABIN SIDE WALLS (A-pillar → C-pillar, thick enough to read) ──
    for (const sx of [-1, 1]) {
      mk(new THREE.BoxGeometry(0.13, roofY - 0.22, 1.50), paint,
        sx * 0.665, 0.18 + (roofY - 0.22) * 0.5, -0.14);
    }
    // A-pillars (leaning forward)
    for (const sx of [-1, 1]) {
      mk(new THREE.BoxGeometry(0.10, 0.52, 0.12), paint, sx * 0.60, roofY - 0.30, -0.68, 0.55);
    }

    // ── ROOF ──────────────────────────────────────────────────────────
    mk(new THREE.BoxGeometry(1.34, 0.12, 1.42), paint, 0, roofY - 0.04, 0.13);

    // ── REAR FASTBACK SLOPE ───────────────────────────────────────────
    mk(new THREE.BoxGeometry(1.30, 0.06, 0.74), paint, 0, rearY + 0.12, 1.62, -0.30);

    // ── FRONT BUMPER ASSEMBLY ─────────────────────────────────────────
    mk(new THREE.BoxGeometry(1.54, 0.20, 0.24), paint, 0, 0.12, -2.07);   // upper (paint)
    mk(new THREE.BoxGeometry(1.54, 0.32, 0.24), dark,  0, -0.14, -2.07);  // lower fascia
    mk(new THREE.BoxGeometry(1.15, 0.24, 0.06), dark,  0, -0.10, -2.16);  // grille
    mk(new THREE.BoxGeometry(1.60, 0.035, 0.26), dark, 0, -0.325, -2.12); // splitter

    // ── REAR BUMPER ASSEMBLY ──────────────────────────────────────────
    mk(new THREE.BoxGeometry(1.56, 0.40, 0.24), paint, 0, -0.04, 2.06);
    mk(new THREE.BoxGeometry(1.30, 0.09, 0.28), dark,  0, -0.295, 2.04, -0.18); // diffuser
    for (const fx of [-0.4, 0, 0.4]) {
      mk(new THREE.BoxGeometry(0.015, 0.10, 0.26), dark, fx, -0.30, 2.05, -0.18);
    }

    // ── GLASS PANELS ──────────────────────────────────────────────────
    // Windshield
    { const m = new THREE.Mesh(new THREE.PlaneGeometry(1.30, 0.70), glassMat);
      m.position.set(0, roofY - 0.23, -0.64); m.rotation.x = 0.56; e.add(m); }
    // Rear window
    { const m = new THREE.Mesh(new THREE.PlaneGeometry(1.22, 0.44), glassMat);
      m.position.set(0, rearY + 0.12, 1.22); m.rotation.x = -0.46; e.add(m); }
    // Side windows
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.24, 0.38), glassMat);
      m.position.set(sx * 0.736, roofY - 0.22, -0.12); m.rotation.y = sx * Math.PI / 2; e.add(m);
    }

    // ── LIGHTS ────────────────────────────────────────────────────────
    const lightMat = new THREE.MeshStandardMaterial({
      color: 0xdddddd, emissive: 0xb0c4d8, emissiveIntensity: 0.5, roughness: 0.3,
    });
    this._headlightMat = lightMat;
    const tailMat = new THREE.MeshStandardMaterial({
      color: 0x55060a, emissive: 0x990a10, emissiveIntensity: 0.7, roughness: 0.3,
    });
    for (const sx of [-1, 1]) {
      mk(new THREE.BoxGeometry(0.34, 0.09, 0.05), lightMat, sx * 0.62, 0.04, -2.17);
      mk(new THREE.BoxGeometry(0.07, 0.09, 0.18), paint, sx * 0.88, 0.30, -0.62); // mirror
      mk(new THREE.BoxGeometry(0.015, 0.05, 3.40),
        new THREE.MeshStandardMaterial({ color: V.accent, roughness: 0.4 }),
        sx * 0.845, -0.245, 0);
    }
    mk(new THREE.BoxGeometry(1.54, 0.07, 0.04), tailMat, 0, rearY - 0.20, 2.16);

    // ── ROCKER PANELS ─────────────────────────────────────────────────
    for (const sx of [-1, 1]) mk(new THREE.BoxGeometry(0.07, 0.09, 2.35), dark, sx * 0.80, -0.315, 0.05);

    // ── EXHAUST ───────────────────────────────────────────────────────
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.9, roughness: 0.3 });
    const pipeGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.10, 10);
    pipeGeo.rotateX(Math.PI / 2);
    for (const px of (V.wing === 'gt' ? [-0.10, 0.10] : [-0.56, 0.56])) {
      mk(pipeGeo, pipeMat, px, -0.22, 2.14);
    }

    // ── SHARK FIN ─────────────────────────────────────────────────────
    mk(new THREE.BoxGeometry(0.035, 0.055, 0.16), dark, 0, roofY + 0.085, 0.85);

    // ── WING / SPOILER ────────────────────────────────────────────────
    if (V.wing === 'gt') {
      mk(new THREE.BoxGeometry(1.46, 0.030, 0.38), dark, 0, rearY + 0.34, 1.90, -0.10);
      for (const sx of [-1, 1]) {
        mk(new THREE.BoxGeometry(0.045, 0.32, 0.18), dark, sx * 0.45, rearY + 0.20, 1.84, 0.25);
        mk(new THREE.BoxGeometry(0.06, 0.24, 0.38), dark, sx * 0.73, rearY + 0.345, 1.90, -0.10);
      }
    } else {
      mk(new THREE.BoxGeometry(1.32, 0.035, 0.30), paint, 0, rearY + 0.14, 1.95);
      for (const sx of [-1, 1]) mk(new THREE.BoxGeometry(0.05, 0.12, 0.16), dark, sx * 0.5, rearY + 0.06, 1.98);
    }

    this._buildWheels(0.26);
  }

  // four spinning wheel groups (positioned each frame in update)
  _buildWheels(tireW) {
    this.wheelMeshes = [];
    const R = this.spec.wheels.radius;

    // tire (rubber)
    const tireGeo = new THREE.CylinderGeometry(R, R, tireW, 28);
    tireGeo.rotateZ(Math.PI / 2);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x16181a, roughness: 0.94, metalness: 0.0 });

    // alloy rim face (inner disc behind spokes)
    const rimFaceGeo = new THREE.CylinderGeometry(R * 0.50, R * 0.50, tireW * 0.72, 22);
    rimFaceGeo.rotateZ(Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc8cdd4, metalness: 0.92, roughness: 0.14, envMapIntensity: 2.8 });

    // 5-spoke wheel spokes (boxes in Y–Z plane, rotated around X/wheel-axle)
    const spokeGeo = new THREE.BoxGeometry(tireW * 0.38, 0.042, R * 0.82);
    const spokeMat = new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.88, roughness: 0.18 });

    // brake disc (vented disc, visible through spokes)
    const discGeo = new THREE.CylinderGeometry(R * 0.62, R * 0.62, 0.030, 20);
    discGeo.rotateZ(Math.PI / 2);
    const discMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.78, roughness: 0.32 });

    // hub center cap
    const capGeo = new THREE.CylinderGeometry(R * 0.11, R * 0.11, tireW * 0.78, 14);
    capGeo.rotateZ(Math.PI / 2);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x18191c, metalness: 0.4, roughness: 0.6 });

    // caliper (red, stationary on grp not spin)
    const calGeo = new THREE.BoxGeometry(0.09, R * 0.48, 0.12);
    const calMat = new THREE.MeshStandardMaterial({ color: 0xcc1800, metalness: 0.52, roughness: 0.45 });

    for (let i = 0; i < 4; i++) {
      const grp = new THREE.Group();
      const spin = new THREE.Group();

      spin.add(new THREE.Mesh(tireGeo, tireMat));
      spin.add(new THREE.Mesh(discGeo, discMat));
      spin.add(new THREE.Mesh(rimFaceGeo, rimMat));
      spin.add(new THREE.Mesh(capGeo, capMat));

      // 5 spokes radiating in the Y–Z plane (wheel axle = X after tireGeo.rotateZ)
      for (let s = 0; s < 5; s++) {
        const ang = (s / 5) * Math.PI * 2;
        const spoke = new THREE.Mesh(spokeGeo, spokeMat);
        // box depth (Z) is the spoke length — rotate around X to point outward at angle
        spoke.rotation.x = ang;
        // shift position to midpoint of the spoke in Y–Z plane
        spoke.position.y = Math.sin(ang) * R * 0.41;
        spoke.position.z = Math.cos(ang) * R * 0.41;
        spin.add(spoke);
      }

      grp.add(spin);
      grp.userData.spin = spin;

      // brake caliper is NOT part of spin (doesn't rotate with wheel)
      const cal = new THREE.Mesh(calGeo, calMat);
      cal.position.set(0, -R * 0.50, 0);  // lower rear of wheel
      grp.add(cal);

      this.exterior.add(grp);
      this.wheelMeshes.push(grp);
    }
  }

  // ---------------------------------------------------------------- open-wheel exteriors
  // Go-kart: low flat frame, exposed wheels, seat, sidepods, bumpers.
  _buildKart() {
    const V = this.spec.visual;
    const paint = new THREE.MeshPhysicalMaterial({ color: V.color, metalness: 0.6, roughness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.06, envMapIntensity: 2.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.7 });
    const e = this.exterior;
    const W = this.spec.wheels;
    // chassis floor pan
    const floor = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 1.5), dark);
    floor.position.set(0, -0.16, 0.05); floor.castShadow = true; e.add(floor);
    // front fairing (nose)
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.16, 0.36), paint);
    nose.position.set(0, -0.10, -0.95); e.add(nose);
    // side pods
    for (const sgn of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.20, 0.85), paint);
      pod.position.set(sgn * 0.46, -0.08, 0.05); e.add(pod);
    }
    // seat (bucket)
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.34, 0.42), dark);
    seat.position.set(0, 0.05, 0.30); e.add(seat);
    const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.40, 0.10), dark);
    seatBack.position.set(0, 0.10, 0.52); e.add(seatBack);
    // steering column + small wheel (visible from chase)
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6), dark);
    col.position.set(0, 0.05, -0.30); col.rotation.x = 0.7; e.add(col);
    // rear bumper + engine block on the right
    const eng = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.3), dark);
    eng.position.set(0.34, 0.0, 0.62); e.add(eng);
    const rearBar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.05), dark);
    rearBar.position.set(0, -0.05, 0.86); e.add(rearBar);
    this._buildWheels(0.16);
    this._headlightMat = null;
  }

  // Formula car: long nose, raised airbox, big front+rear wings, halo, exposed wheels.
  _buildFormula() {
    const V = this.spec.visual;
    const paint = new THREE.MeshPhysicalMaterial({ color: V.color, metalness: 0.70, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 3.0 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x121418, roughness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({ color: V.accent, roughness: 0.5 });
    const e = this.exterior;
    // monocoque tub
    const tub = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.34, 2.6), paint);
    tub.position.set(0, -0.05, 0.2); tub.castShadow = true; e.add(tub);
    // long tapering nose
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.22, 1.5, 8), paint);
    nose.rotation.x = Math.PI / 2; nose.position.set(0, -0.12, -1.9); e.add(nose);
    // sidepods
    for (const sgn of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.30, 1.3), paint);
      pod.position.set(sgn * 0.62, -0.04, 0.45); e.add(pod);
    }
    // airbox behind the driver
    const airbox = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.7), paint);
    airbox.position.set(0, 0.34, 1.25); airbox.castShadow = true; e.add(airbox);
    // halo
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.035, 8, 16, Math.PI), dark);
    halo.rotation.x = -0.5; halo.position.set(0, 0.30, 0.15); e.add(halo);
    const haloPost = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 6), dark);
    haloPost.position.set(0, 0.18, -0.35); e.add(haloPost);
    // front wing
    const fw = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.04, 0.5), accent);
    fw.position.set(0, -0.28, -2.55); e.add(fw);
    for (const sgn of [-1, 1]) {
      const ep = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.5), dark);
      ep.position.set(sgn * 0.86, -0.18, -2.55); e.add(ep);
    }
    // rear wing (tall)
    const rw = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.05, 0.42), accent);
    rw.position.set(0, 0.5, 2.35); rw.castShadow = true; e.add(rw);
    for (const sgn of [-1, 1]) {
      const ep = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.42, 0.42), dark);
      ep.position.set(sgn * 0.52, 0.34, 2.35); e.add(ep);
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.4, 0.1), dark);
      pylon.position.set(sgn * 0.2, 0.3, 2.4); e.add(pylon);
    }
    // diffuser
    const diff = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.3), dark);
    diff.position.set(0, -0.26, 2.2); e.add(diff);
    this._buildWheels(0.35);
    this._headlightMat = null;
  }

  // ---------------------------------------------------------------- cockpit
  _buildCockpit() {
    const V = this.spec.visual;
    const cp = this.cockpit;
    const padMat = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.92 });
    const graphite = new THREE.MeshStandardMaterial({ color: 0x2c313a, roughness: 0.75 });
    const darker = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.85 });
    const accentMat = new THREE.MeshStandardMaterial({
      color: V.accent, roughness: 0.5, emissive: V.accent, emissiveIntensity: 0.15,
    });

    const open = this.type !== 'road';   // kart / formula = open cockpit (no cabin)
    const drvX = open ? 0 : -0.37;        // centered driver in open-wheel cars

    if (!open) {
      // hood
      const hoodGeo = new THREE.PlaneGeometry(1.78, 1.35, 8, 4);
      const hp = hoodGeo.attributes.position;
      for (let i = 0; i < hp.count; i++) {
        const x = hp.getX(i), y = hp.getY(i);
        hp.setZ(i, -0.10 * (y + 0.675) - 0.18 * (x * x) / 0.8);
      }
      hoodGeo.computeVertexNormals();
      const hood = new THREE.Mesh(hoodGeo, new THREE.MeshPhysicalMaterial({
        color: V.color, metalness: 0.72, roughness: 0.16, clearcoat: 1.0, clearcoatRoughness: 0.04, envMapIntensity: 3.2,
      }));
      hood.rotation.x = -Math.PI / 2 + 0.06;
      hood.position.set(0, 0.42, -1.62);
      cp.add(hood);

      // layered dash: soft top pad / mid roll / lower panel + accent line
      const dashTop = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.07, 0.36), padMat);
      dashTop.position.set(0, 0.515, -1.02);
      cp.add(dashTop);
      const dashMid = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.17, 0.30), graphite);
      dashMid.position.set(0, 0.41, -0.95);
      dashMid.rotation.x = 0.10;
      cp.add(dashMid);
      const dashLow = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.20, 0.24), darker);
      dashLow.position.set(0, 0.27, -0.90);
      cp.add(dashLow);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.012, 0.015), accentMat);
      trim.position.set(0, 0.475, -0.832);
      cp.add(trim);

      for (const x of [-0.62, 0.62]) {
        const vent = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.06, 0.02),
          new THREE.MeshStandardMaterial({ color: 0x0b0d11, roughness: 0.6 }));
        vent.position.set(x, 0.46, -0.845);
        cp.add(vent);
      }
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.15),
        new THREE.MeshBasicMaterial({ map: screenTexture() }));
      screen.position.set(0.02, 0.46, -0.838);
      screen.rotation.x = -0.08;
      cp.add(screen);
      const stack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.06), darker);
      stack.position.set(0.02, 0.30, -0.86);
      cp.add(stack);
    }

    // gauge cluster — on the dash (road) or on a small steering-column pod (open)
    const cluster = new THREE.Group();
    // open cars: gauges sit low on/just above the wheel (F1-style, on-wheel
    // display) well below the sightline so the track ahead is clear.
    if (open) {
      // gauges sit on the wheel, ~0.5 m ahead and below the eye — in the lower
      // third of the view (visible) without blocking the track ahead.
      cluster.position.set(drvX, this.eyeLocal.y - 0.20, this.eyeLocal.z - 0.48);
      cluster.scale.setScalar(0.55);
      cluster.rotation.x = -0.5;
    } else {
      cluster.position.set(drvX, 0.52, -0.86);
      cluster.rotation.x = -0.30;
    }
    const backing = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.26, 0.03), darker);
    backing.position.set(0.07, 0, -0.018);
    cluster.add(backing);
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.05, 0.06), padMat);
    bezel.position.set(0.07, 0.145, -0.01);
    cluster.add(bezel);

    const D = this.spec;
    const tachTex = dialTexture('RPM x1000', D.dialMax, 1, D.dialRed);
    const spdTex = dialTexture('km/h', D.dialSpeed, 50, null);
    const mkDial = (tex, x) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.088, 0.006, 8, 28),
        new THREE.MeshStandardMaterial({ color: 0x3a414c, metalness: 0.6, roughness: 0.4 }));
      ring.position.set(x, 0, 0.002);
      cluster.add(ring);
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.085, 32),
        new THREE.MeshBasicMaterial({ map: tex }));
      d.position.set(x, 0, 0);
      cluster.add(d);
      const needle = new THREE.Mesh(new THREE.BoxGeometry(0.007, 0.075, 0.004),
        new THREE.MeshBasicMaterial({ color: 0xff5040 }));
      needle.geometry.translate(0, 0.030, 0);
      needle.position.set(x, 0, 0.006);
      cluster.add(needle);
      const cap = new THREE.Mesh(new THREE.CircleGeometry(0.012, 12),
        new THREE.MeshBasicMaterial({ color: 0x0c0e12 }));
      cap.position.set(x, 0, 0.008);
      cluster.add(cap);
      return needle;
    };
    this.needleTach = mkDial(tachTex, -0.105);
    this.needleSpd = mkDial(spdTex, 0.105);

    // shift lights
    this.shiftLeds = [];
    for (let k = 0; k < 5; k++) {
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.013, 0.009, 0.004),
        new THREE.MeshBasicMaterial({ color: 0x1c2024 }));
      led.position.set(-0.044 + k * 0.022, 0.118, 0.004);
      led.userData.onColor = k < 3 ? 0x2bdd55 : 0xff2418;
      cluster.add(led);
      this.shiftLeds.push(led);
    }
    this.tcLamp = new THREE.Mesh(new THREE.CircleGeometry(0.0085, 12),
      new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
    this.tcLamp.position.set(0.155, 0.095, 0.004);
    this.tcLamp.visible = false;
    cluster.add(this.tcLamp);

    // big gear indicator LCD — right of the speed dial, clear of the wheel
    this.digCanvas = document.createElement('canvas');
    this.digCanvas.width = 128; this.digCanvas.height = 128;
    this.digTex = new THREE.CanvasTexture(this.digCanvas);
    const dig = new THREE.Mesh(new THREE.PlaneGeometry(0.105, 0.105),
      new THREE.MeshBasicMaterial({ map: this.digTex }));
    dig.position.set(0.305, 0.035, 0.012);
    dig.rotation.y = -0.35;                 // tilt toward the driver's eye
    cluster.add(dig);
    cp.add(cluster);

    // ---- steering wheel (flat bottom) + paddles + hands
    this.wheelGroup = new THREE.Group();
    this.wheelGroup.position.set(drvX, open ? this.eyeLocal.y - 0.26 : 0.45, open ? this.eyeLocal.z - 0.50 : -0.70);
    this.wheelGroup.rotation.x = open ? -0.5 : -0.42;   // open cars: wheel ~0.5m ahead, lower third of view
    if (open) this.wheelGroup.scale.setScalar(0.82);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.7 });
    this.wheelSpin = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.175, 0.021, 12, 36, Math.PI * 1.72), rimMat);
    rim.rotation.z = Math.PI / 2 + (Math.PI * 2 - Math.PI * 1.72) / 2;
    this.wheelSpin.add(rim);
    const flatBar = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.034, 0.030), rimMat);
    flatBar.position.set(0, -0.165, 0);
    this.wheelSpin.add(flatBar);
    for (const a of [Math.PI / 2, -Math.PI / 2, Math.PI]) {     // 3-9-6 spokes
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.13, 0.014), graphite);
      spoke.position.set(Math.sin(a) * 0.092, -Math.cos(a) * 0.092, 0);
      spoke.rotation.z = a;
      this.wheelSpin.add(spoke);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.045, 18), graphite);
    hub.rotation.x = Math.PI / 2;
    this.wheelSpin.add(hub);
    const marker = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.032, 0.012),
      new THREE.MeshBasicMaterial({ color: V.accent }));
    marker.position.set(0, 0.172, 0);
    this.wheelSpin.add(marker);

    // ---- hands: four articulated fingers + thumb wrapping the rim tube.
    // Built in a canonical frame (rim tube along +y, radial-out +x,
    // driver side +z), then mirrored onto the 9 & 3 grip points.
    // The hands ride wheelSpin (correct grip kinematics); the arms are
    // solved separately with 2-bone IK from fixed shoulder anchors.
    const glove = new THREE.MeshStandardMaterial({ color: 0x4a515c, roughness: 0.88 });
    const gloveDark = new THREE.MeshStandardMaterial({ color: 0x343a43, roughness: 0.9 });
    const knuckleMat = new THREE.MeshStandardMaterial({ color: V.accent, roughness: 0.6 });
    this.wristAnchors = [];
    const buildHand = () => {
      const h = new THREE.Group();
      // smooth back-of-hand mass (ellipsoid) hugging the outside of the rim
      const back = new THREE.Mesh(new THREE.SphereGeometry(0.034, 12, 10), glove);
      back.position.set(0.040, 0.002, 0.010);
      back.scale.set(0.80, 1.55, 1.05);
      h.add(back);
      // racing-glove knuckle accent strip
      const knuckle = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.085, 0.022), knuckleMat);
      knuckle.position.set(0.062, 0.006, 0.002);
      knuckle.rotation.y = 0.10;
      h.add(knuckle);
      const heel = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), glove);
      heel.position.set(0.040, -0.060, 0.018);
      heel.scale.set(0.85, 1.0, 0.95);
      h.add(heel);
      // four fingers: short arcs over the FAR side of the rim only — from the
      // driver seat you see knuckles + fingertips peeking past the tube
      for (let f = 0; f < 4; f++) {
        const r = 0.0290 - f * 0.0010;
        const arc = 2.35;
        const geo = new THREE.TorusGeometry(r, 0.0105, 7, 10, arc);
        geo.rotateZ(0.30);
        geo.rotateX(-Math.PI / 2);               // wrap from knuckles to far side
        const y = 0.043 - f * 0.0215;
        const finger = new THREE.Mesh(geo, glove);
        finger.position.set(0.006, y, 0);
        h.add(finger);
        // rounded fingertip closing the open arc end
        const endA = 0.30 + arc;
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0105, 8, 6), glove);
        tip.position.set(0.006 + Math.cos(endA) * r, y, -Math.sin(endA) * r);
        h.add(tip);
      }
      // thumb: lies ALONG the rim on the near side, pointing up the wheel
      const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.0115, 0.055, 4, 8), gloveDark);
      thumb.position.set(-0.014, -0.018, 0.028);
      thumb.rotation.z = -0.18;
      thumb.rotation.x = 0.25;
      h.add(thumb);
      // wrist: smooth bridge from the heel toward the forearm
      const wrist = new THREE.Mesh(new THREE.CapsuleGeometry(0.026, 0.055, 4, 9), gloveDark);
      wrist.position.set(0.052, -0.052, 0.034);
      wrist.rotation.z = 0.55;
      wrist.rotation.x = -0.65;
      h.add(wrist);
      // IK target: where the forearm meets the hand
      const anchor = new THREE.Object3D();
      anchor.position.set(0.062, -0.055, 0.058);
      h.add(anchor);
      return { h, anchor };
    };
    for (const sgn of [-1, 1]) {
      const { h, anchor } = buildHand();
      // grips slightly above 9-and-3 (more visible from the driver's eye)
      const lift = 0.32;                                        // ~18 deg up
      const ang = sgn === -1 ? Math.PI - lift : lift;
      h.rotation.z = ang;
      h.position.set(Math.cos(ang) * 0.175, Math.sin(ang) * 0.175, 0.014);
      this.wheelSpin.add(h);
      this.wristAnchors.push(anchor);
    }
    this.wheelGroup.add(this.wheelSpin);

    // ---- arms: 2-bone IK (shoulder fixed to the seat, elbow via pole)
    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.92 });
    this.arms = [];
    const shY = open ? this.eyeLocal.y - 0.06 : 0.61;
    const shZ = open ? this.eyeLocal.z + 0.16 : -0.07;
    this.shoulders = [
      new THREE.Vector3(drvX - 0.19, shY, shZ),  // left
      new THREE.Vector3(drvX + 0.19, shY, shZ),  // right
    ];
    this.armLen = [0.34, 0.34];                   // upper, forearm
    for (let i = 0; i < 2; i++) {
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.043, 0.31, 4, 8), sleeveMat);
      const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.036, 0.31, 4, 8), sleeveMat);
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.044, 10, 8), sleeveMat);
      cp.add(upper, fore, elbow);
      this.arms.push({ upper, fore, elbow });
    }
    this._ikTmp = {
      w: new THREE.Vector3(), d: new THREE.Vector3(), perp: new THREE.Vector3(),
      pole: new THREE.Vector3(), e: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
      q: new THREE.Quaternion(), m: new THREE.Vector3(),
    };

    // paddles
    for (const sgn of [-1, 1]) {
      const paddle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.10, 0.008), graphite);
      paddle.position.set(sgn * 0.10, 0.01, -0.045);
      this.wheelGroup.add(paddle);
    }
    cp.add(this.wheelGroup);

    // pillars / roof / headliner / visors / glass / doors / seats / console —
    // the enclosed cabin; open-wheel cars (kart/formula) skip all of it.
    if (!open) {
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.8 });
    for (const sgn of [-1, 1]) {
      const pil = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.85, 0.08), pillarMat);
      pil.position.set(sgn * 0.83, 0.78, -0.78);
      pil.rotation.x = 0.42;
      pil.rotation.z = sgn * 0.12;
      cp.add(pil);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.05, 1.3), pillarMat);
    roof.position.set(0, 1.15, -0.02);
    cp.add(roof);
    const headliner = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.012, 1.26),
      new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.95 }));
    headliner.position.set(0, 1.12, -0.02);
    cp.add(headliner);
    for (const x of [-0.40, 0.40]) {
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.012, 0.17), padMat);
      visor.position.set(x, 1.075, -0.56);
      visor.rotation.x = 0.30;
      cp.add(visor);
    }

    // windshield
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.62, 0.78),
      new THREE.MeshBasicMaterial({ color: 0x88aabb, transparent: true, opacity: 0.06, depthWrite: false }));
    glass.position.set(0, 0.80, -0.80);
    glass.rotation.x = 0.40;
    cp.add(glass);

    // door cards + armrests
    for (const sgn of [-1, 1]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.46, 1.9), graphite);
      door.position.set(sgn * 0.865, 0.40, 0.05);
      cp.add(door);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.05, 0.65), padMat);
      arm.position.set(sgn * 0.82, 0.34, -0.05);
      cp.add(arm);
    }

    // bolstered sport seats
    for (const x of [-0.37, 0.37]) {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.13, 0.48), darker);
      base.position.set(x, 0.12, 0.25);
      cp.add(base);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.60, 0.11), darker);
      back.position.set(x, 0.44, 0.52);
      back.rotation.x = -0.12;
      cp.add(back);
      for (const sgn of [-1, 1]) {
        const bol = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.52, 0.15), padMat);
        bol.position.set(x + sgn * 0.20, 0.42, 0.50);
        bol.rotation.x = -0.12;
        bol.rotation.z = -sgn * 0.10;
        cp.add(bol);
      }
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.15, 0.09), darker);
      head.position.set(x, 0.82, 0.56);
      cp.add(head);
      const stitch = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.50, 0.115), accentMat);
      stitch.position.set(x, 0.43, 0.523);
      stitch.rotation.x = -0.12;
      cp.add(stitch);
    }

    // center console + rear shelf (closes the cabin)
    const console_ = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.22, 0.9), graphite);
    console_.position.set(0, 0.18, -0.30);
    cp.add(console_);
    const shifter = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.12, 8), darker);
    shifter.position.set(0, 0.34, -0.18);
    cp.add(shifter);
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.05, 0.5), darker);
    shelf.position.set(0, 0.55, 0.95);
    cp.add(shelf);
    }

    // rear-view mirror (the road car shows a center mirror; open cars don't,
    // but the material/RT is always created so renderMirror stays valid)
    this.mirrorMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    if (!open) {
      const mirFrame = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.11, 0.025), padMat);
      mirFrame.position.set(0, 1.02, -0.60);
      mirFrame.rotation.x = -0.10;
      cp.add(mirFrame);
      const mir = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.088), this.mirrorMat);
      mir.position.set(0, 1.02, -0.586);
      mir.rotation.x = -0.10;
      cp.add(mir);
    }

    if (open) this._buildOpenBodywork(cp, V);
  }

  // What an open-wheel driver actually sees from the seat: the nose/bodywork
  // ahead and below, cockpit sides, and (F1) the halo splitting the view.
  _buildOpenBodywork(cp, V) {
    const ey = this.eyeLocal.y, ez = this.eyeLocal.z;
    const paint = new THREE.MeshStandardMaterial({ color: V.color, metalness: 0.3, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.7 });
    if (this.type === 'formula') {
      // nose deck stretching far ahead and dropping away — well below sightline
      const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.22, 2.2, 10), paint);
      nose.rotation.x = Math.PI / 2;
      nose.position.set(0, ey - 0.62, ez - 1.55);
      cp.add(nose);
      // cockpit coaming (survival-cell rim) low at the driver's sides
      for (const sgn of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 1.0), paint);
        rail.position.set(sgn * 0.36, ey - 0.24, ez - 0.10);
        cp.add(rail);
      }
      // halo: side mounts + ring arcing overhead (above the sightline, no center bar in view)
      for (const sgn of [-1, 1]) {
        const mnt = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.40, 8), dark);
        mnt.position.set(sgn * 0.33, ey + 0.06, ez - 0.30);
        mnt.rotation.x = 0.3;
        cp.add(mnt);
      }
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.028, 8, 20, Math.PI), dark);
      ring.rotation.x = -0.5;
      ring.position.set(0, ey + 0.30, ez - 0.30);
      cp.add(ring);
    } else { // kart
      // front fairing / nose cone ahead and low
      const fairing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.42), paint);
      fairing.position.set(0, ey - 0.60, ez - 1.0);
      cp.add(fairing);
      const floor = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.04, 1.2), dark);
      floor.position.set(0, ey - 0.6, ez - 0.35);
      cp.add(floor);
      // steering column down to the wheel
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.42, 6), dark);
      col.position.set(0, ey - 0.46, ez - 0.40);
      col.rotation.x = 0.62;
      cp.add(col);
    }
  }

  setCameraMode(mode) {
    this.mode = mode;
    this.cockpit.visible = mode === 0;
    this.exterior.visible = mode === 2;
  }

  // place a capsule (axis +y, native length L) between two cockpit-space points
  _seg(mesh, a, b, baseLen) {
    const T = this._ikTmp;
    T.m.copy(a).add(b).multiplyScalar(0.5);
    mesh.position.copy(T.m);
    T.d.copy(b).sub(a);
    const len = T.d.length();
    mesh.quaternion.setFromUnitVectors(T.up, T.d.normalize());
    mesh.scale.set(1, Math.max(0.3, len / baseLen), 1);
  }

  _solveArms() {
    if (!this.cockpit.visible) return;
    const T = this._ikTmp;
    const [L1, L2] = this.armLen;
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      const sgn = i === 0 ? -1 : 1;
      // wrist target: hand anchor -> cockpit-local
      T.w.setFromMatrixPosition(this.wristAnchors[i].matrixWorld);
      this.cockpit.worldToLocal(T.w);
      const sh = this.shoulders[i];
      T.d.copy(T.w).sub(sh);
      // NOTE: T.w (the real wrist) is never moved — if the target is out of
      // reach we solve the elbow at full extension and let the forearm
      // stretch to the hand, so the arm can never visibly detach.
      let dist = Math.min(T.d.length(), L1 + L2 - 0.02);
      T.d.normalize();
      // elbow pole: down and slightly outward (natural driving posture)
      T.pole.set(sgn * 0.45, -1, 0.1).normalize();
      T.perp.copy(T.pole).addScaledVector(T.d, -T.pole.dot(T.d));
      if (T.perp.lengthSq() < 1e-6) T.perp.set(0, -1, 0);
      T.perp.normalize();
      const cosA = THREE.MathUtils.clamp(
        (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
      const sinA = Math.sqrt(1 - cosA * cosA);
      T.e.copy(sh).addScaledVector(T.d, cosA * L1).addScaledVector(T.perp, sinA * L1);
      const arm = this.arms[i];
      this._seg(arm.upper, sh, T.e, 0.31 + 0.086);
      arm.elbow.position.copy(T.e);
      this._seg(arm.fore, T.e, T.w, 0.31 + 0.072);
    }
  }

  update(vehicle, dtVis) {
    this.root.position.copy(vehicle.pos);
    this.root.quaternion.copy(vehicle.quat);

    // wheel turns with the ACTUAL steering angle x typical 13:1 column ratio,
    // clamped so the hands never cross over awkwardly
    const realAngle = vehicle.ctrl.steer * vehicle.maxSteerAngle();
    this.wheelSpin.rotation.z = THREE.MathUtils.clamp(-realAngle * 13, -2.6, 2.6);
    this._solveArms();

    const a0 = Math.PI * 200 / 180, a1 = -Math.PI * 20 / 180;
    const rpmF = Math.min(vehicle.rpm / (this.spec.dialMax * 1000), 1);
    const spdF = Math.min(vehicle.speedKmh / this.spec.dialSpeed, 1);
    this.needleTach.rotation.z = (a0 + (a1 - a0) * rpmF) - Math.PI / 2;
    this.needleSpd.rotation.z = (a0 + (a1 - a0) * spdF) - Math.PI / 2;

    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheels[i];
      const g = this.wheelMeshes[i];
      g.position.set(w.x, w.attachY - w.restLen + w.comp - 0.12, w.z);
      g.rotation.y = -w.steer;
      g.userData.spin.rotation.x = -w.spinAngle;
    }

    // shift lights scale with the car's redline
    const redline = this.spec.engine.redline;
    const blink = (performance.now() * 0.012 | 0) % 2 === 0;
    // map the 5 lights to END just as the (full-throttle) upshift fires at
    // redline-80, so the last LED lights right before the shift instead of ~800
    // rpm early — no "lights full, still not shifting" dead zone.
    const atLimiter = vehicle.rpm > redline - 80;
    const start = redline * 0.85, step = (redline - 80 - redline * 0.85) / 4;
    for (let k = 0; k < 5; k++) {
      const led = this.shiftLeds[k];
      const on = atLimiter ? blink : vehicle.rpm > start + k * step;
      led.material.color.set(on ? led.userData.onColor : 0x1c2024);
    }
    this.tcLamp.visible =
      (vehicle.tcCut > 0.04 || (vehicle._absActive && vehicle.ctrl.brake > 0.3)) && blink;

    this._digTimer = (this._digTimer || 0) + dtVis;
    if (this._digTimer > 0.08) {
      this._digTimer = 0;
      const g = this.digCanvas.getContext('2d');
      const rl = vehicle.spec.engine.redline;
      const hot = vehicle.rpm > rl * 0.92;
      const limiter = vehicle.rpm > rl - 150;
      g.fillStyle = '#081a14'; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = '#1d3a30'; g.lineWidth = 3; g.strokeRect(2, 2, 124, 124);
      // gear: huge digit, amber near redline, red flash at the limiter
      g.fillStyle = limiter ? (blink ? '#ff2418' : '#7a1410')
                  : hot ? '#ffb024' : '#5cf0ae';
      g.font = 'bold 96px "Arial Black", Arial';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(vehicle.gearLabel, 64, 56);
      g.fillStyle = '#9fd8c2'; g.font = 'bold 24px monospace';
      g.fillText(String(Math.round(vehicle.speedKmh)), 64, 112);
      this.digTex.needsUpdate = true;
    }
  }

  renderMirror(renderer, scene, vehicle) {
    if (this.mode !== 0) return;
    const eye = this.eyeLocal.clone().applyQuaternion(vehicle.quat).add(vehicle.pos);
    this.mirrorCam.position.copy(eye);
    const back = new THREE.Vector3(0, 0.04, 1).applyQuaternion(vehicle.quat);
    this.mirrorCam.lookAt(eye.clone().add(back));
    const vis = this.cockpit.visible;
    this.cockpit.visible = false;
    this.exterior.visible = false;
    renderer.setRenderTarget(this.mirrorRT);
    renderer.render(scene, this.mirrorCam);
    renderer.setRenderTarget(null);
    this.cockpit.visible = vis;
    this.exterior.visible = this.mode === 2;
  }
}
