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
        maxConcurrency: 1,            // Reduziert auf 1 wegen Memory-Overload (1GB Limit)
        requestHandlerTimeoutSecs: 120,
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
                    '--disable-extensions',
                ],
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
                log.error('⚠️ Amazon Captcha erkannt! Proxy wechseln...');
                throw new Error('CAPTCHA detected');
            }

            // ── SUCHERGEBNISSEITE ────────────────────────────────────────────
            if (type === 'SEARCH_PAGE') {
                log.info(`📄 Suchergebnisseite ${pageNum}: ${request.url}`);
                await page.waitForSelector('.s-result-item, [data-component-type="s-search-result"]', { timeout: 20000 }).catch(() => {});

                const productUrls = await page.evaluate(() => {
                    const links = [];
                    // Versuche verschiedene Selektoren für Suchergebnisse
                    const resultItems = document.querySelectorAll('[data-component-type="s-search-result"], .s-result-item[data-asin], div[data-asin]');
                    
                    resultItems.forEach(item => {
                        const linkEl = item.querySelector('h2 a[href*="/dp/"], a.a-link-normal[href*="/dp/"]');
                        if (linkEl) {
                            const href = linkEl.getAttribute('href');
                            if (href && href.includes('/dp/') && !href.includes('slredirect')) {
                                const clean = href.startsWith('http') ? href : `https://www.amazon.de${href}`;
                                links.push(clean.split('?')[0]);
                            }
                        }
                    });

                    // Fallback
                    if (links.length === 0) {
                        document.querySelectorAll('a[href*="/dp/"]').forEach(el => {
                            const href = el.getAttribute('href');
                            if (href && !href.includes('slredirect') && !href.includes('picassoRedirect')) {
                                const clean = href.startsWith('http') ? href : `https://www.amazon.de${href}`;
                                links.push(clean.split('?')[0]);
                            }
                        });
                    }

                    return [...new Set(links)].slice(0, 15);
                });
                log.info(`🔗 ${productUrls.length} Produkt-URLs auf Seite ${pageNum} gefunden.`);

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
                await page.waitForSelector('#dp, #ppd, #merchant-info', { timeout: 15000 }).catch(() => {});

                const sellerInfo = await page.evaluate(() => {
                    const trigger = document.querySelector('#sellerProfileTriggerId');
                    if (trigger) {
                        const href = trigger.getAttribute('href') || '';
                        const m = href.match(/seller=([A-Z0-9]+)/);
                        if (m) return { sellerId: m[1], sellerName: trigger.textContent.trim() };
                    }
                    const merchant = document.querySelector('#merchant-info');
                    if (merchant) {
                        const link = merchant.querySelector('a[href*="/sp?"]');
                        if (link) {
                            const href = link.getAttribute('href') || '';
                            const m = href.match(/seller=([A-Z0-9]+)/);
                            if (m) return { sellerId: m[1], sellerName: link.textContent.trim() };
                        }
                    }
                    const buyBox = document.querySelector('#tabular-buybox, #desktop_buybox');
                    if (buyBox) {
                        const link = buyBox.querySelector('a[href*="seller="]');
                        if (link) {
                            const href = link.getAttribute('href') || '';
                            const m = href.match(/seller=([A-Z0-9]+)/);
                            const name = link.textContent.trim();
                            if (m && name && name !== 'Details' && name.length > 1) {
                                return { sellerId: m[1], sellerName: name };
                            }
                        }
                    }
                    return null;
                });

                if (!sellerInfo?.sellerId) return;

                const nameLower = sellerInfo.sellerName.toLowerCase();
                if (nameLower.includes('amazon') || nameLower === 'details') {
                    return;
                }

                if (enqueuedSellerIds.has(sellerInfo.sellerId) || collectedSellers.has(sellerInfo.sellerId)) return;
                enqueuedSellerIds.add(sellerInfo.sellerId);

                log.info(`🔍 Seller gefunden: ${sellerInfo.sellerName} (${sellerInfo.sellerId})`);
                await crawler.addRequests([{
                    url: `https://www.amazon.de/sp?seller=${sellerInfo.sellerId}&marketplaceID=A1PA6795UKMFR9`,
                    userData: { 
                        type: 'SELLER_PROFILE', 
                        sellerId: sellerInfo.sellerId, 
                        sellerName: sellerInfo.sellerName, 
                        category: categoryName 
                    },
                }]);

            // ── SELLER-PROFILSEITE ───────────────────────────────────────────
            } else if (type === 'SELLER_PROFILE') {
                if (collectedSellers.size >= maxSellers) return;
                const { sellerId, sellerName } = request.userData;
                log.info(`👤 Händler-Profil wird analysiert: ${sellerName} (${sellerId})`);

                await page.waitForSelector('#seller-profile-container, #page-section-detail-seller-info, .seller-info, .a-box', { timeout: 20000 }).catch(() => {});
                
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
                
                // SOFORT SPEICHERN
                await Actor.pushData(sellerData);
                
                log.info(`✅ [${collectedSellers.size}/${maxSellers}] GESPEICHERT: ${sellerData.sellerName} | 📧 ${sellerData.email || '—'}`);
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
        // Prüfen ob wir schon auf der richtigen Unterseite sind oder klicken müssen
        const detailLink = await page.$('a:has-text("Impressum"), a:has-text("Detaillierte Verkäuferinformationen"), a:has-text("Geschäftsadresse")');
        if (detailLink) {
            await detailLink.click().catch(() => {});
            await page.waitForTimeout(2000); // Kurz warten auf JS-Update
        }

        const data = await page.evaluate(() => {
            const getEmail = (text) => {
                const emails = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
                return emails.find(e => !e.toLowerCase().includes('amazon')) || '';
            };

            const getPhone = (text) => {
                const m = text.match(/(?:Tel(?:efon)?\.?:?\s*|Phone:?\s*|Fon:?\s*|Mobil:?\s*)(\+?[\d\s\-\/\(\)]{7,20})/i);
                return m ? m[1].trim().replace(/\s+/g, ' ') : '';
            };

            const getUst = (text) => {
                const m = text.match(/(?:USt\.?-?Id[^\n]*?:?\s*|VAT[^\n]*?:?\s*)(DE\d{9})/i);
                return m ? m[1].trim() : '';
            };

            const getAddress = (text) => {
                const m = text.match(/([A-Za-zäöüÄÖÜß\s\-\.]+\d*[,\s]+\d{5}\s+[A-Za-zäöüÄÖÜß\s\-]+)/);
                return m ? m[1].trim().replace(/\s+/g, ' ') : '';
            };

            const getCompany = (text) => {
                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
                return lines.find(l => /\b(gmbh|kg|ag|e\.k\.?|gbr|ug|ohg|ltd|inc|s\.r\.l|b\.v)\b/i.test(l)) || '';
            };

            // Suche in spezifischen Containern
            const container = document.querySelector('#page-section-detail-seller-info') || 
                              document.querySelector('#seller-profile-container') || 
                              document.querySelector('.a-box-group') ||
                              document.body;
            
            const text = container.innerText;
            return {
                email: getEmail(text),
                phone: getPhone(text),
                ustId: getUst(text),
                address: getAddress(text),
                companyName: getCompany(text)
            };
        });

        Object.assign(result, data);

    } catch (err) {
        log.warning(`⚠️ Impressum-Extraktion fehlgeschlagen: ${err.message}`);
    }
    return result;
}