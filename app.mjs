import {EventMonitor} from "./monitor.mjs";
import {faceRatios, exampleRatios, EXAMPLE_SECONDS, OUTLINES, MOUTH_POINTS} from "./signals.mjs";
import {drawEye, drawTrace, drawClosures} from "./plots.mjs";
import {ForeheadPulse} from "./forehead.mjs";

const $ = id => document.getElementById(id);
const SDK = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const SOURCE_NAMES = {example:"Drawing, not your camera", camera:"Live camera", file:"Local video"};
const BUTTON_NAMES = {example:"Play example", camera:"Start camera", file:"Choose video"};
const EMPTY_HELP = {
  camera:["Camera preview", "Face the camera in steady light, then start capture."],
  file:["Video preview", "Choose a video showing one face. Playback stays on your device."]
};
let source = "example", model = null, defaultModel = null, customModel = false;
let loadingDefault = true;
let monitor = new EventMonitor(null);
let active = false, generation = 0, animation = null, stream = null, detector = null, objectUrl = null;
let rows = [], now = 0, lastEar = .325, showPreview = true;
let scoredThisEvent = false;
let fileName = "";
let video = $("video"), visionPromise = null;
const previewRows = Array.from({length:81}, (_, i) => [i / 10, ...exampleRatios(i / 10)]);
const startButton = $("start"), stopButton = $("stop"), stage = $("stage");

// Keep the screen on while a session runs: phones dim and lock within seconds otherwise.
// Optional everywhere; a browser without the Wake Lock API, or one that refuses, just carries on.
let wakeLock = null;
async function holdScreen() {
  if (wakeLock || !navigator.wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    lock.addEventListener("release", () => {if (wakeLock === lock) wakeLock = null;});
    if (!active) {lock.release().catch(() => {}); return;}   // the session ended while the request was pending
    wakeLock = lock;
  } catch {}
}
function releaseScreen() {
  const lock = wakeLock; wakeLock = null;
  if (lock) lock.release().catch(() => {});
}
// The system drops the lock when the page is hidden; take it again when the viewer returns.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && active) holdScreen();
});

// Per-closure bookkeeping, derived only from successive monitor.step() states.
// A closure starts on the first frame whose phase is "closure" and ends on the first
// frame where the phase is anything else (eyes reopened, tracking lost, or the session
// ended). Duration convention, used everywhere (banner, plots, log, CSV):
// duration = last "closure" frame's elapsed + FRAME_STEP, i.e. the onset frame counts as one
// full 0.1 s frame, so duration equals the time from onset to the first non-closed frame.
const FRAME_STEP = 0.1;
// A closure still in progress this long after its onset raises a warning that does not depend on
// the classifier, so a missing, wrong or out-of-range model can never suppress it.
const LONG_CLOSURE = 0.85;
class SessionLog {
  constructor() {this.reset();}
  reset() {this.done = []; this.current = null; this.lost = 0; this.t = 0; this.hasModel = false;}
  update(t, state, model) {
    const events = [];
    this.t = t; this.hasModel = Boolean(model);
    if (state.phase === "tracking lost") this.lost += FRAME_STEP;
    if (state.phase === "closure") {
      if (!this.current) {
        this.current = {onset:t, elapsed:0, score:null, flagged:false, long:false, checkpoint:null};
        events.push("start");
      }
      const c = this.current;
      c.elapsed = Number.isFinite(state.elapsed) ? state.elapsed : 0;
      if (Number.isFinite(state.score) && c.score === null) {
        c.score = state.score;
        c.checkpoint = c.onset + (Number.isFinite(state.horizon) ? state.horizon : c.elapsed);
        events.push("checkpoint");
      }
      if (model && state.decision === "flagged" && !c.flagged) {c.flagged = true; events.push("flagged");}
      if (!c.long && c.elapsed >= LONG_CLOSURE - 1e-8) {c.long = true; events.push("long");}
    } else if (this.current) {
      this.close(false); events.push("end");
    }
    return events;
  }
  close(cut) {
    const c = this.current; this.current = null;
    if (!c) return null;
    c.duration = c.elapsed + FRAME_STEP; c.end = c.onset + c.duration; c.cut = cut;
    const byModel = c.flagged ? "Flagged" : c.score !== null ? "Below threshold" :
      cut ? "Session ended" : this.hasModel ? "Reopened early" : "No model";
    c.decision = c.long ? (c.flagged ? "Flagged · long closure" : "Long closure") : byModel;
    this.done.push(c);
    return c;
  }
  // Completed closures plus the one in progress (with its provisional end), for plotting.
  list() {
    const c = this.current;
    return c ? [...this.done, {...c, duration:c.elapsed + FRAME_STEP, end:c.onset + c.elapsed + FRAME_STEP}] : this.done;
  }
  count() {return this.done.length + (this.current ? 1 : 0);}
}
let log = new SessionLog();
let previewCache = {model:undefined, closures:[]};
function previewClosures() {
  if (previewCache.model !== model) {
    const m = new EventMonitor(model), l = new SessionLog();
    for (const [t, ear, mar] of previewRows) l.update(t, m.step(t, ear, mar), model);
    previewCache = {model, closures:l.list()};
  }
  return previewCache.closures;
}
const clock = seconds => {
  const s = Math.max(0, Math.floor(seconds));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};
function csvDownload(name, text) {
  const url = URL.createObjectURL(new Blob([text],{type:"text/csv;charset=utf-8"}));
  const link = document.createElement("a");link.href = url;link.download = name;link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
function announce(message) {$("sr-status").textContent = message;}
function updateHud(state, ear) {
  const phase = String(state.phase).toLowerCase(), current = log.current;
  const last = log.done[log.done.length - 1];
  $("hud-ear").textContent = "EAR " + (ear === null ? "—" : ear.toFixed(3));
  $("hud-count").textContent = "Closures " + log.count();
  $("hud-last").textContent = "Last " + (last ? last.duration.toFixed(2) + " s" : "—");
  let kind = "open", text = "EYES OPEN";
  if (phase === "closure" && current) {
    if (current.long) {kind = "flagged"; text = "LONG CLOSURE " + (current.elapsed + FRAME_STEP).toFixed(2) + " s";}
    else if (current.flagged) {kind = "flagged"; text = "FLAGGED CLOSURE";}
    else {kind = "closure"; text = "CLOSURE " + (current.elapsed + FRAME_STEP).toFixed(2) + " s";}
  } else if (phase === "tracking lost") {kind = "lost"; text = "TRACKING LOST";}
  else if (phase === "waiting") {kind = "lost"; text = "WAITING";}
  const banner = $("hud-banner");
  banner.hidden = false; banner.dataset.kind = kind; banner.textContent = text;
  stage.classList.toggle("flagged", kind === "flagged");
}
function resetHud() {
  $("hud-ear").textContent = "EAR —"; $("hud-count").textContent = "Closures 0"; $("hud-last").textContent = "Last —";
  $("hud-banner").hidden = true; stage.classList.remove("flagged");
}
function updateSummary() {
  const list = log.list(), t = log.t;
  const flagged = list.filter(c => c.flagged).length;
  const longest = list.reduce((m, c) => Math.max(m, c.duration), 0);
  $("sum-time").textContent = t.toFixed(1) + " s";
  $("sum-count").textContent = String(list.length);
  $("sum-flagged").textContent = model ? String(flagged) : "—";
  $("sum-long").textContent = String(list.filter(c => c.long).length);
  $("sum-closed").textContent = t > 0 ? (100 * Math.min(1, list.reduce((sum, c) => sum + c.duration, 0) / t)).toFixed(1) + " %" : "—";
  $("sum-longest").textContent = list.length ? longest.toFixed(2) + " s" : "—";
  // A rate from a few seconds of data is meaningless, so wait for 5 s.
  $("sum-rate").textContent = t >= 5 ? (list.length / (t / 60)).toFixed(1) : "—";
  $("sum-lost").textContent = log.lost.toFixed(1) + " s";
}
function clearSummary() {
  for (const id of ["sum-time","sum-count","sum-flagged","sum-long","sum-closed","sum-longest","sum-rate","sum-lost"]) $(id).textContent = "—";
  renderLog();
}
function renderLog() {
  const body = $("log-body");
  body.replaceChildren();
  if (!log.done.length) {
    const row = body.insertRow(), cell = row.insertCell();
    cell.colSpan = 4; cell.className = "empty"; cell.textContent = "No closures yet.";
  }
  for (const c of [...log.done].reverse()) {
    const row = body.insertRow();
    row.insertCell().textContent = timestamp(c.onset);
    row.insertCell().textContent = c.duration.toFixed(2) + " s";
    row.insertCell().textContent = c.score === null ? "—" : c.score.toFixed(3);
    const decision = row.insertCell();
    decision.textContent = c.decision; if (c.flagged || c.long) decision.className = "flag";
  }
  $("download-events").disabled = !log.done.length;
}
function updateProgress() {
  if (source !== "file") return;
  const total = video.duration;
  if (!Number.isFinite(total) || total <= 0) return;
  const fraction = Math.min(1, video.currentTime / total);
  $("progress-fill").style.width = (fraction * 100).toFixed(1) + "%";
  $("progress").setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
  $("transport-info").textContent = fileName + " · " + clock(video.currentTime) + " / " + clock(total);
}

function timestamp(t) {
  const cs = Math.max(0, Math.round(t * 100));
  return String(Math.floor(cs / 6000)).padStart(2, "0") + ":" +
    String(Math.floor(cs / 100) % 60).padStart(2, "0") + "." + String(cs % 100).padStart(2, "0");
}
function notice(message = "") {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
function draw() {
  if (source === "example") drawEye($("illustration"), lastEar);
  const samples = showPreview ? previewRows : rows.slice(-130), until = showPreview ? 8 : now;
  drawTrace($("trace"), samples, until, {axis:false});
  drawClosures($("states"), samples, showPreview ? previewClosures() : log.list(), until);
}
function showStage(live = false) {
  const example = source === "example";
  $("illustration").hidden = !example;
  $("footage").hidden = !live;
  $("empty-state").hidden = example || live;
  stage.classList.toggle("mirror", live && source === "camera");
  if (!example) {
    $("empty-title").textContent = EMPTY_HELP[source][0];
    $("empty-help").textContent = EMPTY_HELP[source][1];
  }
  $("source-label").textContent = SOURCE_NAMES[source];
  $("pulse-readout").hidden = example;
  $("hud").hidden = !(example || live);
  $("progress").hidden = !(live && source === "file");
  if (!live) stage.classList.remove("flagged");
}
function idleMeasurements() {
  $("phase").textContent = "Ready";
  $("phase").className = "phase";
  $("phase-detail").textContent = source === "example" ?
    "Play the example to follow a short blink and a longer closure." :
    "The readout updates when a face is visible.";
  for (const id of ["ear", "mar", "score", "elapsed"]) $(id).textContent = "—";
  $("checkpoint-fill").style.width = "0";
  $("pulse-bpm").textContent = "—";
  $("pulse-status").textContent = "Experimental forehead estimate from a 30-second window. The eye classifier uses facial geometry.";
}
function clearTrace() {
  monitor = new EventMonitor(model);
  rows = []; now = 0; lastEar = .325; showPreview = false;
  scoredThisEvent = false;
  log = new SessionLog();
  resetHud(); clearSummary();
  $("progress-fill").style.width = "0"; $("progress").setAttribute("aria-valuenow", "0");
  $("timecode").textContent = timestamp(0);
  $("download").disabled = true;
  $("last-decision").hidden = true;
  idleMeasurements();
}
function readout(state, ear, mar) {
  const phase = String(state.phase).toLowerCase();
  const flagged = Boolean(model) && state.decision === "flagged";
  const long = phase === "closure" && Number.isFinite(state.elapsed) && state.elapsed >= LONG_CLOSURE - 1e-8;
  const labels = {open:"Eyes open", closure:"Closure in progress", "tracking lost":"Tracking lost", waiting:"Waiting"};
  $("phase").textContent = long ? "Long closure" : flagged && phase === "closure" ? "Flagged closure" : (labels[phase] || state.phase);
  $("phase").className = "phase" + (flagged || long ? " flagged" : phase === "open" ? " tracking" : "");
  let detail = "Tracking eye aperture between closures.";
  if (phase === "closure") {
    detail = model ? "Waiting for the model’s observation checkpoint." : "Timing this closure. Load a classifier for a model decision.";
    if (Number.isFinite(state.score)) detail = flagged ?
      "The score reached the model’s validation-selected threshold." : "The score is below the model’s selected threshold.";
    if (long) detail = "Eyes closed for at least " + LONG_CLOSURE.toFixed(2) + " s. This warning does not depend on the model.";
  } else if (phase === "tracking lost" || ear === null) {
    detail = "A valid eye and mouth measurement is required to continue.";
  } else if (phase === "waiting") {
    detail = "Collecting valid frames for the next event.";
  }
  $("phase-detail").textContent = detail;
  const elapsed = Number.isFinite(state.elapsed) ? state.elapsed : 0;
  $("elapsed").textContent = elapsed.toFixed(2) + " s";
  $("checkpoint-fill").style.width = Math.min(100, elapsed / .8 * 100) + "%";
  $("ear").textContent = ear === null ? "—" : ear.toFixed(3);
  $("mar").textContent = mar === null ? "—" : mar.toFixed(3);
  $("score").textContent = model && Number.isFinite(state.score) ? state.score.toFixed(3) : "—";
  if (phase !== "closure" || !Number.isFinite(state.score)) scoredThisEvent = false;
  if (!scoredThisEvent && model && phase === "closure" && Number.isFinite(state.score)) {
    scoredThisEvent = true;
    const when = Number.isFinite(state.horizon) ? state.horizon : elapsed;
    $("last-decision").hidden = false;
    $("last-decision").textContent = "Latest decision at " + timestamp(now) + " · " +
      (flagged ? "flagged" : "below threshold") + " · score " + state.score.toFixed(3) +
      " at " + when.toFixed(2) + " s.";
  }
}
function observe(t, ear, mar) {
  const state = monitor.step(t, ear, mar);
  rows.push([t, ear, mar]); now = t;
  const events = log.update(t, state, model);
  if (ear !== null) lastEar = ear;
  $("timecode").textContent = timestamp(t);
  $("download").disabled = false;
  readout(state, ear, mar);
  updateHud(state, ear); updateSummary(); updateProgress();
  if (events.includes("end")) renderLog();
  if (events.includes("flagged")) announce("Flagged closure at " + timestamp(log.current.onset) + ".");
  if (events.includes("long")) announce("Long closure at " + timestamp(log.current.onset) + ".");
  draw();
}
function releaseMedia() {
  if (animation !== null) cancelAnimationFrame(animation);
  animation = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.pause();
  video.srcObject = null;
  if (video.hasAttribute("src")) {video.removeAttribute("src"); video.load();}
  // A fresh element isolates stale 'ended', 'loadeddata' and decoder events.
  const next = video.cloneNode(false);
  video.replaceWith(next); video = next;
  quietInline(video);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  if (detector) detector.close();
  detector = null;
}
function finish(message = "") {
  const wasActive = active;
  generation++; active = false;
  releaseScreen(); syncCameraShortcut();
  if (log.current) {
    log.close(true); renderLog();
    updateHud({phase:"open"}, null); updateSummary();
  }
  if (wasActive && rows.length) {
    const flagged = log.done.filter(c => c.flagged).length, long = log.done.filter(c => c.long).length;
    announce("Session finished. " + log.done.length + " closures" + (model ? ", " + flagged + " flagged by the model" : "") + ", " + long + " long.");
  }
  releaseMedia(); showStage();
  startButton.disabled = loadingDefault; startButton.textContent = BUTTON_NAMES[source];
  stopButton.hidden = true;
  if (message) $("transport-info").textContent = message;
}
// Muted and inline are set as properties as well as attributes: an element made by cloneNode keeps
// the attributes but not the muted state, and iPhone only starts muted, inline video without a tap.
function quietInline(element) {
  element.muted = true; element.defaultMuted = true; element.playsInline = true;
  element.setAttribute("muted", ""); element.setAttribute("playsinline", "");
}
function syncCameraShortcut() {$("use-camera").hidden = source !== "example" || active;}
function selectSource(value) {
  finish(); source = value;
  clearTrace();
  showPreview = source === "example";
  startButton.textContent = BUTTON_NAMES[source];
  $("transport-info").textContent = {example:"Synthetic trace · 18 s",camera:"Camera permission required",file:"One face per video"}[source];
  $("trace-sub").textContent = showPreview ? "Preview of the first eight illustrative seconds" :
    "Eye aspect ratio and closure state over the last eight seconds";
  notice(); showStage(); draw(); syncCameraShortcut();
}
function drawOverlay(points, width, height) {
  const canvas = $("overlay");
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width; canvas.height = height;
  }
  const g = canvas.getContext("2d");
  g.clearRect(0,0,width,height);
  if (!points) return;
  g.lineWidth = Math.max(1.3, width / 700);
  g.strokeStyle = "#c4ff89";g.fillStyle = "#e0ffb5";
  for (const eye of OUTLINES) {
    g.beginPath();
    eye.forEach((id,i) => {
      const {x,y} = points[id];
      if (i) g.lineTo(x * width, y * height);
      else g.moveTo(x * width, y * height);
    });
    g.closePath();g.stroke();
  }
  for (const id of MOUTH_POINTS) {
    const {x,y} = points[id];g.beginPath();
    g.arc(x * width, y * height, Math.max(1.4, width / 480), 0, Math.PI*2);g.fill();
  }
}
async function visionRuntime() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const {FilesetResolver, FaceLandmarker} = await import(SDK + "/vision_bundle.mjs");
      const fileset = await FilesetResolver.forVisionTasks(SDK + "/wasm");
      return {FaceLandmarker, fileset};
    })().catch(error => {visionPromise = null; throw error;});
  }
  return visionPromise;
}
function exampleLoop(id) {
  const start = performance.now();
  let i = 0;
  function tick(clock) {
    if (id !== generation) return;
    const t = Math.min(EXAMPLE_SECONDS, (clock - start) / 1000);
    while (i / 10 <= t) {
      observe(i / 10, ...exampleRatios(i / 10)); i++;
    }
    if (t >= EXAMPLE_SECONDS) finish("Example complete");
    else animation = requestAnimationFrame(tick);
  }
  animation = requestAnimationFrame(tick);
}
function trackVideo(id) {
  const element = video;
  const pulse = new ForeheadPulse();
  let pulseFace = null, faceTime = -Infinity;
  let nextTime = 0, firstTime = null, lastTime = -1;
  function schedule() {
    if (id !== generation) return;
    if (element.requestVideoFrameCallback) element.requestVideoFrameCallback((now,meta) => tick(frameClock(now,meta)));
    else animation = requestAnimationFrame(now => tick(frameClock(now,null)));
  }
  // Seconds on a clock that always moves forward. A live camera uses the wall clock: iPhone Safari
  // reports a frame timestamp for camera streams that does not advance, which froze tracking on the
  // first frame. A file uses the frame's own timestamp, or the playback position if that stalls.
  function frameClock(now, meta) {
    if (source === "camera") return now / 1000;
    return meta && meta.mediaTime > lastTime ? meta.mediaTime : element.currentTime;
  }
  function tick(mediaTime) {
    if (id !== generation || element.ended) return;
    if (element.readyState >= 2 && mediaTime > lastTime) {
      if (firstTime === null) firstTime = source === "camera" ? mediaTime : 0;
      const t = Math.max(0, mediaTime - firstTime);
      if (t + .0005 >= nextTime) {
        try {
          const face = detector.detectForVideo(element, mediaTime * 1000).faceLandmarks[0];
          const w = element.videoWidth, h = element.videoHeight;
          const [ear,mar] = faceRatios(face,w,h);
          pulseFace = ear === null ? null : face;
          faceTime = t;
          drawOverlay(ear === null ? null : face, w, h);
          observe(t,ear,mar);
        } catch (error) {
          finish("Tracking stopped");notice("Face tracking failed. " + error.message);return;
        }
        nextTime = (Math.floor((t + .0005) * 10) + 1) / 10;
      }
      try {
        const estimate = pulse.step(t, element, t - faceTime <= .15 ? pulseFace : null);
        $("pulse-bpm").textContent = Number.isFinite(estimate.bpm) ? Math.round(estimate.bpm) + " bpm" : "—";
        $("pulse-status").textContent = estimate.status;
      } catch {
        pulse.reset("Forehead sampling unavailable");
        $("pulse-bpm").textContent = "—";
        $("pulse-status").textContent = "Forehead sampling unavailable";
      }
      lastTime = mediaTime;
    }
    schedule();
  }
  schedule();
}
async function start(file = null) {
  finish();
  const id = generation;
  clearTrace(); notice(); draw(); active = true;
  holdScreen(); syncCameraShortcut();
  $("trace-sub").textContent = "Eye aspect ratio and closure state over the last eight seconds";
  fileName = file ? file.name : "";
  startButton.disabled = true;
  stopButton.hidden = false;
  if (source === "example") {
    startButton.textContent = "Playing example";
    $("transport-info").textContent = "Synthetic trace · 18 s";
    exampleLoop(id);
    return;
  }
  startButton.textContent = "Loading…";
  let stageName = "landmark tracker";
  try {
    if (source === "camera") {
      stageName = "camera";
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Open this page over HTTPS or on localhost in a camera-enabled browser.");
      $("transport-info").textContent = "Requesting camera permission";
      const capture = await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:640},height:{ideal:480}},audio:false});
      if (id !== generation) {capture.getTracks().forEach(track => track.stop());return;}
      stream = capture; video.srcObject = capture;
      capture.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (id === generation) finish("Camera disconnected");
      }, {once:true});
    } else {
      objectUrl = URL.createObjectURL(file); video.src = objectUrl;
    }
    stageName = "landmark tracker";
    $("transport-info").textContent = "Loading landmark tracker";
    const {FaceLandmarker,fileset} = await visionRuntime();
    if (id !== generation) return;
    const tracker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions:{modelAssetPath:MODEL,delegate:"CPU"},
      runningMode:"VIDEO",numFaces:1,outputFaceBlendshapes:false,outputFacialTransformationMatrixes:false
    });
    if (id !== generation) {tracker.close();return;}
    detector = tracker;
    stageName = "video playback";
    const element = video;
    video.addEventListener("ended", () => {
      if (id !== generation) return;
      const total = element.duration;
      finish("Video complete" + (Number.isFinite(total) ? " · " + clock(total) : ""));
    },{once:true});
    video.addEventListener("error", () => {
      if (id === generation) {finish("Video could not play");notice("Try an MP4 or WebM file supported by this browser.");}
    },{once:true});
    quietInline(video);
    showStage(true);   // visible before playback starts: iPhone does not decode a hidden video
    await video.play();
    if (id !== generation) return;
    startButton.textContent = source === "camera" ? "Camera active" : "Playing video";
    $("transport-info").textContent = source === "camera" ? "Live capture · target 10 Hz" :
      file.name + " · 00:00 / " + (Number.isFinite(video.duration) ? clock(video.duration) : "--:--");
    trackVideo(id);
  } catch (error) {
    if (generation !== id) return;
    finish("Session could not start");
    const reason = {NotAllowedError:"Permission was declined. Allow camera access and try again.",
      NotFoundError:"No available camera was found.",NotReadableError:"The camera is busy or unavailable."}[error.name];
    notice(reason || ("Unable to start " + stageName + ". " + error.message));
  }
}
function applyModel(data, label) {
  const checked = new EventMonitor(data);
  if (active) finish("Model changed · restart capture");
  model = data;
  clearTrace(); monitor = checked; draw();
  $("model-name").textContent = label;
  $("model-description").textContent = model ?
    model.family + " · " + (model.horizon_ticks / 10).toFixed(2) + " s checkpoint · threshold " +
      model.threshold.toFixed(3) + ". Scores apply to ongoing closures." :
    "Load a model exported by the study notebook to see its decision and score.";
  $("unload-model").hidden = !customModel;
}
async function loadDefault() {
  try {
    // AbortSignal.timeout is missing before iOS 16, so the ten-second limit uses a plain controller.
    const limit = new AbortController(), timer = setTimeout(() => limit.abort(), 10000);
    const response = await fetch("./model.json",{cache:"no-cache",signal:limit.signal}).finally(() => clearTimeout(timer));
    if (!response.ok) return;
    const data = await response.json();
    new EventMonitor(data);
    defaultModel = data;
    if (!customModel && !active && !rows.length) {
      applyModel(data,"Development model");
      selectSource(source);
    }
  } catch (error) {
    console.info("Development model unavailable", error.message);
  }
}
document.querySelectorAll('input[name="source"]').forEach(input => {
  input.addEventListener("change", () => {if (input.checked) selectSource(input.value);});
});
startButton.addEventListener("click", () => {
  if (source === "file") $("video-file").click();
  else start();
});
stopButton.addEventListener("click", () => {finish("Session stopped"); syncCameraShortcut();});
$("use-camera").addEventListener("click", () => {
  document.querySelector('input[name="source"][value="camera"]').checked = true;
  selectSource("camera"); start();
});
$("video-file").addEventListener("change", event => {
  const file = event.target.files[0];event.target.value = "";
  if (file) start(file);
});
$("load-model").addEventListener("click", () => $("model-file").click());
$("model-file").addEventListener("change", async event => {
  const file = event.target.files[0];event.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    new EventMonitor(data);
    customModel = true; applyModel(data, file.name);
    $("model-status").hidden = true;
    selectSource(source);
  } catch (error) {
    $("model-status").hidden = false;
    $("model-status").textContent = "Could not use this model. " + error.message;
  }
});
$("unload-model").addEventListener("click", () => {
  customModel = false; applyModel(defaultModel, defaultModel ? "Development model" : "Timing preview");
  $("model-status").hidden = true; selectSource(source);
});
$("download").addEventListener("click", () => {
  if (!rows.length) return;
  const csv = "t,ear,mar,source\r\n" + rows.map(([t,ear,mar]) =>
    [t.toFixed(4), ear ?? "", mar ?? "", source === "example" ? "synthetic_example" : source].join(",")).join("\r\n") + "\r\n";
  csvDownload("blink-study-" + source + ".csv", csv);
});
// Closure log. Duration = last closed-frame elapsed + 0.1 s (see SessionLog).
$("download-events").addEventListener("click", () => {
  if (!log.done.length) return;
  const label = source === "example" ? "synthetic_example" : source;
  const csv = "onset_s,duration_s,checkpoint_s,score,decision,source\r\n" + log.done.map(c =>
    [c.onset.toFixed(3), c.duration.toFixed(3), c.checkpoint === null ? "" : c.checkpoint.toFixed(3),
     c.score === null ? "" : c.score.toFixed(4), c.decision, label].join(",")).join("\r\n") + "\r\n";
  csvDownload("blink-study-events-" + source + ".csv", csv);
});
window.addEventListener("pagehide", () => finish());
new ResizeObserver(draw).observe(document.querySelector(".workspace"));
selectSource("example");
loadDefault().finally(() => {loadingDefault = false; if (!active) startButton.disabled = false;});
