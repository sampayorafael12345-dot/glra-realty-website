/* One place for the loan rates the public calculators pre-fill.
 *
 * Before this file, two tools labelled 11% "Pag-IBIG" and two others used
 * 6.25%, so the same buyer got two different answers. Every page that shows
 * a Pag-IBIG rate now reads it from here.
 *
 * Load it with a plain <script> AFTER the form markup and BEFORE the page's
 * own inline script: it rewrites every element marked data-glra-rate="<key>"
 * straight away, so the page's first calculation already uses these values.
 *   - <input>, <option>, <button>: .value becomes the rate
 *   - data-glra-label="{r}% Pag-IBIG": the text becomes the label with {r}
 *     replaced by the rate ({r2} gives two decimals, e.g. 6.25 -> "6.25")
 *
 * OWNER CHECK: Pag-IBIG publishes a rate for each fixing period. 6.25% is its
 * 3-year fixing rate as last checked (Oct 2026). Confirm against the current
 * Pag-IBIG rate sheet before changing it, then change it here only.
 */
(function () {
  var RATES = {
    pagibig: 6.25,            // % a year, 3-year fixing period
    pagibigFixing: '3-yr fixed'
  };
  window.GLRA_RATES = RATES;

  function fill(root) {
    var els = (root || document).querySelectorAll('[data-glra-rate]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], r = RATES[el.getAttribute('data-glra-rate')];
      if (typeof r !== 'number') continue;
      var tag = el.tagName;
      if (tag === 'INPUT' || tag === 'OPTION' || tag === 'BUTTON') {
        el.value = String(r);
        if (tag === 'INPUT') el.defaultValue = String(r);
      }
      var label = el.getAttribute('data-glra-label');
      if (label) {
        el.textContent = label.replace('{r2}', r.toFixed(2)).replace('{r}', String(r))
          .replace('{fix}', RATES.pagibigFixing);
      }
    }
  }
  window.glraFillRates = fill;
  fill(document);
})();
