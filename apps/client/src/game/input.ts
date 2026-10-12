// Keyboard and mouse state with pointer lock. Game code reads this each frame.

export class Input {
  readonly keys = new Set<string>();
  readonly pressed = new Set<string>(); // went down this frame
  mouseDX = 0;
  mouseDY = 0;
  lmb = false;
  rmb = false;
  lmbPressed = false;
  wheel = 0;
  locked = false;
  sensitivity = 0.0022;
  invertY = false;
  enabled = true;

  constructor(private readonly el: HTMLElement) {
    window.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      if (this.locked && (e.code === "Tab" || e.code === "Space" || e.code.startsWith("F") || e.code === "Slash")) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
    el.addEventListener("mousedown", (e) => {
      if (!this.locked) {
        this.lock();
        return;
      }
      if (e.button === 0) {
        this.lmb = true;
        this.lmbPressed = true;
      }
      if (e.button === 2) this.rmb = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener("wheel", (e) => {
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) {
        this.keys.clear();
        this.lmb = this.rmb = false;
      }
    });
  }

  lock() {
    void (this.el.requestPointerLock as (o?: unknown) => Promise<void> | void).call(this.el, { unadjustedMovement: true });
  }

  down(code: string): boolean {
    return this.enabled && this.keys.has(code);
  }

  /** Call at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.lmbPressed = false;
    this.wheel = 0;
  }
}
