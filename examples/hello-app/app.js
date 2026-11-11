// A starter app. It asks for no permissions: theme and embed context are always available.
(function () {
  var $ = function (id) { return document.getElementById(id); };

  window.bridge.on("theme", function (t) { $("theme").textContent = t.mode; });

  window.bridge.ready
    .then(function () { return window.bridge.call("embed.context", {}); })
    .then(function (ctx) {
      $("embedded").textContent = ctx.embedded ? "yes" : "no (opened in a tab)";
      var list = $("params");
      var names = Object.keys(ctx.params);
      if (names.length === 0) {
        var none = document.createElement("li");
        none.textContent = "none";
        list.appendChild(none);
      }
      names.forEach(function (name) {
        // The note is untrusted text: always textContent, never innerHTML.
        var item = document.createElement("li");
        item.textContent = name + ": " + ctx.params[name];
        list.appendChild(item);
      });
      if (ctx.params.greeting) $("greeting").textContent = ctx.params.greeting;
    })
    .catch(function (err) { $("embedded").textContent = "error: " + (err && err.code); });
})();
