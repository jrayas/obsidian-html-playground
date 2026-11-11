/**
 * The bootstrap script injected into every app. It runs INSIDE the sandboxed iframe.
 *
 * Provides window.bridge ({ call, on, ready }) and applies theme variables. All traffic goes over a
 * private MessageChannel port handed over by the host after a verified "hello" handshake, so the
 * (meaningless) "null" origin is never relied on. Also replaces fetch() for vault paths (reads only).
 *
 * Written as plain ES5-style JavaScript inside a string. Do not use backticks, dollar-brace or
 * backslashes inside it: a template literal would silently change them.
 */
export function buildBootstrap(nonce: string): string {
  return `(function () {
  "use strict";
  var NONCE = ${JSON.stringify(nonce)};
  var port = null;
  var seq = 0;
  var pending = {};
  var handlers = {};
  var queue = [];
  var readyResolve;
  var ready = new Promise(function (resolve) { readyResolve = resolve; });

  function applyTheme(theme) {
    var root = document.documentElement;
    var vars = (theme && theme.vars) || {};
    Object.keys(vars).forEach(function (key) { root.style.setProperty(key, vars[key]); });
    if (theme && theme.mode) {
      root.style.colorScheme = theme.mode;
      root.setAttribute("data-theme", theme.mode);
    }
  }

  function emit(name, payload) {
    var list = handlers[name];
    if (!list) return;
    list.slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }

  function onMessage(event) {
    var m = event.data;
    if (!m || m.v !== 1) return;
    if (m.type === "response" && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (m.ok) {
        p.resolve(m.result);
      } else {
        var err = new Error((m.error && m.error.message) || "Bridge error");
        err.code = (m.error && m.error.code) || "INTERNAL";
        p.reject(err);
      }
    } else if (m.type === "event") {
      if (m.name === "theme") applyTheme(m.payload);
      emit(m.name, m.payload);
    }
  }

  window.addEventListener("message", function (event) {
    if (port || event.source !== window.parent) return;
    var d = event.data;
    if (!d || d.hp !== "port" || !event.ports || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = onMessage;
    queue.splice(0).forEach(function (m) { port.postMessage(m); });
    readyResolve();
  });

  function call(op, args) {
    return new Promise(function (resolve, reject) {
      var id = "r" + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      var message = { v: 1, id: id, type: "request", op: String(op), args: args || {} };
      if (port) port.postMessage(message); else queue.push(message);
    });
  }

  function on(name, fn) {
    (handlers[name] = handlers[name] || []).push(fn);
    return function () {
      handlers[name] = (handlers[name] || []).filter(function (f) { return f !== fn; });
    };
  }

  Object.defineProperty(window, "bridge", {
    value: Object.freeze({ call: call, on: on, ready: ready }),
    writable: false,
    configurable: false
  });

  // ---- fetch shim (reads only) ------------------------------------------------------------
  // fetch("Notes/x.md") becomes a bridge read. Anything with a scheme (or starting with //) goes to the
  // real fetch, where the CSP blocks it. This is a convenience: an app can skip it and call the bridge
  // directly, and the host enforces every rule either way.
  var realFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  var TEXT_EXT = { md: 1, markdown: 1, txt: 1, json: 1, yaml: 1, yml: 1, csv: 1, canvas: 1, html: 1, htm: 1, css: 1, js: 1, xml: 1, svg: 1 };
  var MIME = {
    md: "text/markdown", markdown: "text/markdown", txt: "text/plain", json: "application/json",
    yaml: "text/yaml", yml: "text/yaml", csv: "text/csv", canvas: "application/json", html: "text/html",
    htm: "text/html", css: "text/css", js: "text/javascript", xml: "application/xml", svg: "image/svg+xml",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
    otf: "font/otf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4",
    webm: "video/webm", pdf: "application/pdf"
  };
  var STATUS = { NOT_FOUND: 404, DENIED: 403, INVALID: 400, TOO_LARGE: 413, UNSUPPORTED: 501, INTERNAL: 500 };

  function own(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  }

  function extOf(path) {
    var name = String(path).split("/").pop();
    var i = name.lastIndexOf(".");
    return i < 0 ? "" : name.slice(i + 1).toLowerCase();
  }

  function isVaultPath(input) {
    if (typeof input !== "string") return false;
    var s = input.trim();
    if (s.indexOf("//") === 0) return false;
    return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s);
  }

  function shimFetch(input, init) {
    if (!isVaultPath(input)) {
      return realFetch ? realFetch(input, init) : Promise.reject(new TypeError("fetch is unavailable"));
    }
    var method = String((init && init.method) || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return Promise.resolve(new Response("Writes must use the bridge.", { status: 405, statusText: "Method Not Allowed" }));
    }
    var ext = extOf(input);
    var isText = own(TEXT_EXT, ext) === 1;
    return call(isText ? "files.read" : "files.readBinary", { path: input }).then(
      function (r) {
        var body = method === "HEAD" ? null : (isText ? r.content : r.data);
        var type = own(MIME, ext) || (isText ? "text/plain" : "application/octet-stream");
        return new Response(body, { status: 200, headers: { "Content-Type": type } });
      },
      function (e) {
        var code = (e && e.code) || "INTERNAL";
        return new Response(code, { status: own(STATUS, code) || 500, statusText: code });
      }
    );
  }
  window.fetch = shimFetch;

  // Links must not navigate the sandboxed page. A fragment link such as "#main" is handled here, not by the browser:
  // inside a srcdoc frame the browser resolves it against Obsidian's own address and navigates the whole frame away.
  document.addEventListener("click", function (event) {
    var el = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!el) return;
    event.preventDefault();
    var href = el.getAttribute("href") || "";
    if (href.charAt(0) !== "#") return;
    var id = href.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* keep it as written */ }
    var target = id === "" ? null : document.getElementById(id);
    if (!target) {
      if ((id === "" || id === "top") && window.scrollTo) window.scrollTo(0, 0);
      return;
    }
    if (target.scrollIntoView) target.scrollIntoView();
    if (target.focus) {
      if (!target.hasAttribute("tabindex") && target.tabIndex < 0) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
  }, true);

  window.parent.postMessage({ hp: "hello", nonce: NONCE }, "*");
})();`;
}
