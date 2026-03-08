// Lightweight PDF generator (manual) — single-page invoice with a fixed layout.
const EOL = '\n';

const escapeText = (str) => String(str || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const formatCurrency = (n) => `₹${Number(n || 0).toFixed(2)}`;
const textAbs = (txt, x, y, size = 10) => `1 0 0 1 ${x} ${y} Tm /F1 ${size} Tf (${escapeText(txt)}) Tj${EOL}`;
const moveTo = (x, y) => `${x} ${y} m${EOL}`;
const lineTo = (x, y) => `${x} ${y} l${EOL}`;

const buildInvoicePdf = (order) => {
    const customer = order.customerId || {};
    const billTo = [
        customer.name || 'Customer',
        customer.email || '',
        customer.phone || '',
    ].filter(Boolean).join(', ');
    const invoiceNo = order.orderNumber || order._id;

    let content = 'BT' + EOL;
    let y = 760;
    const add = (t, x, size = 10, step = 14) => { content += textAbs(t, x, y, size); y -= step; };

    // Header with brand + invoice meta
    add('ZOMITRON', 50, 18, 20);
    add('INVOICE', 50, 14, 18);
    add(`Invoice No: ${invoiceNo}`, 50, 11, 14);
    add(`Date: ${new Date(order.createdAt).toLocaleString()}`, 50, 11, 14);
    add(`Payment: ${order.paymentMethod || 'N/A'} (${order.paymentStatus || 'pending'})`, 50, 11, 14);
    add(`Bill To: ${billTo}`, 50, 11, 18);

    // Table coordinates
    const colItemX = 55;
    const colQtyX = 320;
    const colPriceX = 380;
    const colSubX = 470;
    const tableTop = 640;
    y = tableTop;

    // Table header
    add('Item', colItemX, 11, 14);
    add('Qty', colQtyX, 11, 14);
    add('Price', colPriceX, 11, 14);
    add('Subtotal', colSubX, 11, 14);

    // Items
    (order.items || []).forEach((it) => {
        const title = (it.title || '').slice(0, 60);
        y -= 16;
        content += textAbs(title, colItemX, y, 10);
        content += textAbs(String(it.qty || 0), colQtyX, y, 10);
        content += textAbs(formatCurrency(it.price || 0), colPriceX, y, 10);
        content += textAbs(formatCurrency(it.subtotal || (it.price || 0) * (it.qty || 0)), colSubX, y, 10);
    });

    // Totals block under table
    y -= 24;
    content += textAbs(`Subtotal: ${formatCurrency(order.subtotal)}`, colPriceX, y, 11);
    y -= 14;
    content += textAbs(`Delivery: ${formatCurrency(order.deliveryCharge)}`, colPriceX, y, 11);
    y -= 14;
    content += textAbs(`Discount: -${formatCurrency(order.discount)}`, colPriceX, y, 11);
    y -= 16;
    content += textAbs(`Total: ${formatCurrency(order.total)}`, colPriceX, y, 12);

    content += 'ET';

    // Draw table lines
    let graphics = '';
    const topTableY = tableTop + 6;
    const bottomY = y - 10;
    const drawLine = (x1, y1, x2, y2) => { graphics += moveTo(x1, y1) + lineTo(x2, y2); };
    drawLine(40, topTableY, 560, topTableY);
    drawLine(40, bottomY, 560, bottomY);
    // Vertical separators
    [300, 360, 450].forEach((x) => drawLine(x, topTableY, x, bottomY));

    const graphicsStream = `q 0.7 w${EOL}${graphics}S Q`;

    // Assemble PDF objects
    const contents = `${graphicsStream}${EOL}${content}`;
    const len = Buffer.byteLength(contents, 'utf8');

    const objects = [];
    const addObj = (str) => { objects.push(str); return objects.length; };
    addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 1 font
    const fontId = 1;
    addObj(`<< /Length ${len} >>${EOL}stream${EOL}${contents}${EOL}endstream`); // 2 content
    const contentId = 2;
    addObj(`<< /Type /Page /Parent 5 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`); // 3 page
    const pageId = 3;
    addObj(`<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`); // 4 pages
    const pagesId = 4;
    addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`); // 5 catalog

    let offset = 9; // "%PDF-1.4\n"
    const xref = ['0 6'];
    const body = [];
    objects.forEach((obj, idx) => {
        const ref = `${idx + 1} 0 obj${EOL}${obj}${EOL}endobj${EOL}`;
        xref.push(String(offset).padStart(10, '0') + ' 00000 n ');
        body.push(ref);
        offset += Buffer.byteLength(ref, 'utf8');
    });
    const xrefOffset = offset;
    const xrefTable = `xref${EOL}${xref[0]}${EOL}${xref.slice(1).join(EOL)}${EOL}trailer<< /Size 6 /Root 5 0 R >>${EOL}startxref${EOL}${xrefOffset}${EOL}%%EOF`;
    const pdfString = `%PDF-1.4${EOL}${body.join('')}${xrefTable}`;
    return Buffer.from(pdfString, 'utf8');
};

module.exports = { buildInvoicePdf };
