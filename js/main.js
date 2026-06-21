// Boot + game loop: fixed-step physics (240 Hz), camera rigs, HUD, audio.
import * as THREE from 'three';
import { TRACK as T_NORD } from './track_data.js';
import { TRACK as T_SPA } from './tracks/spa.js';
import { TRACK as T_PRAC } from './tracks/practice.js';
import { TRACK as T_KART } from './tracks/kart.js';
import { DEM } from './dem_data.js';
import { setDem, demHeight } from './terrain.js';
import { trackMeta } from './tracks/index.js';
import { showMenu } from './menu.js';
import { CarBuilder } from './builder.js';
import { Track, setTrackWidth } from './track.js';
import { Vehicle, DT, setWeatherGrip } from './physics.js';
import { buildWorld, groundHeightAt } from './world.js';
import { Atmosphere } from './atmo.js';
import { Rain } from './rain.js';
import { Post } from './post.js';
import { CarVisual } from './car.js';
import { Input } from './input.js';
import { TouchInput, isTouchDevice, showStartOverlay } from './touch.js';
import { TIERS, detectTier, AutoQuality } from './quality.js';
import { CARS, savedCarId } from './cars.js';
import { SettingsPanel } from './settings.js';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { SURF } from './track.js';
import { CarAudio } from './audio.js';
import { Hud } from './hud.js';
import { Ghost } from './ghost.js';
import { RaceLine } from './raceline.js';

const TRACK_DATA = { nordschleife: T_NORD, spa: T_SPA, practice: T_PRAC, kart: T_KART };
const _savedTrack = localStorage.getItem('ns-track');
// a saved hidden/removed track (e.g. kart) falls back to the default
const trackId = (_savedTrack && TRACK_DATA[_savedTrack] && !trackMeta(_savedTrack).hidden)
  ? _savedTrack : 'nordschleife';
const TRACK = TRACK_DATA[trackId] || T_NORD;
const tMeta = trackMeta(trackId);
setTrackWidth(TRACK.roadHalf || 4.5);               // narrow kart track, wide road circuits
setDem(trackId === 'nordschleife' ? DEM : null);   // real DEM only for the 'Ring
const track = new Track(TRACK);

const TOUCH = isTouchDevice();
const tierName = detectTier();
const TIER = TIERS[tierName];

const renderer = new THREE.WebGLRenderer({
  antialias: TIER.msaa === 0,          // composer tiers get MSAA via render target
  powerPreference: 'high-performance',
});
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, TIER.pr));
renderer.shadowMap.enabled = TIER.shadow > 0;
renderer.shadowMap.type = TIER.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
renderer.domElement.style.touchAction = 'none';  // prevent browser scroll/zoom eating touch events

const scene = new THREE.Scene();
const atmo = new Atmosphere(scene, renderer, { shadow: TIER.shadow, farScale: TIER.farScale });
const world = buildWorld(scene, track, { trees: TIER.trees, aniso: TIER.aniso });
const roadMat = world.roadMat;
const streetlights = world.streetlights;

// rain + a small pool of moving street-lamp lights (placed near the car)
const rain = new Rain(scene, renderer, Math.floor(5200 * (TIER.trees || 1)));
const lampLights = [];
for (let i = 0; i < (TIER.shadow > 0 ? 6 : 4); i++) {
  const pl = new THREE.PointLight(0xffd9a0, 0, 28, 2);
  scene.add(pl); lampLights.push(pl);
}
const lampBest = lampLights.map(() => ({ d: Infinity, i: -1 }));
let lampsActive = false;
const _roadColor0 = roadMat.color.clone();

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.06, 24000);
const post = new Post(renderer, scene, camera, TIER);
const autoQ = new AutoQuality(tierName, renderer, post, [
  { label: 'Mirror OFF', run: () => { TIER.mirror = 0; } },
]);

const SPAWN_S = tMeta.spawn;   // per-track start position
let carId = savedCarId();
let vehicle = new Vehicle(track, CARS[carId]);
vehicle.reset(SPAWN_S);

let carVis = new CarVisual(scene, renderer, CARS[carId]);
const input = TOUCH ? new TouchInput() : new Input();
const audio = new CarAudio();
const hud = new Hud(track, trackId);
const ghost = new Ghost(scene, track, trackId);
hud.ghost = ghost;
const raceLine = new RaceLine(scene, track);

let camMode = 0;     // 0 cockpit, 1 hood, 2 chase
carVis.setCameraMode(camMode);
let paused = false;

input.onKey = code => {
  const firstStart = !audio.started;
  audio.start();
  if (firstStart) audio.setEngine(CARS[carId]);
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  if (code.startsWith('__mode:')) {
    hud.flash(code.endsWith('tilt') ? 'Tilt steering — tilt the phone like a wheel' : 'Button steering');
    return;
  }
  switch (code) {
    case 'KeyR':
      recoverToTrack();
      break;
    case 'KeyC':
      camMode = (camMode + 1) % 3;
      carVis.setCameraMode(camMode);
      updateCamBtn();
      break;
    case 'ShiftLeft': case 'ShiftRight': case 'ArrowUp':
      if (!vehicle.auto) vehicle.shiftUp();
      break;
    case 'ControlLeft': case 'ControlRight': case 'ArrowDown':
      if (!vehicle.auto) vehicle.shiftDown();
      break;
    case 'KeyM':
      vehicle.auto = !vehicle.auto;
      if (vehicle.gear < 1) vehicle.gear = 1;
      if (TOUCH) input.setManual(!vehicle.auto);
      hud.flash(vehicle.auto ? 'AUTOMATIC' : 'MANUAL — ↑ upshift / ↓ downshift, W/S pedals');
      break;
    case 'KeyT':
      vehicle.tc = !vehicle.tc;
      hud.flash('Traction Control ' + (vehicle.tc ? 'ON' : 'OFF'));
      break;
    case 'KeyB':
      vehicle.abs = !vehicle.abs;
      hud.flash('ABS ' + (vehicle.abs ? 'ON' : 'OFF'));
      break;
    case 'KeyH':
      hud.toggleHelp();
      break;
    case 'KeyN':
      hud.flash(atmo.cycle());
      applyNight();
      break;
    case 'KeyG':
      ghost.enabled = !ghost.enabled;
      hud.flash('Ghost ' + (ghost.enabled ? 'ON' : 'OFF') +
        (ghost.hasBest ? '' : ' (set a best lap first)'));
      break;
    case 'KeyL':
      hud.flash('Racing line: ' + raceLine.cycleMode());
      break;
    case 'KeyP': case 'Escape':
      settings.toggle();
      break;
  }
  if (['ArrowUp', 'KeyW'].includes(code)) hud.toggleHelp(false);
};

// environment state (preset) drives headlights, wet road, rain, streetlights, grip
function applyNight() {
  carVis.setHeadlights(atmo.isNight || atmo.rain);
  rain.setActive(atmo.rain);
  audio.setRain(atmo.rain);
  setWeatherGrip(atmo.grip);
  setWetRoad(atmo.wet);
  streetlights.group.visible = atmo.streetlights;
  lampsActive = atmo.streetlights;
  if (!lampsActive) for (const pl of lampLights) pl.intensity = 0;
}

function setWetRoad(on) {
  roadMat.roughness = on ? 0.42 : 0.94;
  roadMat.metalness = on ? 0.12 : 0;
  roadMat.envMapIntensity = on ? 1.5 : 1;
  if (on) roadMat.color.copy(_roadColor0).multiplyScalar(0.5);
  else roadMat.color.copy(_roadColor0);
  roadMat.needsUpdate = true;
}

// place the lamp-light pool on the nearest street lamps each frame
function updateLamps() {
  const hp = streetlights.headPos, cnt = hp.length / 3;
  const px = vehicle.pos.x, pz = vehicle.pos.z;
  for (const b of lampBest) { b.d = Infinity; b.i = -1; }
  for (let k = 0; k < cnt; k++) {
    const dx = hp[k * 3] - px, dz = hp[k * 3 + 2] - pz, d = dx * dx + dz * dz;
    if (d > 3600) continue;                       // 60 m radius
    let mi = 0;
    for (let j = 1; j < lampBest.length; j++) if (lampBest[j].d > lampBest[mi].d) mi = j;
    if (d < lampBest[mi].d) { lampBest[mi].d = d; lampBest[mi].i = k; }
  }
  for (let j = 0; j < lampLights.length; j++) {
    const b = lampBest[j], pl = lampLights[j];
    if (b.i >= 0) { pl.position.set(hp[b.i * 3], hp[b.i * 3 + 1], hp[b.i * 3 + 2]); pl.intensity = 22; }
    else pl.intensity = 0;
  }
}

// ---- car switching (rebuild vehicle + visuals at the same track position)
function setCar(id) {
  if (!CARS[id] || id === carId) return;
  carId = id;
  localStorage.setItem('ns-car', id);
  const s = vehicle.trackS;
  carVis.dispose();
  vehicle = new Vehicle(track, CARS[id]);
  vehicle.reset(s);
  carVis = new CarVisual(scene, renderer, CARS[id]);
  carVis.setCameraMode(camMode);
  carVis.setHeadlights(atmo.isNight || atmo.rain);
  audio.setEngine(CARS[id]);
  lastGear = 1;
  window.__vehicle = vehicle;
  hud.invalidateLap();
  hud.flash(CARS[id].name);
}

// ---- settings panel
const settings = new SettingsPanel({
  isTouch: TOUCH,
  getState: () => ({
    car: carId, cam: camMode, ctrl: TOUCH ? input.mode : 'buttons',
    tc: vehicle.tc, abs: vehicle.abs, auto: vehicle.auto,
    line: raceLine.mode, ghost: ghost.enabled, preset: atmo.idx,
  }),
  setCar,
  setLineMode: m => { raceLine.setMode(m); },
  setCam: i => { camMode = i; carVis.setCameraMode(i); updateCamBtn(); },
  setCtrl: m => { if (TOUCH) input.setMode(m); },
  setPreset: i => { atmo.apply(i); applyNight(); },
  setTier: name => {
    if (name) localStorage.setItem('ns-tier', name);
    else localStorage.removeItem('ns-tier');
    location.reload();
  },
  toggle: name => {
    if (name === 'tc') vehicle.tc = !vehicle.tc;
    else if (name === 'abs') vehicle.abs = !vehicle.abs;
    else if (name === 'auto') { vehicle.auto = !vehicle.auto; if (vehicle.gear < 1) vehicle.gear = 1; if (TOUCH) input.setManual(!vehicle.auto); }
    else if (name === 'ghost') ghost.enabled = !ghost.enabled;
  },
  resetRecords: () => {
    localStorage.removeItem('ns-best2');
    localStorage.removeItem('ns-best-sectors2');
    localStorage.removeItem('ns-ghost2');
    hud.bestLap = null; hud.bestSectors = [null, null, null];
    hud.el.best.textContent = 'BEST  --:--.---';
    ghost.best = null;
    hud.flash('Records cleared');
  },
  setPaused: v => { paused = v; updateAudioGate(); },
  audioLayers: () => audio.layerDefs(),
  audioState: () => audio.layerStates(),
  setAudioLayer: (k, on) => audio.setLayer(k, on),
});

// mute audio when paused (settings open) or when the tab/app is backgrounded
function updateAudioGate() {
  audio.setActive(!paused && !document.hidden);
}
document.addEventListener('visibilitychange', updateAudioGate);
addEventListener('pagehide', () => audio.setActive(false));

// haptics (mobile): curb buzz, rail scrape, gear shifts
let lastHaptic = 0;
let lastGear = 1;
function updateHaptics(now) {
  if (!TOUCH) return;
  const onCurb = vehicle.wheels.some(w => w.contact && w.surf === SURF.CURB);
  const speed = Math.abs(vehicle.speed);
  try {
    if (vehicle.gear !== lastGear) {
      // upshift only (accelerating); no haptic on downshift
      if (vehicle.gear > lastGear && lastGear >= 1) {
        Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
      }
      lastGear = vehicle.gear;
    }
    if (vehicle.landImpact > 0.55) {
      lastHaptic = now;
      Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {});
      return;
    }
    if (now - lastHaptic < 110) return;
    if (vehicle.scrape > 0.25) {
      lastHaptic = now;
      Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {});
    } else if (onCurb && speed > 8) {
      lastHaptic = now;
      Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    }
  } catch (e) { /* web fallback may be unavailable */ }
}

let _resetCooldown = 0;

// recover to track: works upside down, off-track, airborne — always
function recoverToTrack() {
  vehicle.reset(vehicle.trackS);
  _resetCooldown = 1.5;
  hud.invalidateLap();
  hud.flash('Reset to track');
}
const resetBtn = document.getElementById('reset-btn');
resetBtn.addEventListener('click', () => {
  recoverToTrack();
  resetBtn.blur();
  audio.start();
});

const camBtn = document.getElementById('cam-btn');
function updateCamBtn() {
  if (!camBtn) return;
  const is3rd = camMode === 2;
  camBtn.textContent = is3rd ? '🎥 1인칭 (C)' : '🎥 3인칭 (C)';
  camBtn.classList.toggle('active', is3rd);
}
camBtn.addEventListener('click', () => {
  // toggle between 3rd-person (2) and cockpit (0)
  camMode = camMode === 2 ? 0 : 2;
  carVis.setCameraMode(camMode);
  updateCamBtn();
  camBtn.blur();
  audio.start();
});
updateCamBtn();

// reverse handling: holding brake at standstill engages reverse
function autoReverse() {
  if (!vehicle.auto || _resetCooldown > 0) return;
  // use raw input values — vehicle.ctrl is remapped when in reverse so can't use it
  if (input.brake > 0.3 && Math.abs(vehicle.speed) < 2.0 && vehicle.gear === 1) {
    vehicle.gear = -1;
  } else if (vehicle.gear === -1 && input.throttle > 0.3 && vehicle.speed > -1.0) {
    vehicle.gear = 1;
  }
}

// in reverse, swap pedals so DOWN arrow actually backs up
function applyControls() {
  if (vehicle.gear === -1) {
    vehicle.ctrl.throttle = input.brake;
    vehicle.ctrl.brake = input.throttle;
  } else {
    vehicle.ctrl.throttle = input.throttle;
    vehicle.ctrl.brake = input.brake;
  }
  vehicle.ctrl.steer = input.steer;
  vehicle.ctrl.handbrake = input.handbrake;
}

// ---- camera rigs
const headPos = new THREE.Vector3();
const headOffset = new THREE.Vector3();
const camQuatTarget = new THREE.Quaternion();
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
let headLean = new THREE.Vector3();
const chasePos = new THREE.Vector3();
let chaseInit = false;
let _camYaw = 0;          // chase-camera yaw offset for look-around
let _dragLastX = null;    // last pointer X for delta-based orbit
let _flipTime = 0;        // seconds the car has been upside-down

// touch/mouse drag to orbit the chase camera (delta accumulation, not absolute)
{
  const cv = renderer.domElement;
  cv.addEventListener('pointerdown', e => {
    if (camMode !== 2) return;
    _dragLastX = e.clientX;
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (camMode !== 2 || _dragLastX === null) return;
    const dx = (e.clientX - _dragLastX) / window.innerWidth;
    _camYaw -= dx * Math.PI * 4.0;   // 4× = ~1/4 screen swipe = 180°, very responsive
    _dragLastX = e.clientX;
  });
  const endDrag = () => { _dragLastX = null; };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
}

function updateCamera(dtVis) {
  const q = vehicle.quat;

  // auto-recovery: reset car if upside-down for > 3 s
  const bodyUpY = new THREE.Vector3(0, 1, 0).applyQuaternion(q).y;
  if (bodyUpY < -0.7 && Math.abs(vehicle.speed) < 3) {
    _flipTime += dtVis;
    if (_flipTime > 3.0) { recoverToTrack(); _flipTime = 0; hud.flash('Auto-reset: car flipped'); }
  } else { _flipTime = 0; }

  if (camMode === 2) {
    // chase (3rd-person): fixed distance, look-around via drag
    const camDist = 8.0;
    const camH    = 2.4;
    // drift yaw back toward 0 when not dragging
    if (_dragLastX === null) _camYaw *= Math.max(0, 1 - dtVis * 0.25);  // very slow drift back (~4s)
    const sinY = Math.sin(_camYaw), cosY = Math.cos(_camYaw);
    const behind = new THREE.Vector3(camDist * sinY, camH, camDist * cosY)
      .applyQuaternion(q).add(vehicle.pos);
    if (!chaseInit || chasePos.distanceTo(behind) > 40) { chasePos.copy(behind); chaseInit = true; }
    const lerpK = Math.min(1, dtVis * 5.5);
    chasePos.lerp(behind, lerpK);
    const gq = track.query(chasePos.x, chasePos.z, {});
    if (gq) {
      const gy = groundHeightAt(track, gq, chasePos.x, chasePos.z);
      if (chasePos.y < gy + 0.8) chasePos.y = gy + 0.8;
    }
    camera.position.copy(chasePos);
    const look = vehicle.pos.clone().add(new THREE.Vector3(0, 0.5, 0));
    camera.lookAt(look);
    camera.fov = 72;
  } else {
    const eyeLocal = camMode === 0 ? carVis.eyeLocal : new THREE.Vector3(0, 0.55, -1.0);
    // g-force head motion (body frame)
    const gB = vehicle.gForce.clone().applyQuaternion(q.clone().invert());
    const targetLean = new THREE.Vector3(
      THREE.MathUtils.clamp(-gB.x * 0.0035, -0.05, 0.05),
      THREE.MathUtils.clamp(-Math.abs(gB.x) * 0.0006, -0.02, 0.005),
      THREE.MathUtils.clamp(gB.z * 0.0030, -0.06, 0.045));
    headLean.lerp(targetLean, Math.min(1, dtVis * 7));
    headOffset.copy(eyeLocal).add(headLean);
    headPos.copy(headOffset).applyQuaternion(q).add(vehicle.pos);
    camera.position.copy(headPos);
    // cabin vibration: suspension activity + speed buzz + ABS shudder + landing slam.
    // Speed buzz is kept subtle so the rear-view mirror stays readable at speed.
    const v2 = vehicle.speed * vehicle.speed;
    let vib = Math.min(0.006, vehicle.suspActivity * 0.0011 + v2 * 5e-7);
    if (vehicle._absActive && vehicle.ctrl.brake > 0.3) vib += 0.003;
    camera.position.y += (Math.random() - 0.5) * vib + vehicle.landImpact * -0.035;
    camera.position.x += (Math.random() - 0.5) * vib * 0.6;

    // look slightly into the corner + small pitch with acceleration
    lookEuler.set(
      THREE.MathUtils.clamp(gB.z * 0.0028, -0.05, 0.05),
      -vehicle.ctrl.steer * 0.10,
      0);
    camQuatTarget.setFromEuler(lookEuler).premultiply(q);
    camera.quaternion.slerp(camQuatTarget, Math.min(1, dtVis * 14));
    camera.fov = 72 + Math.min(10, vehicle.speedKmh * 0.028);   // subtle speed FOV
  }
  camera.updateProjectionMatrix();
}

// ---- main loop
let last = performance.now();
let acc = 0;
let frame = 0;

function loop(now) {
  requestAnimationFrame(loop);
  let dtReal = (now - last) / 1000;
  last = now;
  if (dtReal > 0.1) dtReal = 0.1;

  if (_resetCooldown > 0) _resetCooldown -= dtReal;
  if (!paused) {
    input.update(dtReal, vehicle);
    autoReverse();
    applyControls();
    acc += dtReal;
    let steps = 0;
    while (acc >= DT && steps < 30) {
      vehicle.step(DT);
      acc -= DT;
      steps++;
    }
    hud.update(vehicle, dtReal);
    ghost.update(dtReal, vehicle, hud.lapStart !== null ? hud.now() - hud.lapStart : null);
    raceLine.update(vehicle.trackS, Math.abs(vehicle.speed));
    audio.update(vehicle, dtReal);
    updateHaptics(now);
  }

  carVis.update(vehicle, dtReal);
  updateCamera(dtReal);
  atmo.follow(vehicle.pos);
  rain.update(dtReal, camera, vehicle.vel);
  if (lampsActive) updateLamps();
  post.setSpeed(camMode === 2 ? 0 : vehicle.speedKmh);

  autoQ.tick(dtReal, fps => hud.flash(`Performance adjusted (${fps} fps)`));
  hud.fps = hud.fps === undefined ? 60 : hud.fps * 0.95 + (1 / Math.max(dtReal, 1e-3)) * 0.05;

  frame++;
  if (camMode === 0 && TIER.mirror > 0 && frame % TIER.mirror === 0) {
    carVis.renderMirror(renderer, scene, vehicle);
  }
  post.render();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.resize(innerWidth, innerHeight);
});

applyNight();          // apply initial preset's environment (grip/wet/rain/lamps)
requestAnimationFrame(loop);

// commit to driving: start audio, (touch) go fullscreen + lock orientation
function beginDrive() {
  paused = false;
  hud.toggleHelp(false);
  audio.start();
  audio.setEngine(CARS[carId]);
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  updateAudioGate();
  if (TOUCH) {
    try { document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch (e) {}
    try { screen.orientation.lock('landscape'); } catch (e) {}
    TouchInput.requestMotionPermission();
    hud.flash(input.mode === 'tilt' ? 'Tilt steering — tilt the phone like a wheel' : 'Button steering (switch to tilt in settings)');
  }
}

function launchMenu() {
  paused = true;
  hud.toggleHelp(false);
  showMenu({
    trackData: TRACK_DATA, currentTrack: trackId, currentCar: carId,
    onStart: (selTrack, selCar) => {
      if (selTrack !== trackId) {
        localStorage.setItem('ns-track', selTrack);
        localStorage.setItem('ns-car', selCar);
        sessionStorage.setItem('ns-go', '1');
        location.reload();
      } else {
        if (selCar !== carId) { localStorage.setItem('ns-car', selCar); setCar(selCar); }
        beginDrive();
      }
    },
    onBuild: () => {
      const builder = new CarBuilder();
      builder.onDestroy = launchMenu;
    },
  });
}

// boot: skip the menu if we just reloaded from a track pick, else show it
if (sessionStorage.getItem('ns-go')) {
  sessionStorage.removeItem('ns-go');
  hud.flash(tMeta.name);
  beginDrive();
} else {
  launchMenu();
}

window.__atmo = atmo;
window.__rain = rain;
window.__setPreset = i => { atmo.apply(i); applyNight(); };
window.__vehicle = vehicle;   // debug / test handle
window.__track = track;
window.__renderer = renderer;
window.__audio = audio;
window.__demHeight = demHeight;
window.__CARS = CARS;
window.__Vehicle = vehicle.constructor;
window.__CarAudio = audio.constructor;   // debug / test handle (isolated audio)
