require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./prismaClient');
const bodyParser = require('express').json;
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(bodyParser());

/* ===============================
   🔹 CRUD Compteur + SousCompteur
================================= */

// GET compteurs
app.get('/api/compteurs', async (req, res) => {
  try {
    const loueParam = req.query.loue;
    const where = {};
    if (loueParam === 'true') where.loue = true;
    if (loueParam === 'false') where.loue = false;

    const compteurs = await prisma.compteur.findMany({
      where,
      include: { sousCompteurs: true },
      orderBy: { id: 'asc' }
    });
    res.json(compteurs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// POST compteur
app.post('/api/compteurs', async (req, res) => {
  try {
    const { quartier, localisation, loue, codeImmeuble, nomPropriete, rg, typeBien, province, adresse, sousCompteurs } = req.body;
    const newC = await prisma.compteur.create({
      data: {
        quartier,
        localisation,
        loue: !!loue,
        codeImmeuble,
        nomPropriete,
        rg,
        typeBien,
        province,
        adresse,
        sousCompteurs: { create: sousCompteurs || [] }
      },
      include: { sousCompteurs: true }
    });
    res.status(201).json(newC);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: 'Erreur création compteur', detail: err.message });
  }
});

// PUT compteur
// PUT compteur (avec mise à jour des sous-compteurs)
app.put('/api/compteurs/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = req.body;

    const updated = await prisma.$transaction(async (tx) => {
      // 1️⃣ Met à jour le compteur principal
      const compteur = await tx.compteur.update({
        where: { id },
        data: {
          quartier: data.quartier,
          localisation: data.localisation,
          loue: data.loue ?? undefined,
          codeImmeuble: data.codeImmeuble,
          nomPropriete: data.nomPropriete,
          rg: data.rg,
          typeBien: data.typeBien,
          province: data.province,
          adresse: data.adresse
        }
      });

      // 2️⃣ Supprime les anciens sous-compteurs
      await tx.sousCompteur.deleteMany({ where: { compteurId: id } });

      // 3️⃣ Ajoute les nouveaux sous-compteurs
      if (Array.isArray(data.sousCompteurs) && data.sousCompteurs.length > 0) {
        await tx.sousCompteur.createMany({
          data: data.sousCompteurs.map(sc => ({
            numeroCompteur: sc.numeroCompteur,
            compteurId: id
          }))
        });
      }

      // 4️⃣ Retourne le compteur avec ses nouveaux sous-compteurs
      return tx.compteur.findUnique({
        where: { id },
        include: { sousCompteurs: true }
      });
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(400).json({
      message: 'Erreur mise à jour compteur',
      detail: err.message
    });
  }
});

// DELETE compteur
app.delete('/api/compteurs/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.sousCompteur.deleteMany({ where: { compteurId: id } });
    await prisma.compteur.delete({ where: { id } });
    res.json({ message: 'Supprimé' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: 'Erreur suppression', detail: err.message });
  }
});

/* ===============================
   🔹 CRUD SousCompteurs
================================= */

// POST sous-compteur
app.post('/api/souscompteurs', async (req, res) => {
  try {
    const { compteurId, numeroCompteur, numeroFacture, montant } = req.body;
    const newSous = await prisma.sousCompteur.create({
      data: { compteurId, numeroCompteur, numeroFacture, montant }
    });
    res.status(201).json(newSous);
  } catch (err) {
    res.status(400).json({ message: 'Erreur création sous-compteur', detail: err.message });
  }
});

// PUT sous-compteur
app.put('/api/souscompteurs/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { numeroFacture, montant } = req.body;
    const updated = await prisma.sousCompteur.update({
      where: { id },
      data: { numeroFacture: numeroFacture ?? null, montant: montant ?? null }
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: 'Erreur mise à jour sous-compteur', detail: err.message });
  }
});

/* ===============================
   🔹 Paiement / Historique / PDF
================================= */

// POST paiement batch
app.post('/api/payment-batches', async (req, res) => {
  try {
    const compteurs = await prisma.compteur.findMany({
      where: { loue: false },
      include: { sousCompteurs: true }
    });

    const sousCompteurs = compteurs.flatMap(c => c.sousCompteurs).filter(s => s.montant && s.montant > 0);
    if (sousCompteurs.length === 0)
      return res.status(400).json({ message: 'Aucun montant à payer' });

    const total = sousCompteurs.reduce((sum, s) => sum + s.montant, 0);

    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.paymentBatch.create({ data: { total } });
      for (const s of sousCompteurs) {
        await tx.payment.create({
          data: { montant: s.montant, numeroFacture: s.numeroFacture,numeroCompteur: s.numeroCompteur, compteurId: s.compteurId, batchId: batch.id }
        });
        await tx.sousCompteur.update({ where: { id: s.id }, data: { montant: null, numeroFacture: null } });
      }
      return batch;
    });

    res.status(201).json({ message: 'Paiement effectué', batch: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur paiement', detail: err.message });
  }
});

// GET batches
app.get('/api/payment-batches', async (req, res) => {
  try {
    const batches = await prisma.paymentBatch.findMany({ orderBy: { date: 'desc' } });
    res.json(batches);
  } catch (err) {
    res.status(500).json({ message: 'Erreur récupération historique' });
  }
});

// GET batch details
app.get('/api/payment-batches/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({
      where: { id },
      include: { payments: { include: { compteur: true } } }
    });
    res.json(batch);
  } catch (err) {
    res.status(500).json({ message: 'Erreur récupération batch' });
  }
});

// GET batch PDF structuré et corrigé
app.get('/api/payment-batches/:id/pdf', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({
      where: { id },
      include: { payments: { include: { compteur: true } } }
    });
    if (!batch) return res.status(404).json({ message: 'Batch non trouvé' });

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=batch_${id}.pdf`);
    doc.pipe(res);

    // ======== Fonctions utilitaires ========
    const startX = 40;
    const colWidths = [90, 120, 70, 100, 100];
    const headers = ['Quartier', 'Adresse', 'RG', 'N° Facture', 'Montant'];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    function formatMontant(valeur) {
      const montant = typeof valeur === 'number' ? valeur : 0;
      return montant.toLocaleString('fr-FR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).replace(/\//g, '').replace(/\u00A0/g, ' ');
    }

    function drawHorizontalLine(yPos) {
      doc.moveTo(startX, yPos).lineTo(startX + tableWidth, yPos).stroke();
    }

    function drawVerticalLines(yTop, yBottom) {
      let x = startX;
      for (let width of colWidths) {
        doc.moveTo(x, yTop).lineTo(x, yBottom).stroke();
        x += width;
      }
      doc.moveTo(startX + tableWidth, yTop).lineTo(startX + tableWidth, yBottom).stroke();
    }

    // ======== En-tête PDF ========
    const dateBatch = new Date(batch.date);
    const mois = dateBatch.toLocaleString('fr-FR', { month: 'long' });
    const annee = dateBatch.getFullYear();

    doc.fontSize(14).font('Helvetica-Bold').text('Note: Département comptabilité Générales ARO', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).text(`OBJET: FACTURE JIRAMA MOIS de ${mois.toUpperCase()} ${annee}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).text(
      `Veuillez émettre à l'ordre de la JIRAMA un chèque de ${formatMontant(batch.total)} Ariary en règlement des factures ci-après énumérées.`,
      { align: 'center' }
    );
    doc.moveDown(1.5);

    // ======== Tri par quartier ========
    const paiementsTries = batch.payments.sort((a, b) => {
      const q1 = a.compteur.quartier?.toLowerCase() || '';
      const q2 = b.compteur.quartier?.toLowerCase() || '';
      return q1.localeCompare(q2);
    });

    // ======== Tableau ========
    let y = doc.y + 10;

    // En-têtes en gras
    doc.font('Helvetica-Bold').fontSize(11);
    drawHorizontalLine(y);
    let x = startX;
    headers.forEach((h, i) => {
      doc.text(h, x, y + 5, { width: colWidths[i], align: 'center' });
      x += colWidths[i];
    });
    y += 20;
    drawHorizontalLine(y);
    drawVerticalLines(y - 20, y);

    // Contenu en normal, sous-totaux en gras
    doc.font('Helvetica').fontSize(10);
    let currentQuartier = null;
    let sousTotal = 0;
    let yStartQuartier = y;

    for (let p of paiementsTries) {
      const c = p.compteur;
      const quartier = c.quartier || 'Non défini';

      // Sous-total si changement de quartier
      if (currentQuartier && currentQuartier !== quartier) {
        y += 4;
        drawHorizontalLine(y);
        y += 4;

        x = startX;
        for (let i = 0; i < 3; i++) { doc.text('', x, y, { width: colWidths[i], align: 'center' }); x += colWidths[i]; }
        doc.font('Helvetica-Bold').text('Sous-total', x, y, { width: colWidths[3], align: 'center' });
        x += colWidths[3];
        doc.text(formatMontant(sousTotal), x, y, { width: colWidths[4], align: 'center' });

        y += 16;
        drawHorizontalLine(y);
        drawVerticalLines(yStartQuartier, y);
        yStartQuartier = y;
        sousTotal = 0;
      }

      currentQuartier = quartier;
      sousTotal += p.montant || 0;

      // Ligne paiement en normal
      y += 4;
      x = startX;
      const cells = [
        quartier,
        c.adresse || '-',
        c.codeImmeuble || '-',
        p.numeroFacture || 'N/A',
        formatMontant(p.montant)
      ];
      doc.font('Helvetica').fontSize(10); // ligne normale
      cells.forEach((text, i) => {
        doc.text(text, x, y, { width: colWidths[i], align: 'center' });
        x += colWidths[i];
      });
      y += 16;
      drawHorizontalLine(y);
      drawVerticalLines(yStartQuartier, y);
    }

    // Dernier sous-total en gras
    y += 4;
    drawHorizontalLine(y);
    y += 4;
    x = startX;
    for (let i = 0; i < 3; i++) { doc.text('', x, y, { width: colWidths[i], align: 'center' }); x += colWidths[i]; }
    doc.font('Helvetica-Bold').text('Sous-total', x, y, { width: colWidths[3], align: 'center' });
    x += colWidths[3];
    doc.text(formatMontant(sousTotal), x, y, { width: colWidths[4], align: 'center' });
    y += 16;
    drawHorizontalLine(y);
    drawVerticalLines(yStartQuartier, y);

    // ======== Ligne TOTAL GÉNÉRAL dans le tableau ========
    y += 4;
    drawHorizontalLine(y);
    y += 4;
    x = startX;
    for (let i = 0; i < 3; i++) { doc.text('', x, y, { width: colWidths[i], align: 'center' }); x += colWidths[i]; }
    doc.font('Helvetica-Bold').text('TOTAL GÉNÉRAL', x, y, { width: colWidths[3], align: 'center' });
    x += colWidths[3];
    doc.text(formatMontant(batch.total), x, y, { width: colWidths[4], align: 'center' });
    y += 16;
    drawHorizontalLine(y);
    drawVerticalLines(yStartQuartier, y);

    y += 20; // espace après le tableau
    doc.font('Helvetica-Bold').fontSize(12).text(`Montant Total :`, startX, y, { align: 'left' });
    y += 30; // espace avant les signatures

    // ======== Signatures manuscrites ========
    y += 20;
    const signatures = [
      'Services Etudes et Travaux',
      'Services Administratif et Financiers',
      'Tolotra RANDRIANALAINA',
      'Haingo RAZAFINIAINA'
    ];

    // On élargit l'espace horizontal en utilisant 2 colonnes plus larges
    const sigColWidth = tableWidth / 2 + 20; // +20 pour plus d'espacement

    // Ligne 1 : deux premières signatures
    doc.font('Helvetica').fontSize(11);
    doc.text(signatures[0], startX, y, { width: sigColWidth, align: 'center' });
    doc.text(signatures[1], startX + sigColWidth + 20, y, { width: sigColWidth, align: 'center' });

    y += 60; // espace pour signature manuscrite

    // Ligne 2 : deux dernières signatures
    doc.text(signatures[2], startX, y, { width: sigColWidth, align: 'center' });
    doc.text(signatures[3], startX + sigColWidth + 20, y, { width: sigColWidth, align: 'center' });

    doc.end();

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur PDF', detail: err.message });
  }
});

/* ===============================
   🔹 Serveur
================================= */
app.listen(PORT, async () => {
  console.log(`✅ Serveur démarré sur http://localhost:${PORT}`);
  try {
    await prisma.$connect();
    console.log('✅ Prisma connecté à PostgreSQL');
  } catch (err) {
    console.error('❌ Erreur connexion Prisma:', err);
  }
});