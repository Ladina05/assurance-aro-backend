const fs = require('fs');
const path = require('path');

const lines = fs.readFileSync(path.join(__dirname, 'src', 'index.js'), 'utf8').split(/\n/);
const handlerLines = lines.slice(672, 1131); // 673-1131 inclusive (1-indexed)

let inner = handlerLines.join('\n');
inner = inner.replace(
  "app.get('/api/payment-batches/:id/pdf', authenticate, async (req, res) => {",
  ''
);
inner = inner.replace(/\}\);\s*$/, '');

const out = `const PDFDocument = require('pdfkit');
const prisma = require('../prismaClient');

async function writeBatchPdf(req, res) {
${inner}
}

module.exports = { writeBatchPdf };
`;

fs.writeFileSync(path.join(__dirname, 'src', 'utils', 'batchPdf.js'), out);
console.log('Wrote batchPdf.js, chars', out.length);
