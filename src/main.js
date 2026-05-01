import { Actor, log } from 'apify';
import { scrapeSellersByCategory } from './sellerScraper.js';
import { generateExcelFile } from './excelExport.js';
import { getCategoryConfig } from './categoryMap.js';

await Actor.init();

// ─── Input einlesen ───────────────────────────────────────────────────────────
const input = await Actor.getInput();

const {
    category       = 'Baumarkt',
    maxSellers     = 50,
    exportFormat   = 'both',
    proxyConfiguration,
} = input ?? {};

log.info(`🚀 Starte Amazon Seller Scraper`, { category, maxSellers });

// ─── Proxy konfigurieren ─────────────────────────────────────────────────────
const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);

// ─── Kategorie-Konfiguration laden ───────────────────────────────────────────
const categoryConfig = getCategoryConfig(category);
if (!categoryConfig) {
    throw new Error(`Unbekannte Kategorie: "${category}". Bitte eine gültige Kategorie wählen.`);
}

// ─── Scraping starten ────────────────────────────────────────────────────────
const sellers = await scrapeSellersByCategory({
    categoryConfig,
    maxSellers,
    proxyConfig,
});

log.info(`✅ Scraping abgeschlossen: ${sellers.length} Händler gefunden.`);

if (sellers.length === 0) {
    log.warning('⚠️ Keine Händler gefunden. Bitte Kategorie prüfen oder Proxy-Einstellungen anpassen.');
    await Actor.exit();
    process.exit(0);
}

// ─── Daten in Apify Dataset speichern ────────────────────────────────────────
const dataset = await Actor.openDataset();
await dataset.pushData(sellers);
log.info(`📋 ${sellers.length} Datensätze ins Dataset geschrieben.`);

// ─── Excel-Datei generieren ──────────────────────────────────────────────────
if (exportFormat === 'excel' || exportFormat === 'both') {
    const excelBuffer = await generateExcelFile(sellers, category);

    const store = await Actor.openKeyValueStore();
    await store.setValue('sellers_export.xlsx', excelBuffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const excelUrl = store.getPublicUrl('sellers_export.xlsx');
    log.info(`📊 Excel-Datei verfügbar unter: ${excelUrl}`);

    // URL auch in Dataset speichern (für Output-Tab)
    await Actor.setValue('OUTPUT', {
        message: `Scraping abgeschlossen. ${sellers.length} Händler in Kategorie "${category}" gefunden.`,
        excelDownloadUrl: excelUrl,
        totalSellers: sellers.length,
    });
}

log.info('🎉 Actor erfolgreich abgeschlossen.');
await Actor.exit();