import { audioAlertManager } from "../utils/audio-alerts.js";

function tone(frequency, duration, volume = 0.6, type = "sine") {
  if (!audioAlertManager.isSoundEnabled()) return false;
  const context = audioAlertManager._ensureContext?.();
  if (!context || context.state === "suspended") return false;
  const start = context.currentTime;
  audioAlertManager._playTone?.(frequency, start, duration, type, volume * 0.22);
  return true;
}

export const inflitrusSound = Object.freeze({
  signal(direction = "CALL") {
    if (!audioAlertManager.isSoundEnabled()) return false;
    if (direction === "PUT") audioAlertManager.playPutAlert();
    else audioAlertManager.playCallAlert();
    return true;
  },
  blocked() {
    return tone(220, 0.18, 0.6, "sine");
  },
  connected() {
    if (!audioAlertManager.isSoundEnabled()) return false;
    const context = audioAlertManager._ensureContext?.();
    if (!context || context.state === "suspended") return false;
    const length = Math.max(1, Math.floor(context.sampleRate * 0.2));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) data[index] = (Math.random() * 2 - 1) * (1 - index / length);
    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.2);
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    return true;
  },
});
