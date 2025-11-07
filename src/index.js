require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./prismaClient');
const bodyParser = require('express').json;
const PDFDocument = require('pdfkit');
const authRoutes = require('./routes/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { toWords } = require('number-to-words');
const { authenticate, requireRole } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 4000;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const fileType = file.fieldname; // 'cheque' ou 'recu'
    cb(null, `batch_${req.params.id}_${fileType}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(bodyParser());

/* ===============================
   🔹 CRUD Compteur + SousCompteur
================================= */

// GET compteurs - Accessible à tous les utilisateurs connectés
app.get('/api/compteurs', authenticate, async (req, res) => {
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

// POST compteur - Admin et Inserteur seulement
app.post('/api/compteurs', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
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
        sousCompteurs: {
          create: sousCompteurs.map(sc => ({
            numeroCompteur: sc.numeroCompteur,
            typeCompteur: sc.typeCompteur || "eau"
          }))
        }
      },
      include: { sousCompteurs: true }
    });
    res.status(201).json(newC);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: 'Erreur création compteur', detail: err.message });
  }
});

// PUT compteur - Admin et Inserteur seulement
app.put('/api/compteurs/:id', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
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
            typeCompteur: sc.typeCompteur || "eau",
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

// DELETE compteur - Admin seulement
app.delete('/api/compteurs/:id', authenticate, requireRole(['ADMIN']), async (req, res) => {
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

// POST sous-compteur - Admin et Inserteur seulement
app.post('/api/souscompteurs', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
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

// PUT sous-compteur - Admin et Inserteur seulement
app.put('/api/souscompteurs/:id', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
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
   🔹 Gestion des fichiers (Chèques et Reçus)
================================= */

// Upload / Update PDF du chèque - Admin et Inserteur seulement
app.post('/api/payment-batches/:id/cheque', authenticate, requireRole(['ADMIN', 'INSERTEUR']), upload.single('cheque'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.file) return res.status(400).json({ message: "Fichier manquant" });

    const updated = await prisma.paymentBatch.update({
      where: { id },
      data: { chequePdf: req.file.filename }
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erreur upload chèque", detail: err.message });
  }
});

// Télécharger le PDF du chèque - Tous les utilisateurs connectés
app.get('/api/payment-batches/:id/cheque', authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({ where: { id } });
    if (!batch || !batch.chequePdf) return res.status(404).json({ message: "Chèque non trouvé" });

    const filePath = path.join(uploadDir, batch.chequePdf);
    res.download(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erreur téléchargement chèque", detail: err.message });
  }
});

// Supprimer le PDF du chèque - Admin seulement
app.delete('/api/payment-batches/:id/cheque', authenticate, requireRole(['ADMIN']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({ where: { id } });
    if (!batch || !batch.chequePdf) return res.status(404).json({ message: "Chèque non trouvé" });

    const filePath = path.join(uploadDir, batch.chequePdf);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await prisma.paymentBatch.update({ where: { id }, data: { chequePdf: null } });
    res.json({ message: "Chèque supprimé" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erreur suppression chèque", detail: err.message });
  }
});

// Upload / Update PDF du reçu - Admin et Inserteur seulement
app.post('/api/payment-batches/:id/recu', authenticate, requireRole(['ADMIN', 'INSERTEUR']), upload.single('recu'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.file) return res.status(400).json({ message: "Fichier manquant" });

    const updated = await prisma.paymentBatch.update({
      where: { id },
      data: { recuPdf: req.file.filename }
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erreur upload reçu", detail: err.message });
  }
});

// Télécharger le PDF du reçu - Tous les utilisateurs connectés
app.get('/api/payment-batches/:id/recu', authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({ where: { id } });
    if (!batch || !batch.recuPdf) return res.status(404).json({ message: "Reçu non trouvé" });

    const filePath = path.join(uploadDir, batch.recuPdf);
    res.download(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erreur téléchargement reçu", detail: err.message });
  }
});

// Supprimer le PDF du reçu - Admin seulement
app.delete('/api/payment-batches/:id/recu', authenticate, requireRole(['ADMIN']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({ where: { id } });
    if (!batch || !batch.recuPdf) return res.status(404).json({ message: "Reçu non trouvé" });

    const filePath = path.join(uploadDir, batch.recuPdf);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await prisma.paymentBatch.update({ where: { id }, data: { recuPdf: null } });
    res.json({ message: "Reçu supprimé" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erreur suppression reçu", detail: err.message });
  }
});

/* ===============================
   🔹 Paiement / Historique / PDF
================================= */

// POST paiement batch - Admin et Inserteur seulement
app.post('/api/payment-batches', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
  try {
    const { moisPaiement, anneePaiement } = req.body; // Récupérer le mois et l'année depuis le frontend

    const compteurs = await prisma.compteur.findMany({
      where: { loue: false },
      include: { sousCompteurs: true }
    });

    const sousCompteurs = compteurs
      .flatMap(c => c.sousCompteurs.map(s => ({ ...s, compteur: c })))
      .filter(s => s.montant != null && !isNaN(s.montant) && parseFloat(s.montant) > 0);

    if (!sousCompteurs.length)
      return res.status(400).json({ message: 'Aucun montant à payer' });

    const total = sousCompteurs.reduce((sum, s) => sum + parseFloat(s.montant), 0);

    const batch = await prisma.$transaction(async (tx) => {
      const newBatch = await tx.paymentBatch.create({
        data: {
          total,
          moisPaiement: moisPaiement || new Date().getMonth() + 1, // Défaut: mois actuel
          anneePaiement: anneePaiement || new Date().getFullYear() // Défaut: année actuelle
        }
      });

      for (const s of sousCompteurs) {
        await tx.payment.create({
          data: {
            montant: parseFloat(s.montant),
            numeroFacture: s.numeroFacture,
            numeroCompteur: s.numeroCompteur,
            typeCompteur: s.typeCompteur,
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

// GET batches - Tous les utilisateurs connectés
app.get('/api/payment-batches', authenticate, async (req, res) => {
  try {
    const batches = await prisma.paymentBatch.findMany({ orderBy: { date: 'desc' } });
    res.json(batches);
  } catch (err) {
    res.status(500).json({ message: 'Erreur récupération historique' });
  }
});

// GET batch details - Tous les utilisateurs connectés
app.get('/api/payment-batches/:id', authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({
      where: { id },
      include: { payments: { include: { compteur: true } } }
    });

    if (!batch) return res.status(404).json({ message: 'Batch non trouvé' });

    const paymentsWithFloat = batch.payments.map(p => ({
      ...p,
      montant: parseFloat(p.montant)
    }));

    res.json({ ...batch, payments: paymentsWithFloat, total: parseFloat(batch.total) });
  } catch (err) {
    res.status(500).json({ message: 'Erreur récupération batch' });
  }
});

// DELETE batch - Admin seulement
app.delete('/api/payment-batches/:id', authenticate, requireRole(['ADMIN']), async (req, res) => {
  try {
    const id = Number(req.params.id);

    await prisma.$transaction(async (tx) => {
      await tx.payment.deleteMany({ where: { batchId: id } });
      await tx.paymentBatch.delete({ where: { id } });
    });

    res.json({ message: 'Historique supprimé' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur suppression batch', detail: err.message });
  }
});

// GET batch PDF - Tous les utilisateurs connectés
app.get('/api/payment-batches/:id/pdf', authenticate, async (req, res) => {
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

    const startX = 15;
    const colWidths = [80, 80, 80, 70, 70, 90, 90];
    const headers = ['Province', 'Quartier', 'Adresse', 'RG', 'Type', 'N° Facture', 'Montant (Ar)'];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    function formatMontant(valeur) {
      const montant = typeof valeur === 'number' ? valeur : 0;
      return montant.toLocaleString('fr-FR', {
        style: 'decimal',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: true
      }).replace(/\u202F/g, ' ');
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

    // ======== Regrouper par numeroFacture ========
    const groupedPayments = Object.values(
      (batch.payments ?? []).reduce((acc, p) => {
        const key = p.numeroFacture ?? `nofacture-${p.id}`;
        if (!acc[key]) {
          acc[key] = {
            ...p,
            typeCompteur: [p.typeCompteur],
            numeroCompteur: [p.numeroCompteur],
            montant: p.montant ?? 0
          };
        } else {
          acc[key].typeCompteur.push(p.typeCompteur);
          acc[key].numeroCompteur.push(p.numeroCompteur);
          acc[key].montant += p.montant ?? 0;
        }
        return acc;
      }, {})
    );

    const paiementsTries = groupedPayments.sort((a, b) => {
      const q1 = a.compteur.quartier?.toLowerCase() || '';
      const q2 = b.compteur.quartier?.toLowerCase() || '';
      return q1.localeCompare(q2);
    });

    const totalGeneral = paiementsTries.reduce((sum, p) => sum + (p.montant || 0), 0);

    // ======== En-tête PDF ========
    const dateBatch = new Date(batch.date);
    const mois = dateBatch.toLocaleString('fr-FR', { month: 'long' });
    const annee = dateBatch.getFullYear();
    const moisPaiement = batch.moisPaiement || new Date(batch.date).getMonth() + 1;
    const anneePaiement = batch.anneePaiement || new Date(batch.date).getFullYear();

    const nomsMois = [
      'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
    ];
    const nomMois = nomsMois[moisPaiement - 1];

    doc.fontSize(14).font('Helvetica-Bold').text('Note: Département comptabilité Générales ARO', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).text(`OBJET: FACTURE JIRAMA MOIS de ${nomMois.toUpperCase()} ${anneePaiement}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).text("Veuillez émettre à l'ordre de la JIRAMA un chèque de ", { continued: true });
    doc.font('Helvetica-Bold').text(`${formatMontant(totalGeneral)} Ariary`, { continued: true });
    doc.font('Helvetica').text(" en règlement des factures ci-après énumérées.", { align: 'left' });
    doc.moveDown(1.5);

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
    drawVerticalLines(y - 20, y);

    // Contenu du tableau
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
        for (let i = 0; i < 5; i++) { doc.text('', x, y, { width: colWidths[i], align: 'center' }); x += colWidths[i]; }
        doc.font('Helvetica-Bold').text('Sous-total', x, y, { width: colWidths[5], align: 'center' });
        x += colWidths[5];
        doc.text(formatMontant(sousTotal), x, y, { width: colWidths[6], align: 'center' });

        y += 16;
        drawHorizontalLine(y);
        drawVerticalLines(yStartQuartier, y);
        yStartQuartier = y;
        sousTotal = 0;
        doc.font('Helvetica').fontSize(10);
      }

      currentQuartier = quartier;
      sousTotal += p.montant || 0;

      // Ligne du paiement
      y += 4;
      x = startX;
      const cells = [
        c.province || 'N/A',
        quartier,
        c.adresse || '-',
        c.rg || '-',
        p.typeCompteur.join(' / '),
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

    // Dernier sous-total
    y += 4;
    drawHorizontalLine(y);
    y += 4;
    x = startX;
    for (let i = 0; i < 5; i++) { doc.text('', x, y, { width: colWidths[i], align: 'center' }); x += colWidths[i]; }
    doc.font('Helvetica-Bold').text('Sous-total', x, y, { width: colWidths[5], align: 'center' });
    x += colWidths[5];
    doc.text(formatMontant(sousTotal), x, y, { width: colWidths[6], align: 'center' });
    y += 16;
    drawHorizontalLine(y);
    drawVerticalLines(yStartQuartier, y);

    // Total général
    y += 4;
    drawHorizontalLine(y);
    y += 4;
    x = startX;
    for (let i = 0; i < 5; i++) { doc.text('', x, y, { width: colWidths[i], align: 'center' }); x += colWidths[i]; }
    doc.font('Helvetica-Bold').text('TOTAL GÉNÉRAL', x, y, { width: colWidths[5], align: 'center' });
    x += colWidths[5];
    doc.text(formatMontant(totalGeneral), x, y, { width: colWidths[6], align: 'center' });
    y += 16;
    drawHorizontalLine(y);
    drawVerticalLines(yStartQuartier, y);

    function montantEnLettres(montant) {
      const chiffres = [
        '', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
        'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
        'dix-sept', 'dix-huit', 'dix-neuf'
      ];
      const dizaines = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];

      function convertirNombre(n) {
        if (n === 0) return 'zéro';
        if (n < 20) return chiffres[n];
        if (n < 100) {
          let unite = n % 10;
          let dizaine = Math.floor(n / 10);

          // Cas particuliers pour 70, 80, 90
          if ((dizaine === 7 || dizaine === 9) && unite === 0) {
            return dizaines[dizaine];
          }
          if (dizaine === 8 && unite === 0) {
            return dizaines[dizaine] + 's'; // "quatre-vingts"
          }
          if (dizaine === 7 || dizaine === 9) {
            return dizaines[dizaine] + '-' + chiffres[10 + unite];
          }

          // Cas généraux
          let sep = (unite === 1 && dizaine !== 8) ? '-et-' : '-';
          if (unite === 0) return dizaines[dizaine];
          return dizaines[dizaine] + sep + chiffres[unite];
        }
        if (n < 1000) {
          let reste = n % 100;
          let centaine = Math.floor(n / 100);
          let texte = '';

          if (centaine > 1) {
            texte = chiffres[centaine] + ' cent';
            if (reste === 0) texte += 's'; // "deux cents"
          } else {
            texte = 'cent';
          }

          if (reste > 0) {
            texte += ' ' + convertirNombre(reste);
          }
          return texte;
        }

        // Fonction récursive pour les grands nombres
        const echelles = [
          { valeur: 1000000000000, nom: 'billion', pluriel: 'billions' },
          { valeur: 1000000000, nom: 'milliard', pluriel: 'milliards' },
          { valeur: 1000000, nom: 'million', pluriel: 'millions' },
          { valeur: 1000, nom: 'mille', pluriel: 'mille' }
        ];

        for (let echelle of echelles) {
          if (n >= echelle.valeur) {
            let quotient = Math.floor(n / echelle.valeur);
            let reste = n % echelle.valeur;

            let texte = '';
            if (quotient > 1) {
              texte = convertirNombre(quotient) + ' ' + echelle.pluriel;
            } else {
              texte = echelle.nom;
              if (echelle.nom === 'mille') {
                texte = 'mille'; // "mille" reste invariable
              }
            }

            if (reste > 0) {
              // Pour "mille", on ne met pas d'espace supplémentaire si le reste < 100
              if (echelle.valeur === 1000 && reste < 100) {
                texte += ' ';
              } else {
                texte += ' ';
              }
              texte += convertirNombre(reste);
            }

            return texte;
          }
        }

        return 'nombre trop grand';
      }

      const partieEntiere = Math.floor(montant);
      const centimes = Math.round((montant - partieEntiere) * 100);

      let result = convertirNombre(partieEntiere) + ' Ariary';
      if (centimes > 0) {
        result += ' et ' + convertirNombre(centimes) + ' centimes';
      }

      // Mettre la première lettre en majuscule
      return result.charAt(0).toUpperCase() + result.slice(1);
    }

    // ===== Utilisation dans le PDF =====
    y += 20;
    doc.font('Helvetica-Bold').fontSize(12).text(
      `Montant Total : ${montantEnLettres(totalGeneral)}`,
      startX,
      y,
      { align: 'left' }
    );
    y += 30;

    // Signatures
    y += 20;
    const signatures = [
      'Services Etudes et Travaux',
      'Services Administratif et Financiers',
      'Tolotra RANDRIANALAINA',
      'Haingo RAZAFINIAINA'
    ];
    const sigColWidth = tableWidth / 2 + 20;
    doc.font('Helvetica').fontSize(11);
    doc.text(signatures[0], startX, y, { width: sigColWidth, align: 'center' });
    doc.text(signatures[1], startX + sigColWidth + 20, y, { width: sigColWidth, align: 'center' });
    y += 60;
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