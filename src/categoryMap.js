/**
 * Mapping von Kategorie-Namen zu Amazon.de-Suchanfragen.
 * Die URLs filtern auf "sold by third-party sellers" (nicht Amazon selbst).
 */
const CATEGORY_MAP = {
    'Baumarkt': {
        name:      'Baumarkt',
        searchUrl: 'https://www.amazon.de/s?i=tools&rh=n%3A75251031&s=review-rank&language=de_DE',
        nodeId:    '75251031',
    },
    'Elektronik': {
        name:      'Elektronik',
        searchUrl: 'https://www.amazon.de/s?i=electronics&rh=n%3A571860&s=review-rank&language=de_DE',
        nodeId:    '571860',
    },
    'Sport & Freizeit': {
        name:      'Sport & Freizeit',
        searchUrl: 'https://www.amazon.de/s?i=sports&rh=n%3A16435051&s=review-rank&language=de_DE',
        nodeId:    '16435051',
    },
    'Küche & Haushalt': {
        name:      'Küche & Haushalt',
        searchUrl: 'https://www.amazon.de/s?i=kitchen&rh=n%3A3167641&s=review-rank&language=de_DE',
        nodeId:    '3167641',
    },
    'Garten': {
        name:      'Garten',
        searchUrl: 'https://www.amazon.de/s?i=garden&rh=n%3A340845031&s=review-rank&language=de_DE',
        nodeId:    '340845031',
    },
    'Spielzeug': {
        name:      'Spielzeug',
        searchUrl: 'https://www.amazon.de/s?i=toys&rh=n%3A192417031&s=review-rank&language=de_DE',
        nodeId:    '192417031',
    },
    'Bekleidung': {
        name:      'Bekleidung',
        searchUrl: 'https://www.amazon.de/s?i=fashion&rh=n%3A77028031&s=review-rank&language=de_DE',
        nodeId:    '77028031',
    },
    'Bürobedarf': {
        name:      'Bürobedarf',
        searchUrl: 'https://www.amazon.de/s?i=office-products&rh=n%3A192416031&s=review-rank&language=de_DE',
        nodeId:    '192416031',
    },
    'Lebensmittel': {
        name:      'Lebensmittel',
        searchUrl: 'https://www.amazon.de/s?i=grocery&rh=n%3A340846031&s=review-rank&language=de_DE',
        nodeId:    '340846031',
    },
    'Gesundheit & Kosmetik': {
        name:      'Gesundheit & Kosmetik',
        searchUrl: 'https://www.amazon.de/s?i=hpc&rh=n%3A64263031&s=review-rank&language=de_DE',
        nodeId:    '64263031',
    },
    'Schmuck': {
        name:      'Schmuck',
        searchUrl: 'https://www.amazon.de/s?i=jewelry&rh=n%3A193659031&s=review-rank&language=de_DE',
        nodeId:    '193659031',
    },
    'Automotive': {
        name:      'Automotive',
        searchUrl: 'https://www.amazon.de/s?i=automotive&rh=n%3A1981253031&s=review-rank&language=de_DE',
        nodeId:    '1981253031',
    },
    'Haustier': {
        name:      'Haustier',
        searchUrl: 'https://www.amazon.de/s?i=pets&rh=n%3A3047883031&s=review-rank&language=de_DE',
        nodeId:    '3047883031',
    },
    'Musikinstrumente': {
        name:      'Musikinstrumente',
        searchUrl: 'https://www.amazon.de/s?i=musical-instruments&rh=n%3A213079031&s=review-rank&language=de_DE',
        nodeId:    '213079031',
    },
    'Software': {
        name:      'Software',
        searchUrl: 'https://www.amazon.de/s?i=software&rh=n%3A301128&s=review-rank&language=de_DE',
        nodeId:    '301128',
    },
};

export function getCategoryConfig(categoryName) {
    return CATEGORY_MAP[categoryName] ?? null;
}

export function getAvailableCategories() {
    return Object.keys(CATEGORY_MAP);
}