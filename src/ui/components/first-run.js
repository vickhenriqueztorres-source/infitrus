import { ES } from "../i18n/es.js";

export const ONBOARDING_KEY = "ifx_onboarding_v1";

export function readOnboardingState() {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.storage?.local) return resolve(true);
    chrome.storage.local.get([ONBOARDING_KEY], (result) => resolve(Boolean(result?.[ONBOARDING_KEY])));
  });
}

export function completeOnboarding() {
  if (!globalThis.chrome?.storage?.local) return Promise.resolve();
  return chrome.storage.local.set({ [ONBOARDING_KEY]: true });
}

export function onboardingMarkup(step = 0) {
  const steps = [ES.onboarding1, ES.onboarding2, ES.onboarding3];
  const isLast = step >= steps.length - 1;
  return `<div class="ifx-onboarding" role="dialog" aria-modal="true" aria-label="Primer uso">
    <div class="ifx-onboarding-progress" aria-hidden="true">${steps.map((_, index) => `<span class="${index === step ? "is-active" : ""}"></span>`).join("")}</div>
    <div class="ifx-onboarding-number">0${Math.min(step + 1, 3)}</div>
    <h2>${steps[Math.min(step, 2)]}</h2>
    ${isLast ? `<p>${ES.legal}</p>` : ""}
    <button type="button" class="ifx-primary" data-action="onboarding-next">${isLast ? ES.understood : "Continuar"}</button>
  </div>`;
}
