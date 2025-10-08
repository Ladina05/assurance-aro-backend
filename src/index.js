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
app.put('/api/compteurs/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = req.body;
    const updated = await prisma.compteur.update({
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
      },
      include: { sousCompteurs: true }
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: 'Erreur mise à jour compteur', detail: err.message });
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

// GET batch PDF
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

    doc.fontSize(18).text('ASSURANCE ARO', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(14).text(`Reçu de Paiement #${id}`, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(12).text(`Date: ${new Date(batch.date).toLocaleString()}`);
    doc.text(`Total: ${batch.total.toLocaleString()} Ar`).moveDown(1);

    batch.payments.forEach((p, i) => {
      const c = p.compteur;
      doc.text(`${i + 1}. ${c.nomPropriete} (${c.codeImmeuble})`);
      doc.text(`   Adresse : ${c.adresse}, ${c.province}`);
      doc.text(`   N° Compteur : ${p.numeroFacture ?? 'N/A'}`);
      doc.text(`   Montant : ${p.montant?.toLocaleString()} Ar`).moveDown(0.5);
    });

    doc.end();
  } catch (err) {
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
