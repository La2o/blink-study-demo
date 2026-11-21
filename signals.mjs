const LEFT = [362, 385, 387, 263, 373, 380];
const RIGHT = [33, 160, 158, 133, 145, 153];
export const OUTLINES = [LEFT, RIGHT];
export const MOUTH_POINTS = [40, 291, 37, 270, 61, 267];

export function faceRatios(landmarks, width, height) {
  if (!landmarks?.length || !(width > 0 && height > 0)) return [null, null];
  function distance(a, b) {
    const first = landmarks[a], second = landmarks[b];
    if (!first || !second) return NaN;
    // cvzone's original measurements used integer pixel coordinates.
    return Math.hypot(Math.trunc(first.x * width) - Math.trunc(second.x * width),
                      Math.trunc(first.y * height) - Math.trunc(second.y * height));
  }
  function eye([a, b, c, d, e, f]) {
    return (distance(b, f) + distance(c, e)) / (2 * distance(a, d));
  }
  const ear = (eye(LEFT) + eye(RIGHT)) / 2;
  const mar = (distance(40, 291) + distance(37, 270)) / (2 * distance(61, 267));
  return ear >= .05 && ear <= .8 && mar >= .05 && mar <= 3 ? [ear, mar] : [null, null];
}

export const EXAMPLE_SECONDS = 18;
const CLOSURES = [[2.0, .24], [5.2, .93], [9.7, .32], [13.2, 1.16], [16.1, .20]];
export function exampleRatios(t) {
  let ear = .325 + .005 * Math.sin(3.7 * t) + .002 * Math.sin(9 * t);
  for (const [start, duration] of CLOSURES) {
    if (t >= start && t <= start + duration) {
      const ramp = Math.min(.15, duration / 2);
      const depth = Math.min((t - start) / ramp, (start + duration - t) / ramp, 1);
      ear -= .225 * Math.sin(depth * Math.PI / 2);
    }
  }
  return [ear, .55 + .012 * Math.sin(.7 * t)];
}
