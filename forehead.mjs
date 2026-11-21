// Band-passed green-channel spectral estimate on the same 900-sample grid as rppg10.py.
const RATE = 30;
const SIZE = RATE * 30;
const FFT_SIZE = 4096;
const TAU = 2 * Math.PI;

// scipy.signal.butter(3, [0.7, 3.0], "band", fs=30, output="sos") and its sosfilt_zi, as in rppg10.py.
const SOS = [
  [0.009109513841753935, 0.01821902768350787, 0.009109513841753935, 1, -1.5307849521265975, 0.6056215269923997],
  [1, 0, -1, 1, -1.397221138763906, 0.6898776822399334],
  [1, -2, 1, 1, -1.881540991999995, 0.9042770490130764]
];
const ZI = [[0.47779218405605717, -0.28576863593431046], [-0.48690169789781107, -0.48690169789781107], [0, 0]];
const PAD = 21;
export const QUALITY_GATE = 0.75; // chosen on the development half of rPPG-10 (see pulse/README.md)

function cascade(signal) {
  const first = signal[0];
  SOS.forEach(([b0, b1, b2, , a1, a2], section) => {
    let z0 = ZI[section][0] * first, z1 = ZI[section][1] * first;
    for (let i = 0; i < signal.length; i++) {
      const input = signal[i], output = b0 * input + z0;
      z0 = b1 * input - a1 * output + z1;
      z1 = b2 * input - a2 * output;
      signal[i] = output;
    }
  });
}

// Zero-phase band-pass equal to scipy.signal.sosfiltfilt (odd extension, forward and backward pass).
function bandpass(samples) {
  const n = samples.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;
  const padded = new Float64Array(n + 2 * PAD);
  for (let i = 0; i < n; i++) padded[PAD + i] = samples[i] - mean;
  for (let i = 0; i < PAD; i++) {
    padded[i] = 2 * padded[PAD] - padded[2 * PAD - i];
    padded[PAD + n + i] = 2 * padded[PAD + n - 1] - padded[PAD + n - 2 - i];
  }
  cascade(padded);
  padded.reverse();
  cascade(padded);
  padded.reverse();
  return padded.subarray(PAD, PAD + n);
}

// Returns the strongest 40-180 bpm bin and the spectral quality of that peak, or null.
export function greenPulse(samples) {
  if (samples.length !== SIZE) return null;
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < SIZE; i++) {
    const value = samples[i];
    if (!Number.isFinite(value)) return null;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  if (high - low < 1e-10) return null;
  const filtered = bandpass(samples);
  let total = 0, cross = 0;
  const center = (SIZE - 1) / 2;
  for (let i = 0; i < SIZE; i++) {
    total += filtered[i];
    cross += (i - center) * filtered[i];
  }
  const slope = cross / (SIZE * (SIZE * SIZE - 1) / 12);
  const mean = total / SIZE;
  const wave = Float64Array.from(filtered, (value, i) =>
    (value - mean - slope * (i - center)) * (0.5 - 0.5 * Math.cos(TAU * i / SIZE)));
  // Goertzel evaluates just the periodogram bins between 40 and 240 bpm.
  const binBpm = RATE * 60 / FFT_SIZE;
  const firstBin = Math.ceil(40 / binBpm), lastBand = Math.floor(180 / binBpm), lastBin = Math.floor(240 / binBpm);
  const power = new Float64Array(lastBin + 1);
  let bestBin = 0, bestPower = 0;
  for (let bin = firstBin; bin <= lastBin; bin++) {
    const coefficient = 2 * Math.cos(TAU * bin / FFT_SIZE);
    let prior = 0, older = 0;
    for (let i = 0; i < SIZE; i++) {
      const current = wave[i] + coefficient * prior - older;
      older = prior;
      prior = current;
    }
    power[bin] = prior * prior + older * older - coefficient * prior * older;
    if (bin <= lastBand && power[bin] > bestPower) {
      bestPower = power[bin];
      bestBin = bin;
    }
  }
  if (!(bestPower > 0)) return null;
  // Power near the peak and its first harmonic against the rest of the 40-180 bpm band.
  const halfWidth = 6 / binBpm;
  let near = 0, rest = 0;
  for (let bin = firstBin; bin <= lastBin; bin++) {
    const close = Math.abs(bin - bestBin) <= halfWidth || Math.abs(bin - 2 * bestBin) <= halfWidth;
    if (close) near += power[bin];
    else if (bin <= lastBand) rest += power[bin];
  }
  return {bpm: bestBin * binBpm, quality: rest > 0 ? near / rest : Infinity};
}

function interpolateTo30Hz(buffer, end) {
  let left = 0;
  return Float64Array.from({length: SIZE}, (_, i) => {
    const target = end - (SIZE - 1 - i) / RATE;
    while (left < buffer.length - 2 && buffer[left + 1].time < target) left++;
    const a = buffer[left], b = buffer[left + 1];
    const fraction = Math.max(0, Math.min(1, (target - a.time) / (b.time - a.time)));
    return a.value + (b.value - a.value) * fraction;
  });
}

export class ForeheadPulse {
  constructor() {
    this.surface = document.createElement("canvas");
    this.surface.width = this.surface.height = 24;
    this.context = this.surface.getContext("2d", {willReadFrequently: true});
    this.reset("Waiting for a face");
  }

  reset(status) {
    this.buffer = [];
    this.lastEstimateAt = -Infinity;
    this.result = {bpm: null, seconds: 0, status};
    return this.result;
  }

  step(time, video, landmarks) {
    const width = video.videoWidth, height = video.videoHeight;
    if (!this.context || !width || !height || !Number.isFinite(time) ||
        !landmarks?.[151] || !landmarks[234] || !landmarks[454]) {
      return this.reset("Waiting for a visible forehead");
    }
    const size = 0.22 * Math.abs(landmarks[454].x - landmarks[234].x) * width;
    const x = landmarks[151].x * width - size / 2;
    const y = landmarks[151].y * height - size / 2;
    if (!Number.isFinite(x + y + size) || size < 5 || x < 0 || y < 0 ||
        x + size > width || y + size > height) {
      return this.reset("Waiting for a visible forehead");
    }
    const previous = this.buffer.at(-1);
    if (previous && previous.time === time) return this.result;
    // One late frame should not discard half a minute of signal; longer stalls restart the window.
    if (previous && (time < previous.time || time - previous.time > 0.5)) {
      this.reset("Sampling interrupted");
    }
    this.context.drawImage(video, x, y, size, size, 0, 0, 24, 24);
    const rgba = this.context.getImageData(0, 0, 24, 24).data;
    let green = 0;
    for (let i = 1; i < rgba.length; i += 4) green += rgba[i];
    this.buffer.push({time, value: green / (24 * 24)});
    const begin = time - (SIZE - 1) / RATE;
    while (this.buffer.length > 2 && this.buffer[1].time <= begin) this.buffer.shift();
    const seconds = Math.min(30, Math.floor(time - this.buffer[0].time + 1 / RATE + 1e-8));
    if (this.buffer[0].time > begin + 1e-8) {
      return this.result = {bpm: null, seconds, status: `Collecting forehead signal · ${seconds}/30 s`};
    }
    if (this.buffer.length < 240) {
      return this.result = {bpm: null, seconds, status: "Video rate below 8 frames/s"};
    }
    if (time - this.lastEstimateAt >= 1 - 1e-8) {
      this.lastEstimateAt = time;
      const estimate = greenPulse(interpolateTo30Hz(this.buffer, time));
      if (estimate === null) {
        this.result = {bpm: null, quality: null, seconds, status: "Insufficient color variation"};
      } else if (estimate.quality < QUALITY_GATE) {
        this.result = {bpm: null, quality: estimate.quality, seconds, status: "Signal too noisy · no estimate shown"};
      } else {
        this.result = {bpm: estimate.bpm, quality: estimate.quality, seconds, status: "30 s forehead estimate"};
      }
    }
    return this.result;
  }
}
