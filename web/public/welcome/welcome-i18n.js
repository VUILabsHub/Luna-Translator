// Standalone landing-page translations (zh-CN / zh-TW / en). Every [data-i18n]
// element in index.html needs a key here; missing keys fall back to English.
(function () {
  "use strict";

  var messages = {
    "zh-CN": {
      name: "简体中文",
      brandName: "Luna翻译",
      brandShort: "Luna",
      title: "Luna翻译 — 实时同声传译",
      description: "VUI Labs 自研实时同传模型与产品，支持低延迟翻译、行业词库适配、实时音色克隆及中英输入、18 种语言输出。",
      languageLabel: "界面语言",
      platformLabel: "选择使用平台",
      featuresLabel: "产品特点",
      footerLabel: "页脚链接",
      tryNow: "立即体验",
      heroLead: "一种声音，",
      heroAccent: "通行世界",
      ledeLine1: "VUI Labs 自研实时同传模型与产品，面向会议课堂、宣讲直播、面对面交流和远程通话，",
      ledeLine2: "让不同语言的人边说、边听、边交流。",
      openWeb: "打开网页版",
      downloadIos: "下载 iOS 版",
      android: "下载 Android 版",
      apkPackage: "APK 安装包",
      apkUnavailable: "即将提供",
      enterpriseApi: "企业API接入",
      realtimeTitle: "低延迟，跟上交流",
      realtimeBody: "RealSI 中英测试中，文本首字延迟仅 1.2\u00a0秒。",
      terminologyTitle: "懂语言，也懂行业",
      terminologyBody: "中英双向高质量翻译，支持行业词库与专业术语适配。",
      voiceTitle: "换种语言，保留你的声音",
      voiceBody: "经说话人授权，实时克隆音色，让译文保留个人声音特点。",
      languagesTitle: "一次表达，连接多语受众",
      languagesBody: "当前支持中英输入、18 种语言输出，输入语种持续扩展。",
      terms: "用户协议",
      privacy: "隐私政策",
      companySite: "公司官网",
      globalSite: "海外官网",
      githubRepo: "GitHub 仓库"
    },
    "zh-TW": {
      name: "繁體中文",
      brandName: "Luna翻译",
      brandShort: "Luna",
      title: "Luna翻譯 — 即時同步口譯",
      description: "VUI Labs 自主研發的即時同步口譯模型與產品，支援低延遲翻譯、產業詞庫適配、即時聲音複製，以及中英輸入、18 種語言輸出。",
      languageLabel: "介面語言",
      platformLabel: "選擇使用平台",
      featuresLabel: "產品特色",
      footerLabel: "頁尾連結",
      tryNow: "立即體驗",
      heroLead: "一種聲音，",
      heroAccent: "通行世界",
      ledeLine1: "VUI Labs 自主研發的即時同步口譯模型與產品，適用於會議課堂、宣講直播、面對面交流與遠端通話，",
      ledeLine2: "讓不同語言的人邊說、邊聽、邊交流。",
      openWeb: "開啟網頁版",
      downloadIos: "下載 iOS 版",
      android: "下載 Android 版",
      apkPackage: "APK 安裝檔",
      apkUnavailable: "即將推出",
      enterpriseApi: "企業 API 整合",
      realtimeTitle: "低延遲，跟上交流",
      realtimeBody: "RealSI 中英測試中，文字首字延遲僅 1.2\u00a0秒。",
      terminologyTitle: "懂語言，也懂產業",
      terminologyBody: "中英雙向高品質翻譯，支援產業詞庫與專業術語適配。",
      voiceTitle: "換種語言，保留你的聲音",
      voiceBody: "經說話者授權，即時複製音色，讓譯文保留個人聲音特色。",
      languagesTitle: "一次表達，連結多語聽眾",
      languagesBody: "目前支援中英輸入、18 種語言輸出，輸入語言持續擴展。",
      terms: "使用者條款",
      privacy: "隱私權政策",
      companySite: "公司官網",
      globalSite: "海外官網",
      githubRepo: "GitHub 倉庫"
    },
    en: {
      name: "English",
      brandName: "Luna Translator",
      brandShort: "Luna",
      title: "Luna Translator",
      description: "VUI Labs' own live translation model and product: low latency, industry glossaries, real-time voice cloning, and Chinese or English input with output in 18 languages.",
      languageLabel: "Interface language",
      platformLabel: "Choose your platform",
      featuresLabel: "Highlights",
      footerLabel: "Footer links",
      tryNow: "Try now",
      heroLead: "One voice, ",
      heroAccent: "every language",
      ledeLine1: "Live interpretation models and products built in-house by VUI Labs, for meetings and classes, talks and livestreams, in-person conversations and remote calls, ",
      ledeLine2: "so people who speak different languages can talk, listen and connect, all at once.",
      openWeb: "Open web app",
      downloadIos: "Download for iOS",
      android: "Download for Android",
      apkPackage: "APK download",
      apkUnavailable: "Coming soon",
      enterpriseApi: "Enterprise API access",
      realtimeTitle: "Low latency, natural flow",
      realtimeBody: "Just 1.2 seconds to the first translated text in RealSI Chinese\u2013English tests.",
      terminologyTitle: "Language meets expertise",
      terminologyBody: "High-quality Chinese\u2013English translation in both directions, with industry glossaries and terminology adaptation.",
      voiceTitle: "Your voice, translated",
      voiceBody: "With the speaker's consent, real-time voice cloning keeps their vocal character in the translation.",
      languagesTitle: "One talk, every audience",
      languagesBody: "Chinese and English input, output in 18 languages. More input languages are on the way.",
      terms: "Terms of use",
      privacy: "Privacy policy",
      companySite: "Company website",
      globalSite: "Global website",
      githubRepo: "GitHub repository"
    }
  };
  var storageKey = "luna.welcome.language";
  var select = document.getElementById("language-select");

  function matchLocale(value) {
    var tag = String(value || "").replace(/_/g, "-").toLowerCase();
    if (/^zh(?:-|$)/.test(tag)) {
      if (/(?:^|-)hant(?:-|$)/.test(tag)) return "zh-TW";
      if (/(?:^|-)hans(?:-|$)/.test(tag)) return "zh-CN";
      return /(?:^|-)(?:tw|hk|mo)(?:-|$)/.test(tag) ? "zh-TW" : "zh-CN";
    }
    return /^en(?:-|$)/.test(tag) ? "en" : null;
  }

  function initialLocale() {
    var requested = matchLocale(new URL(window.location.href).searchParams.get("lang"));
    if (requested) return requested;
    try {
      var saved = matchLocale(window.localStorage.getItem(storageKey));
      if (saved) return saved;
    } catch (_) {
      // Browser storage can be unavailable; automatic selection still works.
    }
    var preferred = navigator.languages && navigator.languages.length
      ? navigator.languages : [navigator.language];
    for (var i = 0; i < preferred.length; i += 1) {
      var matched = matchLocale(preferred[i]);
      if (matched) return matched;
    }
    return "en";
  }

  var locale = initialLocale();

  function translate(key) {
    return messages[locale][key] || messages.en[key] || key;
  }

  function render() {
    document.documentElement.lang = locale;
    document.title = translate("title");
    document.querySelector('meta[name="description"]').setAttribute("content", translate("description"));
    document.querySelectorAll("[data-i18n]").forEach(function (element) {
      element.textContent = translate(element.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-label]").forEach(function (element) {
      element.setAttribute("aria-label", translate(element.getAttribute("data-i18n-label")));
    });
    select.value = locale;
  }

  Object.keys(messages).forEach(function (key) {
    var option = document.createElement("option");
    option.value = key;
    option.textContent = messages[key].name;
    select.appendChild(option);
  });
  select.addEventListener("change", function () {
    locale = matchLocale(select.value) || "en";
    try {
      window.localStorage.setItem(storageKey, locale);
    } catch (_) {}
    var url = new URL(window.location.href);
    url.searchParams.set("lang", locale);
    window.history.replaceState(null, "", url.toString());
    render();
  });

  window.LunaWelcomeI18n = { t: translate };
  render();
})();
