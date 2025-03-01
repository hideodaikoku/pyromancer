const ctx = canvas.getContext("2d");
let isArpeggiating = false;
let arpCounter = 0;
let lastArpTime = 0;
const ARP_INTERVAL = 200;
const ARP_PATTERN = [-12, -8, -5, 0, 4, 7, 12, 7, 4, 0, -5, -8];
let audioCtx;
let oscillators = [];
let gainNodes = [];
let reverb;
let reverbGain;
let lfo;
let lfoGain;
let envelopeGain;
let isPlaying = false;
const ATTACK_TIME = 0.5; // seconds
const RELEASE_TIME = 0.8; // seconds

const SQUARE_SIZE = 200;
const FONT_SIZE = 20;
const MAX_HARMONICS = 7;
const BASE_FREQUENCY = 65.41; // C4 as base frequency
const PITCH_RANGE = 2; // 2 octaves range
let lastFrame = Date.now();
let rayStarts = []; // To track individual rays

let hands, camera;
let handPositions = { left: null, right: null };

class ThereminVoice {
  constructor(ctx, destination) {
    this.osc = ctx.createOscillator();
    this.gain = ctx.createGain();
    this.osc.type = "sawtooth";
    this.osc.connect(this.gain);
    this.gain.connect(destination);
    this.osc.start();
    this.gain.gain.setValueAtTime(0, 0);
  }

  setFrequency(freq, time) {
    // Smooth pitch transitions
    this.osc.frequency.setTargetAtTime(freq, time, 0.03);
  }

  setGain(value, time) {
    this.gain.gain.setTargetAtTime(value, time, 0.01);
  }
}

async function createReverb() {
  const duration = 3;
  const decay = 2;
  const sampleRate = audioCtx.sampleRate;
  const length = sampleRate * duration;
  const impulse = audioCtx.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const channelData = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      channelData[i] =
        (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }

  reverb = audioCtx.createConvolver();
  reverb.buffer = impulse;

  reverbGain = audioCtx.createGain();
  reverbGain.gain.setValueAtTime(0, 0);

  reverb.connect(reverbGain);
  reverbGain.connect(audioCtx.destination);
}

async function initAudio() {
  audioCtx = new AudioContext();

  await createReverb();

  // Create envelope gain stage
  envelopeGain = audioCtx.createGain();
  envelopeGain.gain.setValueAtTime(0, 0);

  // Create LFO for vibrato
  lfo = audioCtx.createOscillator();
  lfoGain = audioCtx.createGain();
  lfoGain.gain.setValueAtTime(0, 0);
  lfo.connect(lfoGain);
  lfo.start();

  // Create voices (1 main + harmonics)
  const masterGain = audioCtx.createGain();
  masterGain.connect(envelopeGain);

  // Connect envelope to both reverb and destination
  envelopeGain.connect(audioCtx.destination);
  envelopeGain.connect(reverb);
  reverbGain.connect(audioCtx.destination);

  for (let i = 0; i < MAX_HARMONICS; i++) {
    const voice = new ThereminVoice(audioCtx, masterGain);
    oscillators.push(voice.osc);
    gainNodes.push(voice.gain);
    lfoGain.connect(voice.osc.frequency);
  }
}
function updateAudio(blueX, blueY, pinkX, pinkY) {
  if (!audioCtx) return;

  const now = audioCtx.currentTime;

  // Calculate the actual note frequency based on Y position
  const startOctave = 2;
  const endOctave = 4;
  const totalOctaves = endOctave - startOctave + 1;

  // Calculate continuous pitch instead of discrete notes
  const semitoneOffset = (1 - blueY) * (totalOctaves * 12);
  let pitchMultiplier = Math.pow(2, semitoneOffset / 12);

  // Apply arpeggiator if active
  if (isArpeggiating) {
    const currentTime = Date.now();
    if (currentTime - lastArpTime >= ARP_INTERVAL) {
      arpCounter = (arpCounter + 1) % ARP_PATTERN.length;
      lastArpTime = currentTime;
    }
    const semitoneShift = ARP_PATTERN[arpCounter];
    pitchMultiplier *= Math.pow(2, semitoneShift / 12);
  }

  const baseFreq = 261.63 * pitchMultiplier;

  // Rest of audio updates
  const reverbAmount = blueX;
  reverbGain.gain.setTargetAtTime(reverbAmount * 0.7, now, 0.1);

  const vibratoFreq = 1 + (1 - pinkX) * 4;
  const vibratoDepth = (1 - pinkX) * 20;
  lfo.frequency.setTargetAtTime(vibratoFreq, now, 0.1);
  lfoGain.gain.setTargetAtTime(vibratoDepth, now, 0.1);

  const activeHarmonics = 1 + Math.floor((1 - pinkY) * (MAX_HARMONICS - 1));

  for (let i = 0; i < MAX_HARMONICS; i++) {
    const active = i < activeHarmonics;
    const freq = baseFreq * (i + 1);
    const gainValue = active ? 0.3 / Math.sqrt(i + 1) : 0;

    oscillators[i].frequency.setTargetAtTime(freq, now, 0.03);
    gainNodes[i].gain.setTargetAtTime(gainValue, now, 0.01);
  }
}

function isHandFist(landmarks) {
  const fingerTips = [8, 12, 16, 20];
  const fingerBases = [5, 9, 13, 17];
  const palm = landmarks[0];

  return fingerTips.every((tip, index) => {
    const tipPoint = landmarks[tip];
    const basePoint = landmarks[fingerBases[index]];

    const tipToPalmDist = Math.hypot(tipPoint.x - palm.x, tipPoint.y - palm.y);
    const baseToPalmDist = Math.hypot(
      basePoint.x - palm.x,
      basePoint.y - palm.y
    );

    return tipToPalmDist < baseToPalmDist;
  });
}

function onResults(results) {
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
  ctx.restore();
  drawPitchMarkers();

  const handsPresent =
    results.multiHandLandmarks && results.multiHandLandmarks.length >= 2;

  // Handle envelope
  if (handsPresent && !isPlaying) {
    // Start attack
    const now = audioCtx.currentTime;
    envelopeGain.gain.cancelScheduledValues(now);
    envelopeGain.gain.setValueAtTime(envelopeGain.gain.value, now);
    envelopeGain.gain.linearRampToValueAtTime(1, now + ATTACK_TIME);
    isPlaying = true;
  } else if (!handsPresent && isPlaying) {
    // Start release
    const now = audioCtx.currentTime;
    envelopeGain.gain.cancelScheduledValues(now);
    envelopeGain.gain.setValueAtTime(envelopeGain.gain.value, now);
    envelopeGain.gain.linearRampToValueAtTime(0, now + RELEASE_TIME);
    isPlaying = false;
  }

  if (results.multiHandLandmarks) {
    for (const [idx, landmarks] of results.multiHandLandmarks.entries()) {
      const handedness = results.multiHandedness[idx].label;
      if (handedness === "Left") {
        isArpeggiating = isHandFist(landmarks);
      }
      const palmPos = landmarks[9];

      const x = (1 - palmPos.x) * canvas.width;
      const y = palmPos.y * canvas.height;
      const normalizedX = 1 - palmPos.x;
      const normalizedY = palmPos.y;

      if (handedness === "Left") {
        handPositions.left = { x: normalizedX, y: normalizedY };
        drawCrosshair(x, y, true, {
          pitch: Math.round((1 - normalizedY) * 100),
          reverb: Math.round(normalizedX * 100),
        });
      } else {
        handPositions.right = { x: normalizedX, y: normalizedY };
        drawCrosshair(x, y, false, {
          vibrato: Math.round((1 - normalizedX) * 100), // Inverted to match actual control
          harmonics: 1 + Math.floor((1 - normalizedY) * (MAX_HARMONICS - 1)), // Inverted to match actual control
        });
      }

      if (handPositions.left && handPositions.right) {
        updateAudio(
          handPositions.left.x,
          handPositions.left.y,
          handPositions.right.x,
          handPositions.right.y
        );
      }
    }
  }

  // Clear hand positions if hands are not present
  if (!handsPresent) {
    handPositions.left = null;
    handPositions.right = null;
    rayStarts = []; // Clear all rays when hands are removed
  }
}

function getNoteFromY(y) {
  const notes = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
  ];
  const startOctave = 2; // Starting from C2 (bottom of screen)
  const endOctave = 4; // Ending at C4 (top of screen)
  const totalOctaves = endOctave - startOctave + 1;
  const totalNotes = totalOctaves * 12;

  const noteIndex = Math.floor(y * (totalNotes - 1));
  const octave = startOctave + Math.floor(noteIndex / 12);
  const note = notes[noteIndex % 12];

  return `${note}${octave}`;
}

function drawCrosshair(x, y, isLeftHand, values) {
  const baseSize = 100;
  const now = Date.now();
  const deltaTime = (now - lastFrame) / 1000; // Time since last frame in seconds
  lastFrame = now;

  ctx.save();

  // Calculate normalized Y value (0-1, where 1 is top of screen)
  const normalizedY = isLeftHand
    ? values.pitch / 100
    : (values.harmonics - 1) / (MAX_HARMONICS - 1);

  // Size increases with height
  const sizeMultiplier = 1 + normalizedY * 5;
  const SIZE = baseSize * sizeMultiplier;

  // Ray animation parameters
  const baseRaySpeed = 200; // Base pixels per second
  const maxRaySpeed = 800; // Max pixels per second
  const raySpeed = baseRaySpeed + normalizedY * (maxRaySpeed - baseRaySpeed);
  const raySpawnRate = 0.5 + normalizedY * 1.5; // Rays per frame, increases with height

  // Spawn new rays based on Y value
  if (Math.random() < raySpawnRate) {
    const angle = Math.random() * Math.PI * 2;
    rayStarts.push({
      x: x,
      y: y,
      angle: angle,
      distance: 0,
      isLeftHand: isLeftHand,
    });
  }

  // Update and draw rays
  rayStarts = rayStarts.filter((ray) => {
    // Update ray distance for all rays
    ray.distance += raySpeed * deltaTime;

    // Skip drawing but keep rays from other hand
    if (ray.isLeftHand !== isLeftHand) return true;

    // Update the ray's position to current crosshair position
    ray.x = x;
    ray.y = y;

    const alpha = Math.max(0, 1 - ray.distance / (SIZE * 4));
    if (alpha <= 0) return false;

    ctx.beginPath();
    ctx.strokeStyle = `rgba(255, 100, 0, ${alpha})`;
    ctx.lineWidth = 2;

    const startDist = Math.max(0, ray.distance - 100);
    const endDist = ray.distance;

    ctx.moveTo(
      ray.x + Math.cos(ray.angle) * startDist,
      ray.y + Math.sin(ray.angle) * startDist
    );
    ctx.lineTo(
      ray.x + Math.cos(ray.angle) * endDist,
      ray.y + Math.sin(ray.angle) * endDist
    );
    ctx.stroke();

    return ray.distance < SIZE * 2;
  });

  // Draw main crosshair
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 2;

  // Draw vertical line
  ctx.beginPath();
  ctx.moveTo(x, y - SIZE);
  ctx.lineTo(x, y + SIZE);
  ctx.stroke();

  // Draw horizontal line
  ctx.beginPath();
  ctx.moveTo(x - SIZE, y);
  ctx.lineTo(x + SIZE, y);
  ctx.stroke();

  // Draw diagonal lines
  ctx.beginPath();
  ctx.moveTo(x - SIZE / 1.4, y - SIZE / 1.4);
  ctx.lineTo(x + SIZE / 1.4, y + SIZE / 1.4);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x - SIZE / 1.4, y + SIZE / 1.4);
  ctx.lineTo(x + SIZE / 1.4, y - SIZE / 1.4);
  ctx.stroke();

   // Draw a circle
   ctx.beginPath();
   ctx.strokeStyle = "rgb(255,255,255,0.5)"; // Maintain the original stroke color
   ctx.arc(x, y, SIZE/3, Math.PI/2, Math.PI * 2);
   ctx.stroke();

  // Add text
  ctx.fillStyle = "white";
  ctx.font = `${FONT_SIZE}px -apple-system, BlinkMacSystemFont, system-ui`;
  ctx.textBaseline = "middle";

  const TEXT_OFFSET = SIZE + 20;

  if (isLeftHand) {
    ctx.textAlign = "right";
    ctx.fillText(
      `note ${getNoteFromY(values.pitch / 100)}`,
      x - TEXT_OFFSET,
      y - FONT_SIZE / 2
    );
    ctx.fillText(
      `reverb ${values.reverb}`,
      x - TEXT_OFFSET,
      y + FONT_SIZE / 2
    );
  } else {
    ctx.textAlign = "left";
    ctx.fillText(`vib ${values.vibrato}`, x + TEXT_OFFSET, y - FONT_SIZE / 2);
    ctx.fillText(
      `Harmonics: ${values.harmonics}`,
      x + TEXT_OFFSET,
      y + FONT_SIZE / 2
    );
  }

  ctx.restore();
}

function drawPitchMarkers() {
  const notes = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
  ];
  const startOctave = 2; // Starting from C2 (bottom of screen)
  const endOctave = 4; // Ending at C4 (top of screen)

  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.font = "14px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  const totalOctaves = endOctave - startOctave + 1;
  const totalNotes = totalOctaves * 12;

  // Draw each note marker
  for (let i = 0; i < totalNotes; i++) {
    const noteIndex = i % 12;
    const octave = startOctave + Math.floor(i / 12);
    const noteName = `${notes[noteIndex]}${octave}`;

    const normalizedY = (totalNotes - 1 - i) / (totalNotes - 1);
    const yPos = normalizedY * canvas.height;
    const rightEdge = canvas.width - 10; // 10px from right edge

    // Draw marker line
    ctx.beginPath();
    ctx.moveTo(rightEdge - 30, yPos);
    ctx.lineTo(rightEdge, yPos);
    ctx.strokeStyle =
      noteIndex === 0 ? "rgba(255, 255, 255, 0.8)" : "rgba(255, 255, 255, 0.4)";
    ctx.stroke();

    // Draw note name
    ctx.fillText(noteName, rightEdge - 35, yPos);
  }
  ctx.restore();
}

async function init() {
  animateLogo();

  hands = new Hands({
    locateFile: (file) => {
      return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    },
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  hands.onResults(onResults);

  camera = new Camera(video, {
    onFrame: async () => {
      await hands.send({ image: video });
    },
    width: 1280,
    height: 720,
  });

  await camera.start();
  await initAudio();
}

function animateLogo() {
  document.querySelector(".logo-container").classList.add("moved");
  document.querySelector(".background-image").classList.add("hidden");
}

document.onclick = () => {
  if (!audioCtx) init();
};

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.onresize = resizeCanvas;
resizeCanvas();
