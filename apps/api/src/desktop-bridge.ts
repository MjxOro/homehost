import { DESKTOP_BRIDGE_CHANNEL } from "@homehost/shared";

/** Runs only inside the opaque guest. Offers input events, never panel APIs. */
export function desktopBridgeScript(origins: string[]) {
  return `(() => {
    const channel = ${JSON.stringify(DESKTOP_BRIDGE_CHANNEL)};
    const origins = ${JSON.stringify(origins)};
    // UI preferences only; the native Storage API remains unavailable.
    const settings = new Map();
    window.__homehostDesktopSettings = {
      getItem: key => settings.has(String(key)) ? settings.get(String(key)) : null,
      setItem: (key, value) => settings.set(String(key), String(value)),
      removeItem: key => settings.delete(String(key)),
    };
    let sending = false;
    const send = data => parent.postMessage({channel, ...data}, '*');
    const move = event => {
      const point = event.changedTouches ? event.changedTouches[0] : event;
      if (point) send({type:'pointer', x:point.clientX, y:point.clientY});
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('touchstart', move, true);
    document.addEventListener('touchmove', move, true);
    document.addEventListener('mouseleave', () => send({type:'leave'}), true);
    document.addEventListener('keydown', event => {
      if (!sending && event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); send({type:'release'});
      }
    }, true);
    window.addEventListener('message', event => {
      const data = event.data;
      if (event.source !== parent || !origins.includes(event.origin) || !data || data.channel !== channel) return;
      if (data.type === 'focus') {
        const canvas = document.querySelector('#noVNC_container canvas[tabindex]');
        if (canvas) canvas.focus();
        return;
      }
      if (data.type !== 'keys' || !Array.isArray(data.events) || data.events.length > 8) return;
      const target = document.querySelector('#noVNC_container canvas[tabindex]');
      if (!target) return;
      target.focus();
      sending = true;
      try {
        for (const key of data.events) {
          if (!['keydown','keyup'].includes(key.type) || typeof key.key !== 'string' || key.key.length > 32 || typeof key.code !== 'string' || key.code.length > 32) continue;
          target.dispatchEvent(new KeyboardEvent(key.type, {
            key:key.key,code:key.code,ctrlKey:!!key.ctrlKey,altKey:!!key.altKey,shiftKey:!!key.shiftKey,metaKey:!!key.metaKey,
            bubbles:true,cancelable:true,composed:true,
          }));
        }
      } finally { sending = false; }
    });
  })();`;
}
export function desktopHtml(html: string, prefix: string, origins: string[]) {
  const additions = `<base href="${prefix}"><script>${desktopBridgeScript(origins)}</script>`;
  return /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, (head) => head + additions)
    : html.replace(
        /<html\b[^>]*>/i,
        (root) => `${root}<head>${additions}</head>`,
      );
}

/** Kasm's shipped client assumes durable localStorage for UI preferences.
 * Fix those client calls without changing native storage or the sandbox. */
export function desktopJavascript(source: string, assetPath: string) {
  return assetPath.split("?")[0] === "dist/main.bundle.js"
    ? source.replace(
        /\b(?:window\.)?localStorage\.(getItem|setItem|removeItem)\(/g,
        "window.__homehostDesktopSettings.$1(",
      )
    : source;
}
