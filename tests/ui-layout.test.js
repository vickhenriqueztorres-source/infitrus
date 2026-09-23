import test from "node:test";
import assert from "node:assert/strict";
import { expandedMarkup } from "../src/ui/components/layout.js";
import { createViewModel } from "../src/ui/view-model.js";

const preferences = {
  collapsed: false,
  soundEnabled: true,
  openTab: "system",
  settingsOpen: false,
  payoutOpen: false,
};

test("muestra los logs abiertos con el evento más reciente primero", () => {
  const vm = createViewModel({ state: "READY", wsStatus: "conectado" }, { remainingSeconds: 30, progressPct: 50 });
  const html = expandedMarkup(vm, preferences, [
    { id: "old", time: "10:00:00.000", tag: "SISTEMA", message: "Evento antiguo", level: "info" },
    { id: "new", time: "10:00:01.000", tag: "ERRO", message: "Evento reciente", level: "error" },
  ]);

  assert.match(html, />Logs</);
  assert.match(html, /role="log"/);
  assert.match(html, /class="is-error"/);
  assert.ok(html.indexOf("Evento reciente") < html.indexOf("Evento antiguo"));
});
