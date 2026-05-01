import { PlaywrightCrawler, log } from 'crawlee';

/**
 * Scrapt Amazon.de-Händler für eine gegebene Kategorie.
 */
export async function scrapeSellersByCategory({ categoryConfig, maxSellers, proxyConfig }) {
    const { searchUrl, name: categoryName } = categoryConfig;
    const collectedSellers = new Map();
    const enqueuedSellerIds = new Set(); // Verhindert doppelte Profil-Besuche

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,
        requestHandlerTimeoutSecs: 90,
        maxRequestRetries: 3,
        navigationTimeoutSecs: 60,
        launchContext: {
            launchOptions: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=de-DE'],
            },
        },
        preNavigationHooks: [
            async ({ page }) => {
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'de-DE,de;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                });
                await page.context().addCookies([{ name: 'i18n-prefs', value: 'EUR', domain: '.amazon.de', path: '/' }]);
            },
        ],

        async requestHandler({ request, page }) {
            const { type, page: pageNum } = request.userData;

            const title = await page.title();
            if (title.toLowerCase().includes('robot') || title.toLowerCase().includes('captcha')) {
                throw new Error('CAPTCHA detected');
            }

            // ── SUCHERGEBNISSEITE ────────────────────────────────────────────
            if (type === 'SEARCH_PAGE') {
                log.info(`📄 Suchergebnisseite ${pageNum}: ${request.url}`);
                await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 15000 }).catch(() => {});

                const productUrls = await page.evaluate(() => {
                    const links = [];
                    document.querySelectorAll('[data-component-type="s-search-result"] h2 a[href*="/dp/"]').forEach(el => {
                        const href = el.getAttribute('href');
                        if (href && href.includes('/dp/')) {
                            const clean = href.startsWith('http') ? href : `https://www.amazon.de${href}`;
                            links.push(clean.split('?')[0]);
                        }
                    });
                    return [...new Set(links)].slice(0, 15);
                });
                log.info(`🔗 ${productUrls.length} Produkt-URLs auf Seite ${pageNum}`);

                const reqs = productUrls.filter(() => collectedSellers.size < maxSellers)
                    .map(url => ({ url, userData: { type: 'PRODUCT_PAGE' } }));
                if (reqs.length) await crawler.addRequests(reqs);

                if (collectedSellers.size < maxSellers) {
                    const nextUrl = await page.evaluate(() => {
                        const btn = document.querySelector('.s-pagination-next:not(.s-pagination-disabled)');
                        return btn?.href || null;
                    });
                    if (nextUrl) await crawler.addRequests([{ url: nextUrl, userData: { type: 'SEARCH_PAGE', page: pageNum + 1 } }]);
                }

            // ── PRODUKTSEITE ─────────────────────────────────────────────────
            } else if (type === 'PRODUCT_PAGE') {
                if (collectedSellers.size >= maxSellers) return;
                await page.waitForSelector('#dp, #ppd', { timeout: 10000 }).catch(() => {});

                // FIX 1: Nur #sellerProfileTriggerId oder #merchant-info Links verwenden
                const sellerInfo = await page.evaluate(() => {
                    // Primär: #sellerProfileTriggerId hat den echten Händlernamen
                    const trigger = document.querySelector('#sellerProfileTriggerId');
                    if (trigger) {
                        const href = trigger.getAttribute('href') || '';
                        const m = href.match(/seller=([A-Z0-9]+)/);
                        if (m) return { sellerId: m[1], sellerName: trigger.textContent.trim() };
                    }
                    // Sekundär: im #merchant-info Bereich suchen
                    const merchant = document.querySelector('#merchant-info');
                    if (merchant) {
                        const link = merchant.querySelector('a[href*="/sp?"]');
                        if (link) {
                            const href = link.getAttribute('href') || '';
                            const m = href.match(/seller=([A-Z0-9]+)/);
                            if (m) return { sellerId: m[1], sellerName: link.textContent.trim() };
                        }
                    }
                    // Tertiär: "Verkauf durch" Text suchen
                    const buyBox = document.querySelector('#tabular-buybox, #desktop_buybox');
                    if (buyBox) {
                        const link = buyBox.querySelector('a[href*="seller="]');
                        if (link) {
                            const href = link.getAttribute('href') || '';
                            const m = href.match(/seller=([A-Z0-9]+)/);
                            const name = link.textContent.trim();
                            // "Details" überspringen
                            if (m && name && name !== 'Details' && name.length > 1) {
                                return { sellerId: m[1], sellerName: name };
                            }
                        }
                    }
                    return null;
                });

                if (!sellerInfo?.sellerId) return;

                // FIX 2: Amazon selbst überspringen
                const name = sellerInfo.sellerName.toLowerCase();
                if (name.includes('amazon') || name === 'details' || name.length < 2) {
                    log.info(`⏭️ Amazon/ungültiger Seller übersprungen: ${sellerInfo.sellerName}`);
                    return;
                }

                // FIX 3: Deduplizierung VOR dem Enqueuen
                if (enqueuedSellerIds.has(sellerInfo.sellerId) || collectedSellers.has(sellerInfo.sellerId)) return;
                enqueuedSellerIds.add(sellerInfo.sellerId);

                log.info(`🔍 Seller: ${sellerInfo.sellerName} (${sellerInfo.sellerId})`);
                await crawler.addRequests([{
                    url: `https://www.amazon.de/sp?seller=${sellerInfo.sellerId}&marketplaceID=A1PA6795UKMFR9`,
                    userData: { type: 'SELLER_PROFILE', sellerId: sellerInfo.sellerId, sellerName: sellerInfo.sellerName, category: categoryName },
                }]);

            // ── SELLER-PROFILSEITE ───────────────────────────────────────────
            } else if (type === 'SELLER_PROFILE') {
                if (collectedSellers.size >= maxSellers) return;
                const { sellerId, sellerName } = request.userData;
                log.info(`👤 Händler-Profil: ${sellerName} (${sellerId})`);

                await page.waitForSelector('#seller-profile-container, #page-section-detail-seller-info, .seller-info', { timeout: 15000 }).catch(() => {});
                const impressum = await extractImpressum(page);

                const sellerData = {
                    sellerName: impressum.companyName || sellerName || 'Unbekannt',
                    email: impressum.email || '',
                    phone: impressum.phone || '',
                    address: impressum.address || '',
                    ustId: impressum.ustId || '',
                    category: categoryName,
                    storeUrl: `https://www.amazon.de/sp?seller=${sellerId}`,
                    sellerId,
                    scrapedAt: new Date().toISOString(),
                };

                collectedSellers.set(sellerId, sellerData);
                log.info(`✅ [${collectedSellers.size}/${maxSellers}] ${sellerData.sellerName} | 📧 ${sellerData.email || '—'} | 📞 ${sellerData.phone || '—'}`);
            }
        },

        failedRequestHandler({ request, error }) {
            log.error(`❌ Fehlgeschlagen: ${request.url}`, { error: error.message });
        },
    });

    await crawler.addRequests([{ url: searchUrl, userData: { type: 'SEARCH_PAGE', page: 1 } }]);
    await crawler.run();
    return [...collectedSellers.values()];
}

/**
 * Extrahiert Impressumsdaten von einer Amazon-Seller-Profilseite.
 */
async function extractImpressum(page) {
    const result = { companyName: '', email: '', phone: '', address: '', ustId: '' };

    try {
        // Impressum/Detail-Link anklicken falls vorhanden
        const detailLink = await page.$('a:has-text("Impressum"), a:has-text("Detaillierte Verkäuferinformationen"), a:has-text("Geschäftsadresse")');
        if (detailLink) {
            await detailLink.click();
            await page.waitForTimeout(2000);
        }

        // FIX: Gezielt den Seller-Info-Bereich extrahieren, NICHT den ganzen Body
        const pageText = await page.evaluate(() => {
            // Prioritätsreihenfolge: spezifische Seller-Info-Container
            const selectors = [
                '#page-section-detail-seller-info',
                '#seller-profile-container',
                '.a-box-group',
                '#spp-expander-container',
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText.trim().length > 50) return el.innerText;
            }
            // Fallback: Alle .a-section Elemente zusammenfassen (nicht body!)
            const sections = document.querySelectorAll('.a-section');
            let text = '';
            sections.forEach(s => { text += s.innerText + '\n'; });
            return text || document.body.innerText;
        });

        // E-Mail (Amazon-eigene ausfiltern!)
        const emails = pageText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
        const sellerEmail = emails.find(e => !e.toLowerCase().includes('amazon'));
        if (sellerEmail) result.email = sellerEmail.trim();

        // Telefon
        const phoneMatch = pageText.match(/(?:Tel(?:efon)?\.?:?\s*|Phone:?\s*|Fon:?\s*|Mobil:?\s*)(\+?[\d\s\-\/\(\)]{7,20})/i);
        if (phoneMatch) result.phone = phoneMatch[1].trim().replace(/\s+/g, ' ');

        // USt-ID
        const ustMatch = pageText.match(/(?:USt\.?-?Id[^\n]*?:?\s*|VAT[^\n]*?:?\s*)(DE\d{9})/i);
        if (ustMatch) result.ustId = ustMatch[1].trim();

        // Firmenname
        const lines = pageText.split('\n').map(l => l.trim()).filter(l => l.length > 3);
        const companyLine = lines.find(l =>
            /\b(gmbh|kg|ag|e\.k\.?|gbr|ug|ohg|ltd|inc|s\.r\.l|b\.v)\b/i.test(l)
        );
        if (companyLine) result.companyName = companyLine;

        // Adresse (PLZ-Muster)
        const addressMatch = pageText.match(/([A-Za-zäöüÄÖÜß\s\-\.]+\d*[,\s]+\d{5}\s+[A-Za-zäöüÄÖÜß\s\-]+)/);
        if (addressMatch) result.address = addressMatch[1].trim().replace(/\s+/g, ' ');

    } catch (err) {
        log.warning(`⚠️ Impressum-Extraktion fehlgeschlagen: ${err.message}`);
    }
    return result;
}