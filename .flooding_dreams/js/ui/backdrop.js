/* ============================================================
   菜单 / 加载背景：漂浮的梦之物 + 云海天空
   ============================================================ */
import * as THREE from 'three';
import { makeCamera } from '../core/engine.js';
import { getSkyTexture } from '../core/textures.js';

export class Backdrop {
  constructor(engine) {
    this.engine = engine;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x2a2348, 160, 900);
    this.camera = makeCamera(68, 0.5, 6000);
    this.camera.position.set(0, 12, 40);

    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 32, 18),
      // 柔化的天空：整体压暗一档，避免菜单背景刺眼
      new THREE.MeshBasicMaterial({ map: getSkyTexture(), color: 0xb4b1d2, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    sky.name = 'sky';
    this.scene.add(sky);

    this.scene.add(new THREE.HemisphereLight(0xcfc0ff, 0x2a2348, 0.85));
    const key = new THREE.DirectionalLight(0xfff0d8, 1.05);
    key.position.set(40, 80, 30);
    this.scene.add(key);

    // 漂浮的梦之物
    this.shapes = [];
    const geos = [
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.SphereGeometry(0.5, 20, 14),
      new THREE.TorusGeometry(0.5, 0.2, 12, 24),
      new THREE.ConeGeometry(0.5, 1, 6),
      new THREE.OctahedronGeometry(0.6),
    ];
    const colors = ['#ff7fd0', '#7fe3ff', '#8ef5c8', '#ffd98a', '#a08cff', '#ffa06b'];
    for (let i = 0; i < 26; i++) {
      const g = geos[i % geos.length];
      const c = colors[i % colors.length];
      const m = new THREE.MeshStandardMaterial({
        color: c, roughness: 0.55, metalness: 0.12,
        emissive: c, emissiveIntensity: 0.2, transparent: true, opacity: 0.68,
      });
      const mesh = new THREE.Mesh(g, m);
      const ang = (i / 26) * Math.PI * 2 + Math.random() * 0.6;
      const rad = 60 + Math.random() * 190;
      mesh.position.set(Math.cos(ang) * rad, -40 + Math.random() * 130, Math.sin(ang) * rad - 60);
      const s = 2 + Math.random() * 9;
      mesh.scale.setScalar(s);
      mesh.userData = {
        spin: (Math.random() - 0.5) * 0.5,
        bob: 0.6 + Math.random() * 1.6,
        phase: Math.random() * 6.28,
        base: mesh.position.y,
      };
      this.scene.add(mesh);
      this.shapes.push(mesh);
    }

    // 地面云层
    const cloudMat = new THREE.MeshStandardMaterial({ color: 0xe4dcf4, transparent: true, opacity: 0.34, roughness: 1, metalness: 0 });
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), cloudMat);
      m.position.set((Math.random() - 0.5) * 420, -60 - Math.random() * 30, -60 + (Math.random() - 0.5) * 420);
      m.scale.set(60 + Math.random() * 90, 16 + Math.random() * 16, 50 + Math.random() * 70);
      this.scene.add(m);
      this.shapes.push(m);
    }

    this.t = 0;
    this.view = {
      scene: this.scene,
      camera: this.camera,
      update: (dt) => this.update(dt),
    };
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    this.camera.position.x = Math.sin(t * 0.06) * 22;
    this.camera.position.y = 12 + Math.sin(t * 0.11) * 5;
    this.camera.position.z = 40 + Math.cos(t * 0.08) * 14;
    this.camera.lookAt(0, 6, -30);
    const sky = this.scene.getObjectByName('sky');
    if (sky) sky.rotation.y += dt * 0.004;
    for (const s of this.shapes) {
      const u = s.userData;
      if (u.spin !== undefined) {
        s.rotation.y += u.spin * dt;
        s.rotation.x += u.spin * dt * 0.4;
        s.position.y = u.base + Math.sin(t * 0.5 + u.phase) * u.bob;
      }
    }
  }

  dispose() {
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m.map !== getSkyTexture()) m.dispose();
      }
    });
    this.scene.clear();
  }
}