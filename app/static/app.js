// Клиентская часть без фреймворков: события воронки, копирование ссылки, cookie и Метрика.
(function () {
  "use strict";

  function sendEvent(name, props) {
    try {
      fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, props: props || {} }),
        credentials: "same-origin",
        keepalive: true,
      });
    } catch (e) {
      /* аналитика не должна ломать страницу */
    }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    return Promise.resolve();
  }

  document.addEventListener("click", function (e) {
    var tracked = e.target.closest("[data-event]");
    if (tracked) {
      var props = {};
      if (tracked.dataset.channel) props.channel = tracked.dataset.channel;
      sendEvent(tracked.dataset.event, props);
    }

    var copy = e.target.closest("[data-copy]");
    if (copy) {
      copyText(copy.dataset.copy).then(function () {
        var label = copy.querySelector("[data-label]");
        if (label) label.textContent = "Ссылка скопирована";
      });
    }

    var choice = e.target.closest("[data-cookie-choice]");
    if (choice) chooseCookies(choice.dataset.cookieChoice);
  });

  // События «блок в зоне видимости» (paywall_view) — один раз за показ страницы.
  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        sendEvent(entry.target.dataset.viewEvent, {});
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.5 });
    var observeViews = function (root) {
      root.querySelectorAll("[data-view-event]").forEach(function (el) { observer.observe(el); });
    };
    observeViews(document);
    document.body.addEventListener("htmx:afterSwap", function (e) { observeViews(e.target); });
  }

  // --- Яндекс Метрика: только после согласия в баннере ---
  var metrikaId = document.body.dataset.metrikaId;

  function cookieChoice() {
    var match = document.cookie.match(/(?:^|; )cookie_consent=(yes|no)/);
    return match ? match[1] : null;
  }

  function loadMetrika() {
    if (!metrikaId || window.ym) return;
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      k = e.createElement(t); a = e.getElementsByTagName(t)[0];
      k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
    window.ym(Number(metrikaId), "init", {
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      webvisor: false, // выключен на время MVP: записал бы ответы теста
    });
  }

  function chooseCookies(value) {
    document.cookie = "cookie_consent=" + value + "; Max-Age=31536000; Path=/; SameSite=Lax";
    var banner = document.getElementById("cookie-banner");
    if (banner) banner.remove();
    if (value === "yes") loadMetrika();
  }

  if (cookieChoice() === "yes") loadMetrika();
})();
