import * as THREE from 'three';

/* ─────────────────────────────────────────────────────────
   MotorSim  —  Three.js 3D motor-shaft-disk assembly
   PRD §5.4: setAngle(roll, pitch) — sensor angle tracking
   - tiltGroup wraps the entire assembly; lerps to target roll/pitch
   - rotatingGroup (child of tiltGroup) spins the shaft+disk
   - Lerp α = 0.1 per frame (PRD §5.4)
───────────────────────────────────────────────────────── */

const SPIN_RPM  = 600;     // constant visual spin speed
const LERP_A    = 0.1;     // tilt lerp alpha per frame (PRD §5.4)

export class MotorSim {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene:    THREE.Scene;
  readonly camera:   THREE.PerspectiveCamera;

  private tiltGroup!:    THREE.Group;   // whole assembly — roll/pitch applied here
  private rotatingGroup!: THREE.Group;  // shaft + disk — spins
  private motorHousing!:  THREE.Mesh;
  private matDisk!:       THREE.MeshStandardMaterial;
  private diskLight!:     THREE.PointLight;

  private _angle       = 0;   // accumulated spin angle (rad)
  private _targetRoll  = 0;   // rad
  private _targetPitch = 0;   // rad

  private cameraOrigin!: THREE.Vector3;
  private clock = new THREE.Clock();
  private rafId = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1117);
    this.scene.fog = new THREE.Fog(0x0d1117, 14, 24);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(4, 3, 5);
    this.camera.lookAt(0, 0, 0);
    this.cameraOrigin = this.camera.position.clone();

    this._buildScene();
    this._buildLights();
    this._startLoop();
    this._watchResize();
  }

  /* ── Public API ── */

  /**
   * Set target tilt angles (degrees).  The assembly lerps smoothly.
   * roll  → rotation around Z axis (PRD §5.4)
   * pitch → rotation around X axis
   */
  setAngle(roll: number, pitch: number): void {
    this._targetRoll  = THREE.MathUtils.degToRad(roll);
    this._targetPitch = THREE.MathUtils.degToRad(pitch);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.renderer.dispose();
  }

  /* ── Scene construction ── */

  private _buildScene(): void {
    // Grid stays in scene (does not tilt)
    const grid = new THREE.GridHelper(10, 20, 0x1c2333, 0x1c2333);
    grid.position.y = -1.8;
    this.scene.add(grid);

    // tiltGroup — roll/pitch applied here; everything inside tilts together
    this.tiltGroup = new THREE.Group();
    this.scene.add(this.tiltGroup);

    // Materials
    const matHousing = new THREE.MeshStandardMaterial({ color: 0x2d3748, metalness: 0.7, roughness: 0.3 });
    const matShaft   = new THREE.MeshStandardMaterial({ color: 0x718096, metalness: 0.9, roughness: 0.2 });
    const matCap     = new THREE.MeshStandardMaterial({ color: 0x1a2535, metalness: 0.8, roughness: 0.2 });
    const matFin     = new THREE.MeshStandardMaterial({ color: 0x253040, metalness: 0.6, roughness: 0.4 });
    const matSpoke   = new THREE.MeshStandardMaterial({ color: 0x4a5568, metalness: 0.7, roughness: 0.3 });
    const matBearing = new THREE.MeshStandardMaterial({ color: 0x4a4040, metalness: 0.9, roughness: 0.1 });
    const matBase    = new THREE.MeshStandardMaterial({ color: 0x1a2030, metalness: 0.2, roughness: 0.8 });
    const matBolt    = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.9, roughness: 0.2 });

    this.matDisk = new THREE.MeshStandardMaterial({
      color: 0x3fb950, metalness: 0.5, roughness: 0.4,
      emissive: 0x0a2010, emissiveIntensity: 0.3,
    });

    // ── rotatingGroup (child of tiltGroup) — shaft + disk spin ──
    this.rotatingGroup = new THREE.Group();
    this.tiltGroup.add(this.rotatingGroup);

    // Motor housing (fixed in tiltGroup)
    this.motorHousing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.75, 0.75, 1.0, 48), matHousing,
    );
    this.motorHousing.castShadow    = true;
    this.motorHousing.receiveShadow = true;
    this.tiltGroup.add(this.motorHousing);

    // End caps
    const capGeo = new THREE.CylinderGeometry(0.76, 0.76, 0.06, 48);
    [-0.53, 0.53].forEach(y => {
      const cap = new THREE.Mesh(capGeo, matCap);
      cap.position.y = y;
      this.tiltGroup.add(cap);
    });

    // Cooling fins (×8)
    const finGeo = new THREE.BoxGeometry(0.06, 0.9, 0.14);
    for (let i = 0; i < 8; i++) {
      const a   = (i / 8) * Math.PI * 2;
      const fin = new THREE.Mesh(finGeo, matFin);
      fin.position.set(Math.cos(a) * 0.82, 0, Math.sin(a) * 0.82);
      fin.rotation.y = a;
      this.tiltGroup.add(fin);
    }

    // Shaft
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 3.0, 16), matShaft,
    );
    shaft.castShadow = true;
    this.rotatingGroup.add(shaft);

    // Disk (flywheel)
    const disk = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.15, 0.18, 64), this.matDisk,
    );
    disk.position.y      = 0.9;
    disk.castShadow      = true;
    disk.receiveShadow   = true;
    this.rotatingGroup.add(disk);

    // Spokes ×4
    const spokeGeo = new THREE.BoxGeometry(0.08, 0.19, 1.0);
    for (let i = 0; i < 4; i++) {
      const spoke = new THREE.Mesh(spokeGeo, matSpoke);
      spoke.position.y = 0.9;
      spoke.rotation.y = (i / 4) * Math.PI;
      this.rotatingGroup.add(spoke);
    }

    // Bearings
    const bearingGeo = new THREE.TorusGeometry(0.12, 0.04, 8, 24);
    [-0.5, 0.5].forEach(y => {
      const b = new THREE.Mesh(bearingGeo, matBearing);
      b.position.y = y;
      b.rotation.x = Math.PI / 2;
      this.tiltGroup.add(b);
    });

    // Base plate
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.18, 1.6), matBase);
    base.position.y    = -1.1;
    base.receiveShadow = true;
    this.tiltGroup.add(base);

    // Mount bolts
    const boltGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.25, 8);
    ([ [-0.9, -0.5], [0.9, -0.5], [-0.9, 0.5], [0.9, 0.5] ] as [number, number][]).forEach(([x, z]) => {
      const bolt = new THREE.Mesh(boltGeo, matBolt);
      bolt.position.set(x, -1.02, z);
      this.tiltGroup.add(bolt);
    });
  }

  /* ── Lights ── */

  private _buildLights(): void {
    this.scene.add(new THREE.AmbientLight(0x1a2040, 1.5));

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
    dirLight.position.set(5, 8, 4);
    dirLight.castShadow = true;
    Object.assign(dirLight.shadow.mapSize, { width: 1024, height: 1024 });
    const sc = dirLight.shadow.camera as THREE.OrthographicCamera;
    sc.near = 0.1; sc.far = 30;
    sc.left = -5; sc.right = 5; sc.top = 5; sc.bottom = -5;
    this.scene.add(dirLight);

    const accentLight = new THREE.PointLight(0x58a6ff, 1.2, 8);
    accentLight.position.set(-3, 2, 3);
    this.scene.add(accentLight);

    this.diskLight = new THREE.PointLight(0x3fb950, 0.8, 4);
    this.diskLight.position.set(0, 2.5, 0);
    this.scene.add(this.diskLight);
  }

  /* ── Animation loop ── */

  private _startLoop(): void {
    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.1);
      this._tick(dt);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private _tick(dt: number): void {
    // ── Spin disk at constant RPM ──
    this._angle += (SPIN_RPM / 60) * 2 * Math.PI * dt;
    this.rotatingGroup.rotation.y = this._angle;

    // ── Tilt lerp (PRD §5.4: α = 0.1 per frame) ──
    this.tiltGroup.rotation.z += (this._targetRoll  - this.tiltGroup.rotation.z) * LERP_A;
    this.tiltGroup.rotation.x += (this._targetPitch - this.tiltGroup.rotation.x) * LERP_A;

    // Emissive pulse with spin speed
    this.matDisk.emissiveIntensity = 0.2 + 0.3 * Math.sin(this._angle * 0.5);
    this.diskLight.intensity       = 0.5 + 0.4 * Math.abs(Math.sin(this._angle * 0.3));

    // Camera stays still
    this.camera.position.lerp(this.cameraOrigin, 0.05);
    this.camera.lookAt(0, 0, 0);
  }

  /* ── Resize ── */

  private _watchResize(): void {
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(this.canvas.parentElement!);
    this._resize();
  }

  private _resize(): void {
    const wrap = this.canvas.parentElement;
    if (!wrap) return;
    const { clientWidth: w, clientHeight: h } = wrap;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
