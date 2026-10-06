// Preserve old structure and GitHub Pages-prefix bookmarks. Loaded only by 404.html.
(() => {
    const siteRoot = new URL("../../", document.currentScript.src);
    const path = window.location.pathname;
    if (!path.startsWith(siteRoot.pathname)) return;

    let relativePath = path.slice(siteRoot.pathname.length);
    // The former repository prefix is compatibility-only on root deployments.
    const legacyPrefix = siteRoot.pathname === "/" && /^website(?:\/|$)/.test(relativePath);
    if (legacyPrefix) relativePath = relativePath.replace(/^website\/?/, "");
    const aliases = {
        "about.html": "about/",
        "fag": "education/",
        "fag/index.html": "education/"
    };
    ["dcst2001", "exph0300", "idatt2202", "it2810"].forEach((slug) => {
        aliases[`fag/${slug}`] = `education/active/${slug}/`;
        aliases[`fag/${slug}/index.html`] = `education/active/${slug}/`;
    });

    const aliasKey = relativePath.replace(/\/$/, "");
    const alias = Object.hasOwn(aliases, aliasKey) ? aliases[aliasKey] : null;
    if (!alias && !legacyPrefix) return;
    const destination = (alias || relativePath).replace(/(^|\/)index\.html$/, "$1") || "./";
    const target = new URL(destination, siteRoot);
    if (target.origin !== siteRoot.origin) return;
    target.search = window.location.search;
    target.hash = window.location.hash;
    window.location.replace(target.href);
})();
