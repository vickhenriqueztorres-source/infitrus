/**
 * sound.js - Utilitário de som legado (desativado fora do sidepanel)
 * O áudio é gerenciado exclusivamente pelo Side Panel da respectiva janela.
 */
export const inflitrusSound = Object.freeze({
  signal() {
    return false;
  },
  blocked() {
    return false;
  },
  connected() {
    return false;
  },
});
