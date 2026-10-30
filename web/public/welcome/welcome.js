// Landing page behavior: device-aware entry and download availability.
// External file because the site CSP forbids inline scripts (script-src 'self').

(function () {
  "use strict";

  // 立即体验：默认网页版，移动设备复用对应平台的下载链接。
  var experienceButton = document.getElementById("experience-button");
  var iosButton = document.getElementById("ios");
  var apkButton = document.getElementById("apk-button");
  var userAgent = navigator.userAgent || "";
  var platform = navigator.userAgentData && navigator.userAgentData.platform;
  // iPadOS 桌面模式使用 Mac UA，通过触点数与真正的 Mac 区分。
  var isIOS = /iPhone|iPad|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1);
  if (isIOS) {
    experienceButton.setAttribute("href", iosButton.getAttribute("href"));
  } else if (/Android/i.test(userAgent) || platform === "Android") {
    experienceButton.setAttribute("href", apkButton.getAttribute("href"));
  }

  // Android 按钮：检查发布状态；未发布（404）则置灰。
  var apkMeta = document.getElementById("apk-meta");
  function setApkMessage(key, fallback) {
    apkMeta.removeAttribute("hidden");
    apkMeta.setAttribute("data-i18n", key);
    apkMeta.textContent = window.LunaWelcomeI18n ? window.LunaWelcomeI18n.t(key) : fallback;
  }
  fetch("/api/downloads/android/latest.json")
    .then(function (response) {
      if (response.status === 404) {
        apkButton.setAttribute("aria-disabled", "true");
        var footerApk = document.getElementById("footer-apk");
        var footerApkMeta = document.getElementById("footer-apk-meta");
        if (footerApk && footerApkMeta) {
          footerApk.setAttribute("aria-disabled", "true");
          footerApk.addEventListener("click", function (event) { event.preventDefault(); });
          footerApkMeta.removeAttribute("hidden");
          footerApkMeta.setAttribute("data-i18n", "apkUnavailable");
          footerApkMeta.textContent = window.LunaWelcomeI18n ? window.LunaWelcomeI18n.t("apkUnavailable") : "即将提供";
        }
        setApkMessage("apkUnavailable", "即将提供");
        // pointer-events:none only stops mouse clicks; keyboard Enter still fires click.
        apkButton.addEventListener("click", function (event) {
          event.preventDefault();
        });
        // 立即体验 on Android pointed at the APK; fall back to the web app instead of a 404.
        if (experienceButton.getAttribute("href") === apkButton.getAttribute("href")) {
          experienceButton.setAttribute("href", "/");
        }
        return null;
      }
      if (!response.ok) throw new Error("unavailable");
    })
    .catch(function () {
      // 元数据暂不可用不代表安装包未发布，保留直接下载入口。
    });

  // iOS 按钮：后端代查 App Store 链接，失败时保留静态链接。
  // Only the backend's normalised App Store link is accepted as a new href.
  var appStoreLink = /^https:\/\/apps\.apple\.com\/[a-z]{2}\/app\/id[0-9]+$/;
  fetch("/api/downloads/ios/latest.json")
    .then(function (response) {
      if (!response.ok) throw new Error("unavailable");
      return response.json();
    })
    .then(function (latest) {
      if (!latest) return;
      if (typeof latest.trackViewUrl === "string" && appStoreLink.test(latest.trackViewUrl)) {
        var staticHref = iosButton.getAttribute("href");
        iosButton.setAttribute("href", latest.trackViewUrl);
        var footerIos = document.getElementById("footer-ios");
        if (footerIos) footerIos.setAttribute("href", latest.trackViewUrl);
        // 立即体验 on iOS copied the static App Store link; keep it on the same target.
        if (experienceButton.getAttribute("href") === staticHref) {
          experienceButton.setAttribute("href", latest.trackViewUrl);
        }
      }
    })
    .catch(function () {
      // The static App Store link keeps working.
    });
})();
