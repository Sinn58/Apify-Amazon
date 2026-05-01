import ExcelJS from 'exceljs';

/**
 * Generiert eine formatierte Excel-Datei aus den gescrapten Händler-Daten.
 * @param {Array} sellers - Array von Händler-Objekten
 * @param {string} category - Name der gescrapten Kategorie
 * @returns {Buffer} - Excel-Datei als Buffer
 */
export async function generateExcelFile(sellers, category) {
    const workbook = new ExcelJS.Workbook();

    // ── Workbook-Metadaten ────────────────────────────────────────────────────
    workbook.creator    = 'Amazon Seller Scraper by YourBrand';
    workbook.lastModifiedBy = 'Apify Actor';
    workbook.created    = new Date();
    workbook.modified   = new Date();

    // ── Hauptblatt ───────────────────────────────────────────────────────────
    const sheet = workbook.addWorksheet(`Händler – ${category}`, {
        pageSetup: {
            paperSize: 9,           // A4
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
        },
    });

    // ── Spalten definieren ────────────────────────────────────────────────────
    sheet.columns = [
        { header: 'Nr.',              key: 'nr',          width: 6  },
        { header: 'Händlername',      key: 'sellerName',  width: 35 },
        { header: 'E-Mail',           key: 'email',       width: 35 },
        { header: 'Telefon',          key: 'phone',       width: 20 },
        { header: 'Adresse',          key: 'address',     width: 45 },
        { header: 'USt-ID',           key: 'ustId',       width: 18 },
        { header: 'Branche',          key: 'category',    width: 22 },
        { header: 'Amazon Profil',    key: 'storeUrl',    width: 55 },
        { header: 'Seller-ID',        key: 'sellerId',    width: 20 },
        { header: 'Gescrapt am',      key: 'scrapedAt',   width: 22 },
    ];

    // ── Header-Zeile stylen ───────────────────────────────────────────────────
    const headerRow = sheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell(cell => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF232F3E' }, // Amazon-Dunkelgrau
        };
        cell.font = {
            name: 'Calibri',
            bold: true,
            color: { argb: 'FFFFFFFF' },
            size: 11,
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = {
            bottom: { style: 'medium', color: { argb: 'FFFF9900' } }, // Amazon-Orange
        };
    });

    // ── Datenzeilen hinzufügen ────────────────────────────────────────────────
    sellers.forEach((seller, index) => {
        const row = sheet.addRow({
            nr:         index + 1,
            sellerName: seller.sellerName || '',
            email:      seller.email      || '',
            phone:      seller.phone      || '',
            address:    seller.address    || '',
            ustId:      seller.ustId      || '',
            category:   seller.category   || '',
            storeUrl:   seller.storeUrl   || '',
            sellerId:   seller.sellerId   || '',
            scrapedAt:  seller.scrapedAt
                ? new Date(seller.scrapedAt).toLocaleString('de-DE')
                : '',
        });

        // Zeilenabwechslung (Zebra-Streifen)
        const bgColor = index % 2 === 0 ? 'FFFFFFFF' : 'FFF7F7F7';
        row.eachCell({ includeEmpty: true }, cell => {
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: bgColor },
            };
            cell.font = { name: 'Calibri', size: 10 };
            cell.alignment = { vertical: 'middle', wrapText: false };
            cell.border = {
                bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            };
        });

        // Amazon-Profil als Hyperlink
        const urlCell = row.getCell('storeUrl');
        urlCell.value = {
            text:     seller.storeUrl || '',
            hyperlink: seller.storeUrl || '',
        };
        urlCell.font = {
            name: 'Calibri',
            size: 10,
            color: { argb: 'FF0066CC' },
            underline: true,
        };

        row.height = 20;
    });

    // ── AutoFilter aktivieren ─────────────────────────────────────────────────
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to:   { row: sellers.length + 1, column: sheet.columns.length },
    };

    // ── Erste Zeile einfrieren ────────────────────────────────────────────────
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // ── Zusammenfassungs-Blatt ────────────────────────────────────────────────
    const summarySheet = workbook.addWorksheet('Zusammenfassung');
    summarySheet.columns = [
        { header: 'Kennzahl', key: 'label', width: 35 },
        { header: 'Wert',     key: 'value', width: 25 },
    ];

    const withEmail = sellers.filter(s => s.email).length;
    const withPhone = sellers.filter(s => s.phone).length;

    const summaryData = [
        { label: 'Gesamt Händler',         value: sellers.length },
        { label: 'Branche',                value: category },
        { label: 'Mit E-Mail',             value: `${withEmail} (${Math.round(withEmail / sellers.length * 100)}%)` },
        { label: 'Mit Telefonnummer',      value: `${withPhone} (${Math.round(withPhone / sellers.length * 100)}%)` },
        { label: 'Export-Datum',           value: new Date().toLocaleString('de-DE') },
    ];

    summaryData.forEach(row => summarySheet.addRow(row));

    // Header-Stil für Summary
    summarySheet.getRow(1).eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF232F3E' } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });

    // ── Als Buffer zurückgeben ────────────────────────────────────────────────
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
}