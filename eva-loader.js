/* =========================================================
   EVA LOADER — the ONLY connection point between layout.html
   and every other page. Do not copy layout markup/CSS/JS
   anywhere else; this file fetches layout.html at runtime
   and reuses it as-is.

   Place this file next to layout.html. Each page (dashboard.html,
   journal.html, analyze.html, settings.html) loads it via:
     <script src="eva-loader.js"></script>
   ========================================================= */
(async function () {
  // 1. Save what belongs to THIS page before we touch anything.
  const pageTitle = document.title;
  const contentEl = document.getElementById('eva-page-content');
  const pageContentHTML = contentEl ? contentEl.innerHTML : '';

  // 2. Fetch the untouched layout file.
  const res = await fetch('layout.html');
  if (!res.ok) {
    console.error('eva-loader: could not fetch layout.html', res.status);
    return;
  }
  const layoutHTML = await res.text();
  const layoutDoc = new DOMParser().parseFromString(layoutHTML, 'text/html');

  // 3. Swap in layout's <head> (styles, fonts, meta), keep this page's title.
  document.head.innerHTML = layoutDoc.head.innerHTML;
  document.title = pageTitle;

  // 4. Swap in layout's <body> (nav, sidebar, topbar, #eva-page shell).
  document.body.className = layoutDoc.body.className;
  document.body.innerHTML = layoutDoc.body.innerHTML;

  // 5. Drop this page's unique content into the layout's content slot.
  const mainEl = document.getElementById('eva-page');
  if (mainEl) mainEl.innerHTML = pageContentHTML;

  // 6. innerHTML doesn't execute <script> tags — recreate them so the
  //    locked bottom-nav script and the Firebase/theme/nav module run.
  document.querySelectorAll('body script').forEach((oldScript) => {
    const newScript = document.createElement('script');
    for (const attr of oldScript.attributes) {
      newScript.setAttribute(attr.name, attr.value);
    }
    newScript.textContent = oldScript.textContent;
    oldScript.replaceWith(newScript);
  });
})();
