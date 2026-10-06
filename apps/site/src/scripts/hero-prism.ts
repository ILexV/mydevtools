/**
 * Home hero background: animated "signal through a prism" on a canvas.
 * A beam falls into a prism between the hero columns and splits into one
 * coloured ray per hero-lab output row (Base64/URL/Hex/SHA-256); each result
 * leaves the panel's right edge as a parallel line. Light packets travel the
 * whole path. Typing in the lab fires a burst whose packets "deliver" to
 * their row (`mdt:prism-hit`). Pointer tilts the prism.
 * Narrow (mobile) layout: the panel sits under the copy, so the prism floats
 * in the gap above it — the beam enters from the left edge, rays fan down
 * into the panel's top edge, and scrolling (no hover on touch) tilts it.
 *
 * Budget: Canvas 2D, DPR ≤ 1.5, geometry measured only on resize, paused when
 * the hero is offscreen or the tab is hidden. Reduced motion → one static
 * frame, no packets.
 */

interface Pt {
  x: number;
  y: number;
}

interface Ray {
  color: string;
  anchor: Pt; // where the ray meets the lab panel (row centre, left edge)
  out: Pt | null; // same row on the panel's right edge (wide layout only)
  end: Pt | null; // output line runs to the band edge
}

interface Packet {
  ray: number;
  t: number; // 0..1 along source → prism → anchor ⇢ out → end
  speed: number; // progress per ms
  burst: boolean;
  hit?: boolean;
}

// Path split: beam [0, T1) · ray [T1, T2) · hidden inside panel · output [T2, 1].
const T1 = 0.32;
const T2 = 0.62;

const ROW_VARS = ["--mdt-cat-encoding", "--mdt-cat-structured-data", "--mdt-cat-generators", "--mdt-cat-hashing"];
const MAX_DPR = 1.5;
const MAX_PIXELS = 2_000_000;

export function initHeroPrism(band: HTMLElement): void {
  const canvas = band.querySelector<HTMLCanvasElement>("[data-prism-canvas]");
  const panel = band.querySelector<HTMLElement>("[data-hero-lab]");
  const ctx = canvas?.getContext("2d");
  if (!canvas || !panel || !ctx || canvas.dataset.bound) return;
  canvas.dataset.bound = "1";

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const wide = window.matchMedia("(min-width: 900px)");

  let w = 0;
  let h = 0;
  let dark = true;
  let src: Pt = { x: 0, y: 0 };
  let prism: Pt = { x: 0, y: 0 };
  let size = 28;
  let rays: Ray[] = [];
  let packets: Packet[] = [];
  let glow = 0; // prism flash after a burst, decays to 0
  let tilt = 0; // eased pointer influence, -1..1
  let tiltTarget = 0;
  let visible = true;
  let raf = 0;
  let last = 0;
  let nextAmbient = 0;
  let sprite: HTMLCanvasElement | null = null;

  function readColors(): string[] {
    const cs = getComputedStyle(document.documentElement);
    dark = document.documentElement.dataset.theme !== "light";
    return ROW_VARS.map((v) => cs.getPropertyValue(v).trim() || "#7c6cff");
  }

  /** Soft white glow, cached once; tinted packets draw it under a coloured core. */
  function makeSprite(): HTMLCanvasElement {
    const s = document.createElement("canvas");
    s.width = s.height = 48;
    const g = s.getContext("2d")!;
    const grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
    grad.addColorStop(0, "rgba(255,255,255,0.9)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.35)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 48, 48);
    return s;
  }

  function measure(): void {
    const b = band.getBoundingClientRect();
    w = Math.round(b.width);
    h = Math.round(b.height);
    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (w * h * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (w * h));
    canvas!.width = Math.round(w * dpr);
    canvas!.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

    const p = panel!.getBoundingClientRect();
    const rows = Array.from(panel!.querySelectorAll<HTMLElement>("[data-lab-row]"));
    const colors = readColors();
    const left = p.left - b.left;
    const right = p.right - b.left;
    const ys = rows.map((r) => {
      const rr = r.getBoundingClientRect();
      return rr.top - b.top + rr.height / 2;
    });
    if (!wide.matches) {
      // Mobile: prism in the gap above the panel, rays into its top edge.
      const top = p.top - b.top;
      const n = Math.max(1, rows.length);
      size = 18;
      prism = { x: left + p.width * 0.5, y: top - 54 };
      src = { x: -20, y: prism.y - 26 };
      rays = rows.map((_, i) => ({
        color: colors[i % colors.length],
        anchor: { x: left + p.width * (0.26 + (0.48 * i) / Math.max(1, n - 1)), y: top + 1 },
        out: null,
        end: null,
      }));
      return;
    }
    const mid = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : p.top - b.top + p.height / 2;
    size = Math.max(22, Math.min(34, w * 0.022));
    prism = { x: left - Math.max(48, Math.min(72, w * 0.045)), y: mid };
    src = { x: prism.x - 90, y: -20 };
    rays = ys.map((y, i) => ({
      color: colors[i % colors.length],
      anchor: { x: left + 1, y },
      out: { x: right - 1, y },
      end: { x: w + 20, y },
    }));
  }

  /** `#rgb`/`#rrggbb` token → rgba(); canvas colour parsing lacks color-mix() in some engines. */
  function alpha(color: string, a: number): string {
    let hex = color.replace("#", "");
    if (hex.length === 3) hex = hex.replace(/./g, (ch) => ch + ch);
    const n = Number.parseInt(hex.slice(0, 6), 16);
    if (Number.isNaN(n)) return `rgba(124,108,255,${a})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
  }

  function lerp(a: Pt, b: Pt, k: number): Pt {
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  /** Point at progress t; `null` while the packet is inside the (opaque) panel. */
  function pointAt(ray: Ray, t: number): Pt | null {
    if (t < T1) return lerp({ x: src.x + tilt * 8, y: src.y }, prism, t / T1);
    if (t < T2 - 0.06) return lerp(prism, ray.anchor, (t - T1) / (T2 - 0.06 - T1));
    if (t < T2 || !ray.out || !ray.end) return null;
    return lerp(ray.out, ray.end, (t - T2) / (1 - T2));
  }

  function drawScene(now: number): void {
    const c = ctx!;
    c.clearRect(0, 0, w, h);
    if (!rays.length) return;
    const base = dark ? 1 : 0.8;
    const breathe = 0.85 + 0.15 * Math.sin(now / 2400);
    const s = { x: src.x + tilt * 8, y: src.y };
    const first = rays[0];
    const lastRay = rays[rays.length - 1];

    // spectrum wedge between the outer rays, prism → panel edge
    const wedge = c.createLinearGradient(prism.x, prism.y, first.anchor.x, first.anchor.y);
    wedge.addColorStop(0, dark ? `rgba(255,255,255,${0.05 * breathe})` : `rgba(80,80,140,${0.05 * breathe})`);
    wedge.addColorStop(1, alpha(rays[1]?.color ?? first.color, 0.12 * base * breathe));
    c.beginPath();
    c.moveTo(prism.x, prism.y);
    c.lineTo(first.anchor.x, first.anchor.y);
    c.lineTo(lastRay.anchor.x, lastRay.anchor.y);
    c.closePath();
    c.fillStyle = wedge;
    c.fill();

    // incoming white beam
    const beam = c.createLinearGradient(s.x, s.y, prism.x, prism.y);
    beam.addColorStop(0, dark ? "rgba(255,255,255,0)" : "rgba(40,40,70,0)");
    beam.addColorStop(1, dark ? "rgba(255,255,255,0.6)" : "rgba(40,40,70,0.4)");
    c.lineCap = "round";
    c.strokeStyle = beam;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(s.x, s.y);
    c.lineTo(prism.x, prism.y);
    c.stroke();

    // rays (soft glow + crisp core) and the parallel output lines
    for (const r of rays) {
      for (const [lw, a] of [[7, 0.08], [1.25, 0.7]] as const) {
        c.strokeStyle = alpha(r.color, a * base);
        c.lineWidth = lw;
        c.beginPath();
        c.moveTo(prism.x, prism.y);
        c.lineTo(r.anchor.x, r.anchor.y);
        c.stroke();
        if (!r.out || !r.end) continue;
        const g = c.createLinearGradient(r.out.x, 0, r.end.x, 0);
        g.addColorStop(0, alpha(r.color, a * base * 0.8));
        g.addColorStop(1, alpha(r.color, 0));
        c.strokeStyle = g;
        c.beginPath();
        c.moveTo(r.out.x, r.out.y);
        c.lineTo(r.end.x, r.end.y);
        c.stroke();
      }
    }

    // glow where light enters the prism (flares on a burst)
    const gr = size * (1.4 + glow * 0.8);
    const halo = c.createRadialGradient(prism.x, prism.y, 0, prism.x, prism.y, gr);
    halo.addColorStop(0, dark ? `rgba(170,160,255,${0.14 + glow * 0.26})` : `rgba(106,90,249,${0.08 + glow * 0.16})`);
    halo.addColorStop(1, dark ? "rgba(170,160,255,0)" : "rgba(106,90,249,0)");
    c.fillStyle = halo;
    c.fillRect(prism.x - gr, prism.y - gr, gr * 2, gr * 2);

    // prism: rotated triangle with a faint glassy fill
    const rot = -Math.PI / 2 + tilt * 0.12;
    c.save();
    c.translate(prism.x, prism.y);
    c.rotate(rot);
    c.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = (i * 2 * Math.PI) / 3;
      const px = Math.cos(a) * size;
      const py = Math.sin(a) * size;
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.closePath();
    const glass = c.createLinearGradient(-size, -size, size, size);
    glass.addColorStop(0, dark ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.85)");
    glass.addColorStop(1, dark ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.45)");
    c.fillStyle = glass;
    c.fill();
    c.strokeStyle = dark ? "rgba(255,255,255,0.5)" : "rgba(30,30,60,0.35)";
    c.lineWidth = 1.2;
    c.stroke();
    c.restore();

    // ports where rays enter / leave the panel
    for (const r of rays) {
      c.fillStyle = alpha(r.color, 0.95 * base);
      for (const q of r.out ? [r.anchor, r.out] : [r.anchor]) {
        c.beginPath();
        c.arc(q.x, q.y, 2.5, 0, Math.PI * 2);
        c.fill();
      }
    }

    // packets: short fading stroke + glowing head
    for (const p of packets) {
      const r = rays[p.ray];
      const head = r && p.t >= 0 ? pointAt(r, p.t) : null;
      if (!r || !head) continue;
      const col = p.t < T1 ? (dark ? "#ffffff" : "#3a3a66") : r.color;
      const strength = p.burst ? 1 : 0.7;
      const len = p.t < T1 ? 0.035 : 0.05;
      const tail = pointAt(r, Math.max(p.t - len, p.t < T1 ? 0 : p.t < T2 ? T1 : T2));
      if (tail) {
        const g = c.createLinearGradient(tail.x, tail.y, head.x, head.y);
        g.addColorStop(0, alpha(col, 0));
        g.addColorStop(1, alpha(col, 0.9 * strength));
        c.strokeStyle = g;
        c.lineWidth = p.burst ? 2.2 : 1.6;
        c.beginPath();
        c.moveTo(tail.x, tail.y);
        c.lineTo(head.x, head.y);
        c.stroke();
      }
      if (sprite) {
        c.globalAlpha = (dark ? 0.6 : 0.35) * strength;
        c.drawImage(sprite, head.x - 12, head.y - 12, 24, 24);
        c.globalAlpha = 1;
      }
      c.fillStyle = alpha(col, strength);
      c.beginPath();
      c.arc(head.x, head.y, p.burst ? 2.6 : 2, 0, Math.PI * 2);
      c.fill();
    }
  }

  function spawn(burst: boolean): void {
    if (burst) {
      // One point on the beam that splits into all rays at the prism.
      rays.forEach((_, i) => packets.push({ ray: i, t: 0, speed: 1 / 1800, burst: true }));
      glow = 1;
    } else {
      packets.push({ ray: Math.floor(Math.random() * rays.length), t: 0, speed: 1 / (7000 + Math.random() * 3000), burst: false });
    }
    if (packets.length > 24) packets = packets.slice(-24);
  }

  function frame(now: number): void {
    raf = 0;
    const dt = last ? Math.min(64, now - last) : 16;
    last = now;
    tilt += (tiltTarget - tilt) * Math.min(1, dt / 250);
    glow = Math.max(0, glow - dt / 900);
    if (now >= nextAmbient) {
      spawn(false);
      nextAmbient = now + 1400 + Math.random() * 1200;
    }
    const arrived: number[] = [];
    packets = packets.filter((p) => {
      p.t += p.speed * dt;
      if (p.burst && !p.hit && p.t >= T2 - 0.06) {
        p.hit = true;
        arrived.push(p.ray);
      }
      // no output line on mobile: the packet is done once it reaches the panel
      return p.t < (rays[p.ray]?.out ? 1 : T2);
    });
    for (const i of arrived) band.dispatchEvent(new CustomEvent("mdt:prism-hit", { detail: { row: i } }));
    drawScene(now);
    schedule();
  }

  function running(): boolean {
    return visible && !document.hidden && !motion.matches;
  }

  function schedule(): void {
    if (!raf && running()) raf = requestAnimationFrame(frame);
  }

  function refresh(): void {
    measure();
    if (!running()) drawScene(0); // fixed phase → deterministic static frame
    schedule();
  }

  sprite = makeSprite();
  // Measure after first paint so the hero text/LCP is never blocked by canvas setup.
  requestAnimationFrame(() => {
    refresh();
    canvas.classList.add("is-ready");
  });

  new ResizeObserver(() => refresh()).observe(band);
  new IntersectionObserver((entries) => {
    visible = entries[0]?.isIntersecting ?? true;
    last = 0;
    schedule();
  }).observe(band);
  document.addEventListener("visibilitychange", () => {
    last = 0;
    schedule();
  });
  motion.addEventListener("change", refresh);
  wide.addEventListener("change", refresh);
  new MutationObserver(() => refresh()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  document.fonts?.ready.then(refresh);

  band.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const b = band.getBoundingClientRect();
    tiltTarget = Math.max(-1, Math.min(1, ((e.clientX - b.left) / b.width) * 2 - 1));
  });
  band.addEventListener("pointerleave", () => {
    tiltTarget = 0;
  });
  // Touch layouts have no hover: scrolling through the hero tilts the prism instead.
  window.addEventListener(
    "scroll",
    () => {
      if (!wide.matches) tiltTarget = Math.max(-1, Math.min(1, window.scrollY / 220 - 0.4));
    },
    { passive: true },
  );
  let lastBurst = 0;
  band.addEventListener("mdt:lab-input", () => {
    const now = performance.now();
    if (!running() || now - lastBurst < 320) return; // fast typing → one burst per beat
    lastBurst = now;
    spawn(true);
  });
}
