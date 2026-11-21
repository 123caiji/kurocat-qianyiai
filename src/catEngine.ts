import {
  KEYBOARD_KEYS,
  TOTAL_ROWS,
  TOTAL_UNITS,
  type KeySpec,
  formatBubbleForVk,
  resolveKeyByVk,
} from './keyboardLayout';
import { catAudio } from './audio';

export const LOGICAL_W = 420;
export const LOGICAL_H = 440;

interface Vec2 {
  x: number;
  y: number;
}

interface SmearFrame {
  sx: number;
  sy: number;
  px: number;
  py: number;
  alpha: number;
}

type PawMode = 'idle' | 'curled' | 'poke' | 'mouse';

interface PawState {
  side: 'left' | 'right';
  shoulderNormY: number; // vertical fraction along spine (0=ear tips, 1=base)
  shoulderHalfX: number;
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  mode: PawMode;
  idleWeight: number;
  curlWeight: number;
  pokeTime: number;
  impactSquash: number;
  lastActiveAt: number;
  smears: SmearFrame[];
}

interface KeyBubble {
  id: number;
  label: string;
  isSpace: boolean;
  x: number;
  targetX: number;
  y: number;
  targetY: number;
  rot: number;
  createdAt: number;
  lifetime: number;
}

interface KeyAnim {
  pressed: boolean;
  pressAmount: number;
  lastHitAt: number;
}

// Exact measured pixel silhouette half-width profile from original video 0.3s (compact chubby sitting cat!)
// t = 0.0 (ear tips) -> t = 1.0 (bottom base flush on keyboard)
const BODY_SLICES: Array<{ t: number; hw: number }> = [
  { t: 0.12, hw: 49 }, // forehead / ear base
  { t: 0.21, hw: 56 }, // eye line
  { t: 0.30, hw: 60 }, // chubby cheeks widest
  { t: 0.38, hw: 52 }, // gentle neck indent
  { t: 0.47, hw: 54 }, // upper chest
  { t: 0.57, hw: 62 }, // mid chest
  { t: 0.68, hw: 70 }, // plump belly
  { t: 0.79, hw: 73 }, // widest soft thighs!
  { t: 0.90, hw: 69 }, // lower thigh curve
  { t: 0.97, hw: 58 }, // tapers softly inward at base!
  { t: 1.00, hw: 46 }, // cozy bottom rest
];

export class KuroCatEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private lastTime = 0;
  private elapsed = 0;

  public showKeyBubbles = true;

  // Compact true-scale proportions matching ORIG 0.3s directly!
  private readonly catCenterX = 196;
  private readonly catTopY = 82;
  private readonly catBaseY = 308;
  private readonly catHeight = 226;

  // True-scale bright white keyboard right below the sitting cat (slightly taller so legends are super crisp!)
  private readonly kbCenterX = 214;
  private readonly kbCenterY = 353;
  private readonly kbWidth = 266;
  private readonly kbHeight = 74;
  private readonly kbTiltRad = (3.4 * Math.PI) / 180;

  // True-scale white oval mouse to the left of keyboard
  private readonly mouseBaseX = 48;
  private readonly mouseBaseY = 336;
  private mouseOffsetX = 0;
  private mouseOffsetY = 0;
  private mouseTargetOffsetX = 0;
  private mouseTargetOffsetY = 0;
  private mouseLeftDown = false;
  private mouseRightDown = false;
  private mouseMiddleDown = false;
  private mouseScrollFlash = 0;
  private lastMouseMoveAt = -10000;

  // Cursor & 100% live eye tracking + 2.5D head turn
  private cursorRelX = 0.5;
  private cursorRelY = 0.5;
  private cursorOverCat = false;
  private eyeLookX = 0;
  private eyeLookY = 0;
  private faceTurnX = 0;

  // Spine-shear deformation state (exact measured flexible cat spine!)
  private spineLean = 0;    // -1 (mouse lean: head shifts -46px left while hips stay anchored!) .. +1
  private headTilt = 0;
  private typingHunch = 0;  // 0..1 lowers head & rounds posture slightly when typing
  private strikeRock = 0;
  private strikeRockVel = 0;
  private bodyBob = 0;
  private kbBounce = 0;

  // Blinking, petting, ear micro-twitch, typing rhythm
  private nextBlinkAt = 2.8;
  private blinkProgress = 0;
  private isBlinking = false;

  private lastPetCursorX: number | null = null;
  private lastPetCursorY: number | null = null;
  private petEnergy = 0;
  private squintAmount = 0;
  private earTwitchLeft = 0;
  private earTwitchRight = 0;
  private recentKeyTimes: number[] = [];
  private typingEnergy = 0;
  private lastAnyKeyAt = -10000;

  // Paws
  private leftPaw: PawState;
  private rightPaw: PawState;
  private lastSpacePaw: 'left' | 'right' = 'left';

  // Keys & bubbles
  private keyAnims = new Map<string, KeyAnim>();
  private bubbles: KeyBubble[] = [];
  private nextBubbleId = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not initialize 2D canvas context');
    this.ctx = ctx;

    for (const k of KEYBOARD_KEYS) {
      this.keyAnims.set(k.id, { pressed: false, pressAmount: 0, lastHitAt: -10000 });
    }

    this.leftPaw = {
      side: 'left',
      shoulderNormY: 0.50,
      shoulderHalfX: -32,
      pos: { x: this.catCenterX - 18, y: this.catBaseY },
      vel: { x: 0, y: 0 },
      target: { x: this.catCenterX - 18, y: this.catBaseY },
      mode: 'idle',
      idleWeight: 1,
      curlWeight: 0,
      pokeTime: 1,
      impactSquash: 0,
      lastActiveAt: -10000,
      smears: [],
    };

    this.rightPaw = {
      side: 'right',
      shoulderNormY: 0.50,
      shoulderHalfX: 32,
      pos: { x: this.catCenterX + 18, y: this.catBaseY },
      vel: { x: 0, y: 0 },
      target: { x: this.catCenterX + 18, y: this.catBaseY },
      mode: 'idle',
      idleWeight: 1,
      curlWeight: 0,
      pokeTime: 1,
      impactSquash: 0,
      lastActiveAt: -10000,
      smears: [],
    };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  public resize(): void {
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  public start(): void {
    this.lastTime = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTime) / 1000));
      this.lastTime = now;
      this.update(dt, now);
      this.render();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  public stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  // ---- Flexible spine coordinate system (exact match to measured 0.3s -> 2.2s shear!) ----

  private spinePoint(t: number, breath: number): Vec2 {
    // t in [0..1]: 0 = ear tips, 1 = seated base on desk
    const u = Math.max(0, Math.min(1, 1 - t)); // 0 at hips, 1 at head
    const shearCurve = u * u * (3 - 2 * u); // smoothstep from hips up to head!
    // Measured mouse-lean shift: -46px at head, -34px at neck, -18px at chest, 0px at hips!
    const leanX = this.spineLean * 46 * shearCurve + this.strikeRock * 8 * shearCurve;
    const hunchY = (this.typingHunch * 14 + this.bodyBob * 3.0 + breath) * shearCurve;
    // Slight forward drop when leaning deeply to the mouse
    const leanDropY = Math.abs(this.spineLean) * 6 * shearCurve;
    return {
      x: this.catCenterX + leanX,
      y: this.catTopY + t * this.catHeight + hunchY + leanDropY,
    };
  }

  private getLiveShoulder(paw: PawState, breath: number): Vec2 {
    const sp = this.spinePoint(paw.shoulderNormY, breath);
    return {
      x: sp.x + paw.shoulderHalfX,
      y: sp.y,
    };
  }

  private getLiveCurledPawPos(paw: PawState, breath: number): Vec2 {
    // Bent forearm elbow -> cute curled paw sitting near lower belly (matches 8.3s / 10.6s!)
    const sp = this.spinePoint(0.84, breath);
    const bob = Math.sin(this.elapsed * 12 + (paw.side === 'left' ? 0 : Math.PI)) * (1.5 + this.typingEnergy * 2.0);
    const xOff = paw.side === 'left' ? -24 : 24;
    return {
      x: sp.x + xOff,
      y: sp.y + bob,
    };
  }

  // ---- Input event handlers ----

  public onKeyDown(vk: number, repeat: boolean): void {
    const now = performance.now();
    const spec = resolveKeyByVk(vk);
    if (!spec) return;

    const anim = this.keyAnims.get(spec.id);
    if (anim) {
      anim.pressed = true;
      anim.pressAmount = 1;
      anim.lastHitAt = now;
    }

    if (repeat) return;

    this.lastAnyKeyAt = now;
    this.recentKeyTimes.push(now);
    if (this.recentKeyTimes.length > 26) this.recentKeyTimes.shift();

    this.bodyBob = Math.min(1, this.bodyBob + 0.55);
    this.kbBounce = Math.min(1, this.kbBounce + 0.45);

    if (Math.random() < 0.16) {
      if (Math.random() < 0.5) this.earTwitchLeft = 1;
      else this.earTwitchRight = 1;
    }

    const keyColCenter = spec.uStart + spec.uWidth * 0.5;
    let targetPoint = this.getKeyWorldCenter(spec);
    let chosen: PawState;

    // Only keep left paw locked to mouse while actively sweeping (<320ms) or holding a mouse button;
    // otherwise strictly split keyboard: left half (< 7.0: Esc, 1-6, Q-T, A-G, Z-B) -> left paw, right half (>= 7.0: 7-0, Y-P, H-L, N-M) -> right paw!
    const activelyMousing = this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 320;

    if (spec.id === 'space') {
      if (activelyMousing) {
        chosen = this.rightPaw;
      } else {
        this.lastSpacePaw = this.lastSpacePaw === 'left' ? 'right' : 'left';
        chosen = this.lastSpacePaw === 'left' ? this.leftPaw : this.rightPaw;
      }
      const spaceU = chosen.side === 'left' ? spec.uStart + spec.uWidth * 0.34 : spec.uStart + spec.uWidth * 0.66;
      targetPoint = this.projectKeyboardPoint(spaceU, spec.row + 0.5);
    } else if (activelyMousing) {
      chosen = this.rightPaw;
    } else if (keyColCenter < 7.0) {
      chosen = this.leftPaw;
    } else {
      chosen = this.rightPaw;
    }

    this.strikeRockVel += (chosen.side === 'left' ? -1 : 1) * (1.25 + this.typingEnergy * 1.0);

    const prevShoulder = this.getLiveShoulder(chosen, 0);
    if (chosen.mode === 'poke' && Math.hypot(targetPoint.x - chosen.pos.x, targetPoint.y - chosen.pos.y) > 22) {
      chosen.smears.push({
        sx: prevShoulder.x,
        sy: prevShoulder.y,
        px: chosen.pos.x,
        py: chosen.pos.y,
        alpha: 0.28,
      });
      if (chosen.smears.length > 3) chosen.smears.shift();
    }

    if (chosen.mode === 'curled' || chosen.mode === 'idle') {
      const startPt = this.getLiveCurledPawPos(chosen, 0);
      chosen.pos = { x: startPt.x, y: startPt.y };
      chosen.vel = { x: 0, y: 260 };
    }
    chosen.mode = 'poke';
    chosen.target = { x: targetPoint.x, y: targetPoint.y };
    chosen.pokeTime = 0;
    chosen.impactSquash = 0.85;
    chosen.lastActiveAt = now;

    const other = chosen.side === 'left' ? this.rightPaw : this.leftPaw;
    if (other.mode === 'idle' && !activelyMousing) {
      other.mode = 'curled';
      other.lastActiveAt = now;
    }

    catAudio.playKeyClick((keyColCenter - 7.5) * 0.35);

    if (this.showKeyBubbles) {
      const label = formatBubbleForVk(vk, spec);
      if (label) {
        this.spawnBubble(label, spec.id === 'space', targetPoint.x, now);
      }
    }
  }

  public onKeyUp(vk: number): void {
    const spec = resolveKeyByVk(vk);
    if (!spec) return;
    const anim = this.keyAnims.get(spec.id);
    if (anim) anim.pressed = false;
  }

  public onGlobalMouseMove(nx: number, ny: number): void {
    const now = performance.now();
    this.mouseTargetOffsetX = (nx - 0.5) * 32;
    this.mouseTargetOffsetY = (ny - 0.5) * 20;
    this.lastMouseMoveAt = now;

    this.leftPaw.mode = 'mouse';
    this.leftPaw.lastActiveAt = now;
  }

  public onMouseDown(button: string): void {
    const now = performance.now();
    if (button === 'left') this.mouseLeftDown = true;
    else if (button === 'right') this.mouseRightDown = true;
    else if (button === 'middle') this.mouseMiddleDown = true;

    this.lastMouseMoveAt = now;
    this.leftPaw.mode = 'mouse';
    this.leftPaw.lastActiveAt = now;
    catAudio.playMouseClick();
  }

  public onMouseUp(button: string): void {
    if (button === 'left') this.mouseLeftDown = false;
    else if (button === 'right') this.mouseRightDown = false;
    else if (button === 'middle') this.mouseMiddleDown = false;
  }

  public onMouseWheel(): void {
    const now = performance.now();
    this.mouseScrollFlash = 1;
    this.lastMouseMoveAt = now;
    this.leftPaw.mode = 'mouse';
    this.leftPaw.lastActiveAt = now;
  }

  public onWindowCursor(relX: number, relY: number, overCat: boolean): void {
    this.cursorRelX = relX;
    this.cursorRelY = relY;
    this.cursorOverCat = overCat;

    if (overCat && !this.mouseLeftDown && !this.mouseRightDown) {
      const px = relX * LOGICAL_W;
      const py = relY * LOGICAL_H;
      if (this.lastPetCursorX !== null && this.lastPetCursorY !== null) {
        const dist = Math.hypot(px - this.lastPetCursorX, py - this.lastPetCursorY);
        if (dist > 1.5 && dist < 80) {
          this.petEnergy = Math.min(1, this.petEnergy + dist * 0.011);
          if (this.petEnergy > 0.45) {
            catAudio.playPurrPulse();
          }
        }
      }
      this.lastPetCursorX = px;
      this.lastPetCursorY = py;
    } else {
      this.lastPetCursorX = null;
      this.lastPetCursorY = null;
    }
  }

  // ---- Keyboard projection ----

  private projectKeyboardPoint(uCol: number, rowPos: number): Vec2 {
    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;
    const localX = -innerW / 2 + (uCol / TOTAL_UNITS) * innerW;
    const localY = -innerH / 2 + (rowPos / TOTAL_ROWS) * innerH;

    const depthFactor = 0.94 + (rowPos / TOTAL_ROWS) * 0.09;
    const px = localX * depthFactor;
    const py = localY;

    const cos = Math.cos(this.kbTiltRad);
    const sin = Math.sin(this.kbTiltRad);
    return {
      x: this.kbCenterX + px * cos - py * sin,
      y: this.kbCenterY + px * sin + py * cos,
    };
  }

  private getKeyWorldCenter(spec: KeySpec): Vec2 {
    return this.projectKeyboardPoint(spec.uStart + spec.uWidth * 0.5, spec.row + 0.5);
  }

  private spawnBubble(label: string, isSpace: boolean, keyX: number, now: number): void {
    if (this.bubbles.length >= 6) {
      this.bubbles.shift();
    }
    const baseX = Math.max(125, Math.min(315, keyX * 0.45 + 140));
    const staggerY = 258 + ((this.nextBubbleId % 3) - 1) * 10 + (Math.random() - 0.5) * 6;
    this.bubbles.push({
      id: this.nextBubbleId++,
      label,
      isSpace,
      x: baseX,
      targetX: baseX,
      y: 292,
      targetY: staggerY,
      rot: ((Math.random() - 0.5) * 4.5 * Math.PI) / 180,
      createdAt: now,
      lifetime: 940,
    });
    this.layoutBubbles();
  }

  private layoutBubbles(): void {
    const count = this.bubbles.length;
    if (count === 0) return;

    const widths = this.bubbles.map((b) => (b.isSpace ? 40 : Math.max(25, b.label.length * 7.5 + 14)));
    const gap = 3.5;
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (count - 1);
    const anchor = 232;
    let cursor = Math.max(126, Math.min(338 - totalW, anchor - totalW * 0.5));

    for (let i = 0; i < count; i++) {
      const w = widths[i];
      this.bubbles[i].targetX = cursor + w * 0.5;
      cursor += w + gap;
    }
  }

  // ---- Simulation update ----

  private update(dt: number, now: number): void {
    this.elapsed += dt;

    const mLerp = 1 - Math.exp(-28 * dt);
    this.mouseOffsetX += (this.mouseTargetOffsetX - this.mouseOffsetX) * mLerp;
    this.mouseOffsetY += (this.mouseTargetOffsetY - this.mouseOffsetY) * mLerp;
    this.mouseScrollFlash = Math.max(0, this.mouseScrollFlash - dt * 4.5);

    while (this.recentKeyTimes.length > 0 && now - this.recentKeyTimes[0] > 950) {
      this.recentKeyTimes.shift();
    }
    const targetTypingEnergy = Math.min(1, this.recentKeyTimes.length / 7);
    this.typingEnergy += (targetTypingEnergy - this.typingEnergy) * (1 - Math.exp(-9 * dt));

    const isTypingRecently = now - this.lastAnyKeyAt < 650;
    const targetHunch = isTypingRecently ? 0.45 + this.typingEnergy * 0.55 : 0;
    this.typingHunch += (targetHunch - this.typingHunch) * (1 - Math.exp(-10 * dt));

    const rockAcc = -this.strikeRock * 150 - this.strikeRockVel * 16;
    this.strikeRockVel += rockAcc * dt;
    this.strikeRock = Math.max(-1, Math.min(1, this.strikeRock + this.strikeRockVel * dt));

    this.bodyBob = Math.max(0, this.bodyBob - dt * 14);
    this.kbBounce = Math.max(0, this.kbBounce - dt * 15);

    // Measured spine-shear lean: shifts head & chest cleanly forward-left toward mouse while hips stay anchored!
    let targetLean = 0;
    if (this.leftPaw.mode === 'mouse') {
      const mouseSweepBias = (this.mouseOffsetX / 18) * 0.22;
      targetLean = this.rightPaw.mode === 'poke'
        ? -0.52 + mouseSweepBias
        : -0.96 + mouseSweepBias;
    } else if (this.rightPaw.mode === 'poke' && this.rightPaw.target.x > this.catCenterX + 65) {
      targetLean = 0.22;
    } else if (this.leftPaw.mode === 'poke' && this.leftPaw.target.x < this.catCenterX - 55) {
      targetLean = -0.20;
    }
    this.spineLean += (targetLean - this.spineLean) * (1 - Math.exp(-10 * dt));

    const desiredHeadTilt = this.typingHunch * (this.strikeRock * 0.065 - 0.04) + this.spineLean * 0.08;
    this.headTilt += (desiredHeadTilt - this.headTilt) * (1 - Math.exp(-9 * dt));

    this.petEnergy = Math.max(0, this.petEnergy - dt * (this.cursorOverCat ? 0.22 : 0.65));
    const wantSquint = this.petEnergy > 0.3 ? 1 : 0;
    this.squintAmount += (wantSquint - this.squintAmount) * (1 - Math.exp(-12 * dt));

    this.earTwitchLeft = Math.max(0, this.earTwitchLeft - dt * 8);
    this.earTwitchRight = Math.max(0, this.earTwitchRight - dt * 8);

    if (!this.isBlinking && this.elapsed >= this.nextBlinkAt) {
      this.isBlinking = true;
      this.blinkProgress = 0;
    }
    if (this.isBlinking) {
      this.blinkProgress += dt * 12;
      if (this.blinkProgress >= 2) {
        this.isBlinking = false;
        this.blinkProgress = 0;
        this.nextBlinkAt = this.elapsed + 2.8 + Math.random() * 3.6;
      }
    }

    // 100% live eye tracking toward cursor, OR cozy bottom-edge glance at keys during pure typing!
    const eyePos = this.spinePoint(0.24, 0);
    const eyeCenterRelX = eyePos.x / LOGICAL_W;
    const eyeCenterRelY = eyePos.y / LOGICAL_H;
    let dx = this.cursorRelX - eyeCenterRelX;
    let dy = this.cursorRelY - eyeCenterRelY;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.001) {
      const mag = Math.min(1, dist * 1.9);
      dx = (dx / dist) * mag;
      dy = (dy / dist) * mag;
    }
    const mouseRecentlyMoved = now - this.lastMouseMoveAt < 2400;
    const pureTypingGlance = mouseRecentlyMoved ? 0 : this.typingHunch;
    const targetEyeX = dx * 7.0 * (1 - pureTypingGlance * 0.3);
    const targetEyeY = dy * 5.2 * (1 - pureTypingGlance * 0.45) + pureTypingGlance * 5.8;
    const eyeLerp = 1 - Math.exp(-20 * dt);
    this.eyeLookX += (targetEyeX - this.eyeLookX) * eyeLerp;
    this.eyeLookY += (targetEyeY - this.eyeLookY) * eyeLerp;

    const targetFaceTurn = dx * 4.0 + this.spineLean * 8.0 + pureTypingGlance * 2.0;
    this.faceTurnX += (targetFaceTurn - this.faceTurnX) * (1 - Math.exp(-10 * dt));

    for (const anim of this.keyAnims.values()) {
      if (!anim.pressed && anim.pressAmount > 0) {
        anim.pressAmount = Math.max(0, anim.pressAmount - dt * 5.0);
      }
    }

    this.updatePaw(this.leftPaw, dt, now);
    this.updatePaw(this.rightPaw, dt, now);

    const beforeLen = this.bubbles.length;
    this.bubbles = this.bubbles.filter((b) => now - b.createdAt < b.lifetime);
    if (this.bubbles.length !== beforeLen) {
      this.layoutBubbles();
    }
    for (const b of this.bubbles) {
      const age = (now - b.createdAt) / b.lifetime;
      b.x += (b.targetX - b.x) * (1 - Math.exp(-18 * dt));
      const desiredY = b.targetY - age * 10;
      b.y += (desiredY - b.y) * (1 - Math.exp(-16 * dt));
    }
  }

  private updatePaw(paw: PawState, dt: number, now: number): void {
    const liveMouseX = this.mouseBaseX + this.mouseOffsetX;
    const liveMouseY = this.mouseBaseY + this.mouseOffsetY;

    if (paw.mode === 'mouse') {
      paw.target = { x: liveMouseX + 2, y: liveMouseY - 2 };
      const stillHolding = this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 2200;
      if (!stillHolding) {
        paw.mode = 'idle';
      }
    } else if (paw.mode === 'poke') {
      paw.pokeTime += dt;
      if (paw.pokeTime > 0.13) {
        if (paw.side === 'left' && (this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 450)) {
          paw.mode = 'mouse';
        } else if (now - this.lastAnyKeyAt < 650) {
          paw.mode = 'curled';
        } else {
          paw.mode = 'idle';
        }
      }
    } else if (paw.mode === 'curled') {
      if (now - this.lastAnyKeyAt > 680) {
        paw.mode = 'idle';
      }
    }

    if (paw.mode === 'curled') {
      paw.target = this.getLiveCurledPawPos(paw, 0);
    } else if (paw.mode === 'idle') {
      const baseSp = this.spinePoint(1.0, 0);
      paw.target = { x: baseSp.x + (paw.side === 'left' ? -19 : 19), y: baseSp.y };
    }

    const wantIdle = paw.mode === 'idle' ? 1 : 0;
    const wantCurl = paw.mode === 'curled' ? 1 : 0;
    const blendRate = 1 - Math.exp(-20 * dt);
    paw.idleWeight += (wantIdle - paw.idleWeight) * blendRate;
    paw.curlWeight += (wantCurl - paw.curlWeight) * blendRate;

    const stiffness = paw.mode === 'mouse' ? 1500 : paw.mode === 'poke' ? 1650 : 720;
    const damping = paw.mode === 'mouse' ? 56 : paw.mode === 'poke' ? 48 : 34;
    const ax = (paw.target.x - paw.pos.x) * stiffness - paw.vel.x * damping;
    const ay = (paw.target.y - paw.pos.y) * stiffness - paw.vel.y * damping;
    paw.vel.x += ax * dt;
    paw.vel.y += ay * dt;
    paw.pos.x += paw.vel.x * dt;
    paw.pos.y += paw.vel.y * dt;

    paw.impactSquash = Math.max(0, paw.impactSquash - dt * 7.5);

    for (const s of paw.smears) {
      s.alpha -= dt * 3.8;
    }
    paw.smears = paw.smears.filter((s) => s.alpha > 0.02);
  }

  // ---- High-fidelity true-scale rendering ----

  private render(): void {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    ctx.save();
    const scaleX = cw / LOGICAL_W;
    const scaleY = ch / LOGICAL_H;
    const uniformScale = Math.min(scaleX, scaleY);
    const offsetX = (cw - LOGICAL_W * uniformScale) * 0.5;
    const offsetY = (ch - LOGICAL_H * uniformScale) * 0.5;
    ctx.translate(offsetX, offsetY);
    ctx.scale(uniformScale, uniformScale);

    const breath = Math.sin(this.elapsed * 2.1) * 1.0;
    const purrShift = this.squintAmount > 0.4 ? Math.sin(this.elapsed * 22) * 0.45 * this.squintAmount : 0;

    // Layer 1: Thick plush calm low-right S-hook black tail (measured 17px thick, barely drifts!)
    this.drawTail(ctx);

    // Layer 2: Mini mouse & 65% mechanical keyboard
    this.drawMiniMouse(ctx);
    this.drawKeyboard(ctx);

    // Layer 3: Exact measured spine-deformable cat silhouette (ears, cheeks, neck, pear belly, grounded hind feet, eyes & tiny whiskers)
    this.drawCatBody(ctx, breath, purrShift);

    // Layer 4: True-scale velvety cat paws (tapered idle legs / planted diagonal mouse support leg / bent curled chest paw / plump round poking paw!)
    this.drawPaw(ctx, this.leftPaw, breath);
    this.drawPaw(ctx, this.rightPaw, breath);

    // Layer 5: Organic bouncing 3D keycap bubbles
    if (this.showKeyBubbles) {
      this.drawKeyBubbles(ctx);
    }

    ctx.restore();
  }

  private drawTail(ctx: CanvasRenderingContext2D): void {
    // Exact ORIG 0.3s tail: leaves hip slightly higher, flat horizontal start curving cleanly up into a soft horizontal S-hook!
    const gentleDrift = Math.sin(this.elapsed * 0.9) * 1.4;
    const hipRight = this.spinePoint(0.84, 0);

    const startX = hipRight.x + 56;
    const startY = hipRight.y - 2;
    const cp1X = startX + 34;
    const cp1Y = startY + 4 + gentleDrift * 0.25;
    const cp2X = startX + 38;
    const cp2Y = startY - 34 + gentleDrift * 0.45;
    const endX = startX + 70 + gentleDrift * 0.35;
    const endY = startY - 35 + gentleDrift;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(18, 17, 18, 0.45)';
    ctx.shadowBlur = 1.6;
    ctx.strokeStyle = '#141314';
    ctx.lineWidth = 16.0;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
    ctx.stroke();
    ctx.restore();
  }

  private drawCatBody(ctx: CanvasRenderingContext2D, breath: number, purrShift: number): void {
    const catBlack = '#141314';

    // Evaluate measured left & right silhouette points deformed by flexible cat spine!
    const leftPts: Vec2[] = [];
    const rightPts: Vec2[] = [];
    const bellySwell = 1 + this.typingHunch * 0.04;

    for (const slice of BODY_SLICES) {
      const sp = this.spinePoint(slice.t, breath);
      const widen = slice.t > 0.45 ? bellySwell : 1;
      const hw = slice.hw * widen;
      leftPts.push({ x: sp.x + purrShift - hw, y: sp.y });
      rightPts.push({ x: sp.x + purrShift + hw, y: sp.y });
    }

    const crownPt = this.spinePoint(0.11, breath);
    const basePt = this.spinePoint(1.0, breath);

    ctx.save();
    ctx.shadowColor = 'rgba(18, 17, 18, 0.42)';
    ctx.shadowBlur = 1.6;
    ctx.fillStyle = catBlack;

    // 1) Cute rounded grounded hind paws peeking out when front paws lift (matches 8.3s, 10.6s, 13.2s, 31.0s!)
    const anyFrontLifted = this.leftPaw.idleWeight < 0.7 || this.rightPaw.idleWeight < 0.7;
    if (anyFrontLifted) {
      for (const [fx, fy, rx, ry] of [
        [basePt.x - 42, basePt.y - 3, 14.5, 11.5],
        [basePt.x + 32, basePt.y - 1, 15.0, 11.5],
      ]) {
        ctx.beginPath();
        ctx.ellipse(fx, fy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 2) Draw exact smooth spline through measured silhouette slices (left top -> right top -> right down -> bottom -> left up)!
    ctx.beginPath();
    // Smooth crown between ears
    ctx.moveTo(leftPts[0].x + 14, leftPts[0].y - 6);
    ctx.quadraticCurveTo(crownPt.x + purrShift, crownPt.y - 2, rightPts[0].x - 14, rightPts[0].y - 6);

    // Right side smoothly through measured control slices
    ctx.lineTo(rightPts[0].x, rightPts[0].y);
    for (let i = 0; i < rightPts.length - 1; i++) {
      const p0 = rightPts[i];
      const p1 = rightPts[i + 1];
      const mx = (p0.x + p1.x) * 0.5;
      const my = (p0.y + p1.y) * 0.5;
      ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
    }
    const lastR = rightPts[rightPts.length - 1];
    ctx.lineTo(lastR.x, lastR.y);

    // Cozy rounded base resting flush on top of keyboard
    const lastL = leftPts[leftPts.length - 1];
    ctx.quadraticCurveTo(basePt.x + purrShift, basePt.y + 6, lastL.x, lastL.y);

    // Left side smoothly up through measured slices
    for (let i = leftPts.length - 1; i > 0; i--) {
      const p0 = leftPts[i];
      const p1 = leftPts[i - 1];
      const mx = (p0.x + p1.x) * 0.5;
      const my = (p0.y + p1.y) * 0.5;
      ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
    }
    ctx.lineTo(leftPts[0].x, leftPts[0].y);
    ctx.closePath();
    ctx.fill();

    // 3) Compact plush rounded cat ears matching ORIG 0.3s exact height (shorter & cuter, no tall rabbit ears!)
    const headCenter = this.spinePoint(0.24, breath);
    ctx.save();
    ctx.translate(headCenter.x + purrShift, headCenter.y);
    ctx.rotate(this.headTilt);

    const lTwitch = Math.sin(this.earTwitchLeft * Math.PI) * 0.12;
    const rTwitch = Math.sin(this.earTwitchRight * Math.PI) * 0.12;

    // Left ear (compact, rounded-tip kitten ear matching ORIG 0.3s!)
    ctx.save();
    ctx.translate(-33 + this.faceTurnX * 0.18, -28);
    ctx.rotate(-0.08 - lTwitch);
    ctx.beginPath();
    ctx.moveTo(-19, 20);
    ctx.bezierCurveTo(-19, -8, -12, -23, -3, -21);
    ctx.bezierCurveTo(8, -18, 16, -6, 21, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Right ear
    ctx.save();
    ctx.translate(33 + this.faceTurnX * 0.18, -28);
    ctx.rotate(0.08 + rTwitch);
    ctx.beginPath();
    ctx.moveTo(19, 20);
    ctx.bezierCurveTo(19, -8, 12, -23, 3, -21);
    ctx.bezierCurveTo(-8, -18, -16, -6, -21, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.shadowBlur = 0;

    // 4) Delicate wispy short cheek whiskers adapting to 2.5D head turn (exact match to 0.3s, 2.2s, reference photo!)
    ctx.strokeStyle = 'rgba(205, 208, 214, 0.54)';
    ctx.lineWidth = 1.05;
    ctx.lineCap = 'round';
    const wShift = this.faceTurnX * 0.72;
    const leftLen = Math.max(8, 12 - this.faceTurnX * 0.55);
    const rightLen = Math.max(8, 12 + this.faceTurnX * 0.55);
    for (let i = 0; i < 3; i++) {
      const wy = 16 + i * 5.0;
      const slant = 2.0 + i * 1.1;
      ctx.beginPath();
      ctx.moveTo(-34 + wShift, wy);
      ctx.lineTo(-34 + wShift - leftLen, wy + slant);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(34 + wShift, wy);
      ctx.lineTo(34 + wShift + rightLen, wy + slant);
      ctx.stroke();
    }

    // 5) Exact measured lemon-chartreuse eyes (cx = +-23px!)
    this.drawEyes(ctx, this.faceTurnX * 0.72, -1);

    ctx.restore(); // end head

    ctx.restore();
  }

  private drawEyes(ctx: CanvasRenderingContext2D, cx: number, eyeY: number): void {
    const blinkVal = this.isBlinking ? 1 - Math.abs(this.blinkProgress - 1) : 0;
    const closedness = Math.max(blinkVal, this.squintAmount * 0.85);

    // Exact measured eye spacing & size from original 0.3s & 10.6s!
    const eyeXs = [cx - 23.0, cx + 23.0];
    const rx = 14.8 + this.typingHunch * 1.0;
    const ry = 13.4 - this.typingHunch * 0.5;

    for (let idx = 0; idx < 2; idx++) {
      const ex = eyeXs[idx];
      ctx.save();
      ctx.translate(ex, eyeY);

      if (this.squintAmount > 0.4 && blinkVal < 0.3) {
        // Cozy sleepy almond-slit eyes + soft dark upper eyelid hoods (exact 3.4s!)
        ctx.fillStyle = 'rgba(42, 42, 46, 0.85)';
        ctx.beginPath();
        ctx.ellipse(0, -5.5, rx * 0.95, 6.2, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#d4f044';
        ctx.beginPath();
        ctx.ellipse(0, 1.8, rx * 0.98, 3.6, idx === 0 ? 0.06 : -0.06, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      const openRy = Math.max(1.2, ry * (1 - closedness));
      const curiousTilt = (idx === 0 ? -0.1 : 0.1) * (0.25 + this.typingHunch * 0.75);
      ctx.rotate(curiousTilt);

      ctx.fillStyle = '#d4f044';
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.clip();

      if (openRy > 3.2) {
        // Expressive solid matte black pupil hugging lower rim when looking down at keyboard!
        const px = this.eyeLookX;
        const py = this.eyeLookY;
        const pupilRx = 6.2;
        const pupilRy = 8.8;

        ctx.fillStyle = '#0e0e10';
        ctx.beginPath();
        ctx.ellipse(px, py, pupilRx, pupilRy, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  private drawMiniMouse(ctx: CanvasRenderingContext2D): void {
    const mx = this.mouseBaseX + this.mouseOffsetX;
    const my = this.mouseBaseY + this.mouseOffsetY;
    const rx = 16.5;
    const ry = 20.5;
    const clicked = this.mouseLeftDown || this.mouseRightDown || this.mouseMiddleDown;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(-0.06);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.24)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 3;

    ctx.fillStyle = clicked ? '#d4f044' : '#f0f0ec';
    ctx.strokeStyle = '#303136';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();

    ctx.fillStyle = this.mouseScrollFlash > 0.2 ? '#92ba12' : '#5e6066';
    this.roundRect(ctx, -1.8, -12, 3.6, 7.5, 1.8);
    ctx.fill();

    ctx.restore();
  }

  private drawKeyboard(ctx: CanvasRenderingContext2D): void {
    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;

    ctx.save();
    ctx.translate(this.kbCenterX, this.kbCenterY + this.kbBounce * 1.1);
    ctx.rotate(this.kbTiltRad);

    const topHalfW = (this.kbWidth * 0.955) / 2;
    const botHalfW = (this.kbWidth * 1.035) / 2;
    const halfH = this.kbHeight / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
    ctx.shadowBlur = 11;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = '#191a1e';
    this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH + 3.5, halfH + 5.5, 6.5);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#24262c';
    ctx.strokeStyle = '#363840';
    ctx.lineWidth = 1.1;
    this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH, halfH, 6.5);
    ctx.fill();
    ctx.stroke();

    // Bright clean light-grey inner keybed matching ORIG 0.3s bright airy white keyboard!
    ctx.fillStyle = '#d4d6d1';
    this.trapezoidPath(ctx, topHalfW - 5, botHalfW - 5, -halfH + 4, halfH - 4, 3.5);
    ctx.fill();

    const rowH = innerH / TOTAL_ROWS;
    const unitW = innerW / TOTAL_UNITS;
    const gap = 0.9;

    for (const key of KEYBOARD_KEYS) {
      const anim = this.keyAnims.get(key.id);
      const press = anim ? anim.pressAmount : 0;

      const rowCenterFrac = (key.row + 0.5) / TOTAL_ROWS;
      const depthScale = 0.94 + rowCenterFrac * 0.09;

      const rawX = -innerW / 2 + key.uStart * unitW + gap * 0.5;
      const rawW = key.uWidth * unitW - gap;
      const x = rawX * depthScale;
      const w = rawW * depthScale;
      const y = -innerH / 2 + key.row * rowH + gap * 0.5 + press * 2.0;
      const h = rowH - gap - 0.8;

      let topColor = '#f8f8f5';
      let sideColor = '#d0d2cc';
      if (press > 0.14) {
        topColor = '#d2f244';
        sideColor = '#8cb014';
      } else if (key.accent === 'orange') {
        topColor = '#f4a524';
        sideColor = '#c27a10';
      } else if (key.accent === 'mod') {
        topColor = '#efefeb';
        sideColor = '#c7c9c3';
      }

      ctx.fillStyle = sideColor;
      this.roundRect(ctx, x, y + 1.4, w, h, 1.8);
      ctx.fill();

      ctx.fillStyle = topColor;
      this.roundRect(ctx, x, y, w, h - 0.9, 1.8);
      ctx.fill();

      // Crisp, clear keycap legends (letters, numbers & compact icons!)
      const legend = key.id === 'space' ? '' : key.id === 'esc' ? 'Esc' : key.label;
      if (legend) {
        const isWideWord = legend.length >= 3;
        const fontSize = isWideWord ? 5.6 : legend.length === 2 ? 6.4 : 7.8;
        ctx.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
        ctx.fillStyle = press > 0.14
          ? '#111214'
          : key.accent === 'orange'
            ? '#ffffff'
            : '#2c2f36';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(legend, x + w * 0.5, y + (h - 0.9) * 0.52);
      }
    }

    ctx.restore();
  }

  /**
   * True-scale plush velvety cat arm & chubby rounded paw ball (1:1 match to reference photo & 8.3s / 13.2s / 31.0s!)
   */
  private drawPlumpCatArm(
    ctx: CanvasRenderingContext2D,
    side: 'left' | 'right',
    sx: number,
    sy: number,
    px: number,
    py: number,
    squash: number,
    withCrease: boolean,
  ): void {
    const dx = px - sx;
    const dy = py - sy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;

    const wristDist = Math.max(6, len - 8);
    const wx = sx + ux * wristDist;
    const wy = sy + uy * wristDist;

    // True-scale plush proportions for 248px tall cat!
    const rShoulder = 14.2;
    const rWrist = 9.4;
    const pawRx = 14.5 * (1 + squash * 0.14);
    const pawRy = 11.8 * (1 - squash * 0.12);

    ctx.save();
    ctx.shadowColor = 'rgba(18, 17, 18, 0.42)';
    ctx.shadowBlur = 1.6;
    ctx.fillStyle = '#141314';

    // Arm silhouette tapering gently from shoulder to wrist
    ctx.beginPath();
    ctx.moveTo(sx + nx * rShoulder, sy + ny * rShoulder);
    ctx.quadraticCurveTo(
      (sx + wx) * 0.5 + nx * (rShoulder * 0.84),
      (sy + wy) * 0.5 + ny * (rShoulder * 0.84),
      wx + nx * rWrist,
      wy + ny * rWrist,
    );
    ctx.lineTo(wx - nx * rWrist, wy - ny * rWrist);
    ctx.quadraticCurveTo(
      (sx + wx) * 0.5 - nx * (rShoulder * 0.84),
      (sy + wy) * 0.5 - ny * (rShoulder * 0.84),
      sx - nx * rShoulder,
      sy - ny * rShoulder,
    );
    ctx.closePath();
    ctx.fill();

    // Seamless shoulder merge
    ctx.beginPath();
    ctx.arc(sx, sy, rShoulder, 0, Math.PI * 2);
    ctx.fill();

    // Plump, soft rounded black velvet paw ball pressing firmly onto the key!
    ctx.beginPath();
    ctx.ellipse(px, py + 1.5, pawRx, pawRy, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    // Clean crisp subtle light-grey side separation lines ONLY where the arm crosses the black body (exact 2.2s / 8.3s / 13.2s!)
    if (withCrease && len > 28) {
      const startFrac = 0.18;
      const endFrac = 0.72;
      for (const sgn of [-1, 1]) {
        const csx = sx + ux * (len * startFrac) + nx * sgn * (rShoulder * 0.86);
        const csy = sy + uy * (len * startFrac) + ny * sgn * (rShoulder * 0.86);
        const cex = sx + ux * (len * endFrac) + nx * sgn * (rWrist * 1.02);
        const cey = sy + uy * (len * endFrac) + ny * sgn * (rWrist * 1.02);

        const creaseGrad = ctx.createLinearGradient(csx, csy, cex, cey);
        creaseGrad.addColorStop(0.0, 'rgba(216, 218, 222, 0.0)');
        creaseGrad.addColorStop(0.22, 'rgba(216, 218, 222, 0.65)');
        creaseGrad.addColorStop(0.84, 'rgba(216, 218, 222, 0.56)');
        creaseGrad.addColorStop(1.0, 'rgba(216, 218, 222, 0.0)');

        ctx.strokeStyle = creaseGrad;
        ctx.lineWidth = 1.3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(csx, csy);
        ctx.lineTo(cex, cey);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Real 2-segment articulated bent kitten arm (shoulder -> elbow -> curled plump paw on chest!)
   * Matches original video 8.3s (left paw), 10.6s (both paws), 23.2s, 26.2s!
   */
  private drawBentCurledArm(ctx: CanvasRenderingContext2D, paw: PawState, breath: number, alpha: number): void {
    const sh = this.getLiveShoulder(paw, breath);
    const cp = this.getLiveCurledPawPos(paw, breath);
    const sign = paw.side === 'left' ? -1 : 1;
    // Natural elbow bends slightly outward & down below shoulder before forearm curves inward-up!
    const elbowX = sh.x + sign * 8;
    const elbowY = cp.y + 8;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Continuous bent velvety black arm + plump curled paw
    ctx.strokeStyle = '#141314';
    ctx.lineWidth = 20;
    ctx.beginPath();
    ctx.moveTo(sh.x, sh.y);
    ctx.quadraticCurveTo(elbowX, elbowY, cp.x, cp.y);
    ctx.stroke();

    ctx.fillStyle = '#141314';
    ctx.beginPath();
    ctx.ellipse(cp.x, cp.y, 12.5, 11.0, sign * 0.2, 0, Math.PI * 2);
    ctx.fill();

    // Clear crisp soft-grey contour along the bent curled forearm & kitten paw (exact match to ORIG 10.6s!)
    const grad = ctx.createLinearGradient(elbowX, elbowY - 12, cp.x, cp.y + 12);
    grad.addColorStop(0.0, 'rgba(214, 216, 220, 0.0)');
    grad.addColorStop(0.30, 'rgba(214, 216, 220, 0.65)');
    grad.addColorStop(0.85, 'rgba(220, 222, 226, 0.72)');
    grad.addColorStop(1.0, 'rgba(220, 222, 226, 0.25)');

    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(elbowX + sign * 8, elbowY - 16);
    ctx.quadraticCurveTo(elbowX + sign * 4, elbowY + 12, cp.x + sign * 2, cp.y + 10);
    ctx.quadraticCurveTo(cp.x - sign * 11, cp.y + 8, cp.x - sign * 12, cp.y - 4);
    ctx.stroke();

    ctx.restore();
  }

  private drawPaw(ctx: CanvasRenderingContext2D, paw: PawState, breath: number): void {
    // 1) Seated idle vertical front legs (EXACT 4 clean lines of ORIG 0.3s!) OR planted diagonal supporting leg (ORIG 2.2s!)
    if (paw.idleWeight > 0.05) {
      ctx.save();
      ctx.globalAlpha = paw.idleWeight;

      if (paw.side === 'right' && this.leftPaw.mode === 'mouse') {
        const sh = this.getLiveShoulder(paw, breath);
        const baseSp = this.spinePoint(1.0, breath);
        this.drawPlumpCatArm(ctx, 'right', sh.x - 4, sh.y + 8, baseSp.x + 28, baseSp.y - 2, 0, true);
      } else {
        // Exact 4-line seated leg silhouette from ORIG 0.3s (outer curved leg line + crisp inner center-gap line!)
        const topSp = this.spinePoint(0.66, breath);
        const midSp = this.spinePoint(0.84, breath);
        const botSp = this.spinePoint(1.0, breath);
        const sign = paw.side === 'left' ? -1 : 1;

        const outerTopX = topSp.x + sign * 41;
        const outerBotX = botSp.x + sign * 35;
        const innerTopX = topSp.x + sign * 6.5;
        const innerBotX = botSp.x + sign * 9.5;

        // Crisp subtle light-grey outer leg curve & inner leg-gap line (4 total lines across both legs — exact ORIG 0.3s!)
        const lineGrad = ctx.createLinearGradient(topSp.x, topSp.y, botSp.x, botSp.y);
        lineGrad.addColorStop(0.0, 'rgba(210, 212, 216, 0.0)');
        lineGrad.addColorStop(0.18, 'rgba(210, 212, 216, 0.64)');
        lineGrad.addColorStop(0.92, 'rgba(210, 212, 216, 0.62)');
        lineGrad.addColorStop(1.0, 'rgba(210, 212, 216, 0.25)');

        ctx.strokeStyle = lineGrad;
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';

        // Outer front-leg separation line (gently curves inward toward paw!)
        ctx.beginPath();
        ctx.moveTo(outerTopX, topSp.y);
        ctx.quadraticCurveTo(midSp.x + sign * 41, midSp.y, outerBotX, botSp.y - 1);
        ctx.stroke();

        // Inner front-leg gap line (tapers slightly outward toward paws, exact inverted narrow V from ORIG 0.3s!)
        ctx.beginPath();
        ctx.moveTo(innerTopX, topSp.y + 10);
        ctx.lineTo(innerBotX, botSp.y - 1);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 2) Continuous bent articulated curled chest arm (8.3s / 10.6s / 23.2s / 26.2s!)
    if (paw.curlWeight > 0.05) {
      this.drawBentCurledArm(ctx, paw, breath, paw.curlWeight);
    }

    // 3) Plump velvety poking / mouse-holding cat arm!
    const activeArmWeight = Math.max(0, 1 - paw.idleWeight - paw.curlWeight);
    if (activeArmWeight > 0.05) {
      const sh = this.getLiveShoulder(paw, breath);
      const px = paw.pos.x;
      const py = paw.pos.y + (paw.mode === 'mouse' && (this.mouseLeftDown || this.mouseRightDown) ? 2.5 : 0);

      ctx.save();
      ctx.globalAlpha = Math.min(1, activeArmWeight * 1.2);

      for (const sm of paw.smears) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, sm.alpha * activeArmWeight);
        this.drawPlumpCatArm(ctx, paw.side, sm.sx, sm.sy, sm.px, sm.py, 0, false);
        ctx.restore();
      }

      // Keep mouse-reaching arm pure velvet black in open air (ORIG 2.2s); show subtle separation lines when poking across black torso!
      this.drawPlumpCatArm(ctx, paw.side, sh.x, sh.y, px, py, paw.impactSquash, paw.mode !== 'mouse');
      ctx.restore();
    }
  }

  private drawKeyBubbles(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();

    for (const b of this.bubbles) {
      const age = now - b.createdAt;
      const t = Math.min(1, age / b.lifetime);

      let scale = 1;
      if (t < 0.11) {
        const p = t / 0.11;
        scale = 0.62 + Math.sin(p * Math.PI * 0.65) * 0.44;
      } else if (t > 0.76) {
        scale = 1 - ((t - 0.76) / 0.24) * 0.1;
      }
      const alpha = t < 0.72 ? 1 : Math.max(0, 1 - (t - 0.72) / 0.28);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.scale(scale, scale);

      ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
      const textW = ctx.measureText(b.label).width;
      const boxW = b.isSpace ? 40 : Math.max(24, textW + 13);
      const boxH = 24;
      const bx = -boxW / 2;
      const by = -boxH / 2;

      ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 2;

      ctx.fillStyle = '#c8cac6';
      this.roundRect(ctx, bx, by + 2.2, boxW, boxH, 5.5);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(38, 40, 46, 0.42)';
      ctx.lineWidth = 1.05;
      this.roundRect(ctx, bx, by, boxW, boxH - 1.3, 5.5);
      ctx.fill();
      ctx.stroke();

      if (b.isSpace) {
        ctx.strokeStyle = '#222429';
        ctx.lineWidth = 1.55;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(-9, -1);
        ctx.lineTo(-9, 2.0);
        ctx.lineTo(9, 2.0);
        ctx.lineTo(9, -1);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#1e2025';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.label, 0, -0.5);
      }

      ctx.restore();
    }
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  private trapezoidPath(
    ctx: CanvasRenderingContext2D,
    topHalfW: number,
    botHalfW: number,
    topY: number,
    botY: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(-topHalfW + r, topY);
    ctx.lineTo(topHalfW - r, topY);
    ctx.quadraticCurveTo(topHalfW, topY, topHalfW + 1, topY + r);
    ctx.lineTo(botHalfW, botY - r);
    ctx.quadraticCurveTo(botHalfW, botY, botHalfW - r, botY);
    ctx.lineTo(-botHalfW + r, botY);
    ctx.quadraticCurveTo(-botHalfW, botY, -botHalfW, botY - r);
    ctx.lineTo(-topHalfW - 1, topY + r);
    ctx.quadraticCurveTo(-topHalfW, topY, -topHalfW + r, topY);
    ctx.closePath();
  }
}
