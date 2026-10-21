/* Reuse the shared command palette; no second search implementation. */
(() => {
    if (!document.body.classList.contains("home-page")) return;

    const searchButton = document.getElementById("site-search-button");
    const headerSearch = document.getElementById("home-search-button");
    if (!searchButton || !headerSearch) return;

    headerSearch.title = searchButton.title;
    headerSearch.addEventListener("click", () => searchButton.click());
    headerSearch.hidden = false;
    document.body.classList.add("home-enhanced");
})();
