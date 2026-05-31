import * as THREE from 'three';
import type { Severity } from '../types';

/* ─────────────────────────────────────────────────────────
   MotorSim  —  Three.js 3D 모터-축-디스크 어셈블리
   PRD §4.1 씬 구성 / §4.2 제어 루프 / §4.3 이상 시나리오
   W1 범위: 씬 구조 + 회전 애니메이션 + 심각도별 시각 반응
   W3 이후: wsClient.ts → setRPM() / setSeverity() 연동
───────────────────────────────────────────────────────── */

/** 심각도별 외형 설정 */
const SEVERITY_STYLE: Record<Severity, {
  diskColor: number;
  diskEmissive: number;
  lightColor: number;
  weightOpacity: number;
  jitterScale: number;
}> = {
  normal:   { diskColor: 0x3fb950, diskEmissive: 0x0a2010, lightColor: 0x3fb950, weightOpacity: 0,   jitterScale: 0     },
  warning:  { diskColor: 0xd29922, diskEmissive: 0x201500, lightColor: 0xd29922, weightOpacity: 0.6, jitterScale: 0.012 },
  critical: { diskColor: 0xf85149, diskEmissive: 0x200000, lightColor: 0xf85149, weightOpacity: 1.0, jitterScale: 0.04  },
};

/** PRD §3.3.3 심각도별 목표 RPM */
export const SEVERITY_RPM: Record<Severity, number> = {
  normal:   1200,
  warning:  600,
  critical: 0,
};

export class MotorSim {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene:    THREE.Scene;
  readonly camera:   THREE.PerspectiveCamera;

  currentRPM  = 0;
  targetRPM   = 1200;
  severity: Severity = 'normal';

  private rotatingGroup!: THREE.Group;
  private motorHousing!:  THREE.Mesh;
  private disk!:          THREE.Mesh;
  private matDisk!:       THREE.MeshStandardMaterial;
  private matWeight!:     THREE.MeshStandardMaterial;
  private diskLight!:     THREE.PointLight;

  private angle       = 0;   // 누적 회전각 (rad)
  private jitterScale = 0;
  private cameraOrigin!: THREE.Vector3;
  private clock = new THREE.Clock();
  private rafId = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    // ── Renderer ──
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

    // ── Scene & Camera ──
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

  /* ── 공개 제어 API ── */

  setRPM(rpm: number): void {
    this.targetRPM = Math.max(0, rpm);
  }

  setSeverity(severity: Severity): void {
    if (this.severity === severity) return;
    this.severity = severity;

    const s = SEVERITY_STYLE[severity];
    this.matDisk.color.setHex(s.diskColor);
    this.matDisk.emissive.setHex(s.diskEmissive);
    this.diskLight.color.setHex(s.lightColor);
    this.matWeight.opacity  = s.weightOpacity;
    this.jitterScale        = s.jitterScale;
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.renderer.dispose();
  }

  /* ── 씬 오브젝트 구성 (PRD §4.1) ── */

  private _buildScene(): void {
    // 바닥 그리드
    const grid = new THREE.GridHelper(10, 20, 0x1c2333, 0x1c2333);
    grid.position.y = -1.8;
    this.scene.add(grid);

    // 재질
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
    this.matWeight = new THREE.MeshStandardMaterial({
      color: 0xf85149, metalness: 0.3, roughness: 0.5,
      transparent: true, opacity: 0,
    });

    // ── 회전 그룹 (축 + 디스크 + 불균형 추) ──
    this.rotatingGroup = new THREE.Group();
    this.scene.add(this.rotatingGroup);

    // 모터 하우징 — 고정 (CylinderGeometry, PRD §4.1)
    this.motorHousing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.75, 0.75, 1.0, 48),
      matHousing,
    );
    this.motorHousing.castShadow    = true;
    this.motorHousing.receiveShadow = true;
    this.scene.add(this.motorHousing);

    // 엔드 캡
    const capGeo = new THREE.CylinderGeometry(0.76, 0.76, 0.06, 48);
    [-0.53, 0.53].forEach(y => {
      const cap = new THREE.Mesh(capGeo, matCap);
      cap.position.y = y;
      this.scene.add(cap);
    });

    // 냉각 핀 8개
    const finGeo = new THREE.BoxGeometry(0.06, 0.9, 0.14);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const fin = new THREE.Mesh(finGeo, matFin);
      fin.position.set(Math.cos(a) * 0.82, 0, Math.sin(a) * 0.82);
      fin.rotation.y = a;
      this.scene.add(fin);
    }

    // 회전축 (shaft) — CylinderGeometry thin, PRD §4.1
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 3.0, 16),
      matShaft,
    );
    shaft.castShadow = true;
    this.rotatingGroup.add(shaft);

    // 디스크 (flywheel) — CylinderGeometry flat, PRD §4.1
    this.disk = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.15, 0.18, 64),
      this.matDisk,
    );
    this.disk.position.y  = 0.9;
    this.disk.castShadow    = true;
    this.disk.receiveShadow = true;
    this.rotatingGroup.add(this.disk);

    // 스포크 4개 (회전 시각화)
    const spokeGeo = new THREE.BoxGeometry(0.08, 0.19, 1.0);
    for (let i = 0; i < 4; i++) {
      const spoke = new THREE.Mesh(spokeGeo, matSpoke);
      spoke.position.y = 0.9;
      spoke.rotation.y = (i / 4) * Math.PI;
      this.rotatingGroup.add(spoke);
    }

    // 불균형 추 — SphereGeometry 편심 위치 (PRD §4.1, W1: 숨김)
    const weight = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 16),
      this.matWeight,
    );
    weight.position.set(0.9, 0.9, 0);
    this.rotatingGroup.add(weight);

    // 베어링 (TorusGeometry)
    const bearingGeo = new THREE.TorusGeometry(0.12, 0.04, 8, 24);
    [-0.5, 0.5].forEach(y => {
      const b = new THREE.Mesh(bearingGeo, matBearing);
      b.position.y = y;
      b.rotation.x = Math.PI / 2;
      this.scene.add(b);
    });

    // 받침대
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.18, 1.6), matBase);
    base.position.y   = -1.1;
    base.receiveShadow = true;
    this.scene.add(base);

    // 볼트
    const boltGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.25, 8);
    ([ [-0.9, -0.5], [0.9, -0.5], [-0.9, 0.5], [0.9, 0.5] ] as [number, number][]).forEach(([x, z]) => {
      const bolt = new THREE.Mesh(boltGeo, matBolt);
      bolt.position.set(x, -1.02, z);
      this.scene.add(bolt);
    });
  }

  /* ── 조명 ── */

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

  /* ── 애니메이션 루프 ── */

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
    // RPM lerp: 목표값으로 부드럽게 수렴
    this.currentRPM += (this.targetRPM - this.currentRPM) * (1 - Math.pow(0.03, dt));

    // 회전각 누적 (rad/s = RPM / 60 * 2π)
    this.angle += (this.currentRPM / 60) * 2 * Math.PI * dt;
    this.rotatingGroup.rotation.y = this.angle;

    // 발광 강도 (RPM 비례)
    const t = this.currentRPM / 1200;
    this.matDisk.emissiveIntensity = 0.1 + t * 0.5;
    this.diskLight.intensity       = 0.3 + t * 0.8;

    // 진동 이펙트
    if (this.jitterScale > 0) {
      const jx = (Math.random() - 0.5) * 2 * this.jitterScale;
      const jz = (Math.random() - 0.5) * 2 * this.jitterScale;

      if (this.severity === 'critical') {
        this.rotatingGroup.position.set(jx, 0, jz);
        this.motorHousing.position.set(jx * 0.6, 0, jz * 0.6);
      }
      // 카메라 흔들림
      const sa = this.jitterScale * 0.5;
      this.camera.position.x = this.cameraOrigin.x + (Math.random() - 0.5) * sa;
      this.camera.position.y = this.cameraOrigin.y + (Math.random() - 0.5) * sa * 0.5;
      this.camera.lookAt(0, 0, 0);
    } else {
      this.rotatingGroup.position.set(0, 0, 0);
      this.motorHousing.position.set(0, 0, 0);
      this.camera.position.lerp(this.cameraOrigin, 0.1);
      this.camera.lookAt(0, 0, 0);
    }
  }

  /* ── 리사이즈 ── */

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
