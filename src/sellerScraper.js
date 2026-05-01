import { PlaywrightCrawler, log } from 'crawlee';
import { Actor } from 'apify';

/**
 * Scrapt Amazon.de-Händler für eine gegebene Kategorie.
 * Strategie:
 *   1. Suchergebnisseiten nach Kategorie durchsuchen → Produkt-URLs sammeln
 *   2. Auf Produktseiten die Seller-ID extrahieren
 *   3. Seller-Profilseite + Impressum besuchen → Kontaktdaten auslesen
 */
export async function scrapeSellersByCategory({ categoryConfig, maxSellers, proxyConfig }) {
    const { searchUrl, name: categoryName } = categoryConfig;
    const collectedSellers = new Map(); // sellerId → Daten

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,            // Niedrig halten um Amazon nicht zu triggern
        requestHandlerTimeoutSecs: 90,
        maxRequestRetries: 3,
        navigationTimeoutSecs: 60,

        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--lang=de-DE',
                ],
            },
        },

        // Cookies & Headers setzen um echter Browser zu wirken
        preNavigationHooks: [
            async ({ page }) => {
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                });
                // Amazon-spezifische Cookies (Sprachversion)
                await page.context().addCookies([{
                    name: 'i18n-prefs',
                    value: 'EUR',
                    domain: '.amazon.de',
                    path: '/',
                }]);
            },
        ],

        async requestHandler({ request, page }) {
            const { type, page: pageNum } = request.userData;

            // ── CAPTCHA erkennen ────────────────────────────────────────────
            const title = await page.title();
            if (title.toLowerCase().includes('robot') || title.toLowerCase().includes('captcha')) {
                log.warning(`⚠️ CAPTCHA erkannt auf ${request.url} — Retry wird ausgelöst`);
                throw new Error('CAPTCHA detected — retrying with new proxy');
            }

            // ── SUCHERGEBNISSEITE verarbeiten ───────────────────────────────
            if (type === 'SEARCH_PAGE') {
                log.info(`📄 Verarbeite Suchergebnisseite ${pageNum}: ${request.url}`);

                // Warten bis Suchergebnisse geladen
                await page.waitForSelector('[data-component-type="s-search-result"], .s-result-item', {
                    timeout: 15000,
                }).catch(() => {
                    log.warning(`⚠️ Keine Suchergebnisse auf Seite ${pageNum} gefunden`);
                });

                // Produkt-Links extrahieren
                const productUrls = await page.evaluate(() => {
                    const links = [];
                    document.querySelectorAll(
                        '[data-component-type="s-search-result"] a.a-link-normal[href*="/dp/"], h2 a[href*="/dp/"], a[href*="/dp/"]'
                    ).forEach(el => {
                        const href = el.getAttribute('href');
                        if (href && href.includes('/dp/') && !href.includes('sponsored')) {
                            const clean = href.startsWith('http')
                                ? href
                                : `https://www.amazon.de${href}`;
                            links.push(clean.split('?')[0]); // Query-Params entfernen
                        }
                    });
                    // Duplikate entfernen
                    return [...new Set(links)].slice(0, 15);
                });

                log.info(`🔗 ${productUrls.length} Produkt-URLs gefunden auf Seite ${pageNum}`);

                // Produkt-Seiten einreihen (um Seller-ID zu finden)
                const requests = [];
                for (const url of productUrls) {
                    if (collectedSellers.size < maxSellers) {
                        requests.push({
                            url,
                            userData: { type: 'PRODUCT_PAGE' },
                        });
                    }
                }
                if (requests.length > 0) {
                    await crawler.addRequests(requests);
                }

                // Nächste Suchergebnisseite einreihen (Pagination)
                if (collectedSellers.size < maxSellers) {
                    const nextPageUrl = await page.evaluate(() => {
                        const nextBtn = document.querySelector(
                            '.s-pagination-next:not(.s-pagination-disabled)'
                        );
                        if (nextBtn && nextBtn.href) return nextBtn.href;
                        return null;
                    });

                    if (nextPageUrl) {
                        await crawler.addRequests([{
                            url: nextPageUrl,
                            userData: { type: 'SEARCH_PAGE', page: pageNum + 1 },
                        }]);
                    }
                }

            // ── PRODUKTSEITE verarbeiten ────────────────────────────────────
            } else if (type === 'PRODUCT_PAGE') {
                if (collectedSellers.size >= maxSellers) return;

                // Warten bis Seite geladen
                await page.waitForSelector('#dp, #ppd', { timeout: 10000 }).catch(() => {});

                // Seller-ID aus Seite extrahieren
                const sellerInfo = await page.evaluate(() => {
                    // Verkäufer-Link finden
                    const sellerLink = document.querySelector(
                        '#sellerProfileTriggerId, #merchant-info a[href*="seller="], a[href*="seller="]'
                    );
                    if (!sellerLink) return null;

                    const href = sellerLink.getAttribute('href') || '';
                    const match = href.match(/seller=([A-Z0-9]+)/);
                    const sellerId = match ? match[1] : null;
                    const sellerName = sellerLink.textContent?.trim();

                    return { sellerId, sellerName };
                });

                if (!sellerInfo?.sellerId || collectedSellers.has(sellerInfo.sellerId)) {
                    return; // Kein Seller oder bereits verarbeitet
                }

                log.info(`🔍 Seller gefunden: ${sellerInfo.sellerName} (${sellerInfo.sellerId})`);

                // Seller-Profilseite einreihen
                const sellerProfileUrl =
                    `https://www.amazon.de/sp?seller=${sellerInfo.sellerId}&marketplaceID=A1PA6795UKMFR9`;

                await crawler.addRequests([{
                    url: sellerProfileUrl,
                    userData: {
                        type: 'SELLER_PROFILE',
                        sellerId: sellerInfo.sellerId,
                        sellerName: sellerInfo.sellerName,
                        category: categoryName,
                    },
                }]);

            // ── SELLER-PROFILSEITE verarbeiten ──────────────────────────────
            } else if (type === 'SELLER_PROFILE') {
                if (collectedSellers.size >= maxSellers) return;

                const { sellerId, sellerName } = request.userData;
                log.info(`👤 Verarbeite Händler-Profil: ${sellerName} (${sellerId})`);

                // Warten bis Seller-Profil geladen
                await page.waitForSelector('#page-section-detail-seller-info, #seller-profile-container, .a-box', {
                    timeout: 15000,
                }).catch(() => {});

                // Impressum-Daten extrahieren
                const impressumData = await extractImpressum(page);

                const sellerData = {
                    sellerName:  impressumData.companyName || sellerName || 'Unbekannt',
                    email:       impressumData.email       || '',
                    phone:       impressumData.phone       || '',
                    address:     impressumData.address     || '',
                    ustId:       impressumData.ustId       || '',
                    category:    categoryName,
                    storeUrl:    `https://www.amazon.de/sp?seller=${sellerId}`,
                    sellerId,
                    scrapedAt:   new Date().toISOString(),
                };

                collectedSellers.set(sellerId, sellerData);

                log.info(
                    `✅ [${collectedSellers.size}/${maxSellers}] ${sellerData.sellerName} | ` +
                    `📧 ${sellerData.email || '—'} | 📞 ${sellerData.phone || '—'}`
                );
            }
        },

        failedRequestHandler({ request, error }) {
            log.error(`❌ Request fehlgeschlagen: ${request.url}`, { error: error.message });
        },
    });

    // Start-URL hinzufügen und Crawler starten
    await crawler.addRequests([{
        url: searchUrl,
        userData: { type: 'SEARCH_PAGE', page: 1 },
    }]);

    await crawler.run();
    return [...collectedSellers.values()];
}

/**
 * Extrahiert Impressumsdaten von einer Amazon-Seller-Profilseite.
 * Amazon zeigt das Impressum im Tab "Detaillierte Verkäuferinformationen".
 */
async function extractImpressum(page) {
    const result = {
        companyName: '',
        email:       '',
        phone:       '',
        address:     '',
        ustId:       '',
    };

    try {
        // Impressum-/Detailbereich-Link suchen und anklicken
        const detailLink = await page.$('a[href*="seller-profile"], #page-section-detail-seller-info a, a:has-text("Impressum"), a:has-text("Detaillierte")');
        if (detailLink) {
            await detailLink.click();
            await page.waitForTimeout(2000);
        }

        // Gesamten Seitentext holen und parsen
        const pageText = await page.evaluate(() => {
            // Impressum-Bereich suchen
            const sections = [
                document.querySelector('#page-section-detail-seller-info'),
                document.querySelector('.a-section.a-padding-base'),
                document.querySelector('#seller-profile-container'),
                document.body,
            ];
            for (const el of sections) {
                if (el && el.innerText.trim().length > 50) return el.innerText;
            }
            return document.body.innerText;
        });

        // ── Regex-Extraktion ─────────────────────────────────────────────────

        // E-Mail
        const emailMatch = pageText.match(
            /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/
        );
        if (emailMatch) result.email = emailMatch[1].trim();

        // Telefon (deutsche Formate)
        const phoneMatch = pageText.match(
            /(?:Tel(?:efon)?\.?:?\s*|Phone:?\s*|Fon:?\s*|☎\s*)(\+?[\d\s\-\/\(\)]{7,20})/i
        );
        if (phoneMatch) result.phone = phoneMatch[1].trim().replace(/\s+/g, ' ');

        // USt-ID / Steuernummer
        const ustMatch = pageText.match(
            /(?:USt\.?-?Id(?:entifikationsnummer)?\.?:?\s*|VAT:?\s*)(DE\d{9})/i
        );
        if (ustMatch) result.ustId = ustMatch[1].trim();

        // Unternehmensname (erste Zeile des Impressums)
        const lines = pageText.split('\n').map(l => l.trim()).filter(Boolean);
        const nameIdx = lines.findIndex(l =>
            l.toLowerCase().includes('gmbh')    ||
            l.toLowerCase().includes('kg')      ||
            l.toLowerCase().includes('ag')      ||
            l.toLowerCase().includes('e.k.')    ||
            l.toLowerCase().includes('e.k')     ||
            l.toLowerCase().includes('gbr')     ||
            l.toLowerCase().includes('ug')      ||
            l.toLowerCase().includes('ohg')
        );
        if (nameIdx !== -1) result.companyName = lines[nameIdx];

        // Adresse (Zeile mit PLZ-Muster)
        const addressMatch = pageText.match(
            /([A-Za-zäöüÄÖÜß\s\-\.]+\d*[,\s]+\d{5}\s+[A-Za-zäöüÄÖÜß\s\-]+)/
        );
        if (addressMatch) result.address = addressMatch[1].trim().replace(/\s+/g, ' ');

    } catch (err) {
        log.warning(`⚠️ Impressum-Extraktion fehlgeschlagen: ${err.message}`);
    }

    return result;
}