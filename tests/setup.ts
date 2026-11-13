// Obsidian code uses `window.setTimeout` for popout-window compatibility. Node has no `window`, so point it at the global object.
Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
