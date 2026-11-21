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

interface PawState {
  side: 'left' | 'right';
  shoulderOffset: Vec2;
  idlePos: Vec2;
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  mode: 'idle' | 'mouse' | 'key';
  activeBlend: number; // 0 = seated leg lines, 1 = active elastic arm
  // 3-phase vertical slap animation (lift -> slap down -> rebound hover)
  strikeTime: number; // elapsed since last strike (seconds)
  isStriking: boolean;
  hoverLift: number; // current upward lift off keycap surface
  impactSquash: number; // 0..1 paw pad contact squash on slap
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

  // Cat layout coordinates (exact proportions from video 00:00 - 00:41)
  private readonly catX = 204;
  private readonly catBaseY = 298; // bottom where cat sits right behind keyboard

  // Keyboard geometry (compact 65% white/dark/orange board, slight charming tilt)
  private readonly kbCenterX = 220;
  private readonly kbCenterY = 344;
  private readonly kbWidth = 234;
  private readonly kbHeight = 66;
  private readonly kbTiltRad = (3.8 * Math.PI) / 180;

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

  // Cursor & eye tracking
  private cursorRelX = 0.5;
  private cursorRelY = 0.5;
  private cursorOverCat = false;
  private eyeLookX = 0;
  private eyeLookY = 0;

  // Expressive organic body animation (exact match to video!)
  private bodyLean = 0; // -1 left toward mouse .. +1 right toward right keys
  private typingHunch = 0; // 0..1 squishes & hunches forward over keyboard during typing!
  private strikeRock = 0; // left-right rocking impulse on rapid alternating slaps
  private strikeRockVel = 0;
  private bodyBob = 0; // vertical bob impulse on key slam
  private kbBounce = 0;

  // Blinking, petting, ear micro-twitch, typing rhythm
  private nextBlinkAt = 2.6;
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
      shoulderOffset: { x: -28, y: -76 },
      idlePos: { x: this.catX - 13, y: 298 },
      pos: { x: this.catX - 13, y: 298 },
      vel: { x: 0, y: 0 },
      target: { x: this.catX - 13, y: 298 },
      mode: 'idle',
      activeBlend: 0,
      strikeTime: 1,
      isStriking: false,
      hoverLift: 0,
      impactSquash: 0,
      lastActiveAt: -10000,
      smears: [],
    };

    this.rightPaw = {
      side: 'right',
      shoulderOffset: { x: 28, y: -76 },
      idlePos: { x: this.catX + 13, y: 298 },
      pos: { x: this.catX + 13, y: 298 },
      vel: { x: 0, y: 0 },
      target: { x: this.catX + 13, y: 298 },
      mode: 'idle',
      activeBlend: 0,
      strikeTime: 1,
      isStriking: false,
      hoverLift: 0,
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

    // Lively squash-bob and keyboard tap impact
    this.bodyBob = Math.min(1, this.bodyBob + 0.72);
    this.kbBounce = Math.min(1, this.kbBounce + 0.65);

    if (Math.random() < 0.18) {
      if (Math.random() < 0.5) this.earTwitchLeft = 1;
      else this.earTwitchRight = 1;
    }

    const keyColCenter = spec.uStart + spec.uWidth * 0.5;
    let targetPoint = this.getKeyWorldCenter(spec);
    let chosen: PawState;

    // If user is actively moving/sweeping or clicking the mouse, keep left paw 100% dedicated to the mouse
    // while right paw seamlessly handles ALL keyboard strikes (matching video 00:24 - 00:41!)
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

    // Add playful alternating body rock impulse!
    this.strikeRockVel += (chosen.side === 'left' ? -1 : 1) * (1.8 + this.typingEnergy * 1.4);

    // Record pre-strike smear snapshot when whipping fast between keys
    const prevShoulder = this.getLiveShoulder(chosen, 0);
    if (chosen.activeBlend > 0.35) {
      chosen.smears.push({
        sx: prevShoulder.x,
        sy: prevShoulder.y,
        px: chosen.pos.x,
        py: chosen.pos.y - chosen.hoverLift,
        alpha: 0.32,
      });
      if (chosen.smears.length > 4) chosen.smears.shift();
    }

    // Trigger 3-phase vertical slap (lift -> slam onto keycap -> rebound hover!)
    chosen.mode = 'key';
    chosen.target = { x: targetPoint.x, y: targetPoint.y - 2 };
    chosen.strikeTime = 0;
    chosen.isStriking = true;
    chosen.lastActiveAt = now;

    // If the OTHER paw is idle and not on mouse, raise it into ready-hover typing stance during fast bursts!
    const other = chosen.side === 'left' ? this.rightPaw : this.leftPaw;
    if (other.mode === 'idle' && this.recentKeyTimes.length >= 2) {
      const readyKey = other.side === 'left'
        ? this.projectKeyboardPoint(4.2, 2.3)
        : this.projectKeyboardPoint(9.2, 2.3);
      other.mode = 'key';
      other.target = { x: readyKey.x, y: readyKey.y - 2 };
      other.isStriking = false;
      other.hoverLift = 16;
      other.lastActiveAt = now - 120;
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
    this.mouseTargetOffsetX = (nx - 0.5) * 38;
    this.mouseTargetOffsetY = (ny - 0.5) * 24;
    this.lastMouseMoveAt = now;

    // Immediately dedicate left paw to the moving mouse so you can sweep mouse + type simultaneously!
    this.leftPaw.mode = 'mouse';
    this.leftPaw.isStriking = false;
    this.leftPaw.lastActiveAt = now;
  }

  public onMouseDown(button: string): void {
    const now = performance.now();
    if (button === 'left') this.mouseLeftDown = true;
    else if (button === 'right') this.mouseRightDown = true;
    else if (button === 'middle') this.mouseMiddleDown = true;

    this.lastMouseMoveAt = now;
    this.leftPaw.mode = 'mouse';
    this.leftPaw.isStriking = true;
    this.leftPaw.strikeTime = 0.03;
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
    // Neat horizontal keycap strip right above the keyboard (exact clean style of video 00:08-00:41!)
    // Keep at most 5 bubbles in a clean non-overlapping cluster
    if (this.bubbles.length >= 6) {
      this.bubbles.shift();
    }

    const baseX = Math.max(122, Math.min(312, keyX * 0.55 + 128));
    const bubble: KeyBubble = {
      id: this.nextBubbleId++,
      label,
      isSpace,
      x: baseX,
      targetX: baseX,
      y: 288,
      createdAt: now,
      lifetime: 920,
    };
    this.bubbles.push(bubble);

    // Repack active bubbles into a crisp neat horizontal strip with zero ugly overlap!
    this.layoutBubbles();
  }

  private layoutBubbles(): void {
    const count = this.bubbles.length;
    if (count === 0) return;

    const widths = this.bubbles.map((b) => (b.isSpace ? 42 : Math.max(25, b.label.length * 8 + 14)));
    const gap = 5;
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (count - 1);
    const centerAnchor = 252; // slightly right-of-center above keyboard, matching video 00:08-00:41!
    let cursor = Math.max(106, Math.min(340 - totalW, centerAnchor - totalW * 0.5));

    for (let i = 0; i < count; i++) {
      const w = widths[i];
      this.bubbles[i].targetX = cursor + w * 0.5;
      cursor += w + gap;
    }
  }

  // ---- Dynamic body transform & shoulder attachment ----

  private getBodyTransform(breath: number) {
    const leanAngle = this.bodyLean * 0.13 + this.strikeRock * 0.045;
    const shiftX = this.bodyLean * 11;
    const hunchDrop = this.typingHunch * 11 + this.bodyBob * 3.2;
    const scaleX = 1 + this.typingHunch * 0.055 + this.bodyBob * 0.025;
    const scaleY = 1 - this.typingHunch * 0.065 - this.bodyBob * 0.03;
    return {
      pivotX: this.catX,
      pivotY: this.catBaseY,
      leanAngle,
      shiftX,
      shiftY: breath * 0.8 + hunchDrop,
      scaleX,
      scaleY,
    };
  }

  private getLiveShoulder(paw: PawState, breath: number): Vec2 {
    const tr = this.getBodyTransform(breath);
    const lx = paw.shoulderOffset.x * tr.scaleX;
    const ly = (paw.shoulderOffset.y + tr.shiftY * 0.7) * tr.scaleY;
    const cos = Math.cos(tr.leanAngle);
    const sin = Math.sin(tr.leanAngle);
    return {
      x: tr.pivotX + tr.shiftX + lx * cos - ly * sin,
      y: tr.pivotY + lx * sin + ly * cos,
    };
  }

  // ---- Simulation step ----

  private update(dt: number, now: number): void {
    this.elapsed += dt;

    // Snappy mini mouse glide (responds immediately when furiously sweeping mouse back & forth!)
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

    // Hunch down enthusiastically over the keyboard while typing! (Video 00:08 - 00:26!)
    const isTypingRecently = now - this.lastAnyKeyAt < 580;
    const targetHunch = isTypingRecently ? 0.45 + this.typingEnergy * 0.55 : 0;
    this.typingHunch += (targetHunch - this.typingHunch) * (1 - Math.exp(-10 * dt));

    // Spring rock impulse on alternating key slaps
    const rockAcc = -this.strikeRock * 140 - this.strikeRockVel * 15;
    this.strikeRockVel += rockAcc * dt;
    this.strikeRock = Math.max(-1.2, Math.min(1.2, this.strikeRock + this.strikeRockVel * dt));

    this.bodyBob = Math.max(0, this.bodyBob - dt * 13);
    this.kbBounce = Math.max(0, this.kbBounce - dt * 15);

    // Natural body lean toward mouse (tracks live mouse sweep!) or far-right keys
    let targetLean = 0;
    if (this.leftPaw.mode === 'mouse') {
      const mouseSweepBias = (this.mouseOffsetX / 19) * 0.28;
      targetLean = this.rightPaw.mode === 'key'
        ? -0.45 + mouseSweepBias
        : -0.82 + mouseSweepBias;
    } else if (this.rightPaw.mode === 'key' && this.rightPaw.target.x > this.catX + 60) {
      targetLean = 0.42;
    } else if (this.leftPaw.mode === 'key' && this.leftPaw.target.x < this.catX - 55) {
      targetLean = -0.35;
    }
    this.bodyLean += (targetLean - this.bodyLean) * (1 - Math.exp(-11 * dt));

    // Petting decay & happy flat yellow-green squint eyes
    this.petEnergy = Math.max(0, this.petEnergy - dt * (this.cursorOverCat ? 0.22 : 0.65));
    const wantSquint = this.petEnergy > 0.32 ? 1 : 0;
    this.squintAmount += (wantSquint - this.squintAmount) * (1 - Math.exp(-13 * dt));

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
        this.nextBlinkAt = this.elapsed + 2.6 + Math.random() * 3.5;
      }
    }

    // Expressive 100% live eye tracking toward the mouse cursor — EVEN while typing & sweeping simultaneously!
    // (Only glance down at keyboard if mouse has been stationary for > 2.2s while pure typing.)
    const eyeCenterRelX = (this.catX + this.bodyLean * 12) / LOGICAL_W;
    const eyeCenterRelY = (this.catBaseY - 132) / LOGICAL_H;
    let dx = this.cursorRelX - eyeCenterRelX;
    let dy = this.cursorRelY - eyeCenterRelY;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.001) {
      const mag = Math.min(1, dist * 1.85);
      dx = (dx / dist) * mag;
      dy = (dy / dist) * mag;
    }
    const mouseRecentlyMoved = now - this.lastMouseMoveAt < 2200;
    const pureTypingGlance = mouseRecentlyMoved ? 0 : this.typingHunch;
    const targetEyeX = dx * 7.2 * (1 - pureTypingGlance * 0.35) + this.strikeRock * (mouseRecentlyMoved ? 0.3 : 1.2);
    const targetEyeY = dy * 5.2 * (1 - pureTypingGlance * 0.35) + pureTypingGlance * 4.0;
    const eyeLerp = 1 - Math.exp(-20 * dt);
    this.eyeLookX += (targetEyeX - this.eyeLookX) * eyeLerp;
    this.eyeLookY += (targetEyeY - this.eyeLookY) * eyeLerp;

    // Keycap glow decay
    for (const anim of this.keyAnims.values()) {
      if (!anim.pressed && anim.pressAmount > 0) {
        anim.pressAmount = Math.max(0, anim.pressAmount - dt * 5.2);
      }
    }

    this.updatePaw(this.leftPaw, dt, now);
    this.updatePaw(this.rightPaw, dt, now);

    // Smooth horizontal layout & pop-up for keycap bubbles
    const beforeLen = this.bubbles.length;
    this.bubbles = this.bubbles.filter((b) => now - b.createdAt < b.lifetime);
    if (this.bubbles.length !== beforeLen) {
      this.layoutBubbles();
    }
    for (const b of this.bubbles) {
      const age = (now - b.createdAt) / b.lifetime;
      b.x += (b.targetX - b.x) * (1 - Math.exp(-18 * dt));
      const targetY = 272 - age * 14;
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
    } else if (paw.mode === 'key') {
      if (now - this.lastAnyKeyAt > 620 && now - paw.lastActiveAt > 560) {
        if (paw.side === 'left' && now - this.lastMouseMoveAt < 1800) {
          paw.mode = 'mouse';
        } else {
          paw.mode = 'idle';
        }
      }
    }

    if (paw.mode === 'idle') {
      paw.target = { x: paw.idlePos.x, y: paw.idlePos.y };
      paw.hoverLift *= Math.exp(-16 * dt);
      paw.impactSquash *= Math.exp(-16 * dt);
    }

    const targetBlend = paw.mode === 'idle' ? 0 : 1;
    paw.activeBlend += (targetBlend - paw.activeBlend) * (1 - Math.exp(-18 * dt));

    // Ultra-snappy tracking so paw stays 100% glued to rapidly sweeping mouse OR hits keys crisply
    const stiffness = paw.mode === 'mouse' ? 1400 : 980;
    const damping = paw.mode === 'mouse' ? 54 : 38;
    const ax = (paw.target.x - paw.pos.x) * stiffness - paw.vel.x * damping;
    const ay = (paw.target.y - paw.pos.y) * stiffness - paw.vel.y * damping;
    paw.vel.x += ax * dt;
    paw.vel.y += ay * dt;
    paw.pos.x += paw.vel.x * dt;
    paw.pos.y += paw.vel.y * dt;

    // 3-PHASE SLAP ANIMATION (exact lively up-down-slap motion from video 00:08-00:26!)
    if (paw.mode === 'key') {
      if (paw.isStriking) {
        paw.strikeTime += dt;
        const t = paw.strikeTime;
        if (t < 0.032) {
          // Phase 1: quick high wind-up arc
          const p = t / 0.032;
          paw.hoverLift = 12 + Math.sin(p * Math.PI * 0.5) * 14;
          paw.impactSquash = 0;
        } else if (t < 0.088) {
          // Phase 2: HARD SLAP DOWN onto keycap!
          const p = (t - 0.032) / 0.056;
          const prevLift = paw.hoverLift;
          paw.hoverLift = (1 - p) * 24 - p * 3.5;
          paw.impactSquash = p > 0.6 ? (p - 0.6) / 0.4 : 0;
          // Emit vertical slap motion blur smear mid-slam!
          if (prevLift > 14 && paw.hoverLift <= 14) {
            const sh = this.getLiveShoulder(paw, 0);
            paw.smears.push({
              sx: sh.x,
              sy: sh.y,
              px: paw.pos.x,
              py: paw.pos.y - 18,
              alpha: 0.34,
            });
            if (paw.smears.length > 4) paw.smears.shift();
          }
        } else if (t < 0.17) {
          // Phase 3: spring rebound back to ready hover above keyboard!
          const p = (t - 0.088) / 0.082;
          paw.hoverLift = -3.5 + p * 18.5;
          paw.impactSquash = (1 - p) * 0.9;
        } else {
          paw.isStriking = false;
          paw.hoverLift = 15;
          paw.impactSquash = 0;
        }
      } else {
        // Gentle eager ready-hover bobbing above keyboard between strikes
        const bob = Math.sin(this.elapsed * 14 + (paw.side === 'left' ? 0 : Math.PI)) * (1.8 + this.typingEnergy * 2.5);
        const wantLift = 13 + bob;
        paw.hoverLift += (wantLift - paw.hoverLift) * (1 - Math.exp(-14 * dt));
        paw.impactSquash *= Math.exp(-16 * dt);
      }
    } else if (paw.mode === 'mouse') {
      const clickPress = this.mouseLeftDown || this.mouseRightDown ? -3.5 : 0;
      paw.hoverLift += (clickPress - paw.hoverLift) * (1 - Math.exp(-22 * dt));
      paw.impactSquash = this.mouseLeftDown || this.mouseRightDown ? 0.45 : 0;
    }

    // Decay motion-blur smears smoothly
    for (const s of paw.smears) {
      s.alpha -= dt * 3.2;
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

    const breath = Math.sin(this.elapsed * 2.4) * 1.1;
    const purrShift = this.squintAmount > 0.4 ? Math.sin(this.elapsed * 24) * 0.5 * this.squintAmount : 0;

    // Layer 1: Sleek matte S-curved black tail
    this.drawTail(ctx, breath);

    // Layer 2: Mini mouse & 65% mechanical keyboard
    this.drawMiniMouse(ctx);
    this.drawKeyboard(ctx);

    // Layer 3: Unified squishy chubby hand-drawn black cat body + ears + chartreuse eyes
    this.drawCatBody(ctx, breath, purrShift);

    // Layer 4: Seated idle leg outlines & straight tapered elastic black arms with vertical slap smear
    this.drawPaw(ctx, this.leftPaw, breath);
    this.drawPaw(ctx, this.rightPaw, breath);

    // Layer 5: Crisp horizontal floating 3D keycap bubbles
    if (this.showKeyBubbles) {
      this.drawKeyBubbles(ctx);
    }

    ctx.restore();
  }

  private drawTail(ctx: CanvasRenderingContext2D, breath: number): void {
    const swaySpeed = 2.0 + this.typingEnergy * 4.6 + this.squintAmount * 1.2;
    const swayAmp = 11 + this.typingEnergy * 10;
    const sway = Math.sin(this.elapsed * swaySpeed) * swayAmp;
    const swayTip = Math.cos(this.elapsed * swaySpeed - 0.85) * (swayAmp * 0.65);

    const startX = this.catX + 42 + this.bodyLean * 4;
    const startY = this.catBaseY - 14 + breath * 0.3;
    const cp1X = this.catX + 82 + sway * 0.3;
    const cp1Y = this.catBaseY - 10;
    const cp2X = this.catX + 96 + sway * 0.7;
    const cp2Y = this.catBaseY - 36 + swayTip * 0.35;
    const endX = this.catX + 114 + sway * 0.85;
    const endY = this.catBaseY - 56 + swayTip * 0.5;

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

    ctx.save();
    ctx.translate(tr.pivotX + tr.shiftX + purrShift, tr.pivotY);
    ctx.rotate(tr.leanAngle);
    ctx.scale(tr.scaleX, tr.scaleY);

    // Coordinates relative to cat bottom-center (0, 0) where keyboard top meets cat belly!
    const headY = -132 + tr.shiftY * 0.55;
    const catBlack = '#141314';

    ctx.fillStyle = catBlack;

    // 1) Cute smaller wide-set rounded-triangle cat ears (exact match to video 00:00!)
    const lTwitch = Math.sin(this.earTwitchLeft * Math.PI) * 0.14;
    const rTwitch = Math.sin(this.earTwitchRight * Math.PI) * 0.14;

    // Left ear
    ctx.save();
    ctx.translate(-30, headY - 21);
    ctx.rotate(-lTwitch);
    ctx.beginPath();
    ctx.moveTo(-12, 14);
    ctx.quadraticCurveTo(-14, -15, -5, -24);
    ctx.quadraticCurveTo(6, -15, 14, -2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Right ear
    ctx.save();
    ctx.translate(30, headY - 21);
    ctx.rotate(rTwitch);
    ctx.beginPath();
    ctx.moveTo(12, 14);
    ctx.quadraticCurveTo(14, -15, 5, -24);
    ctx.quadraticCurveTo(-6, -15, -14, -2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 2) Cute plush rounded-cheek kitten silhouette (gentle soft cheek curve flowing into plump pear belly!)
    ctx.beginPath();
    // Soft rounded crown between ears
    ctx.moveTo(-25, headY - 27);
    ctx.quadraticCurveTo(0, headY - 32, 25, headY - 27);
    // Right plush round cheek (bulges gently out at cheeks, tucks softly under chin, then swells into plump pear belly!)
    ctx.bezierCurveTo(49, headY - 21, 52, headY + 12, 34, headY + 26);
    ctx.bezierCurveTo(47, headY + 46, 58, -34, 49, 0);
    // Rounded cozy base right behind keyboard
    ctx.quadraticCurveTo(0, 9, -49, 0);
    // Left plump pear belly up to soft tucked neck & left plush round cheek
    ctx.bezierCurveTo(-58, -34, -47, headY + 46, -34, headY + 26);
    ctx.bezierCurveTo(-52, headY + 12, -49, headY - 21, -25, headY - 27);
    ctx.closePath();
    ctx.fill();

    // 3) Subtle muted-grey tucked hind-haunch curves (exact understated linework of video 00:00!)
    ctx.strokeStyle = 'rgba(162, 162, 166, 0.5)';
    ctx.lineWidth = 1.25;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-45, -46);
    ctx.quadraticCurveTo(-53, -22, -44, -2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(45, -46);
    ctx.quadraticCurveTo(53, -22, 44, -2);
    ctx.stroke();

    // 4) Iconic big round dumb-cute (呆萌) flat chartreuse yellow-green eyes!
    this.drawEyes(ctx, 0, headY + 1);

    ctx.restore();
  }

  private drawEyes(ctx: CanvasRenderingContext2D, cx: number, eyeY: number): void {
    const blinkVal = this.isBlinking ? 1 - Math.abs(this.blinkProgress - 1) : 0;
    const closedness = Math.max(blinkVal, this.squintAmount * 0.9);

    // Zero grumpy slant! Perfectly level, wide, round, innocent cute eyes (exact match to video 00:00, 00:08, 00:13, 00:28!)
    const eyeXs = [cx - 18.5, cx + 18.5];
    const rx = 14.2;
    const ry = 13.0;

    for (const ex of eyeXs) {
      ctx.save();
      ctx.translate(ex, eyeY);

      if (this.squintAmount > 0.42 && blinkVal < 0.3) {
        // Exact flat matte chartreuse horizontal squint lines from video 00:03 & 00:06!
        ctx.strokeStyle = '#cce832';
        ctx.lineWidth = 3.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-12.5, 0.5);
        ctx.lineTo(12.5, 0.5);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      const openRy = Math.max(1.2, ry * (1 - closedness));

      // Flat luminous chartreuse yellow-green iris (matches hand-drawn matte aesthetic of video!)
      ctx.fillStyle = '#cce832';
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.clip();

      if (openRy > 3.0) {
        // Cute compact round-oval matte black pupil with plenty of yellow-green iris visible (exact 呆萌 look!)
        const px = this.eyeLookX;
        const py = this.eyeLookY;
        const pupilRx = 4.6 + this.typingEnergy * 0.6;
        const pupilRy = 6.2 + this.typingEnergy * 0.6;

        ctx.fillStyle = '#0f0e10';
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
    const rx = 14;
    const ry = 18.5;
    const clicked = this.mouseLeftDown || this.mouseRightDown || this.mouseMiddleDown;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(-0.06);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 3;

    // Clean egg-oval light mouse; turns bright chartreuse green when clicked (exact match to video 00:28!)
    ctx.fillStyle = clicked ? '#c8ea32' : '#ecece8';
    ctx.strokeStyle = '#2d2e32';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();

    // Minimalist scroll slit
    ctx.fillStyle = this.mouseScrollFlash > 0.2 ? '#98c414' : '#5e6066';
    this.roundRect(ctx, -1.7, -11.5, 3.4, 7.2, 1.7);
    ctx.fill();

    ctx.restore();
  }

  private drawKeyboard(ctx: CanvasRenderingContext2D): void {
    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;

    ctx.save();
    ctx.translate(this.kbCenterX, this.kbCenterY + this.kbBounce * 1.4);
    ctx.rotate(this.kbTiltRad);

    const topHalfW = (this.kbWidth * 0.955) / 2;
    const botHalfW = (this.kbWidth * 1.035) / 2;
    const halfH = this.kbHeight / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.36)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = '#1b1c20';
    this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH + 3.5, halfH + 5.5, 7);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#26282e';
    ctx.strokeStyle = '#383a42';
    ctx.lineWidth = 1.1;
    this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH, halfH, 7);
    ctx.fill();
    ctx.stroke();

    const rowH = innerH / TOTAL_ROWS;
    const unitW = innerW / TOTAL_UNITS;
    const gap = 1.6;

    for (const key of KEYBOARD_KEYS) {
      const anim = this.keyAnims.get(key.id);
      const press = anim ? anim.pressAmount : 0;

      const rowCenterFrac = (key.row + 0.5) / TOTAL_ROWS;
      const depthScale = 0.94 + rowCenterFrac * 0.09;

      const rawX = -innerW / 2 + key.uStart * unitW + gap * 0.5;
      const rawW = key.uWidth * unitW - gap;
      const x = rawX * depthScale;
      const w = rawW * depthScale;
      const y = -innerH / 2 + key.row * rowH + gap * 0.5 + press * 2.1;
      const h = rowH - gap - 1.1;

      let topColor = '#f4f4f0';
      let sideColor = '#c4c5bf';
      if (press > 0.14) {
        topColor = '#c8ea32';
        sideColor = '#8cb014';
      } else if (key.accent === 'orange') {
        topColor = '#f4a524';
        sideColor = '#c27a10';
      } else if (key.accent === 'mod') {
        topColor = '#e4e5e0';
        sideColor = '#b5b6b0';
      }

      ctx.fillStyle = sideColor;
      this.roundRect(ctx, x, y + 1.6, w, h, 2.0);
      ctx.fill();

      ctx.fillStyle = topColor;
      this.roundRect(ctx, x, y, w, h - 1.1, 2.0);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawTaperedStraightArm(
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

    // Stout shoulder (~11px half-width) smoothly tapering to plush rounded mitten paw (~7.8px half-width)
    const r0 = 11.2;
    const r1 = 7.8 * (1 + squash * 0.16);
    const pawRy = 7.4 * (1 - squash * 0.16);

    // Subtle natural bend (just 4px, NOT a giant curved noodle! Exact match to video 00:02, 00:18, 00:26, 00:35!)
    const midX = (sx + px) * 0.5 + nx * 2.5;
    const midY = (sy + py) * 0.5 + ny * 2.5;

    // 1) Solid matte ink-black tapered elastic arm + plush rounded mitten paw
    ctx.fillStyle = '#141314';
    ctx.beginPath();
    ctx.moveTo(sx + nx * r0, sy + ny * r0);
    ctx.quadraticCurveTo(midX + nx * ((r0 + r1) * 0.5), midY + ny * ((r0 + r1) * 0.5), px + nx * r1, py + ny * r1);
    ctx.lineTo(px - nx * r1, py - ny * r1);
    ctx.quadraticCurveTo(midX - nx * ((r0 + r1) * 0.5), midY - ny * ((r0 + r1) * 0.5), sx - nx * r0, sy - ny * r0);
    ctx.closePath();
    ctx.fill();

    // Seamless shoulder join circle
    ctx.beginPath();
    ctx.arc(sx, sy, r0, 0, Math.PI * 2);
    ctx.fill();

    // Soft plush rounded black mitten paw tip (NO cartoon white fork toes!)
    ctx.beginPath();
    ctx.ellipse(px, py, r1 * 1.05, pawRy, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2) Understated thin muted-grey contour along lower forearm & paw so it reads clearly over black torso
    if (outlineAlpha > 0.02) {
      const grad = ctx.createLinearGradient(sx, sy, px, py);
      grad.addColorStop(0.0, 'rgba(175, 176, 180, 0)');
      grad.addColorStop(0.32, 'rgba(175, 176, 180, 0)');
      grad.addColorStop(0.65, `rgba(175, 176, 180, ${outlineAlpha * 0.7})`);
      grad.addColorStop(1.0, `rgba(182, 184, 188, ${outlineAlpha})`);

      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.25;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx + nx * r0, sy + ny * r0);
      ctx.quadraticCurveTo(midX + nx * ((r0 + r1) * 0.5), midY + ny * ((r0 + r1) * 0.5), px + nx * r1, py + ny * r1);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(sx - nx * r0, sy - ny * r0);
      ctx.quadraticCurveTo(midX - nx * ((r0 + r1) * 0.5), midY - ny * ((r0 + r1) * 0.5), px - nx * r1, py - ny * r1);
      ctx.stroke();

      // Subtle rounded paw bottom contour
      ctx.strokeStyle = `rgba(182, 184, 188, ${outlineAlpha * 0.85})`;
      ctx.beginPath();
      ctx.ellipse(px, py, r1 * 1.02, pawRy, 0, 0.15, Math.PI - 0.15);
      ctx.stroke();
    }
  }

  private drawPaw(ctx: CanvasRenderingContext2D, paw: PawState, breath: number): void {
    const tr = this.getBodyTransform(breath);

    // 1) Seated idle vertical front leg lines (exact understated grey lines from video 00:00!)
    if (paw.activeBlend < 0.92) {
      const idleAlpha = 1 - paw.activeBlend;
      ctx.save();
      ctx.globalAlpha = idleAlpha;
      ctx.translate(tr.pivotX + tr.shiftX, tr.pivotY);
      ctx.rotate(tr.leanAngle);
      ctx.scale(tr.scaleX, tr.scaleY);

      const legX = paw.side === 'left' ? -13.5 : 13.5;
      const legTopY = -66;
      const legBotY = -1;

      ctx.fillStyle = '#141314';
      this.roundRect(ctx, legX - 6.8, legTopY, 13.6, legBotY - legTopY + 3, 6.8);
      ctx.fill();

      // Subtle muted-grey vertical leg outline with simple rounded mitten bottom (exact match to 00:00!)
      ctx.strokeStyle = 'rgba(168, 170, 174, 0.52)';
      ctx.lineWidth = 1.25;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(legX - 6.5, legTopY + 4);
      ctx.lineTo(legX - 6.5, legBotY - 3);
      ctx.quadraticCurveTo(legX - 6.5, legBotY + 3, legX, legBotY + 3);
      ctx.quadraticCurveTo(legX + 6.5, legBotY + 3, legX + 6.5, legBotY - 3);
      ctx.lineTo(legX + 6.5, legTopY + 4);
      ctx.stroke();
      ctx.restore();
    }

    // 2) Active straight-tapered elastic black arm + vertical slap motion blur!
    if (paw.activeBlend > 0.05) {
      const sh = this.getLiveShoulder(paw, breath);
      const px = paw.pos.x;
      const py = paw.pos.y - paw.hoverLift;

      ctx.save();
      ctx.globalAlpha = Math.min(1, paw.activeBlend * 1.15);

      // Motion-blur slap afterimages (exact kinetic blur from video 00:13, 00:14, 00:26, 00:33!)
      for (const sm of paw.smears) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, sm.alpha * paw.activeBlend);
        this.drawTaperedStraightArm(ctx, sm.sx, sm.sy, sm.px, sm.py, 0, 0);
        ctx.restore();
      }

      // Main crisp elastic cat arm
      this.drawTaperedStraightArm(ctx, sh.x, sh.y, px, py, paw.impactSquash, 0.44);
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
        scale = 0.6 + Math.sin(p * Math.PI * 0.65) * 0.48;
      } else if (t > 0.76) {
        scale = 1 - ((t - 0.76) / 0.24) * 0.1;
      }
      const alpha = t < 0.72 ? 1 : Math.max(0, 1 - (t - 0.72) / 0.28);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(b.x, b.y);
      ctx.scale(scale, scale);

      ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
      const textW = ctx.measureText(b.label).width;
      const boxW = b.isSpace ? 42 : Math.max(24, textW + 13);
      const boxH = 24;
      const bx = -boxW / 2;
      const by = -boxH / 2;

      ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 2;

      // Clean 3D white keycap bottom lip
      ctx.fillStyle = '#c8cac6';
      this.roundRect(ctx, bx, by + 2.4, boxW, boxH, 5.5);
      ctx.fill();

      // Clean flat-white top face
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(38, 40, 46, 0.36)';
      ctx.lineWidth = 1.05;
      this.roundRect(ctx, bx, by, boxW, boxH - 1.4, 5.5);
      ctx.fill();
      ctx.stroke();

      if (b.isSpace) {
        ctx.strokeStyle = '#222429';
        ctx.lineWidth = 1.65;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(-10, -1);
        ctx.lineTo(-10, 2.2);
        ctx.lineTo(10, 2.2);
        ctx.lineTo(10, -1);
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
