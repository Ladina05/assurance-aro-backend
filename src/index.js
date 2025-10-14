require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./prismaClient');
const bodyParser = require('express').json;
const PDFDocument = require('pdfkit');
const authRoutes = require('./routes/auth');

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
    const { quartier, localisation, loue, codeImmeuble, nomPropriete, rg, typeBien, province, adresse, sousCompteurs, typeCompteur } = req.body;
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
        sousCompteurs: { create: sousCompteurs || [] },
        typeCompteur
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
          adresse: data.adresse,
          typeCompteur: data.typeCompteur
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

    const sousCompteurs = compteurs
      .flatMap(c => c.sousCompteurs.map(s => ({ ...s, compteur: c }))) // ✅ on attache le compteur à chaque sous-compteur
      .filter(s => s.montant != null && !isNaN(s.montant) && parseFloat(s.montant) > 0);

    if (!sousCompteurs.length)
      return res.status(400).json({ message: 'Aucun montant à payer' });

    const total = sousCompteurs.reduce((sum, s) => sum + parseFloat(s.montant), 0);

    const batch = await prisma.$transaction(async (tx) => {
      const newBatch = await tx.paymentBatch.create({ data: { total } });

      for (const s of sousCompteurs) {
        await tx.payment.create({
          data: {
            montant: parseFloat(s.montant),
            numeroFacture: s.numeroFacture,
            numeroCompteur: s.numeroCompteur,
            typeCompteur: s.compteur.typeCompteur, // ✅ correction ici
            compteurId: s.compteurId,
            batchId: newBatch.id
          }
        });

        await tx.sousCompteur.update({
          where: { id: s.id },
          data: { montant: null, numeroFacture: null }
        });
      }

      return newBatch;
    });

    res.status(201).json({ message: 'Paiement effectué', batch });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur paiement', detail: err.message });
  }
});

// GET batches
app.get('/api/payment-batches', async (req, res) => {
  try {
    const batches = await prisma.paymentBatch.findMany({ orderBy: { date: 'desc' } });
    // Prisma renvoie déjà des Float si le champ total est Float
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

    if (!batch) return res.status(404).json({ message: 'Batch non trouvé' });

    // Assurer que les montants sont bien des Float
    const paymentsWithFloat = batch.payments.map(p => ({
      ...p,
      montant: parseFloat(p.montant)
    }));

    res.json({ ...batch, payments: paymentsWithFloat, total: parseFloat(batch.total) });
  } catch (err) {
    res.status(500).json({ message: 'Erreur récupération batch' });
  }
});

// DELETE batch
app.delete('/api/payment-batches/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);

    await prisma.$transaction(async (tx) => {
      // Supprimer tous les paiements associés
      await tx.payment.deleteMany({ where: { batchId: id } });
      // Supprimer le batch
      await tx.paymentBatch.delete({ where: { id } });
    });

    res.json({ message: 'Historique supprimé' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur suppression batch', detail: err.message });
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
    const startX = 15;
    const colWidths = [90, 120, 100, 70, 100, 100];
    const headers = ['Quartier', 'Adresse', 'RG','Type', 'N° Facture', 'Montant (Ar)'];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    function formatMontant(valeur) {
      const montant = typeof valeur === 'number' ? valeur : 0;
      // Utilise le séparateur d’espace insécable correct
      return montant.toLocaleString('fr-FR', {
        style: 'decimal',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: true
      }).replace(/\u202F/g, ' '); // remplace les espaces insécables par de vrais espaces
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

    const totalGeneral = batch.payments.reduce((sum, p) => sum + (p.montant || 0), 0);

    // ======== En-tête PDF ========
    const dateBatch = new Date(batch.date);
    const mois = dateBatch.toLocaleString('fr-FR', { month: 'long' });
    const annee = dateBatch.getFullYear();

    doc.fontSize(14).font('Helvetica-Bold').text('Note: Département comptabilité Générales ARO', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).text(`OBJET: FACTURE JIRAMA MOIS de ${mois.toUpperCase()} ${annee}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).text(
      `Veuillez émettre à l'ordre de la JIRAMA un chèque de ${formatMontant(totalGeneral)} Ariary en règlement des factures ci-après énumérées.`,
      { align: 'left' }
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

    // En-têtes du tableau (gras)
    doc.font('Helvetica-Bold').fontSize(11);
    drawHorizontalLine(y);
    let x = startX;
    headers.forEach((h, i) => {
      doc.text(h, x, y + 5, { width: colWidths[i], align: 'center' });
      x += colWidths[i];
    });
    y += 20;
    drawHorizontalLine(y);
    drawVerticalLines(y - 20, y); // bordures verticales des en-têtes

    // Contenu du tableau (normal pour les lignes)
    doc.font('Helvetica').fontSize(10);
    let currentQuartier = null;
    let sousTotal = 0;
    let yStartQuartier = y;

    for (let p of paiementsTries) {
      const c = p.compteur;
      const quartier = c.quartier || 'Non défini';

      // Affiche un sous-total si on change de quartier
      if (currentQuartier && currentQuartier !== quartier) {
        y += 4;
        drawHorizontalLine(y);
        y += 4;

        // Sous-total (gras)
        x = startX;
        for (let i = 0; i < 4; i++) { doc.text('', x, y, { width: colWidths[i], align: 'center' }); x += colWidths[i]; }
        doc.font('Helvetica-Bold').text('Sous-total', x, y, { width: colWidths[4], align: 'center' });
        x += colWidths[4];
        doc.text(formatMontant(sousTotal), x, y, { width: colWidths[5], align: 'center' });

        y += 16;
        drawHorizontalLine(y);
        drawVerticalLines(yStartQuartier, y);
        yStartQuartier = y;
        sousTotal = 0;

        // Revenir au texte normal pour les lignes suivantes
        doc.font('Helvetica').fontSize(10);
      }

      currentQuartier = quartier;
      sousTotal += p.montant || 0;

      // Ligne normale du paiement (texte normal)
      y += 4;
      x = startX;
      const cells = [
        quartier,
        c.adresse || '-',
        c.rg || '-',
        c.typeCompteur || '-',
        p.numeroFacture || 'N/A',
        formatMontant(p.montant)
      ];

      cells.forEach((text, i) => {
        doc.text(text, x, y, { width: colWidths[i], align: 'center' });
        x += colWidths[i];
      });

      y += 16;
      drawHorizontalLine(y);
      drawVerticalLines(y - 20, y);
    }

    // Dernier sous-total du dernier quartier (gras)
    y += 4;
    drawHorizontalLine(y);
    y += 4;
    x = startX;
    for (let i = 0; i < 4; i++) { doc.text('', x, y, { width: colWidths[i], align: 'center' }); x += colWidths[i]; }
    doc.font('Helvetica-Bold').text('Sous-total', x, y, { width: colWidths[4], align: 'center' });
    x += colWidths[4];
    doc.text(formatMontant(sousTotal), x, y, { width: colWidths[5], align: 'center' });
    y += 16;
    drawHorizontalLine(y);
    drawVerticalLines(yStartQuartier, y);

    // Ligne TOTAL GÉNÉRAL (gras)
    y += 4;
    drawHorizontalLine(y);
    y += 4;
    x = startX;
    for (let i = 0; i < 4; i++) { doc.text('', x, y, { width: colWidths[i], align: 'center' }); x += colWidths[i]; }
    doc.font('Helvetica-Bold').text('TOTAL GÉNÉRAL', x, y, { width: colWidths[4], align: 'center' });
    x += colWidths[4];
    doc.text(formatMontant(totalGeneral), x, y, { width: colWidths[5], align: 'center' });
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

app.use('/api/auth', authRoutes);

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