// Char Triage: start-up. Publishes the API, the Alt+Shift+T panel shortcut,
// loads stored data, and resumes a scan that a reload interrupted.

CTRShare.install();
CTRUi.install();
marinara.onCleanup(() => CTRScan.stop());

try {
  await CTRStore.load();
  window.dispatchEvent(new CustomEvent("marinara-char-triage:changed"));
  const { scanning, connectionId } = CTRStore.settings;
  if (scanning && connectionId) {
    // Give Marinara a moment to finish its own start-up requests first.
    marinara.setTimeout(() => {
      void CTRScan.start().catch((error) => marinara.log.warn("Char Triage: could not resume the scan", error));
    }, 5000);
  }
} catch (error) {
  marinara.log.error("Char Triage failed to load", error);
}
