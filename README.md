# Blink Study demo

A browser demo that watches eye closures as they develop. It reads a live camera or an uploaded video,
tracks the face with MediaPipe, and scores each closure 0.4 s after it starts with a small model trained on
manually reviewed events. A closure that lasts 0.85 s raises a separate warning that does not depend on the model.

Live page: https://la2o.github.io/blink-study-demo/

- Video is processed inside your browser. Nothing is uploaded or stored.
- The face tracker is downloaded from Google's MediaPipe servers on first use.
- Research demonstration only. Not a medical or safety device; do not use it while driving.
