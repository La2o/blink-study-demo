function surface(canvas) {
  const {width, height} = canvas.getBoundingClientRect();
  if (width < 1 || height < 1) return null;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const g = canvas.getContext("2d");
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, width, height);
  return [g, width, height];
}

const LEFT = 42;
// Both stacked plots use identical horizontal margins so their 8 s windows line up.
const rightEdge = w => w - (w < 420 ? 30 : 68);
const MONO = '12px Consolas, monospace', SMALL = '10px Consolas, monospace';

function timeAxis(g, px, start, bottom) {
  g.font = MONO; g.fillStyle = "#506965"; g.textAlign = "center"; g.textBaseline = "top";
  for (let i = 0; i <= 4; i++) {
    const t = start + 2 * i;
    g.fillText(t.toFixed(start % 1 < .049 ? 0 : 1) + "s", px(t), bottom + 6);
  }
}
// Spans [from, to] (seconds) where the eye ratio was missing: tracking lost.
function gapSpans(samples, start, limit) {
  const spans = []; let from = null;
  for (const [t, ear] of samples) {
    if (!Number.isFinite(ear)) {if (from === null) from = t;}
    else if (from !== null) {spans.push([from, t]); from = null;}
  }
  if (from !== null) spans.push([from, limit]);
  return spans.map(([a, b]) => [Math.max(a, start), Math.min(b, limit)]).filter(([a, b]) => b > a);
}
function drawGaps(g, spans, px, top, bottom) {
  for (const [a, b] of spans) {
    const x0 = px(a), width = Math.max(2, px(b) - x0), height = bottom - top;
    g.save();
    g.beginPath(); g.rect(x0, top, width, height); g.clip();
    g.fillStyle = "#e6ece8"; g.fillRect(x0, top, width, height);
    g.strokeStyle = "#b9c6c0"; g.lineWidth = 1; g.beginPath();
    for (let x = x0 - height; x < x0 + width; x += 6) {g.moveTo(x, bottom); g.lineTo(x + height, top);}
    g.stroke(); g.restore();
  }
}

// opts.axis=false omits the time labels (for the upper plot of a stack).
export function drawTrace(canvas, samples, now, opts = {}) {
  const frame = surface(canvas);
  if (!frame) return;
  const [g, w, h] = frame;
  const axis = opts.axis !== false;
  const left = LEFT, top = 8, right = rightEdge(w), bottom = axis ? h - 24 : h - 6;
  const start = Math.max(0, now - 8);
  const end = start + 8;
  const points = samples.filter(([t]) => t >= start && t <= end);
  const maxEye = Math.max(.4, ...points.map(([, ear]) => ear || 0));
  const ceil = Math.ceil(maxEye / .2) * .2;
  const px = t => left + (t - start) / 8 * (right - left);
  const py = v => bottom - v / ceil * (bottom - top);
  drawGaps(g, gapSpans(points, start, Math.min(end, now)), px, top, bottom);
  g.font = MONO;
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (let i = 0; i < 3; i++) {
    const v = i * ceil / 2, y = py(v);
    g.strokeStyle = "#d8e2dc"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
    g.fillStyle = "#506965"; g.fillText(v.toFixed(2), left - 6, y);
  }
  if (axis) timeAxis(g, px, start, bottom);
  let segment = [], previous = -Infinity;
  function drawSegment() {
    if (!segment.length) return;
    const path = new Path2D();
    segment.forEach(([t, ear], i) => i ? path.lineTo(px(t), py(ear)) : path.moveTo(px(t), py(ear)));
    g.lineWidth = 2.6; g.strokeStyle = "#167660"; g.stroke(path);
    const fill = new Path2D(path);
    fill.lineTo(px(segment.at(-1)[0]), bottom); fill.lineTo(px(segment[0][0]), bottom); fill.closePath();
    const gradient = g.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, "#9bd7b578"); gradient.addColorStop(1, "#d9ece228");
    g.fillStyle = gradient; g.fill(fill);
    segment = [];
  }
  for (const [t, ear] of points) {
    if (!Number.isFinite(ear) || t - previous > .3) drawSegment();
    if (Number.isFinite(ear)) segment.push([t, ear]);
    previous = t;
  }
  drawSegment();
  // Detector thresholds: dashed guides labelled at the right edge.
  const wide = w >= 420;
  g.font = SMALL; g.textAlign = "left";
  g.setLineDash([5, 4]); g.lineWidth = 1.3;
  for (const [value, colour, label, above] of [[.23, "#3a6f9a", wide ? "0.23 reopen" : "0.23", true],
                                                [.20, "#b4472a", wide ? "0.20 close" : "0.20", false]]) {
    const y = py(value);
    g.strokeStyle = colour; g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
    g.fillStyle = colour; g.textBaseline = above ? "bottom" : "top";
    g.fillText(label, right + 4, above ? y + 1 : y);
  }
  g.setLineDash([]);
}

// Closure-state strip: 0 = open, 1 = closed. `closures` items are
// {onset, end, flagged, long, checkpoint}; flagged or long ones are red, others teal.
export function drawClosures(canvas, samples, closures, now) {
  const frame = surface(canvas);
  if (!frame) return;
  const [g, w, h] = frame;
  const left = LEFT, right = rightEdge(w), top = 14, bottom = h - 24;
  const start = Math.max(0, now - 8), end = start + 8;
  const px = t => left + (t - start) / 8 * (right - left);
  const yClosed = top, yOpen = bottom - 2;
  const limit = Math.min(end, now);
  drawGaps(g, gapSpans(samples.filter(([t]) => t >= start && t <= end), start, limit), px, top, bottom);
  g.font = SMALL; g.textAlign = "right"; g.textBaseline = "middle"; g.fillStyle = "#506965";
  g.strokeStyle = "#d8e2dc"; g.lineWidth = 1;
  for (const [y, label] of [[yClosed, "closed"], [yOpen, "open"]]) {
    g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
    g.fillText(label, left - 6, y);
  }
  timeAxis(g, px, start, bottom);
  g.strokeStyle = "#167660"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(px(start), yOpen); g.lineTo(px(limit), yOpen); g.stroke();
  for (const c of closures) {
    if (c.end <= start || c.onset >= end) continue;
    const x0 = px(Math.max(c.onset, start)), x1 = px(Math.min(c.end, end));
    const width = Math.max(2, x1 - x0);
    g.fillStyle = c.flagged || c.long ? "#c8372d" : "#167660";
    g.fillRect(x0, yClosed, width, yOpen - yClosed);
    g.strokeStyle = c.flagged || c.long ? "#7d1d17" : "#0d4a3e"; g.lineWidth = 1.5;
    g.strokeRect(x0, yClosed, width, yOpen - yClosed);
    if (c.checkpoint !== null && c.checkpoint >= start && c.checkpoint <= end) {
      const x = px(c.checkpoint);
      g.strokeStyle = "#ffffff"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, yClosed); g.lineTo(x, yClosed + 11); g.stroke();
      g.fillStyle = "#102e32"; g.beginPath();
      g.moveTo(x - 4, 2); g.lineTo(x + 4, 2); g.lineTo(x, yClosed - 1); g.closePath(); g.fill();
    }
  }
}

// A procedural eye makes the source of the example signal explicit.
export function drawEye(canvas, ratio) {
  const frame = surface(canvas);
  if (!frame) return;
  const [g, w, h] = frame;
  const gradient = g.createRadialGradient(w * .5, h * .52, 4, w * .49, h * .5, w * .63);
  gradient.addColorStop(0, "#21464a"); gradient.addColorStop(1, "#10292e");
  g.fillStyle = gradient; g.fillRect(0, 0, w, h);
  g.lineWidth = 1; g.strokeStyle = "#91c1a611";
  const grid = Math.max(18, w / 26);
  g.beginPath();
  for (let x = w / 2 % grid; x <= w; x += grid) {g.moveTo(x, 0); g.lineTo(x, h);}
  for (let y = h / 2 % grid; y <= h; y += grid) {g.moveTo(0, y); g.lineTo(w, y);}
  g.stroke();
  g.save(); g.translate(w * .5, h * .53);
  const scale = Math.min(w / 580, h / 220);
  g.scale(scale, scale);
  const aperture = Math.min(1, Math.max(.04, (ratio - .085) / .24));
  const upper = 62 * aperture, lower = 48 * aperture;
  function contour(inset = 0) {
    const p = new Path2D();
    p.moveTo(-136, 2);
    p.bezierCurveTo(-82, -upper - inset, 26, -upper * 1.25 - inset, 135, -3);
    p.bezierCurveTo(72, lower * 1.08 + inset, -40, lower * 1.22 + inset, -136, 2);
    p.closePath();
    return p;
  }
  g.strokeStyle = "#91c8ad5c"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(-143,-7);g.bezierCurveTo(-78,-upper-28,34,-upper-45,144,-10);
  g.moveTo(-112,16);g.bezierCurveTo(-38,lower+26,41,lower+14,101,22);g.stroke();
  const eye = contour();
  g.fillStyle = "#52716b";g.fill(eye);g.save();g.clip(eye);
  const iris = g.createRadialGradient(0,0,10,0,0,47);
  iris.addColorStop(0,"#8ea786");iris.addColorStop(.46,"#9fad77");iris.addColorStop(.80,"#527d63");iris.addColorStop(1,"#243f3b");
  g.fillStyle = iris;g.beginPath();g.arc(0,0,47,0,2*Math.PI);g.fill();
  for (let i=0; i<180; i++) {
    const angle = i * Math.PI / 90;
    const radius = 19 + (Math.sin(i * 8.35) + 1) * 3.3;
    const end = 40 + Math.sin(i * 3.3) * 4.2;
    g.strokeStyle = i % 3 ? "#cce69b79":"#2e5146ae";g.lineWidth = i % 3 ? .65:1.05;
    g.beginPath();g.moveTo(radius*Math.cos(angle),radius*Math.sin(angle));
    g.lineTo(end*Math.cos(angle+.032*Math.sin(i)),end*Math.sin(angle+.032*Math.sin(i)));g.stroke();
  }
  g.fillStyle = "#102c2c";g.beginPath();g.arc(0,0,19,0,Math.PI*2);g.fill();
  g.fillStyle = "#e7efd4d9";g.beginPath();g.ellipse(-9,-10,4.5,3,-.4,0,Math.PI*2);g.fill();
  g.restore();g.strokeStyle="#c4e8a0";g.lineWidth=1.7;g.stroke(eye);
  const points = [[-136,2],[-62,-upper*.78],[55,-upper*.81],[135,-3],[55,lower*.77],[-60,lower*.68]];
  g.fillStyle = "#d5ff98";
  for (const [x,y] of points){g.beginPath();g.arc(x,y,3,0,2*Math.PI);g.fill();}
  g.strokeStyle="#a6d4baba";g.lineWidth=1.25;
  g.beginPath();
  for (const side of [-1,1]) for (const vertical of [-1,1]) {
    const x=side*163, y=vertical*72;
    g.moveTo(x-side*13,y);g.lineTo(x,y);g.lineTo(x,y-vertical*13);
  }
  g.stroke();g.restore();
}
