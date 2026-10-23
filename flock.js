// A murmuration for the hero: a flock of tiny birds that follow three drifting targets,
// so it stretches, splits and merges again. No dependencies.
//
// Built to be cheap:
//  - birds are plotted into a small pixel buffer (about 2 CSS px per pixel) and uploaded once per frame,
//    instead of thousands of separate canvas draw calls
//  - the buffer is stretched by CSS, so the cost does not grow with screen density
//  - it runs at 30fps and only while the hero is on screen
//  - if a device is slow, it first drops to 15fps and, if that is still too much, settles on a still frame
const canvas = document.querySelector(".flock");

if (canvas) {
  const ctx = canvas.getContext("2d");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const light = window.matchMedia("(prefers-color-scheme: light)");

  const CELL = 2; // CSS pixels per buffer pixel
  const STEPS_PER_FRAME = 2; // two physics steps per drawn frame keeps the speed of a 60fps flock
  const WIND_CELL = 32; // CSS pixels per wind cell

  // Liveliness: the main knobs for how much the flock moves
  const SPEED = 1.7; // how fast the flock's targets travel (1 = the old, calm speed)
  const MAX_SPEED = 3.4; // how fast a single bird can fly
  const SWIRL = 0.026; // how strongly birds circle their target (more = tighter ribbons)
  const TRAIL = 0.88; // brightness kept from the previous frame (0.8 = short streaks, 0.95 = long ones)

  const pointer = { x: 0, y: 0, active: false };
  // Three sub-flocks that each chase their own target, so the flock keeps splitting and merging
  const targets = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  // How much brightness each value keeps after one frame of fading
  const fade = new Uint8Array(256).map((_, value) => (value * TRAIL) | 0);

  let width = 0;
  let height = 0;
  let bufferWidth = 0;
  let bufferHeight = 0;
  let image = null;
  let pixels = null; // image.data, only the alpha channel changes per frame
  let count = 0;
  let px = new Float32Array(0);
  let py = new Float32Array(0);
  let vx = new Float32Array(0);
  let vy = new Float32Array(0);
  let grip = new Float32Array(0);
  let windCols = 0;
  let windRows = 0;
  let windCos = new Float32Array(0);
  let windSin = new Float32Array(0);
  let time = 0;
  let raf = 0;
  let frameMs = 1000 / 30;
  let gaveUp = false; // the browser could not keep up, so the flock stays a still frame
  let last = 0;
  let waited = 0;
  let samples = 0;
  let strength = 120;

  function readTheme() {
    // --soft is lavender on dark and deep blue on light, so the birds always follow the theme
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    probe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--soft").trim() || "#b8c6ff";
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    strength = light.matches ? 150 : 120;
    if (!pixels) return;
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 0;
    }
  }

  function seed(next) {
    count = next;
    px = new Float32Array(count);
    py = new Float32Array(count);
    vx = new Float32Array(count);
    vy = new Float32Array(count);
    grip = new Float32Array(count);
    const radius = Math.min(width, height) * 0.25;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * radius;
      px[i] = width * 0.62 + Math.cos(angle) * distance;
      py[i] = height * 0.45 + Math.sin(angle) * distance;
      // Every bird holds on to its target a little differently, which fills the flock out instead of making rings
      grip[i] = 0.25 + Math.random() * 1.1;
    }
  }

  // Neighbours share the same smooth wind, which is what makes them look like they fly together.
  // It is worked out once per step on a coarse grid, not once per bird.
  function updateWind() {
    for (let row = 0; row < windRows; row++) {
      for (let col = 0; col < windCols; col++) {
        const x = col * WIND_CELL;
        const y = row * WIND_CELL;
        const angle = (Math.sin(x * 0.012 + time * 0.6) + Math.cos(y * 0.014 - time * 0.5)) * 2;
        const at = row * windCols + col;
        windCos[at] = Math.cos(angle) * 0.07;
        windSin[at] = Math.sin(angle) * 0.07;
      }
    }
  }

  function step() {
    time += 0.016 * SPEED;
    updateWind();

    const cx = width * 0.58;
    const cy = height * 0.46;
    const rx = width * 0.27;
    const ry = height * 0.29;
    targets[0].x = cx + rx * Math.sin(time * 0.37) + rx * 0.4 * Math.sin(time * 0.91 + 1);
    targets[0].y = cy + ry * Math.sin(time * 0.29 + 2) + ry * 0.4 * Math.cos(time * 0.77);
    targets[1].x = cx + rx * Math.sin(time * 0.31 + 3) + rx * 0.4 * Math.cos(time * 0.83);
    targets[1].y = cy + ry * Math.sin(time * 0.41 + 5) + ry * 0.4 * Math.sin(time * 0.69 + 2);
    targets[2].x = cx + rx * Math.sin(time * 0.23 + 4) + rx * 0.4 * Math.sin(time * 0.71 + 3);
    targets[2].y = cy + ry * Math.sin(time * 0.33 + 1) + ry * 0.4 * Math.cos(time * 0.97 + 4);

    if (pointer.active && !reduced.matches) {
      targets[0].x += (pointer.x - targets[0].x) * 0.85;
      targets[0].y += (pointer.y - targets[0].y) * 0.85;
    }

    const reach = Math.min(width, height) * 0.35;
    const invWind = 1 / WIND_CELL;
    for (let i = 0; i < count; i++) {
      const target = targets[i % 3];
      const dx = target.x - px[i];
      const dy = target.y - py[i];
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;

      // Pull towards the target (harder when far away) plus a sideways swirl, so the birds circle instead of clumping.
      const pull = Math.min(distance / reach, 2) * 0.05 * grip[i];
      const swirl = SWIRL * Math.min(1, reach / distance);
      let ax = (dx / distance) * pull - (dy / distance) * swirl;
      let ay = (dy / distance) * pull + (dx / distance) * swirl;

      const col = (px[i] * invWind) | 0;
      const row = (py[i] * invWind) | 0;
      if (col >= 0 && col < windCols && row >= 0 && row < windRows) {
        const at = row * windCols + col;
        ax += windCos[at];
        ay += windSin[at];
      }
      ax += (Math.random() - 0.5) * 0.05;
      ay += (Math.random() - 0.5) * 0.05;

      let nx = (vx[i] + ax) * 0.97;
      let ny = (vy[i] + ay) * 0.97;
      const speed = Math.sqrt(nx * nx + ny * ny);
      if (speed > MAX_SPEED) {
        nx = (nx / speed) * MAX_SPEED;
        ny = (ny / speed) * MAX_SPEED;
      }
      vx[i] = nx;
      vy[i] = ny;
      px[i] += nx;
      py[i] += ny;
    }
  }

  function draw() {
    const inv = 1 / CELL;
    // Fade the previous frame instead of clearing it, so every bird leaves a short streak behind it
    for (let a = 3; a < pixels.length; a += 4) pixels[a] = fade[pixels[a]];
    // Where birds overlap, the alpha adds up (and clamps at 255), so dense parts glow like the grain behind them
    for (let i = 0; i < count; i++) {
      const x = (px[i] * inv) | 0;
      const y = (py[i] * inv) | 0;
      if (x < 0 || y < 0 || x >= bufferWidth || y >= bufferHeight) continue;
      pixels[(y * bufferWidth + x) * 4 + 3] += strength;
    }
    ctx.putImageData(image, 0, 0);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < frameMs - 2) return;

    // Watch how long frames really take to arrive. A busy browser delivers them late, whatever our own code costs.
    // (Gaps over half a second are tab switches or scrolling off-screen, not slowness.)
    const gap = now - last;
    last = now;
    if (gap < 500) {
      waited += gap;
      // Decide after 30 frames, or after two seconds if frames are arriving that slowly
      if (++samples >= 30 || waited >= 2000) {
        const average = waited / samples;
        waited = 0;
        samples = 0;
        if (average > frameMs * 1.6) {
          if (frameMs < 50) {
            frameMs = 1000 / 15;
          } else {
            gaveUp = true;
            stop();
            return;
          }
        }
      }
    }

    for (let s = 0; s < STEPS_PER_FRAME; s++) step();
    draw();
  }

  function start() {
    if (!raf && !reduced.matches && !gaveUp) raf = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    width = rect.width;
    height = rect.height;
    bufferWidth = Math.max(1, Math.round(width / CELL));
    bufferHeight = Math.max(1, Math.round(height / CELL));
    canvas.width = bufferWidth;
    canvas.height = bufferHeight;
    image = ctx.createImageData(bufferWidth, bufferHeight);
    pixels = image.data;
    windCols = Math.ceil(width / WIND_CELL) + 1;
    windRows = Math.ceil(height / WIND_CELL) + 1;
    windCos = new Float32Array(windCols * windRows);
    windSin = new Float32Array(windCols * windRows);
    readTheme();
    const next = Math.min(1600, Math.max(400, Math.round((width * height) / 400)));
    if (next !== count) seed(next);
    if (!raf) draw();
  }

  resize();
  for (let i = 0; i < (reduced.matches ? 300 : 80); i++) step();
  draw();

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop())).observe(canvas);

  window.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse") return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.active = pointer.x >= 0 && pointer.x <= rect.width && pointer.y >= 0 && pointer.y <= rect.height;
    },
    { passive: true },
  );

  light.addEventListener("change", () => {
    readTheme();
    if (!raf) draw();
  });
  reduced.addEventListener("change", () => (reduced.matches ? stop() : start()));
}
