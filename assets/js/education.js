(() => {
    "use strict";

    const previousLink = document.querySelector("[data-previous-courses]");
    if (!previousLink) return;

    // Preserve bookmarks to the previous tab after moving its content to a page.
    const redirectPreviousTab = () => {
        if (window.location.hash !== "#tidligere-fag") return;
        const target = new URL(previousLink.href);
        target.search = window.location.search;
        target.hash = window.location.hash;
        window.location.replace(target.href);
    };

    window.addEventListener("hashchange", redirectPreviousTab);
    redirectPreviousTab();
})();
