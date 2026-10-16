const PDFDocument = require('pdfkit');

function formatMoney(value) {
  return Number(value || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildQuotePdfBuffer({ customerName, recipient, concept, areaM2, items, total, message = '' }) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'LETTER', margins: { top: 42, bottom: 42, left: 44, right: 44 }, info: { Title: `Cotización - ${concept}`, Author: 'Recubrimientos Diego S.A.' } });
    const chunks = [];
    const pageWidth = document.page.width;
    const left = 44;
    const tableWidth = pageWidth - 88;
    const columns = [
      { title: 'Tipo', width: 78, align: 'left' },
      { title: 'Descripción', width: 178, align: 'left' },
      { title: 'Cantidad', width: 70, align: 'right' },
      { title: 'Precio unitario', width: 96, align: 'right' },
      { title: 'Subtotal', width: 102, align: 'right' }
    ];

    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);

    const drawPageHeading = () => {
      document.rect(0, 0, pageWidth, 88).fill('#D96D5C');
      document.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(23).text('COTIZACIÓN', left, 23, { lineBreak: false });
      document.fillColor('#FFF2EF').font('Helvetica').fontSize(10).text('Recubrimientos Diego S.A.', left, 55, { lineBreak: false });
      document.fillColor('#1A2C3D').font('Helvetica').fontSize(10);
      document.y = 108;
    };

    const drawTableHeading = () => {
      const top = document.y;
      document.rect(left, top, tableWidth, 28).fill('#EEF2F5');
      let x = left;
      columns.forEach((column) => {
        document.fillColor('#33495B').font('Helvetica-Bold').fontSize(8.5)
          .text(column.title, x + 5, top + 9, { width: column.width - 10, align: column.align, lineBreak: false });
        x += column.width;
      });
      document.y = top + 28;
    };

    const startContinuationPage = () => {
      document.addPage();
      drawPageHeading();
      document.fillColor('#5C6D7D').font('Helvetica').fontSize(9).text('Detalle de cotización (continuación)', left, document.y);
      document.moveDown(0.8);
      drawTableHeading();
    };

    try {
      drawPageHeading();
      const dateLabel = new Intl.DateTimeFormat('es-GT', { dateStyle: 'long', timeZone: 'America/Guatemala' }).format(new Date());
      document.fillColor('#5C6D7D').font('Helvetica').fontSize(9).text(dateLabel, left, document.y, { align: 'right', width: tableWidth });
      document.moveDown(1.1);
      document.fillColor('#1A2C3D').font('Helvetica-Bold').fontSize(10).text('Preparada para', left, document.y);
      document.font('Helvetica').fontSize(11).text(customerName, left, document.y + 4);
      document.fillColor('#5C6D7D').fontSize(9).text(recipient, left, document.y + 3);
      document.moveDown(1.4);
      document.fillColor('#1A2C3D').font('Helvetica-Bold').fontSize(16).text(concept, left, document.y, { width: tableWidth });
      document.moveDown(0.6);
      document.fillColor('#1A2C3D').font('Helvetica-Bold').fontSize(10).text(`Área a pintar: ${Number(areaM2).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m²`, left, document.y);
      document.moveDown(0.8);
      if (message) {
        document.fillColor('#435666').font('Helvetica').fontSize(9.5).text(message, left, document.y, { width: tableWidth, lineGap: 2 });
        document.moveDown(0.8);
      }
      const groups = items.reduce((result, item) => {
        (result[item.tipo] ||= []).push(item);
        return result;
      }, {});
      Object.entries(groups).forEach(([kind, groupItems]) => {
        if (document.y + 48 > document.page.height - 42) startContinuationPage();
        document.moveDown(0.6);
        document.fillColor('#1A2C3D').font('Helvetica-Bold').fontSize(11).text(kind, left, document.y);
        document.moveDown(0.4);
        drawTableHeading();
        groupItems.forEach((item) => {
        const descriptionHeight = document.heightOfString(item.descripcion, { width: columns[1].width - 12, font: 'Helvetica', fontSize: 9 });
        const typeHeight = document.heightOfString(item.tipo, { width: columns[0].width - 12, font: 'Helvetica', fontSize: 8.5 });
        const rowHeight = Math.max(30, descriptionHeight, typeHeight) + 12;
        if (document.y + rowHeight + 94 > document.page.height - 42) {
          startContinuationPage();
          document.fillColor('#1A2C3D').font('Helvetica-Bold').fontSize(11).text(`${kind} (continuación)`, left, document.y);
          document.moveDown(0.4);
          drawTableHeading();
        }

        const top = document.y;
        document.rect(left, top, tableWidth, rowHeight).stroke('#DDE4E9');
        const values = [
          item.tipo,
          item.descripcion,
          `${Number(item.cantidad).toLocaleString('es-GT', { maximumFractionDigits: 2 })} ${item.unidad}`,
          `Q ${formatMoney(item.precio_unitario)}`,
          `Q ${formatMoney(item.subtotal)}`
        ];
        let x = left;
        values.forEach((value, index) => {
          const column = columns[index];
          document.fillColor('#263B4B').font(index === 4 ? 'Helvetica-Bold' : 'Helvetica').fontSize(index === 0 ? 8.5 : 9)
            .text(String(value), x + 5, top + 6, { width: column.width - 10, height: rowHeight - 10, align: column.align, lineGap: 1 });
          x += column.width;
        });
        document.y = top + rowHeight;
        });
      });

      if (document.y + 76 > document.page.height - 42) startContinuationPage();
      document.moveDown(1.1);
      const totalTop = document.y;
      document.roundedRect(pageWidth - left - 240, totalTop, 240, 58, 8).fill('#FCE7E4');
      document.fillColor('#5C6D7D').font('Helvetica').fontSize(9).text('TOTAL COTIZADO', pageWidth - left - 226, totalTop + 11, { width: 212, align: 'right' });
      document.fillColor('#1A2C3D').font('Helvetica-Bold').fontSize(18).text(`Q ${formatMoney(total)}`, pageWidth - left - 226, totalTop + 27, { width: 212, align: 'right' });
      document.y = totalTop + 72;
      document.fillColor('#687987').font('Helvetica').fontSize(8.5)
        .text('La cotización se preparó con base en las partidas indicadas y puede estar sujeta a confirmación de los detalles del trabajo.', left, document.y, { width: tableWidth, lineGap: 2 });
      document.end();
    } catch (error) {
      document.destroy();
      reject(error);
    }
  });
}

module.exports = { buildQuotePdfBuffer };
