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

  /**
   * Alerta sonoro de Pré-Sinal CALL (Compra / Alta).
   * Tríade maior ascendente harmoniosa e brilhante: Dó 5 (523.25 Hz) -> Mi 5 (659.25 Hz) -> Sol 5 (783.99 Hz).
   */
  playCallAlert() {
    if (!this.isEnabled) return;
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    this._playTone(523.25, now, 0.08, "sine", this.volume * 0.45);
    this._playTone(659.25, now + 0.09, 0.08, "sine", this.volume * 0.50);
    this._playTone(783.99, now + 0.18, 0.16, "sine", this.volume * 0.55);
  }

  /**
   * Alerta sonoro de Pré-Sinal PUT (Venda / Baixa).
   * Tríade menor descendente encorpada e firme: Sol 5 (783.99 Hz) -> Mi bemol 5 (622.25 Hz) -> Dó 5 (523.25 Hz).
   */
  playPutAlert() {
    if (!this.isEnabled) return;
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    this._playTone(783.99, now, 0.08, "sine", this.volume * 0.50);
    this._playTone(622.25, now + 0.09, 0.08, "sine", this.volume * 0.50);
    this._playTone(523.25, now + 0.18, 0.16, "sine", this.volume * 0.55);
  }

  /**
   * Alerta sonoro de EXECUÇÃO IMEDIATA (Segundo 00 - ENTRY_NOW).
   * Acorde duplo de impacto com ataque enérgico: C6 (1046.5 Hz) + G6 (1568 Hz) + confirmação C7 (2093 Hz).
   * Som de ação imperativo e inconfundível.
   */
  playEntryAlert() {
    if (!this.isEnabled) return;
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    // Impacto duplo simultâneo (C6 + G6)
    this._playTone(1046.5, now, 0.12, "sine", this.volume * 0.85);
    this._playTone(1567.98, now, 0.12, "triangle", this.volume * 0.70);
    // Ping agudo de confirmação (C7)
    this._playTone(2093.0, now + 0.09, 0.18, "sine", this.volume * 0.75);
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

    if (secondsRemaining > 0) {
      // Bip curto e discreto nos segundos 3, 2, 1 (sonar tick: 880 Hz, 35ms)
      const now = ctx.currentTime;
      this._playTone(880, now, 0.035, "sine", this.volume * 0.40);
    } else {
      // Segundo 0: executa alerta enérgico de entrada
      this.playEntryAlert();
    }
  }

  /**
   * Som de vitória (WIN). Fanfarra curta ascendente.
   */
  playWinAlert() {
    if (!this.isEnabled) return;
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    this._playTone(783.99, now, 0.08, "sine", this.volume * 0.45);
    this._playTone(1046.5, now + 0.08, 0.08, "sine", this.volume * 0.50);
    this._playTone(1318.5, now + 0.16, 0.22, "sine", this.volume * 0.55);
  }

  /**
   * Som de perda (LOSS). Dois tons discretos em decaimento.
   */
  playLossAlert() {
    if (!this.isEnabled) return;
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    this._playTone(392.0, now, 0.10, "sine", this.volume * 0.35);
    this._playTone(329.63, now + 0.11, 0.18, "sine", this.volume * 0.35);
  }

  /**
   * Som de empate (DOJI).
   */
  playDojiAlert() {
    if (!this.isEnabled) return;
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    this._playTone(440.0, now, 0.15, "sine", this.volume * 0.30);
  }

  /** Toca a firma sonora genérica de sinal (retrocompatibilidade) */
  playSignalAlert() {
    this.playCallAlert();
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
