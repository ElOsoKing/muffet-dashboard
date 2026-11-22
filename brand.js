// Marca "SilklyBot" para los overlays del plan gratis. El plan Pro no la lleva.
// Uso en un overlay:  <script src="/brand.js"></script>  y luego  SilklyBrand.attach(elemento)
// La marquita se pone pegada debajo del elemento, a la derecha, chiquita y discreta.
(function () {
  var parts = location.pathname.split('/').filter(Boolean);
  var q = new URLSearchParams(location.search);
  var user = (q.get('channel') || decodeURIComponent(parts[parts.length - 1] || '')).toLowerCase();
  var css = document.createElement('style');
  css.textContent = '.silkly-brand{position:absolute;right:6px;bottom:-20px;z-index:99;font:600 11px/1 Inter,system-ui,sans-serif;'
    + 'color:rgba(255,255,255,.85);background:rgba(10,8,20,.55);padding:4px 8px;border-radius:9px;letter-spacing:.2px;'
    + 'pointer-events:none;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.6)}'
    + '.silkly-brand b{color:#c9a7ff;font-weight:800}'
    + '.silkly-brand.inside{bottom:6px}'
    + '.silkly-brand.top{top:6px;bottom:auto}';
  document.head.appendChild(css);
  var info = /^[a-z0-9_]{3,25}$/.test(user)
    ? fetch('/api/brand/' + encodeURIComponent(user), { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return { brand: false, pro: false }; })
    : Promise.resolve({ brand: false, pro: false });
  window.SilklyBrand = {
    info: info,
    // donde: nada = debajo del elemento · 'inside' = adentro abajo a la derecha · 'top' = adentro arriba a la derecha
    make: function (donde) {
      var b = document.createElement('div');
      b.className = 'silkly-brand' + (donde === 'inside' || donde === true ? ' inside' : donde === 'top' ? ' top' : '');
      b.setAttribute('translate', 'no');
      b.innerHTML = '🕷️ <b>SilklyBot</b>';
      return b;
    },
    attach: function (el, donde) {
      if (!el) return;
      info.then(function (d) {
        if (!d.brand || el.querySelector(':scope > .silkly-brand')) return;
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        el.appendChild(window.SilklyBrand.make(donde));
      });
    },
  };
})();
