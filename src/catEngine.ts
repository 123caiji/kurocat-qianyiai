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

interface PawState {
  side: 'left' | 'right';
  shoulder: Vec2;
  idlePos: Vec2;
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  mode: 'idle' | 'mouse' | 'key';
  activeBlend: number; // 0 = seated front leg, 1 = extended IK arm
  pressBounce: number;
  lastActiveAt: number;
  trail: Vec2[];
}

interface KeyBubble {
  id: number;
  label: string;
  x: number;
  y: number;
  vx: number;
  createdAt: number;
  lifetime: number;
}

interface KeyAnim {
  pressed: boolean;
  pressAmount: number; // 0..1 smooth depression & glow
  lastHitAt: number;
}

export class KuroCatEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private lastTime = 0;
  private elapsed = 0;

  // Settings
  public showKeyBubbles = true;

  // Cat anchor coordinates in logical 420x440 space
  private readonly catX = 204;
  private readonly catBodyY = 224;
  private readonly catHeadY = 148;

  // Keyboard transform parameters (exact tilted 65% board matching video)
  private readonly kbCenterX = 222;
  private readonly kbCenterY = 342;
  private readonly kbWidth = 232;
  private readonly kbHeight = 68;
  private readonly kbTiltRad = (4.2 * Math.PI) / 180;

  // Mouse base position (viewer's left of keyboard, matching video)
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

  // Blinking, petting, ear twitch & typing cadence
  private nextBlinkAt = 2.4;
  private blinkProgress = 0; // 0 = open, 1 = closed
  private isBlinking = false;

  private lastPetCursorX: number | null = null;
  private lastPetCursorY: number | null = null;
  private petEnergy = 0; // 0..1, > 0.35 triggers happy squint eyes
  private squintAmount = 0;
  private earTwitchLeft = 0;
  private earTwitchRight = 0;
  private recentKeyTimes: number[] = [];
  private typingEnergy = 0; // 0..1 based on recent WPM

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
      shoulder: { x: this.catX - 28, y: this.catBodyY - 12 },
      idlePos: { x: this.catX - 14, y: 294 },
      pos: { x: this.catX - 14, y: 294 },
      vel: { x: 0, y: 0 },
      target: { x: this.catX - 14, y: 294 },
      mode: 'idle',
      activeBlend: 0,
      pressBounce: 0,
      lastActiveAt: -10000,
      trail: [],
    };

    this.rightPaw = {
      side: 'right',
      shoulder: { x: this.catX + 28, y: this.catBodyY - 12 },
      idlePos: { x: this.catX + 14, y: 294 },
      pos: { x: this.catX + 14, y: 294 },
      vel: { x: 0, y: 0 },
      target: { x: this.catX + 14, y: 294 },
      mode: 'idle',
      activeBlend: 0,
      pressBounce: 0,
      lastActiveAt: -10000,
      trail: [],
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

  // ---- Input event handlers from Rust global hooks ----

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

    // Track typing rhythm for lively tail/ear/smear feedback
    this.recentKeyTimes.push(now);
    if (this.recentKeyTimes.length > 24) this.recentKeyTimes.shift();

    // Subtle ear twitch on bursts
    if (Math.random() < 0.22) {
      if (Math.random() < 0.5) this.earTwitchLeft = 1;
      else this.earTwitchRight = 1;
    }

    // Choose paw & compute exact keycap center on tilted board
    const keyColCenter = spec.uStart + spec.uWidth * 0.5;
    let targetPoint = this.getKeyWorldCenter(spec);
    let chosen: PawState;

    if (spec.id === 'space') {
      const mouseRecent = now - this.lastMouseMoveAt < 700 || this.mouseLeftDown || this.mouseRightDown;
      if (mouseRecent) {
        chosen = this.rightPaw;
      } else {
        this.lastSpacePaw = this.lastSpacePaw === 'left' ? 'right' : 'left';
        chosen = this.lastSpacePaw === 'left' ? this.leftPaw : this.rightPaw;
      }
      const spaceU = chosen.side === 'left' ? spec.uStart + spec.uWidth * 0.34 : spec.uStart + spec.uWidth * 0.66;
      targetPoint = this.projectKeyboardPoint(spaceU, spec.row + 0.5);
    } else if (keyColCenter <= 6.2) {
      const mouseVeryActive = this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 350;
      if (mouseVeryActive && now - this.rightPaw.lastActiveAt > 180) {
        // Right paw reaches cleanly across while left paw holds mouse!
        chosen = this.rightPaw;
      } else {
        chosen = this.leftPaw;
      }
    } else {
      chosen = this.rightPaw;
    }

    chosen.mode = 'key';
    chosen.target = { x: targetPoint.x, y: targetPoint.y - 5 };
    chosen.pressBounce = 1;
    chosen.lastActiveAt = now;

    // Audio
    catAudio.playKeyClick((keyColCenter - 7.5) * 0.35);

    // Floating 3D keycap bubble
    if (this.showKeyBubbles) {
      const label = formatBubbleForVk(vk, spec);
      if (label) {
        this.spawnBubble(label, targetPoint.x, targetPoint.y - 42, now);
      }
    }
  }

  public onKeyUp(vk: number): void {
    const spec = resolveKeyByVk(vk);
    if (!spec) return;
    const anim = this.keyAnims.get(spec.id);
    if (anim) {
      anim.pressed = false;
    }
  }

  public onGlobalMouseMove(nx: number, ny: number): void {
    const now = performance.now();
    this.mouseTargetOffsetX = (nx - 0.5) * 26;
    this.mouseTargetOffsetY = (ny - 0.5) * 18;
    this.lastMouseMoveAt = now;

    // Move viewer-left paw onto the mini mouse unless actively mid-keystroke (<120ms)
    if (this.leftPaw.mode !== 'key' || now - this.leftPaw.lastActiveAt > 160) {
      this.leftPaw.mode = 'mouse';
      this.leftPaw.lastActiveAt = now;
    }
  }

  public onMouseDown(button: string): void {
    const now = performance.now();
    if (button === 'left') this.mouseLeftDown = true;
    else if (button === 'right') this.mouseRightDown = true;
    else if (button === 'middle') this.mouseMiddleDown = true;

    this.lastMouseMoveAt = now;
    this.leftPaw.mode = 'mouse';
    this.leftPaw.pressBounce = 1;
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
    this.leftPaw.pressBounce = 0.65;
    this.leftPaw.lastActiveAt = now;
  }

  public onWindowCursor(relX: number, relY: number, overCat: boolean): void {
    this.cursorRelX = relX;
    this.cursorRelY = relY;
    this.cursorOverCat = overCat;

    // Petting gesture: rubbing cursor over the cat's head/body triggers happy squint eyes!
    if (overCat && !this.mouseLeftDown && !this.mouseRightDown) {
      const px = relX * LOGICAL_W;
      const py = relY * LOGICAL_H;
      if (this.lastPetCursorX !== null && this.lastPetCursorY !== null) {
        const dist = Math.hypot(px - this.lastPetCursorX, py - this.lastPetCursorY);
        if (dist > 1.5 && dist < 80) {
          this.petEnergy = Math.min(1, this.petEnergy + dist * 0.0095);
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

  // ---- Coordinate projection for exact paw-to-key alignment ----

  private projectKeyboardPoint(uCol: number, rowPos: number): Vec2 {
    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;
    const localX = -innerW / 2 + (uCol / TOTAL_UNITS) * innerW;
    const localY = -innerH / 2 + (rowPos / TOTAL_ROWS) * innerH;

    // Slight perspective trapezoid widening toward bottom row
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

  private spawnBubble(label: string, rawX: number, rawY: number, now: number): void {
    // Clamp inside readable area above keyboard
    let x = Math.max(85, Math.min(LOGICAL_W - 65, rawX));
    let y = Math.max(222, Math.min(286, rawY));

    // Gentle de-overlap against recent active bubbles
    for (let pass = 0; pass < 3; pass++) {
      for (const b of this.bubbles) {
        if (now - b.createdAt > 550) continue;
        const dx = x - b.x;
        const dy = y - b.y;
        if (Math.abs(dx) < 28 && Math.abs(dy) < 24) {
          x += dx >= 0 ? 22 : -22;
          y -= 6;
        }
      }
    }
    x = Math.max(76, Math.min(LOGICAL_W - 58, x));
    y = Math.max(216, Math.min(286, y));

    this.bubbles.push({
      id: this.nextBubbleId++,
      label,
      x,
      y,
      vx: (Math.random() - 0.5) * 8,
      createdAt: now,
      lifetime: 980,
    });

    if (this.bubbles.length > 9) {
      this.bubbles.shift();
    }
  }

  // ---- Simulation step ----

  private update(dt: number, now: number): void {
    this.elapsed += dt;

    // Smooth mini mouse glide
    const mLerp = 1 - Math.exp(-16 * dt);
    this.mouseOffsetX += (this.mouseTargetOffsetX - this.mouseOffsetX) * mLerp;
    this.mouseOffsetY += (this.mouseTargetOffsetY - this.mouseOffsetY) * mLerp;
    this.mouseScrollFlash = Math.max(0, this.mouseScrollFlash - dt * 4.5);

    // Recent typing speed energy (0..1)
    while (this.recentKeyTimes.length > 0 && now - this.recentKeyTimes[0] > 1000) {
      this.recentKeyTimes.shift();
    }
    const targetTypingEnergy = Math.min(1, this.recentKeyTimes.length / 8);
    this.typingEnergy += (targetTypingEnergy - this.typingEnergy) * (1 - Math.exp(-8 * dt));

    // Petting decay & smooth squint transition
    this.petEnergy = Math.max(0, this.petEnergy - dt * (this.cursorOverCat ? 0.24 : 0.65));
    const wantSquint = this.petEnergy > 0.34 ? 1 : 0;
    this.squintAmount += (wantSquint - this.squintAmount) * (1 - Math.exp(-12 * dt));

    // Ear twitch decay
    this.earTwitchLeft = Math.max(0, this.earTwitchLeft - dt * 7);
    this.earTwitchRight = Math.max(0, this.earTwitchRight - dt * 7);

    // Blink scheduler
    if (!this.isBlinking && this.elapsed >= this.nextBlinkAt) {
      this.isBlinking = true;
      this.blinkProgress = 0;
    }
    if (this.isBlinking) {
      this.blinkProgress += dt * 11.5;
      if (this.blinkProgress >= 2) {
        this.isBlinking = false;
        this.blinkProgress = 0;
        this.nextBlinkAt = this.elapsed + 2.6 + Math.random() * 3.4;
      }
    }

    // Eye tracking toward global cursor (or glancing slightly down at keyboard during intense typing)
    const eyeCenterRelX = this.catX / LOGICAL_W;
    const eyeCenterRelY = this.catHeadY / LOGICAL_H;
    let dx = this.cursorRelX - eyeCenterRelX;
    let dy = this.cursorRelY - eyeCenterRelY;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.001) {
      const mag = Math.min(1, dist * 1.45);
      dx = (dx / dist) * mag;
      dy = (dy / dist) * mag;
    }
    // Slight downward glance when typing rapidly
    const targetEyeX = dx * 5.2;
    const targetEyeY = dy * 3.8 + this.typingEnergy * 2.1;
    const eyeLerp = 1 - Math.exp(-14 * dt);
    this.eyeLookX += (targetEyeX - this.eyeLookX) * eyeLerp;
    this.eyeLookY += (targetEyeY - this.eyeLookY) * eyeLerp;

    // Update key depression/glow decay
    for (const anim of this.keyAnims.values()) {
      if (!anim.pressed && anim.pressAmount > 0) {
        anim.pressAmount = Math.max(0, anim.pressAmount - dt * 6.8);
      }
    }

    // Update paw targets & spring physics
    this.updatePaw(this.leftPaw, dt, now);
    this.updatePaw(this.rightPaw, dt, now);

    // Update floating bubbles
    this.bubbles = this.bubbles.filter((b) => now - b.createdAt < b.lifetime);
    for (const b of this.bubbles) {
      b.x += b.vx * dt;
      b.y -= 16 * dt;
    }
  }

  private updatePaw(paw: PawState, dt: number, now: number): void {
    const liveMouseX = this.mouseBaseX + this.mouseOffsetX;
    const liveMouseY = this.mouseBaseY + this.mouseOffsetY;

    if (paw.mode === 'mouse') {
      paw.target = { x: liveMouseX + 2, y: liveMouseY - 3 };
      const stillHolding = this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 2300;
      if (!stillHolding) {
        paw.mode = 'idle';
      }
    } else if (paw.mode === 'key') {
      if (now - paw.lastActiveAt > 480) {
        // If left paw and mouse moved recently, smoothly return to mouse; else idle
        if (paw.side === 'left' && now - this.lastMouseMoveAt < 1800) {
          paw.mode = 'mouse';
        } else {
          paw.mode = 'idle';
        }
      }
    }

    if (paw.mode === 'idle') {
      paw.target = { x: paw.idlePos.x, y: paw.idlePos.y };
    }

    // Smooth blend between seated front-leg posture and extended dynamic arm
    const targetBlend = paw.mode === 'idle' ? 0 : 1;
    paw.activeBlend += (targetBlend - paw.activeBlend) * (1 - Math.exp(-15 * dt));

    // Snappy damped spring physics for arm tip
    const stiffness = paw.mode === 'key' ? 760 : 540;
    const damping = paw.mode === 'key' ? 35 : 30;
    const ax = (paw.target.x - paw.pos.x) * stiffness - paw.vel.x * damping;
    const ay = (paw.target.y - paw.pos.y) * stiffness - paw.vel.y * damping;
    paw.vel.x += ax * dt;
    paw.vel.y += ay * dt;
    paw.pos.x += paw.vel.x * dt;
    paw.pos.y += paw.vel.y * dt;

    // Strike bounce decay
    paw.pressBounce = Math.max(0, paw.pressBounce - dt * 10);

    // Motion smear history for high-speed typing energy
    if (paw.activeBlend > 0.35 && this.typingEnergy > 0.35) {
      paw.trail.push({ x: paw.pos.x, y: paw.pos.y });
      if (paw.trail.length > 3) paw.trail.shift();
    } else if (paw.trail.length > 0) {
      paw.trail.shift();
    }
  }

  // ---- High-craftsmanship Canvas 2D rendering ----

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

    const breath = Math.sin(this.elapsed * 2.5) * 1.4;
    const purrShift = this.squintAmount > 0.4 ? Math.sin(this.elapsed * 26) * 0.55 * this.squintAmount : 0;

    // Layer 1: Swishing black tail behind body
    this.drawTail(ctx, breath);

    // Layer 2: Mini white mouse & 65% mechanical keyboard (in front bottom area, underneath cat paws)
    this.drawMiniMouse(ctx);
    this.drawKeyboard(ctx);

    // Layer 3: Plump sitting black cat torso, haunches, head, ears, glowing green eyes & whiskers
    this.drawCatBodyAndHead(ctx, breath, purrShift);

    // Layer 4: Seated resting front legs (when idle) & dynamic IK paws (when typing / mousing)
    this.drawPaw(ctx, this.leftPaw, breath);
    this.drawPaw(ctx, this.rightPaw, breath);

    // Layer 5: Floating 3D keycap bubbles above keyboard
    if (this.showKeyBubbles) {
      this.drawKeyBubbles(ctx);
    }

    ctx.restore();
  }

  private drawTail(ctx: CanvasRenderingContext2D, breath: number): void {
    const swaySpeed = 2.1 + this.typingEnergy * 4.5 + this.squintAmount * 1.2;
    const swayAmp = 14 + this.typingEnergy * 11;
    const sway = Math.sin(this.elapsed * swaySpeed) * swayAmp;
    const swayTip = Math.cos(this.elapsed * swaySpeed - 0.8) * (swayAmp * 0.7);

    const startX = this.catX + 40;
    const startY = this.catBodyY + 56 + breath * 0.4;
    const cp1X = this.catX + 86 + sway * 0.35;
    const cp1Y = this.catBodyY + 64;
    const cp2X = this.catX + 102 + sway * 0.7;
    const cp2Y = this.catBodyY + 26 + swayTip * 0.3;
    const endX = this.catX + 114 + sway * 0.9;
    const endY = this.catBodyY - 6 + swayTip * 0.5;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Subtle soft drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 3;

    ctx.strokeStyle = '#111114';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
    ctx.stroke();

    // Subtle rim highlight so tail reads on dark wallpapers
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(235, 236, 242, 0.22)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(startX + 4, startY - 6);
    ctx.bezierCurveTo(cp1X, cp1Y - 6, cp2X - 5, cp2Y - 5, endX - 4, endY - 3);
    ctx.stroke();
    ctx.restore();
  }

  private drawCatBodyAndHead(ctx: CanvasRenderingContext2D, breath: number, purrShift: number): void {
    const cx = this.catX + purrShift;
    const by = this.catBodyY + breath * 0.5;
    const hy = this.catHeadY + breath;

    ctx.save();

    // Soft ambient shadow for legibility on both light & dark wallpapers
    ctx.shadowColor = 'rgba(0, 0, 0, 0.32)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;

    // 1) Plump pear-shaped sitting black cat torso
    ctx.fillStyle = '#111114';
    ctx.beginPath();
    ctx.moveTo(cx - 34, hy + 20);
    ctx.bezierCurveTo(cx - 56, by - 14, cx - 64, by + 44, cx - 48, by + 72);
    ctx.quadraticCurveTo(cx, by + 84, cx + 48, by + 72);
    ctx.bezierCurveTo(cx + 64, by + 44, cx + 56, by - 14, cx + 34, hy + 20);
    ctx.closePath();
    ctx.fill();

    // 2) Pointed cat ears with micro-twitch
    const lTwitch = Math.sin(this.earTwitchLeft * Math.PI) * 0.14;
    const rTwitch = Math.sin(this.earTwitchRight * Math.PI) * 0.14;

    // Left ear (perkier, faithful to video)
    ctx.save();
    ctx.translate(cx - 29, hy - 22);
    ctx.rotate(-lTwitch);
    ctx.beginPath();
    ctx.moveTo(-16, 14);
    ctx.quadraticCurveTo(-19, -24, -10, -37);
    ctx.quadraticCurveTo(5, -20, 17, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Right ear (perkier, faithful to video)
    ctx.save();
    ctx.translate(cx + 29, hy - 22);
    ctx.rotate(rTwitch);
    ctx.beginPath();
    ctx.moveTo(16, 14);
    ctx.quadraticCurveTo(19, -24, 10, -37);
    ctx.quadraticCurveTo(-5, -20, -17, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 3) Plump rounded cat head (merges seamlessly into torso with no chin seam!)
    ctx.beginPath();
    ctx.ellipse(cx, hy, 47, 37, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    // 4) Hand-drawn delicate white haunch lines (exact video style!)
    ctx.strokeStyle = 'rgba(236, 238, 244, 0.72)';
    ctx.lineWidth = 1.45;
    ctx.lineCap = 'round';

    // Left tucked haunch arc
    ctx.beginPath();
    ctx.moveTo(cx - 46, by + 30);
    ctx.quadraticCurveTo(cx - 56, by + 52, cx - 44, by + 70);
    ctx.stroke();
    // Right tucked haunch arc
    ctx.beginPath();
    ctx.moveTo(cx + 46, by + 30);
    ctx.quadraticCurveTo(cx + 56, by + 52, cx + 44, by + 70);
    ctx.stroke();

    // 5) Cute delicate curved white whiskers (3 left, 3 right)
    ctx.strokeStyle = 'rgba(236, 238, 244, 0.62)';
    ctx.lineWidth = 1.25;
    const whiskerOffsets = [-6, 0, 6];
    for (let i = 0; i < 3; i++) {
      const wy = hy + 11 + whiskerOffsets[i];
      const curve = (i - 1) * 3.5;
      // Left side
      ctx.beginPath();
      ctx.moveTo(cx - 38, wy);
      ctx.quadraticCurveTo(cx - 52, wy - 1 + curve * 0.3, cx - 64, wy + curve);
      ctx.stroke();
      // Right side
      ctx.beginPath();
      ctx.moveTo(cx + 38, wy);
      ctx.quadraticCurveTo(cx + 52, wy - 1 + curve * 0.3, cx + 64, wy + curve);
      ctx.stroke();
    }

    // 6) Signature glowing yellow-green eyes!
    this.drawEyes(ctx, cx, hy + 2);

    ctx.restore();
  }

  private drawEyes(ctx: CanvasRenderingContext2D, cx: number, eyeY: number): void {
    const blinkVal = this.isBlinking ? 1 - Math.abs(this.blinkProgress - 1) : 0;
    const closedness = Math.max(blinkVal, this.squintAmount * 0.86);

    const eyePositions = [cx - 17, cx + 17];
    const rx = 13.4;
    const ry = 11.4;

    for (const ex of eyePositions) {
      ctx.save();

      if (this.squintAmount > 0.45 && blinkVal < 0.3) {
        // Happy petting horizontal glowing yellow-green squint lines (exact match to video 00:03 & 00:06!)
        ctx.shadowColor = 'rgba(200, 245, 56, 0.55)';
        ctx.shadowBlur = 7;
        ctx.strokeStyle = '#cff83e';
        ctx.lineWidth = 3.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(ex - 11.5, eyeY + 1);
        ctx.quadraticCurveTo(ex, eyeY - 2.6 * this.squintAmount, ex + 11.5, eyeY + 1);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      // Open / blinking glowing yellow-green almond eye
      const openRy = Math.max(1.2, ry * (1 - closedness));

      ctx.shadowColor = 'rgba(198, 245, 52, 0.32)';
      ctx.shadowBlur = 4.5;

      const grad = ctx.createRadialGradient(ex - 2, eyeY - 3, 2, ex, eyeY, rx + 2);
      grad.addColorStop(0, '#e2ff5c');
      grad.addColorStop(0.65, '#c4f230');
      grad.addColorStop(1, '#94d614');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, rx, openRy, 0, 0, Math.PI * 2);
      ctx.fill();

      // Clip pupil cleanly inside the eye opening
      ctx.shadowBlur = 0;
      ctx.clip();

      if (openRy > 3.2) {
        const px = ex + this.eyeLookX;
        const py = eyeY + this.eyeLookY;
        const pupilRx = 5.5 + this.typingEnergy * 1.1;
        const pupilRy = 8.1 + this.typingEnergy * 0.9;

        ctx.fillStyle = '#0c0c0e';
        ctx.beginPath();
        ctx.ellipse(px, py, pupilRx, pupilRy, 0, 0, Math.PI * 2);
        ctx.fill();

        // Crisp cute white specular catchlight
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.beginPath();
        ctx.arc(px - 2.2, py - 2.6, 1.85, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  private drawMiniMouse(ctx: CanvasRenderingContext2D): void {
    const mx = this.mouseBaseX + this.mouseOffsetX;
    const my = this.mouseBaseY + this.mouseOffsetY;
    const rx = 14.5;
    const ry = 19.5;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(-0.08);

    // Shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.32)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;

    // Mouse body
    ctx.fillStyle = '#f3f3ef';
    ctx.strokeStyle = '#24252b';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();

    // Clip button highlights inside mouse silhouette
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx - 0.8, ry - 0.8, 0, 0, Math.PI * 2);
    ctx.clip();

    if (this.mouseLeftDown) {
      ctx.fillStyle = '#c5f536';
      ctx.fillRect(-rx, -ry, rx, ry * 0.95);
    }
    if (this.mouseRightDown) {
      ctx.fillStyle = '#c5f536';
      ctx.fillRect(0, -ry, rx, ry * 0.95);
    }
    ctx.restore();

    // Horizontal seam & vertical button divider
    ctx.strokeStyle = 'rgba(40, 42, 48, 0.55)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(-rx + 1.5, -2);
    ctx.quadraticCurveTo(0, 0.5, rx - 1.5, -2);
    ctx.moveTo(0, -ry + 1);
    ctx.lineTo(0, -1.5);
    ctx.stroke();

    // Scroll wheel pill
    ctx.fillStyle = this.mouseMiddleDown || this.mouseScrollFlash > 0.2 ? '#c5f536' : '#555861';
    this.roundRect(ctx, -2.3, -12.5, 4.6, 8.2, 2.3);
    ctx.fill();

    ctx.restore();
  }

  private drawKeyboard(ctx: CanvasRenderingContext2D): void {
    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;

    ctx.save();
    ctx.translate(this.kbCenterX, this.kbCenterY);
    ctx.rotate(this.kbTiltRad);

    // 1) Keyboard 3D dark chassis with subtle trapezoidal perspective
    const topHalfW = (this.kbWidth * 0.955) / 2;
    const botHalfW = (this.kbWidth * 1.035) / 2;
    const halfH = this.kbHeight / 2;

    // Ground drop shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#18191e';
    this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH + 4, halfH + 6, 8);
    ctx.fill();
    ctx.restore();

    // Main keyboard deck top surface
    ctx.fillStyle = '#25272e';
    ctx.strokeStyle = '#383b45';
    ctx.lineWidth = 1.2;
    this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH, halfH, 8);
    ctx.fill();
    ctx.stroke();

    // 2) Render every keycap cleanly using the exact same row/col math as paw targeting
    const rowH = innerH / TOTAL_ROWS;
    const unitW = innerW / TOTAL_UNITS;
    const gap = 1.7;

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
      const h = rowH - gap - 1.2;

      // Keycap base color
      let topColor = '#f6f6f2';
      let sideColor = '#c4c5bf';
      if (press > 0.15) {
        topColor = '#c6f638';
        sideColor = '#84b315';
      } else if (key.accent === 'orange') {
        topColor = '#f6a623';
        sideColor = '#c47c10';
      } else if (key.accent === 'mod') {
        topColor = '#e3e4df';
        sideColor = '#b3b5ae';
      }

      // 3D bottom lip
      ctx.fillStyle = sideColor;
      this.roundRect(ctx, x, y + 1.8, w, h, 2.2);
      ctx.fill();

      // Keycap top face
      ctx.save();
      if (press > 0.25) {
        ctx.shadowColor = 'rgba(198, 246, 56, 0.75)';
        ctx.shadowBlur = 7;
      }
      ctx.fillStyle = topColor;
      this.roundRect(ctx, x, y, w, h - 1.2, 2.2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  private drawPaw(ctx: CanvasRenderingContext2D, paw: PawState, breath: number): void {
    const sx = paw.shoulder.x;
    const sy = paw.shoulder.y + breath * 0.6;

    // 1) Seated idle front leg (exact dainty vertical hand-drawn white-outlined paws from video 00:00!)
    if (paw.activeBlend < 0.92) {
      const idleAlpha = 1 - paw.activeBlend;
      ctx.save();
      ctx.globalAlpha = idleAlpha;
      const legX = paw.idlePos.x;
      const legTopY = sy + 26;
      const legBotY = paw.idlePos.y + 4;

      // Black leg core
      ctx.fillStyle = '#111114';
      this.roundRect(ctx, legX - 7.5, legTopY, 15, legBotY - legTopY, 7.5);
      ctx.fill();

      // Crisp hand-drawn white leg outline & cute toe lines
      ctx.strokeStyle = 'rgba(238, 240, 245, 0.78)';
      ctx.lineWidth = 1.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(legX - 7.2, legTopY + 3);
      ctx.lineTo(legX - 7.2, legBotY - 5);
      ctx.quadraticCurveTo(legX - 7.2, legBotY + 1, legX, legBotY + 1);
      ctx.quadraticCurveTo(legX + 7.2, legBotY + 1, legX + 7.2, legBotY - 5);
      ctx.lineTo(legX + 7.2, legTopY + 3);
      ctx.stroke();

      // Two cute tiny white toe ticks
      ctx.beginPath();
      ctx.moveTo(legX - 2.6, legBotY - 4.5);
      ctx.lineTo(legX - 2.6, legBotY + 0.5);
      ctx.moveTo(legX + 2.6, legBotY - 4.5);
      ctx.lineTo(legX + 2.6, legBotY + 0.5);
      ctx.stroke();
      ctx.restore();
    }

    // 2) Active dynamic IK black cat arm reaching cleanly to exact key or mouse!
    if (paw.activeBlend > 0.05) {
      const px = paw.pos.x;
      const py = paw.pos.y + paw.pressBounce * 2.6;

      // Compute natural outward-bowing elbow control point so arm NEVER clips weirdly
      const midX = (sx + px) * 0.5;
      const midY = (sy + py) * 0.5;
      const outwardSign = paw.side === 'left' ? -1 : 1;
      const reachDist = Math.hypot(px - sx, py - sy);
      const bowOut = Math.min(26, 10 + reachDist * 0.14);
      const ex = midX + outwardSign * bowOut;
      const ey = midY - 12;

      ctx.save();
      ctx.globalAlpha = Math.min(1, paw.activeBlend * 1.15);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Fast-typing motion blur smear ghosts (like video 00:10-00:22!)
      for (let i = 0; i < paw.trail.length; i++) {
        const tp = paw.trail[i];
        const ghostAlpha = ((i + 1) / (paw.trail.length + 1)) * 0.22 * this.typingEnergy;
        ctx.save();
        ctx.globalAlpha = ghostAlpha;
        ctx.strokeStyle = '#111114';
        ctx.lineWidth = 14;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(ex, ey, tp.x, tp.y);
        ctx.stroke();
        ctx.restore();
      }

      // Soft drop shadow beneath active arm
      ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
      ctx.shadowBlur = 7;
      ctx.shadowOffsetY = 3;

      // Outer subtle white contour that fades smoothly to transparent at the shoulder
      // so the arm merges organically into the black torso with ZERO shoulder seam!
      const outlineGrad = ctx.createLinearGradient(sx, sy, px, py);
      outlineGrad.addColorStop(0.0, 'rgba(235, 237, 242, 0.0)');
      outlineGrad.addColorStop(0.26, 'rgba(235, 237, 242, 0.0)');
      outlineGrad.addColorStop(0.42, 'rgba(235, 237, 242, 0.45)');
      outlineGrad.addColorStop(1.0, 'rgba(235, 237, 242, 0.62)');

      ctx.strokeStyle = outlineGrad;
      ctx.lineWidth = 18.2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(ex, ey, px, py);
      ctx.stroke();

      // Solid matte black cat limb core
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#111114';
      ctx.lineWidth = 15.6;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(ex, ey, px, py);
      ctx.stroke();

      // Seamless shoulder merge cap
      ctx.fillStyle = '#111114';
      ctx.beginPath();
      ctx.arc(sx, sy, 11.5, 0, Math.PI * 2);
      ctx.fill();

      // Rounded cute paw tip + tiny white toe ticks
      ctx.fillStyle = '#111114';
      ctx.beginPath();
      ctx.ellipse(px, py + 1, 9.4, 8.0, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(238, 240, 245, 0.72)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(px, py + 1, 9.0, 0.2, Math.PI - 0.2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(px - 3.0, py + 4);
      ctx.lineTo(px - 3.0, py + 8.3);
      ctx.moveTo(px + 3.0, py + 4);
      ctx.lineTo(px + 3.0, py + 8.3);
      ctx.stroke();

      ctx.restore();
    }
  }

  private drawKeyBubbles(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();

    for (const b of this.bubbles) {
      const age = now - b.createdAt;
      const t = Math.min(1, age / b.lifetime);

      // Pop-in spring scale, gentle hold, smooth fade-out
      let scale = 1;
      if (t < 0.12) {
        const p = t / 0.12;
        scale = 0.55 + Math.sin(p * Math.PI * 0.65) * 0.55;
      }
      const alpha = t < 0.68 ? 1 : Math.max(0, 1 - (t - 0.68) / 0.32);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(b.x, b.y);
      ctx.scale(scale, scale);

      ctx.font = '700 12.5px "Segoe UI", system-ui, sans-serif';
      const textW = ctx.measureText(b.label).width;
      const boxW = Math.max(25, textW + 14);
      const boxH = 25;
      const bx = -boxW / 2;
      const by = -boxH / 2;

      // Soft elevation shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
      ctx.shadowBlur = 7;
      ctx.shadowOffsetY = 3;

      // 3D keycap bottom lip
      ctx.fillStyle = '#c5c7c2';
      this.roundRect(ctx, bx, by + 2.5, boxW, boxH, 6);
      ctx.fill();

      // White keycap face
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fcfcf9';
      ctx.strokeStyle = 'rgba(32, 34, 40, 0.35)';
      ctx.lineWidth = 1.1;
      this.roundRect(ctx, bx, by, boxW, boxH - 1.5, 6);
      ctx.fill();
      ctx.stroke();

      // Crisp dark key label
      ctx.fillStyle = '#1d1f24';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, 0, -0.5);

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
