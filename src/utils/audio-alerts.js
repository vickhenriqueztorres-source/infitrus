/**
 * audio-alerts.js - Gerenciador de Alertas Sonoros Sintetizados
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Gerar áudio nativo de alta qualidade e baixa latência via Web Audio API.
 * - Eliminar necessidade de arquivos .mp3 externos ou conexões de rede (100% offline).
 * - Imune a bloqueios de CSP (Content Security Policy) das páginas de corretoras.
 * - Oferecer timbres harmônicos agradáveis e diferenciados para CALL e PUT.
 * - Fornecer bips de contagem regressiva sutil para a virada de vela (3, 2, 1, 0).
 * - Gerenciar estado de ativação / mudo com persistência em chrome.storage.local.
 */

export class AudioAlertManager {
  constructor() {
    this.audioCtx = null;
    this.isEnabled = true;
    this.volume = 0.60;
    this._unlocked = false;

    this._loadSettings();
    this._setupAutoUnlock();
  }

  /**
   * Carrega preferências de som salvas no chrome.storage ou localStorage.
   */
  async _loadSettings() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.get(["oracle_sound_enabled", "oracle_sound_volume"], (res) => {
          if (res.oracle_sound_enabled !== undefined) {
            this.isEnabled = Boolean(res.oracle_sound_enabled);
          }
          if (res.oracle_sound_volume !== undefined) {
            this.volume = Number(res.oracle_sound_volume);
          }
        });
      } else if (typeof localStorage !== "undefined") {
        const saved = localStorage.getItem("oracle_sound_enabled");
        if (saved !== null) {
          this.isEnabled = saved === "true";
        }
      }
    } catch (_) {}
  }

  /**
   * Desbloqueia o AudioContext na primeira interação do usuário na página.
   */
  _setupAutoUnlock() {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const unlock = () => {
      if (!this._unlocked) {
        this._ensureContext();
        if (this.audioCtx && this.audioCtx.state === "suspended") {
          this.audioCtx.resume().then(() => {
            this._unlocked = true;
          }).catch(() => {});
        } else {
          this._unlocked = true;
        }
      }
      document.removeEventListener("click", unlock);
      document.removeEventListener("keydown", unlock);
    };

    document.addEventListener("click", unlock, { once: true, passive: true });
    document.addEventListener("keydown", unlock, { once: true, passive: true });
  }

  /**
   * Inicializa de forma preguiçosa o AudioContext quando necessário.
   */
  _ensureContext() {
    if (this.audioCtx) return this.audioCtx;
    if (typeof window === "undefined") return null;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    try {
      this.audioCtx = new AudioContextClass();
    } catch (_) {
      this.audioCtx = null;
    }
    return this.audioCtx;
  }

  /**
   * Alterna estado de mudo / som ativado.
   * @returns {boolean} Novo estado
   */
  toggleSound() {
    this.isEnabled = !this.isEnabled;
    this._saveSettings();
    return this.isEnabled;
  }

  /**
   * Define explicitamente se o som está ativado.
   * @param {boolean} enabled
   */
  setSoundEnabled(enabled) {
    this.isEnabled = Boolean(enabled);
    this._saveSettings();
  }

  isSoundEnabled() {
    return this.isEnabled;
  }

  _saveSettings() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.set({
          oracle_sound_enabled: this.isEnabled,
          oracle_sound_volume: this.volume,
        });
      } else if (typeof localStorage !== "undefined") {
        localStorage.setItem("oracle_sound_enabled", String(this.isEnabled));
      }
    } catch (_) {}
  }

  /** Toca la firma sonora corta de señal: dos pulsos ascendentes tipo sonar. */
  playSignalAlert() {
    if (!this.isEnabled) return;
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    this._playTone(880, now, 0.11, "sine", this.volume * 0.34);
    this._playTone(1320, now + 0.13, 0.11, "sine", this.volume * 0.38);
  }

  playCallAlert() {
    this.playSignalAlert();
  }

  playPutAlert() {
    this.playSignalAlert();
  }

  /**
   * Toca um bip sutil de contagem regressiva para a virada de vela.
   * @param {number} secondsRemaining - Segundos restantes (3, 2, 1, 0)
   */
  playCountdownPip(secondsRemaining) {
    if (!this.isEnabled) return;
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    if (secondsRemaining > 0) {
      // Bip curto e discreto nos segundos 3, 2, 1 (880 Hz, 30ms)
      this._playTone(880, now, 0.04, "sine", this.volume * 0.4);
    } else {
      // Sinal de entrada no segundo 0 (dois tons rápidos e agudos: 1046 Hz e 1318 Hz)
      this._playTone(1046.5, now, 0.06, "sine", this.volume * 0.8);
      this._playTone(1318.5, now + 0.07, 0.12, "sine", this.volume * 0.9);
    }
  }

  /**
   * Toca um único tom sintetizado com envelope de ataque e decaimento exponencial.
   */
  _playTone(freq, startTime, duration, type = "sine", gainVal = 0.2) {
    try {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, startTime);

      // Envelope ADSR suave (evita estalos/clicks de áudio)
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainVal), startTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(startTime);
      osc.stop(startTime + duration + 0.02);
    } catch (_) {}
  }
}

export const audioAlertManager = new AudioAlertManager();
