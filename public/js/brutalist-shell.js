/* Brutalist Shell — small runtime upgrader for inner pages.
   Adds the LIVE top strip and rewrites the existing .navbar links to the
   brutalist nav with Tools / Guides dropdowns. Pages keep their old HTML
   intact; this only modifies the visible top chrome.
*/
(function(){
  if(window.__abShellLoaded) return;
  window.__abShellLoaded = true;

  function ready(fn){
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  // 0) Upgrade the plain-text "GLRA" loader to the real logo image (light + dark
  //    aware). Runs as early as possible so the swap happens before the reveal.
  function upgradeLoader(){
    var logo = document.querySelector('#loader .loader-logo');
    if(!logo || logo.dataset.abUpgraded) return;
    var wrap = document.createElement('div');
    wrap.className = 'loader-logo-wrap';
    wrap.dataset.abUpgraded = '1';
    wrap.innerHTML =
        '<img src="/img/logo.png" alt="GLRA Realty" class="loader-logo-img loader-logo-light">'
      + '<img src="/img/hero-logo.png" alt="GLRA Realty" class="loader-logo-img loader-logo-dark">'
      + '<div class="loader-tagline">Licensed Real Estate Broker</div>';
    logo.replaceWith(wrap);
  }
  upgradeLoader();

  ready(function(){
    upgradeLoader();

    // 1) Inject LIVE top strip if not present
    if(!document.querySelector('.ab-top-strip')){
      var top = document.createElement('div');
      top.className = 'ab-top-strip';
      top.innerHTML = '<span><span class="live"></span>LIVE · By appointment only</span><span>MAKATI · SINCE 2014</span>';
      document.body.insertBefore(top, document.body.firstChild);
    }

    // 2) Rewrite the .navbar's links to brutalist nav with dropdowns
    var nav = document.querySelector('nav.navbar');
    if(nav){
      // Preserve the existing logo + mobile menu button
      var logo = nav.querySelector('.logo');
      var mob  = nav.querySelector('.mobile-menu-btn');
      nav.innerHTML = '';
      if(mob) nav.appendChild(mob);
      if(logo){
        // Make logo clickable to /
        if(!logo.getAttribute('onclick')) logo.setAttribute('onclick', "window.location.href='/'");
        nav.appendChild(logo);
      }

      var links = document.createElement('div');
      links.className = 'nav-links';
      links.innerHTML = ''
        + '<a href="/">Home</a>'
        + '<a href="/properties.html">Properties</a>'
        + '<div class="nav-dropdown">'
        +   '<a>Tools ▾</a>'
        +   '<div class="nav-dropdown-menu">'
        +     '<a href="/tools.html" style="font-weight:800">// All Tools ↴</a>'
        +     '<a href="/valuation.html">// What\'s My Property Worth?</a>'
        +     '<a href="/affordability.html">// Affordability</a>'
        +     '<a href="/rent-vs-buy.html">// Rent vs Buy</a>'
        +     '<a href="/loan-comparison.html">// Pag-IBIG vs Bank</a>'
        +     '<a href="/savings-goal.html">// Savings Planner</a>'
        +     '<a href="/calculator.html">// Closing Fees</a>'
        +     '<a href="/amortization.html">// Amortization</a>'
        +     '<a href="/rental-yield.html">// Rental Yield</a>'
        +     '<a href="/estate-tax.html">// Estate Tax</a>'
        +     '<a href="/zonal.html">// Zonal Value</a>'
        +     '<a href="/ercf.html">// Registration</a>'
        +     '<a href="/cost-of-ownership.html">// Cost of Ownership</a>'
        +   '</div>'
        + '</div>'
        + '<div class="nav-dropdown">'
        +   '<a>Guides ▾</a>'
        +   '<div class="nav-dropdown-menu">'
        +     '<a href="/guide.html">// Doc Guide</a>'
        +     '<a href="/blog.html">// Journal</a>'
        +     '<a href="/neighborhoods.html">// Neighborhoods</a>'
        +     '<a href="/testimonials.html">// Testimonials</a>'
        +     '<a href="/list-property.html">// List Your Property</a>'
        +   '</div>'
        + '</div>'
        + '<a href="/about.html">About</a>'
        + '<a href="/list-property.html" class="contact-btn-nav">List property →</a>';
      nav.appendChild(links);

      // Mark current page's link as active
      try {
        var path = window.location.pathname.replace(/\/$/, '') || '/';
        nav.querySelectorAll('a[href]').forEach(function(a){
          var href = a.getAttribute('href');
          if(!href || href.indexOf('#') === 0) return;
          var clean = href.replace(/\/$/, '');
          if(clean === path) a.classList.add('active');
        });
      } catch(e){}
    }

    // 3) Standardize the mobile side menu — one canonical menu on every page,
    //    same sections as the homepage overlay (// Browse, // Tools, // The Practice)
    var overlay = document.querySelector('.mobile-overlay-links');
    if(overlay){
      overlay.innerHTML = ''
        + '<div class="mo-label">// Browse</div>'
        + '<a href="/" onclick="closeMobileMenu()">Home</a>'
        + '<a href="/properties.html" onclick="closeMobileMenu()">Properties</a>'
        + '<a href="/list-property.html" onclick="closeMobileMenu()">List Your Property</a>'
        + '<div class="mo-label">// Tools</div>'
        + '<a href="/tools.html" onclick="closeMobileMenu()">All Tools &amp; Calculators</a>'
        + '<a href="/valuation.html" onclick="closeMobileMenu()">What\'s My Property Worth?</a>'
        + '<a href="/affordability.html" onclick="closeMobileMenu()">Affordability</a>'
        + '<a href="/rent-vs-buy.html" onclick="closeMobileMenu()">Rent vs Buy</a>'
        + '<a href="/loan-comparison.html" onclick="closeMobileMenu()">Pag-IBIG vs Bank Loan</a>'
        + '<a href="/savings-goal.html" onclick="closeMobileMenu()">Savings Planner</a>'
        + '<a href="/calculator.html" onclick="closeMobileMenu()">Closing Fees</a>'
        + '<a href="/amortization.html" onclick="closeMobileMenu()">Amortization</a>'
        + '<a href="/rental-yield.html" onclick="closeMobileMenu()">Rental Yield</a>'
        + '<a href="/estate-tax.html" onclick="closeMobileMenu()">Estate Tax</a>'
        + '<a href="/zonal.html" onclick="closeMobileMenu()">Zonal Value</a>'
        + '<a href="/ercf.html" onclick="closeMobileMenu()">Registration Fee</a>'
        + '<a href="/cost-of-ownership.html" onclick="closeMobileMenu()">Cost of Ownership</a>'
        + '<div class="mo-label">// The Practice</div>'
        + '<a href="/about.html" onclick="closeMobileMenu()">About Us</a>'
        + '<a href="/neighborhoods.html" onclick="closeMobileMenu()">Neighborhoods</a>'
        + '<a href="/testimonials.html" onclick="closeMobileMenu()">Testimonials</a>'
        + '<a href="/blog.html" onclick="closeMobileMenu()">Blog</a>'
        + '<a href="/guide.html" onclick="closeMobileMenu()">Doc Guide</a>'
        + '<a href="/#contact" onclick="closeMobileMenu()">Contact</a>';
      try {
        var mpath = window.location.pathname.replace(/\/$/, '') || '/';
        overlay.querySelectorAll('a[href]').forEach(function(a){
          var href = (a.getAttribute('href') || '').replace(/\/$/, '');
          if(href === mpath) a.classList.add('gl-active');
        });
      } catch(e){}
    }
  });
})();
