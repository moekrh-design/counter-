/* PWA / iOS Fullscreen helper
   - Best effort to hide Safari UI (cannot force true fullscreen in Safari)
   - Show a lightweight "Add to Home Screen" hint on iOS when not running standalone
*/
(function () {
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isStandalone() {
    // iOS Safari: navigator.standalone (legacy). Modern: display-mode media query.
    return (window.navigator.standalone === true) || window.matchMedia('(display-mode: standalone)').matches;
  }
  function tryHideSafariBar() {
    // Best effort: nudges Safari to collapse the top/bottom bars after user gesture or load
    setTimeout(function () { window.scrollTo(0, 1); }, 50);
    setTimeout(function () { window.scrollTo(0, 1); }, 250);
  }
  function setVhVar() {
    var vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', vh + 'px');
  }

  function showA2HS() {
    if (!isIOS() || isStandalone()) return;

    // Avoid repeated prompts in same session
    if (sessionStorage.getItem('a2hs_hint_dismissed') === '1') return;

    var wrap = document.createElement('div');
    wrap.className = 'a2hs-hint';
    wrap.innerHTML = `
      <div class="a2hs-card" dir="rtl">
        <div class="a2hs-title">للوضع “فل سكرين” على الآيباد</div>
        <div class="a2hs-text">من سفاري اضغط <b>مشاركة</b> ثم <b>إضافة إلى الشاشة الرئيسية</b> وبعدها افتح النظام من الأيقونة.</div>
        <button type="button" class="a2hs-close">تم</button>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelector('.a2hs-close').addEventListener('click', function () {
      sessionStorage.setItem('a2hs_hint_dismissed', '1');
      wrap.remove();
    }, { passive: true });
  }

  // Init
  setVhVar();
  tryHideSafariBar();
  showA2HS();

  window.addEventListener('resize', function () {
    setVhVar();
    tryHideSafariBar();
  });

  window.addEventListener('orientationchange', function () {
    setTimeout(function () {
      setVhVar();
      tryHideSafariBar();
    }, 250);
  });
})();
