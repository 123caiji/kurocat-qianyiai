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
  shoulderOffset: Vec2;
  curlOffset: Vec2; // tucked U-paw resting point on chest (exact video 8.3s / 10.6s / 23.2s!)
  idlePos: Vec2;
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  mode: PawMode;
  // Blend weights for seamless transitions
  idleWeight: number;   // 1 = seated straight front leg (0.3s / 2.2s right leg)
  curlWeight: number;   // 1 = curled U-paw tucked on chest (8.3s / 10.6s)
  pokeTime: number;     // elapsed time in current key poke
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
  createdAt: number;
  lifetime: number;
}

interface KeyAnim {
  pressed: boolean;
  pressAmount: number;
  lastHitAt: number;
}

export class KuroCatEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private lastTime = 0;
  private elapsed = 0;

  public showKeyBubbles = true;

  // Cat anchor coordinates (exact proportions from zoomed video frames 0.3s - 35.5s)
  private readonly catX = 204;
  private readonly catBaseY = 297;

  // Keyboard geometry (65% white/dark/orange board, slight clockwise desk tilt)
  private readonly kbCenterX = 220;
  private readonly kbCenterY = 345;
  private readonly kbWidth = 234;
  private readonly kbHeight = 64;
  private readonly kbTiltRad = (3.4 * Math.PI) / 180;

  // White oval mouse to the left of keyboard
  private readonly mouseBaseX = 72;
  private readonly mouseBaseY = 330;
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
  private faceTurnX = 0; // subtle 2.5D head turn parallax (matches 2.2s!)

  // Expressive body motion (matches 2.2s lean, 8.3s/10.6s hunch & head tilt)
  private bodyLean = 0;      // -1 left toward mouse .. +1 right
  private headTilt = 0;      // subtle curious head tilt when typing/looking (8.3s / 10.6s / 13.2s)
  private typingHunch = 0;   // 0..1 hunches slightly forward when typing
  private strikeRock = 0;
  private strikeRockVel = 0;
  private bodyBob = 0;
  private kbBounce = 0;

  // Blinking, petting, typing cadence
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
      shoulderOffset: { x: -27, y: -82 },
      curlOffset: { x: -20, y: -34 },
      idlePos: { x: this.catX - 13, y: this.catBaseY + 1 },
      pos: { x: this.catX - 13, y: this.catBaseY + 1 },
      vel: { x: 0, y: 0 },
      target: { x: this.catX - 13, y: this.catBaseY + 1 },
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
      shoulderOffset: { x: 27, y: -82 },
      curlOffset: { x: 20, y: -34 },
      idlePos: { x: this.catX + 13, y: this.catBaseY + 1 },
      pos: { x: this.catX + 13, y: this.catBaseY + 1 },
      vel: { x: 0, y: 0 },
      target: { x: this.catX + 13, y: this.catBaseY + 1 },
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
    this.kbBounce = Math.min(1, this.kbBounce + 0.5);

    if (Math.random() < 0.16) {
      if (Math.random() < 0.5) this.earTwitchLeft = 1;
      else this.earTwitchRight = 1;
    }

    const keyColCenter = spec.uStart + spec.uWidth * 0.5;
    let targetPoint = this.getKeyWorldCenter(spec);
    let chosen: PawState;

    // When mouse is active/sweeping, keep left paw 100% dedicated to mouse & let right paw hit ALL keys (31.0s / 35.5s!)
    const mouseDedicated = this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 900;

    if (spec.id === 'space') {
      if (mouseDedicated) {
        chosen = this.rightPaw;
      } else {
        this.lastSpacePaw = this.lastSpacePaw === 'left' ? 'right' : 'left';
        chosen = this.lastSpacePaw === 'left' ? this.leftPaw : this.rightPaw;
      }
      const spaceU = chosen.side === 'left' ? spec.uStart + spec.uWidth * 0.34 : spec.uStart + spec.uWidth * 0.66;
      targetPoint = this.projectKeyboardPoint(spaceU, spec.row + 0.5);
    } else if (mouseDedicated) {
      chosen = this.rightPaw;
    } else if (keyColCenter <= 6.2) {
      chosen = this.leftPaw;
    } else {
      chosen = this.rightPaw;
    }

    this.strikeRockVel += (chosen.side === 'left' ? -1 : 1) * (1.35 + this.typingEnergy * 1.1);

    // Record crisp motion smear when whipping rapidly between keys (exact match to 16.2s / 35.5s!)
    const prevShoulder = this.getLiveShoulder(chosen, 0);
    if (chosen.mode === 'poke' && Math.hypot(targetPoint.x - chosen.pos.x, targetPoint.y - chosen.pos.y) > 18) {
      chosen.smears.push({
        sx: prevShoulder.x,
        sy: prevShoulder.y,
        px: chosen.pos.x,
        py: chosen.pos.y,
        alpha: 0.32,
      });
      if (chosen.smears.length > 3) chosen.smears.shift();
    }

    // Shoot straight from curled chest paw down onto the exact keycap! (8.3s / 13.2s / 16.2s / 31.0s!)
    if (chosen.mode === 'curled' || chosen.mode === 'idle') {
      const startCurl = this.getLiveCurlPoint(chosen, 0);
      chosen.pos = { x: startCurl.x, y: startCurl.y };
      chosen.vel = { x: 0, y: 220 };
    }
    chosen.mode = 'poke';
    chosen.target = { x: targetPoint.x, y: targetPoint.y - 1 };
    chosen.pokeTime = 0;
    chosen.impactSquash = 0.75;
    chosen.lastActiveAt = now;

    // Curl the OTHER idle paw cutely up onto the chest during typing! (exact 8.3s / 10.6s / 23.2s pose!)
    const other = chosen.side === 'left' ? this.rightPaw : this.leftPaw;
    if (other.mode === 'idle' && !mouseDedicated) {
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
    this.mouseTargetOffsetX = (nx - 0.5) * 36;
    this.mouseTargetOffsetY = (ny - 0.5) * 22;
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

  // ---- Coordinate projection ----

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
    const baseX = Math.max(122, Math.min(314, keyX * 0.5 + 145));
    this.bubbles.push({
      id: this.nextBubbleId++,
      label,
      isSpace,
      x: baseX,
      targetX: baseX,
      y: 286,
      createdAt: now,
      lifetime: 920,
    });
    this.layoutBubbles();
  }

  private layoutBubbles(): void {
    const count = this.bubbles.length;
    if (count === 0) return;

    const widths = this.bubbles.map((b) => (b.isSpace ? 38 : Math.max(23, b.label.length * 7.5 + 12)));
    const gap = 4.5;
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (count - 1);
    const anchor = 258; // positioned right over lower-right belly / above keyboard just like video 8.3s-35.5s!
    let cursor = Math.max(115, Math.min(344 - totalW, anchor - totalW * 0.5));

    for (let i = 0; i < count; i++) {
      const w = widths[i];
      this.bubbles[i].targetX = cursor + w * 0.5;
      cursor += w + gap;
    }
  }

  // ---- Body transforms & attachment points ----

  private getBodyTransform(breath: number) {
    const leanAngle = this.bodyLean * 0.19 + this.strikeRock * 0.04;
    const shiftX = this.bodyLean * 14;
    const hunchDrop = this.typingHunch * 10 + this.bodyBob * 2.4;
    const scaleX = 1 + this.typingHunch * 0.045 + this.bodyBob * 0.018;
    const scaleY = 1 - this.typingHunch * 0.055 - this.bodyBob * 0.022;
    return {
      pivotX: this.catX,
      pivotY: this.catBaseY,
      leanAngle,
      shiftX,
      shiftY: breath * 0.6 + hunchDrop,
      scaleX,
      scaleY,
    };
  }

  private bodyLocalToWorld(lx: number, ly: number, breath: number): Vec2 {
    const tr = this.getBodyTransform(breath);
    const sx = lx * tr.scaleX;
    const sy = (ly + tr.shiftY * 0.65) * tr.scaleY;
    const cos = Math.cos(tr.leanAngle);
    const sin = Math.sin(tr.leanAngle);
    return {
      x: tr.pivotX + tr.shiftX + sx * cos - sy * sin,
      y: tr.pivotY + sx * sin + sy * cos,
    };
  }

  private getLiveShoulder(paw: PawState, breath: number): Vec2 {
    return this.bodyLocalToWorld(paw.shoulderOffset.x, paw.shoulderOffset.y, breath);
  }

  private getLiveCurlPoint(paw: PawState, breath: number): Vec2 {
    const bob = Math.sin(this.elapsed * 13 + (paw.side === 'left' ? 0 : Math.PI)) * (1.5 + this.typingEnergy * 2.2);
    return this.bodyLocalToWorld(paw.curlOffset.x, paw.curlOffset.y + bob, breath);
  }

  // ---- Simulation step ----

  private update(dt: number, now: number): void {
    this.elapsed += dt;

    // Snappy mini mouse glide
    const mLerp = 1 - Math.exp(-28 * dt);
    this.mouseOffsetX += (this.mouseTargetOffsetX - this.mouseOffsetX) * mLerp;
    this.mouseOffsetY += (this.mouseTargetOffsetY - this.mouseOffsetY) * mLerp;
    this.mouseScrollFlash = Math.max(0, this.mouseScrollFlash - dt * 4.5);

    // Recent typing cadence
    while (this.recentKeyTimes.length > 0 && now - this.recentKeyTimes[0] > 950) {
      this.recentKeyTimes.shift();
    }
    const targetTypingEnergy = Math.min(1, this.recentKeyTimes.length / 7);
    this.typingEnergy += (targetTypingEnergy - this.typingEnergy) * (1 - Math.exp(-9 * dt));

    const isTypingRecently = now - this.lastAnyKeyAt < 650;
    const targetHunch = isTypingRecently ? 0.42 + this.typingEnergy * 0.58 : 0;
    this.typingHunch += (targetHunch - this.typingHunch) * (1 - Math.exp(-10 * dt));

    // Gentle alternating rock
    const rockAcc = -this.strikeRock * 150 - this.strikeRockVel * 16;
    this.strikeRockVel += rockAcc * dt;
    this.strikeRock = Math.max(-1, Math.min(1, this.strikeRock + this.strikeRockVel * dt));

    this.bodyBob = Math.max(0, this.bodyBob - dt * 14);
    this.kbBounce = Math.max(0, this.kbBounce - dt * 15);

    // Expressive forward-left body lean when holding mouse (exact match to 2.2s / 3.4s / 31.0s!)
    let targetLean = 0;
    if (this.leftPaw.mode === 'mouse') {
      const mouseSweepBias = (this.mouseOffsetX / 18) * 0.24;
      targetLean = this.rightPaw.mode === 'poke'
        ? -0.42 + mouseSweepBias
        : -0.92 + mouseSweepBias;
    } else if (this.rightPaw.mode === 'poke' && this.rightPaw.target.x > this.catX + 60) {
      targetLean = 0.26;
    } else if (this.leftPaw.mode === 'poke' && this.leftPaw.target.x < this.catX - 55) {
      targetLean = -0.24;
    }
    this.bodyLean += (targetLean - this.bodyLean) * (1 - Math.exp(-10 * dt));

    // Subtle curious head tilt during typing (matches 8.3s / 10.6s / 13.2s!)
    const desiredHeadTilt = this.typingHunch * (this.strikeRock * 0.08 - 0.05) + this.bodyLean * 0.06;
    this.headTilt += (desiredHeadTilt - this.headTilt) * (1 - Math.exp(-9 * dt));

    // Petting decay & sleepy almond squint eyes (3.4s!)
    this.petEnergy = Math.max(0, this.petEnergy - dt * (this.cursorOverCat ? 0.22 : 0.65));
    const wantSquint = this.petEnergy > 0.3 ? 1 : 0;
    this.squintAmount += (wantSquint - this.squintAmount) * (1 - Math.exp(-12 * dt));

    this.earTwitchLeft = Math.max(0, this.earTwitchLeft - dt * 8);
    this.earTwitchRight = Math.max(0, this.earTwitchRight - dt * 8);

    // Natural blink
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

    // 100% live cursor eye tracking + 2.5D head-turn parallax (matches 2.2s / 31.0s!)
    const eyeCenterRelX = (this.catX + this.bodyLean * 14) / LOGICAL_W;
    const eyeCenterRelY = (this.catBaseY - 144) / LOGICAL_H;
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
    const targetEyeX = dx * 5.8 * (1 - pureTypingGlance * 0.25);
    const targetEyeY = dy * 4.8 * (1 - pureTypingGlance * 0.35) + pureTypingGlance * 3.8;
    const eyeLerp = 1 - Math.exp(-20 * dt);
    this.eyeLookX += (targetEyeX - this.eyeLookX) * eyeLerp;
    this.eyeLookY += (targetEyeY - this.eyeLookY) * eyeLerp;

    const targetFaceTurn = dx * 3.5 + this.bodyLean * 4.5;
    this.faceTurnX += (targetFaceTurn - this.faceTurnX) * (1 - Math.exp(-10 * dt));

    // Key glow decay
    for (const anim of this.keyAnims.values()) {
      if (!anim.pressed && anim.pressAmount > 0) {
        anim.pressAmount = Math.max(0, anim.pressAmount - dt * 5.2);
      }
    }

    this.updatePaw(this.leftPaw, dt, now);
    this.updatePaw(this.rightPaw, dt, now);

    // Smooth horizontal keycap bubbles
    const beforeLen = this.bubbles.length;
    this.bubbles = this.bubbles.filter((b) => now - b.createdAt < b.lifetime);
    if (this.bubbles.length !== beforeLen) {
      this.layoutBubbles();
    }
    for (const b of this.bubbles) {
      const age = (now - b.createdAt) / b.lifetime;
      b.x += (b.targetX - b.x) * (1 - Math.exp(-18 * dt));
      const targetY = 274 - age * 12;
      b.y += (targetY - b.y) * (1 - Math.exp(-16 * dt));
    }
  }

  private updatePaw(paw: PawState, dt: number, now: number): void {
    const liveMouseX = this.mouseBaseX + this.mouseOffsetX;
    const liveMouseY = this.mouseBaseY + this.mouseOffsetY;

    if (paw.mode === 'mouse') {
      paw.target = { x: liveMouseX + 1, y: liveMouseY - 3 };
      const stillHolding = this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 2200;
      if (!stillHolding) {
        paw.mode = 'idle';
      }
    } else if (paw.mode === 'poke') {
      paw.pokeTime += dt;
      // Hold brief crisp poke (~115ms) on keycap, then snap cleanly back up to curled chest U-paw! (exact 8.3s / 10.6s / 16.2s / 31.0s rhythm!)
      if (paw.pokeTime > 0.115) {
        if (paw.side === 'left' && now - this.lastMouseMoveAt < 1800) {
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
      const cp = this.getLiveCurlPoint(paw, 0);
      paw.target = cp;
    } else if (paw.mode === 'idle') {
      paw.target = { x: paw.idlePos.x, y: paw.idlePos.y };
    }

    // Smooth mode blend weights
    const wantIdle = paw.mode === 'idle' ? 1 : 0;
    const wantCurl = paw.mode === 'curled' ? 1 : 0;
    const blendRate = 1 - Math.exp(-22 * dt);
    paw.idleWeight += (wantIdle - paw.idleWeight) * blendRate;
    paw.curlWeight += (wantCurl - paw.curlWeight) * blendRate;

    // Snappy spring physics (glued tightly to mouse when sweeping; whips sharply to keys on poke!)
    const stiffness = paw.mode === 'mouse' ? 1500 : paw.mode === 'poke' ? 1650 : 720;
    const damping = paw.mode === 'mouse' ? 56 : paw.mode === 'poke' ? 48 : 34;
    const ax = (paw.target.x - paw.pos.x) * stiffness - paw.vel.x * damping;
    const ay = (paw.target.y - paw.pos.y) * stiffness - paw.vel.y * damping;
    paw.vel.x += ax * dt;
    paw.vel.y += ay * dt;
    paw.pos.x += paw.vel.x * dt;
    paw.pos.y += paw.vel.y * dt;

    paw.impactSquash = Math.max(0, paw.impactSquash - dt * 8);

    // Decay motion smears
    for (const s of paw.smears) {
      s.alpha -= dt * 3.6;
    }
    paw.smears = paw.smears.filter((s) => s.alpha > 0.02);
  }

  // ---- High-fidelity hand-drawn Canvas 2D rendering ----

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

    const breath = Math.sin(this.elapsed * 2.1) * 0.9;
    const purrShift = this.squintAmount > 0.4 ? Math.sin(this.elapsed * 22) * 0.45 * this.squintAmount : 0;

    // Layer 1: Calm, steady graceful S-hook black tail (NO wild wagging — matches all 12 frames!)
    this.drawTail(ctx);

    // Layer 2: Mini mouse & 65% mechanical keyboard
    this.drawMiniMouse(ctx);
    this.drawKeyboard(ctx);

    // Layer 3: Exact Jiji-style sitting black cat (rounded hind paws + sleek pear body + plump head + tiny cheek whiskers + lemon-green eyes)
    this.drawCatBody(ctx, breath, purrShift);

    // Layer 4: Front paws (tapered idle front legs / planted mouse-lean support leg / curled-on-chest U-paws / straight poking elastic arms)
    this.drawPaw(ctx, this.leftPaw, breath);
    this.drawPaw(ctx, this.rightPaw, breath);

    // Layer 5: Crisp floating 3D keycap bubbles
    if (this.showKeyBubbles) {
      this.drawKeyBubbles(ctx);
    }

    ctx.restore();
  }

  private drawTail(ctx: CanvasRenderingContext2D): void {
    // Whisper-gentle slow drift ONLY (±1.8px) — calm & steady just like original video 0.3s - 35.5s!
    const gentleDrift = Math.sin(this.elapsed * 0.95) * 1.8;

    const startX = this.catX + 38 + this.bodyLean * 4;
    const startY = this.catBaseY - 14;
    const cp1X = this.catX + 74;
    const cp1Y = this.catBaseY - 11 + gentleDrift * 0.3;
    const cp2X = this.catX + 86;
    const cp2Y = this.catBaseY - 40 + gentleDrift * 0.6;
    const endX = this.catX + 109 + gentleDrift * 0.4;
    const endY = this.catBaseY - 44 + gentleDrift;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#141314';
    ctx.lineWidth = 10.5;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
    ctx.stroke();
    ctx.restore();
  }

  private drawCatBody(ctx: CanvasRenderingContext2D, breath: number, purrShift: number): void {
    const tr = this.getBodyTransform(breath);
    const catBlack = '#141314';

    ctx.save();

    // 0) Two cute little round grounded hind paws peeking out at bottom-left & bottom-right (exact match to 2.2s, 8.3s, 10.6s, 16.2s, 31.0s!)
    ctx.fillStyle = catBlack;
    ctx.strokeStyle = 'rgba(210, 212, 216, 0.42)';
    ctx.lineWidth = 1.1;
    for (const footX of [this.catX - 31 + tr.shiftX * 0.25, this.catX + 31 + tr.shiftX * 0.25]) {
      ctx.beginPath();
      ctx.ellipse(footX, this.catBaseY - 2, 11.5, 8.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Apply body lean & gentle typing hunch
    ctx.translate(tr.pivotX + tr.shiftX + purrShift, tr.pivotY);
    ctx.rotate(tr.leanAngle);
    ctx.scale(tr.scaleX, tr.scaleY);

    const headY = -146 + tr.shiftY * 0.55;
    ctx.fillStyle = catBlack;

    // 1) Sleek Jiji-style pear sitting torso (narrower shoulders swelling gracefully to plump lower hips, exact 0.3s shape!)
    ctx.beginPath();
    ctx.moveTo(-27, headY + 22);
    ctx.bezierCurveTo(-40, headY + 46, -54, -44, -44, -4);
    ctx.quadraticCurveTo(0, 5, 44, -4);
    ctx.bezierCurveTo(54, -44, 40, headY + 46, 27, headY + 22);
    ctx.closePath();
    ctx.fill();

    // 2) Head + Ears (with subtle curious tilt & 2.5D face parallax!)
    ctx.save();
    ctx.translate(0, headY);
    ctx.rotate(this.headTilt);

    const lTwitch = Math.sin(this.earTwitchLeft * Math.PI) * 0.14;
    const rTwitch = Math.sin(this.earTwitchRight * Math.PI) * 0.14;

    // Left ear (medium-small rounded triangle at outer crown corner, exact 0.3s & 2.2s!)
    ctx.save();
    ctx.translate(-26 + this.faceTurnX * 0.18, -22);
    ctx.rotate(-0.12 - lTwitch);
    ctx.beginPath();
    ctx.moveTo(-12, 16);
    ctx.quadraticCurveTo(-13, -18, -4, -27);
    ctx.quadraticCurveTo(8, -16, 15, -2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Right ear
    ctx.save();
    ctx.translate(26 + this.faceTurnX * 0.18, -22);
    ctx.rotate(0.12 + rTwitch);
    ctx.beginPath();
    ctx.moveTo(12, 16);
    ctx.quadraticCurveTo(13, -18, 4, -27);
    ctx.quadraticCurveTo(-8, -16, -15, -2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Plump cute oval-cheeked cat head (exact proportions of 0.3s & 2.2s!)
    ctx.beginPath();
    ctx.moveTo(-24, -27);
    ctx.quadraticCurveTo(0, -31, 24, -27);
    ctx.bezierCurveTo(44, -20, 46, 12, 30, 26);
    ctx.quadraticCurveTo(0, 34, -30, 26);
    ctx.bezierCurveTo(-46, 12, -44, -20, -24, -27);
    ctx.closePath();
    ctx.fill();

    // 3) Exact tiny short downward-slanted cheek whiskers right at lower cheek edge! (matches 0.3s, 2.2s, 8.3s, 10.6s, 16.2s, 31.0s!)
    ctx.strokeStyle = 'rgba(218, 220, 224, 0.62)';
    ctx.lineWidth = 1.05;
    ctx.lineCap = 'round';
    const wShift = this.faceTurnX * 0.55;
    for (let i = 0; i < 3; i++) {
      const wy = 11 + i * 4.2;
      const slant = 2.0 + i * 1.1;
      // Left cheek tiny dashes
      ctx.beginPath();
      ctx.moveTo(-27 + wShift, wy);
      ctx.lineTo(-37 + wShift, wy + slant);
      ctx.stroke();
      // Right cheek tiny dashes
      ctx.beginPath();
      ctx.moveTo(27 + wShift, wy);
      ctx.lineTo(37 + wShift, wy + slant);
      ctx.stroke();
    }

    // 4) Iconic lemon-chartreuse eyes (shifted subtly by faceTurnX for 2.5D head turn like 2.2s!)
    this.drawEyes(ctx, this.faceTurnX * 0.65, -2);

    ctx.restore(); // end head

    ctx.restore();
  }

  private drawEyes(ctx: CanvasRenderingContext2D, cx: number, eyeY: number): void {
    const blinkVal = this.isBlinking ? 1 - Math.abs(this.blinkProgress - 1) : 0;
    const closedness = Math.max(blinkVal, this.squintAmount * 0.85);

    const eyeXs = [cx - 16.5, cx + 16.5];
    // Slightly taller cute upright oval eyes in idle (exact match to 0.3s!)
    const rx = 11.4 + this.typingHunch * 1.0;
    const ry = 12.6 - this.typingHunch * 1.0;

    for (let idx = 0; idx < 2; idx++) {
      const ex = eyeXs[idx];
      ctx.save();
      ctx.translate(ex, eyeY);

      if (this.squintAmount > 0.4 && blinkVal < 0.3) {
        // Exact cozy sleepy almond-slit eyes + soft dark upper eyelid hood from video 3.4s!!
        ctx.fillStyle = 'rgba(42, 42, 46, 0.85)';
        ctx.beginPath();
        ctx.ellipse(0, -4.5, rx * 0.95, 5.2, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#d4f044';
        ctx.beginPath();
        ctx.ellipse(0, 1.5, rx * 0.98, 3.0, idx === 0 ? 0.06 : -0.06, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      const openRy = Math.max(1.2, ry * (1 - closedness));

      // Flat clean lemon-chartreuse iris (matches 0.3s - 35.5s!)
      ctx.fillStyle = '#d4f044';
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.clip();

      if (openRy > 3.0) {
        const px = this.eyeLookX;
        const py = this.eyeLookY;
        const pupilRx = 4.6;
        const pupilRy = 7.4;

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
    const rx = 13.5;
    const ry = 17.5;
    const clicked = this.mouseLeftDown || this.mouseRightDown || this.mouseMiddleDown;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(-0.06);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.24)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 3;

    // Exact light oval mouse; lights clean bright chartreuse green on click (3.4s!)
    ctx.fillStyle = clicked ? '#d4f044' : '#f0f0ec';
    ctx.strokeStyle = '#303136';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();

    // Tiny top scroll bar
    ctx.fillStyle = this.mouseScrollFlash > 0.2 ? '#92ba12' : '#5e6066';
    this.roundRect(ctx, -1.5, -10.5, 3.0, 6.5, 1.5);
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

    const rowH = innerH / TOTAL_ROWS;
    const unitW = innerW / TOTAL_UNITS;
    const gap = 1.5;

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
      const h = rowH - gap - 1.0;

      let topColor = '#f5f5f1';
      let sideColor = '#c5c6c0';
      if (press > 0.14) {
        topColor = '#d2f244';
        sideColor = '#8cb014';
      } else if (key.accent === 'orange') {
        topColor = '#f4a524';
        sideColor = '#c27a10';
      } else if (key.accent === 'mod') {
        topColor = '#e6e7e2';
        sideColor = '#b7b8b2';
      }

      ctx.fillStyle = sideColor;
      this.roundRect(ctx, x, y + 1.5, w, h, 1.8);
      ctx.fill();

      ctx.fillStyle = topColor;
      this.roundRect(ctx, x, y, w, h - 1.0, 1.8);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawTaperedArm(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    px: number,
    py: number,
    squash: number,
    outlineAlpha: number,
  ): void {
    const dx = px - sx;
    const dy = py - sy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / len;
    const ny = dx / len;

    const r0 = 10.2;
    const r1 = 7.4 * (1 + squash * 0.14);
    const pawRy = 7.2 * (1 - squash * 0.14);

    // Clean straight tapered elastic cat leg (exact match to 2.2s, 3.4s, 8.3s, 13.2s, 16.2s, 31.0s!)
    ctx.fillStyle = '#141314';
    ctx.beginPath();
    ctx.moveTo(sx + nx * r0, sy + ny * r0);
    ctx.lineTo(px + nx * r1, py + ny * r1);
    ctx.lineTo(px - nx * r1, py - ny * r1);
    ctx.lineTo(sx - nx * r0, sy - ny * r0);
    ctx.closePath();
    ctx.fill();

    // Seamless shoulder join
    ctx.beginPath();
    ctx.arc(sx, sy, r0, 0, Math.PI * 2);
    ctx.fill();

    // Smooth plush rounded mitten paw (NO cartoon fork claws!)
    ctx.beginPath();
    ctx.ellipse(px, py, r1 * 1.04, pawRy, 0, 0, Math.PI * 2);
    ctx.fill();

    // Crisp subtle white-grey contour along sides & rounded tip (exact match to 8.3s / 13.2s / 31.0s!)
    if (outlineAlpha > 0.02) {
      const grad = ctx.createLinearGradient(sx, sy, px, py);
      grad.addColorStop(0.0, 'rgba(218, 220, 224, 0)');
      grad.addColorStop(0.22, 'rgba(218, 220, 224, 0)');
      grad.addColorStop(0.55, `rgba(218, 220, 224, ${outlineAlpha * 0.78})`);
      grad.addColorStop(1.0, `rgba(224, 226, 230, ${outlineAlpha})`);

      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.25;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx + nx * r0, sy + ny * r0);
      ctx.lineTo(px + nx * r1, py + ny * r1);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(sx - nx * r0, sy - ny * r0);
      ctx.lineTo(px - nx * r1, py - ny * r1);
      ctx.stroke();

      ctx.strokeStyle = `rgba(224, 226, 230, ${outlineAlpha * 0.85})`;
      ctx.beginPath();
      ctx.ellipse(px, py, r1 * 1.02, pawRy, 0, 0.1, Math.PI - 0.1);
      ctx.stroke();
    }
  }

  private drawCurledChestPaw(ctx: CanvasRenderingContext2D, paw: PawState, breath: number, alpha: number): void {
    // EXACT CUTE CURLED-UP `U`-SHAPED KITTEN PAW TUCKED ON CHEST FROM VIDEO 8.3s, 10.6s, 23.2s, 26.2s!!
    const cp = this.getLiveCurlPoint(paw, breath);
    const tilt = paw.side === 'left' ? 0.16 : -0.16;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cp.x, cp.y);
    ctx.rotate(tilt);

    // Solid black tucked forearm/paw pad
    ctx.fillStyle = '#141314';
    ctx.beginPath();
    ctx.ellipse(0, 0, 10.5, 13.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Signature crisp curved white-grey U-contour outlining the tucked paw against the black belly!
    ctx.strokeStyle = 'rgba(224, 226, 230, 0.78)';
    ctx.lineWidth = 1.35;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-9.2, -9.5);
    ctx.bezierCurveTo(-11.5, 2, -8.5, 12.5, 0, 12.5);
    ctx.bezierCurveTo(8.5, 12.5, 11.5, 2, 9.2, -9.5);
    ctx.stroke();

    ctx.restore();
  }

  private drawPaw(ctx: CanvasRenderingContext2D, paw: PawState, breath: number): void {
    const tr = this.getBodyTransform(breath);

    // 1) Seated idle vertical front leg (0.3s) OR planted supporting diagonal right leg during mouse lean (2.2s / 3.4s!)
    if (paw.idleWeight > 0.05) {
      ctx.save();
      ctx.globalAlpha = paw.idleWeight;

      if (paw.side === 'right' && this.leftPaw.mode === 'mouse') {
        // Planted supporting right front leg leaning diagonally to hold up body (exact match to 2.2s & 3.4s!)
        const sh = this.getLiveShoulder(paw, breath);
        const footX = this.catX + 18;
        const footY = this.catBaseY + 1;
        this.drawTaperedArm(ctx, sh.x, sh.y + 8, footX, footY, 0, 0.72);
      } else {
        // Classic slim tapered vertical front leg on seated cat (exact match to 0.3s!)
        ctx.translate(tr.pivotX + tr.shiftX, tr.pivotY);
        ctx.rotate(tr.leanAngle);
        ctx.scale(tr.scaleX, tr.scaleY);

        const legX = paw.side === 'left' ? -13.5 : 13.5;
        const topY = -68;
        const botY = 0;

        ctx.fillStyle = '#141314';
        ctx.beginPath();
        ctx.moveTo(legX - 8.2, topY);
        ctx.lineTo(legX + 8.2, topY);
        ctx.lineTo(legX + 6.4, botY - 2);
        ctx.quadraticCurveTo(legX, botY + 4, legX - 6.4, botY - 2);
        ctx.closePath();
        ctx.fill();

        // Crisp subtle white-grey tapered vertical leg contour (exact match to 0.3s!)
        ctx.strokeStyle = 'rgba(212, 214, 218, 0.65)';
        ctx.lineWidth = 1.25;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(legX - 8.0, topY + 2);
        ctx.lineTo(legX - 6.3, botY - 2);
        ctx.quadraticCurveTo(legX, botY + 3.5, legX + 6.3, botY - 2);
        ctx.lineTo(legX + 8.0, topY + 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 2) Curled-up `U`-shaped kitten paw tucked on chest while ready to type! (exact match to 8.3s / 10.6s / 23.2s / 26.2s!)
    if (paw.curlWeight > 0.05) {
      this.drawCurledChestPaw(ctx, paw, breath, paw.curlWeight);
    }

    // 3) Extended straight-tapered elastic arm poking a key or holding the mouse! (2.2s / 8.3s / 13.2s / 16.2s / 31.0s!)
    const activeArmWeight = Math.max(0, 1 - paw.idleWeight - paw.curlWeight);
    if (activeArmWeight > 0.05) {
      const sh = this.getLiveShoulder(paw, breath);
      const px = paw.pos.x;
      const py = paw.pos.y + (paw.mode === 'mouse' && (this.mouseLeftDown || this.mouseRightDown) ? 2.5 : 0);

      ctx.save();
      ctx.globalAlpha = Math.min(1, activeArmWeight * 1.2);

      // Motion-blur smear on fast cross-keyboard whips (exact match to 16.2s / 35.5s!)
      for (const sm of paw.smears) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, sm.alpha * activeArmWeight);
        this.drawTaperedArm(ctx, sm.sx, sm.sy, sm.px, sm.py, 0, 0.25);
        ctx.restore();
      }

      this.drawTaperedArm(ctx, sh.x, sh.y, px, py, paw.impactSquash, 0.68);
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
      ctx.scale(scale, scale);

      ctx.font = '700 11.5px "Segoe UI", system-ui, sans-serif';
      const textW = ctx.measureText(b.label).width;
      const boxW = b.isSpace ? 38 : Math.max(23, textW + 12);
      const boxH = 23;
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
