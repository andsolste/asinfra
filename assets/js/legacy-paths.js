// Preserve incoming links after moving Om meg and Fag. Loaded only by 404.html.
(() => {
    const siteRoot = new URL("../../", document.currentScript.src);
    const path = window.location.pathname;
    if (!path.startsWith(siteRoot.pathname)) return;

    const relativePath = path.slice(siteRoot.pathname.length).replace(/\/$/, "");
    const aliases = {
        "about.html": "about/",
        "fag": "education/",
        "fag/index.html": "education/"
    };
    ["dcst2001", "exph0300", "idatt2202", "it2810"].forEach((slug) => {
        aliases[`fag/${slug}`] = `education/active/${slug}/`;
        aliases[`fag/${slug}/index.html`] = `education/active/${slug}/`;
    });

    if (!aliases[relativePath]) return;
    const target = new URL(aliases[relativePath], siteRoot);
    target.search = window.location.search;
    target.hash = window.location.hash;
    window.location.replace(target.href);
})();
