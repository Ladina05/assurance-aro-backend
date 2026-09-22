const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const prisma = require('../prismaClient');
const { authenticate } = require('../middleware/auth');
const { formatMontantFR } = require('../utils/format');

const router = express.Router();

async function getEvolutionData(rg, annee) {
  const compteur = await prisma.compteur.findFirst({
    where: { rg: rg.toString() }
  });

  if (!compteur) return null;

  const factures = await prisma.facture.findMany({
    where: {
      payee: true,
      annee: parseInt(annee),
      sousCompteur: {
        compteurId: compteur.id
      }
    },
    include: {
      sousCompteur: {
        include: {
          compteur: true
        }
      }
    }
  });

  const statistiquesMois = {};
  for (let mois = 1; mois <= 12; mois++) {
    statistiquesMois[mois] = {
      mois: mois,
      nomMois: new Date(parseInt(annee), mois - 1, 1).toLocaleString('fr-FR', { month: 'long' }),
      montant: 0
    };
  }

  factures.forEach(facture => {
    const mois = facture.mois;
    if (mois >= 1 && mois <= 12) {
      statistiquesMois[mois].montant += parseFloat(facture.montant || 0);
    }
  });

  const resultat = Object.values(statistiquesMois).map(item => ({
    mois: item.mois,
    nomMois: item.nomMois.charAt(0).toUpperCase() + item.nomMois.slice(1),
    montant: parseFloat(item.montant.toFixed(2))
  }));

  const totalAnnuel = parseFloat(resultat.reduce((sum, item) => sum + item.montant, 0).toFixed(2));

  return { compteur, resultat, totalAnnuel };
}

router.get('/evolution', authenticate, async (req, res) => {
  try {
    const { rg, annee } = req.query;

    if (!rg || !annee) {
      return res.status(400).json({
        message: 'Le RG du compteur et l\'année sont requis'
      });
    }

    const data = await getEvolutionData(rg, annee);
    if (!data) {
      return res.status(404).json({
        message: 'Compteur non trouvé avec ce RG'
      });
    }

    const { compteur, resultat, totalAnnuel } = data;

    res.json({
      compteur: {
        id: compteur.id,
        rg: compteur.rg,
        quartier: compteur.quartier,
        localisation: compteur.localisation,
        nomPropriete: compteur.nomPropriete
      },
      annee: parseInt(annee),
      statistiques: resultat,
      totalAnnuel
    });
  } catch (err) {
    console.error('Erreur statistiques évolution:', err);
    res.status(500).json({
      message: 'Erreur lors du calcul des statistiques',
      detail: err.message
    });
  }
});

router.get('/general', authenticate, async (req, res) => {
  try {
    const { annee } = req.query;
    const anneeCourante = annee ? parseInt(annee) : new Date().getFullYear();

    const factures = await prisma.facture.findMany({
      where: {
        payee: true,
        annee: anneeCourante
      },
      include: {
        sousCompteur: {
          include: {
            compteur: true
          }
        },
        batch: true
      }
    });

    const statistiquesMois = {};

    for (let mois = 1; mois <= 12; mois++) {
      statistiquesMois[mois] = {
        mois: mois,
        nomMois: new Date(anneeCourante, mois - 1, 1).toLocaleString('fr-FR', { month: 'long' }),
        montant: 0,
        nombreFactures: 0
      };
    }

    factures.forEach(facture => {
      const mois = facture.mois;
      if (mois >= 1 && mois <= 12) {
        statistiquesMois[mois].montant += parseFloat(facture.montant || 0);
        statistiquesMois[mois].nombreFactures += 1;
      }
    });

    const resultat = Object.values(statistiquesMois).map(item => ({
      mois: item.mois,
      nomMois: item.nomMois.charAt(0).toUpperCase() + item.nomMois.slice(1),
      montant: parseFloat(item.montant.toFixed(2)),
      nombrePaiements: item.nombreFactures
    }));

    const totalAnnuel = parseFloat(resultat.reduce((sum, item) => sum + item.montant, 0).toFixed(2));
    const totalPaiements = resultat.reduce((sum, item) => sum + item.nombrePaiements, 0);

    res.json({
      annee: anneeCourante,
      statistiques: resultat,
      totalAnnuel: totalAnnuel,
      totalPaiements: totalPaiements,
      moyenneMensuelle: parseFloat((totalAnnuel / 12).toFixed(2))
    });
  } catch (err) {
    console.error('Erreur statistiques générales:', err);
    res.status(500).json({
      message: 'Erreur lors du calcul des statistiques générales',
      detail: err.message
    });
  }
});

router.get('/evolution/export-excel', authenticate, async (req, res) => {
  try {
    const { rg, annee } = req.query;

    if (!rg || !annee) {
      return res.status(400).json({
        message: 'Le RG du compteur et l\'année sont requis'
      });
    }

    const data = await getEvolutionData(rg, annee);
    if (!data) {
      return res.status(404).json({
        message: 'Compteur non trouvé avec ce RG'
      });
    }

    const { compteur, resultat, totalAnnuel } = data;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Évolution des paiements');

    const titre = `Évolution des paiements - ${compteur.quartier} - ${compteur.nomPropriete} - RG: ${compteur.rg} - Année: ${annee}`;

    worksheet.mergeCells('A1:B1');
    worksheet.getCell('A1').value = titre;
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

    worksheet.addRow(['Mois', 'Montant payé (Ar)']);

    const headerRow = worksheet.getRow(2);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8F5E8' }
    };

    resultat.forEach(stat => {
      worksheet.addRow([stat.nomMois, stat.montant]);
    });

    worksheet.addRow(['TOTAL ANNÉE', totalAnnuel]);
    const totalRow = worksheet.getRow(resultat.length + 3);
    totalRow.font = { bold: true };
    totalRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD4EDDA' }
    };

    worksheet.columns = [
      { width: 20 },
      { width: 25 }
    ];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=evolution_paiements_${compteur.rg}_${annee}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Erreur export Excel:', err);
    res.status(500).json({
      message: 'Erreur lors de l\'export Excel',
      detail: err.message
    });
  }
});

router.get('/evolution/export-pdf', authenticate, async (req, res) => {
  try {
    const { rg, annee } = req.query;

    if (!rg || !annee) {
      return res.status(400).json({
        message: 'Le RG du compteur et l\'année sont requis'
      });
    }

    const data = await getEvolutionData(rg, annee);
    if (!data) {
      return res.status(404).json({
        message: 'Compteur non trouvé avec ce RG'
      });
    }

    const { compteur, resultat, totalAnnuel } = data;

    const doc = new PDFDocument({ margin: 40 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=evolution_paiements_${compteur.rg}_${annee}.pdf`);

    doc.pipe(res);

    const titre = `Évolution des paiements - Année ${annee}`;
    const sousTitre = `${compteur.quartier} - ${compteur.nomPropriete} - RG: ${compteur.rg}`;

    doc.fontSize(18).font('Helvetica-Bold').text(titre, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica').text(sousTitre, { align: 'center' });
    doc.moveDown(1);

    const startX = 50;
    const colWidths = [200, 150];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    const rowHeight = 25;
    const headerHeight = 30;

    let yPosition = doc.y;

    doc.rect(startX, yPosition, tableWidth, headerHeight).stroke();
    doc.rect(startX, yPosition + headerHeight, tableWidth, rowHeight * (resultat.length + 1)).stroke();

    doc.rect(startX, yPosition, colWidths[0], headerHeight).fillAndStroke('#f8f9fa', '#000');
    doc.rect(startX + colWidths[0], yPosition, colWidths[1], headerHeight).fillAndStroke('#f8f9fa', '#000');

    doc.fontSize(10).font('Helvetica-Bold');
    doc.fillColor('#000');
    doc.text('Mois', startX + 10, yPosition + 10, { width: colWidths[0] - 20, align: 'left' });
    doc.text('Montant payé (Ar)', startX + colWidths[0] + 10, yPosition + 10, { width: colWidths[1] - 20, align: 'right' });

    yPosition += headerHeight;

    doc.fontSize(10).font('Helvetica');

    resultat.forEach((stat) => {
      doc.moveTo(startX, yPosition).lineTo(startX + tableWidth, yPosition).stroke();
      doc.moveTo(startX + colWidths[0], yPosition).lineTo(startX + colWidths[0], yPosition + rowHeight).stroke();

      doc.text(stat.nomMois, startX + 10, yPosition + 8, {
        width: colWidths[0] - 20,
        align: 'left'
      });

      doc.text(formatMontantFR(stat.montant), startX + colWidths[0] + 10, yPosition + 8, {
        width: colWidths[1] - 20,
        align: 'right'
      });

      yPosition += rowHeight;
    });

    doc.moveTo(startX, yPosition).lineTo(startX + tableWidth, yPosition).stroke();

    doc.rect(startX, yPosition, colWidths[0], rowHeight).fillAndStroke('#e8f5e8', '#000');
    doc.rect(startX + colWidths[0], yPosition, colWidths[1], rowHeight).fillAndStroke('#e8f5e8', '#000');

    doc.fontSize(11).font('Helvetica-Bold');
    doc.text('TOTAL ANNÉE', startX + 10, yPosition + 8, {
      width: colWidths[0] - 20,
      align: 'left'
    });

    doc.text(formatMontantFR(totalAnnuel), startX + colWidths[0] + 10, yPosition + 8, {
      width: colWidths[1] - 20,
      align: 'right'
    });

    doc.moveTo(startX, yPosition + rowHeight).lineTo(startX + tableWidth, yPosition + rowHeight).stroke();

    doc.end();
  } catch (err) {
    console.error('Erreur export PDF:', err);
    res.status(500).json({
      message: 'Erreur lors de l\'export PDF',
      detail: err.message
    });
  }
});

module.exports = router;
