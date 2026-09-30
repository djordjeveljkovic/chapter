const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
export async function registerOffline(
  onUpdate: (registration: ServiceWorkerRegistration) => void,
): Promise<boolean> {
  if (!import.meta.env.PROD) return false;
  if (!window.isSecureContext)
    throw new Error(
      "Offline reading requires HTTPS. Open the deployed site over HTTPS, or use localhost for a local preview.",
    );
  if (!("serviceWorker" in navigator))
    throw new Error(
      "This browser cannot save the offline app. Use Android Chrome to download books for offline reading.",
    );
  const registration = await navigator.serviceWorker.register(`${base}sw.js`, {
    scope: base,
  });
  if (registration.waiting) onUpdate(registration);
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller)
        onUpdate(registration);
    });
  });
  await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "The offline app could not finish saving. Reconnect and reload to retry.",
            ),
          ),
        45000,
      ),
    ),
  ]);
  return true;
}

export async function verifyOfflineShell(): Promise<boolean> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return false;
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
  ]);
  if (!registration) return false;
  const worker = registration.active;
  if (!worker) return false;
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, 10000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data === true);
    };
    worker.postMessage({ type: "CHECK_OFFLINE" }, [channel.port2]);
  });
}
