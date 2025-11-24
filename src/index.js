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

// Augmenter la limite de taille pour les images base64
app.use(express.json({ limit: '10mb' })); // Augmentez à 10MB
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
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
      include: {
        sousCompteurs: {
          include: {
            factures: {
              where: {
                payee: false // Inclure seulement les factures non payées
              }
            }
          }
        }
      },
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
    const { quartier, localisation, loue, codeImmeuble, codeLocal, nomPropriete, rg, typeBien, province, adresse, sousCompteurs } = req.body;

    const newC = await prisma.compteur.create({
      data: {
        quartier,
        localisation,
        loue: !!loue,
        codeImmeuble,
        codeLocal,
        nomPropriete,
        rg,
        typeBien,
        province,
        adresse,
        // Créer les sous-compteurs seulement s'ils sont fournis et non vides
        sousCompteurs: sousCompteurs && sousCompteurs.length > 0 ? {
          create: sousCompteurs.map(sc => ({
            numeroCompteur: sc.numeroCompteur,
            typeCompteur: sc.typeCompteur || "eau"
          }))
        } : undefined
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
          codeLocal: data.codeLocal,
          nomPropriete: data.nomPropriete,
          rg: data.rg,
          typeBien: data.typeBien,
          province: data.province,
          adresse: data.adresse
        }
      });

      // 2️⃣ Gestion des sous-compteurs avec suppression des factures si nécessaire
      if (Array.isArray(data.sousCompteurs)) {
        // Récupérer les sous-compteurs existants
        const sousCompteursExistants = await tx.sousCompteur.findMany({
          where: { compteurId: id },
          include: { factures: true }
        });

        // Identifier les sous-compteurs à supprimer
        const nouveauxNumeros = data.sousCompteurs.map(sc => sc.numeroCompteur);
        const sousCompteursASupprimer = sousCompteursExistants.filter(sc =>
          !nouveauxNumeros.includes(sc.numeroCompteur)
        );

        // Supprimer d'abord les factures des sous-compteurs à supprimer
        for (const sc of sousCompteursASupprimer) {
          if (sc.factures && sc.factures.length > 0) {
            await tx.facture.deleteMany({
              where: { sousCompteurId: sc.id }
            });
          }
        }

        // Supprimer les sous-compteurs
        await tx.sousCompteur.deleteMany({
          where: {
            id: { in: sousCompteursASupprimer.map(sc => sc.id) }
          }
        });

        // Mettre à jour ou créer les sous-compteurs
        for (const scData of data.sousCompteurs) {
          const sousCompteurExistant = sousCompteursExistants.find(
            sc => sc.numeroCompteur === scData.numeroCompteur
          );

          if (sousCompteurExistant) {
            await tx.sousCompteur.update({
              where: { id: sousCompteurExistant.id },
              data: {
                typeCompteur: scData.typeCompteur || "eau"
              }
            });
          } else {
            await tx.sousCompteur.create({
              data: {
                numeroCompteur: scData.numeroCompteur,
                typeCompteur: scData.typeCompteur || "eau",
                compteurId: id
              }
            });
          }
        }
      }

      // 3️⃣ Retourne le compteur mis à jour
      return tx.compteur.findUnique({
        where: { id },
        include: {
          sousCompteurs: {
            include: {
              factures: true
            }
          }
        }
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
    const { compteurId, numeroCompteur, numeroFacture, montant, moisFacture, anneeFacture } = req.body;
    const newSous = await prisma.sousCompteur.create({
      data: { compteurId, numeroCompteur, numeroFacture, montant, moisFacture, anneeFacture }
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
    const { numeroFacture, montant, moisFacture, anneeFacture } = req.body;
    const updated = await prisma.sousCompteur.update({
      where: { id },
      data: {
        numeroFacture: numeroFacture ?? null,
        montant: montant ?? null,
        moisFacture: moisFacture ?? null,
        anneeFacture: anneeFacture ?? null
      }
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: 'Erreur mise à jour sous-compteur', detail: err.message });
  }
});

// Nouvelle route pour ajouter une facture
app.post('/api/factures', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
  try {
    const { sousCompteurId, numeroFacture, montant, mois, annee } = req.body;

    console.log('Données reçues:', { sousCompteurId, numeroFacture, montant, mois, annee }); // Debug

    const nouvelleFacture = await prisma.facture.create({
      data: {
        sousCompteurId: parseInt(sousCompteurId),
        numeroFacture,
        montant: parseFloat(montant),
        mois: parseInt(mois),
        annee: parseInt(annee)
      },
      include: {
        sousCompteur: {
          include: {
            compteur: true
          }
        }
      }
    });

    res.status(201).json(nouvelleFacture);
  } catch (err) {
    console.error('Erreur création facture:', err);
    res.status(400).json({ message: 'Erreur création facture', detail: err.message });
  }
});

// Route pour supprimer une facture
app.delete('/api/factures/:id', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    await prisma.facture.delete({
      where: { id }
    });

    res.json({ message: 'Facture supprimée' });
  } catch (err) {
    console.error('Erreur suppression facture:', err);
    res.status(400).json({ message: 'Erreur suppression facture', detail: err.message });
  }
});

// Modifier la route GET compteurs pour inclure les factures
app.get('/api/compteurs', authenticate, async (req, res) => {
  try {
    const loueParam = req.query.loue;
    const where = {};
    if (loueParam === 'true') where.loue = true;
    if (loueParam === 'false') where.loue = false;

    const compteurs = await prisma.compteur.findMany({
      where,
      include: {
        sousCompteurs: {
          include: {
            factures: {
              where: {
                payee: false
              }
            }
          }
        }
      },
      orderBy: { id: 'asc' }
    });
    res.json(compteurs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
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
    const { moisPaiement, anneePaiement } = req.body;

    // Récupérer toutes les factures non payées des compteurs non loués
    const factures = await prisma.facture.findMany({
      where: {
        payee: false,
        sousCompteur: {
          compteur: {
            loue: false
          }
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

    if (!factures.length)
      return res.status(400).json({ message: 'Aucune facture à payer' });

    const total = factures.reduce((sum, f) => sum + parseFloat(f.montant), 0);

    const batch = await prisma.$transaction(async (tx) => {
      const newBatch = await tx.paymentBatch.create({
        data: {
          total,
          moisPaiement: moisPaiement || new Date().getMonth() + 1,
          anneePaiement: anneePaiement || new Date().getFullYear()
        }
      });

      // Grouper les factures par numeroFacture pour conserver la logique d'addition
      const facturesGroupes = factures.reduce((acc, facture) => {
        const key = facture.numeroFacture;
        if (!acc[key]) {
          acc[key] = {
            ...facture,
            montant: facture.montant,
            typeCompteur: [facture.sousCompteur.typeCompteur],
            numeroCompteur: [facture.sousCompteur.numeroCompteur],
            compteurId: facture.sousCompteur.compteurId,
            compteur: facture.sousCompteur.compteur
          };
        } else {
          acc[key].montant += facture.montant;
          acc[key].typeCompteur.push(facture.sousCompteur.typeCompteur);
          acc[key].numeroCompteur.push(facture.sousCompteur.numeroCompteur);
        }
        return acc;
      }, {});

      // Créer les paiements groupés
      for (const [numeroFacture, factureGroupe] of Object.entries(facturesGroupes)) {
        await tx.payment.create({
          data: {
            montant: parseFloat(factureGroupe.montant),
            numeroFacture: numeroFacture,
            numeroCompteur: factureGroupe.numeroCompteur.join(' / '),
            typeCompteur: factureGroupe.typeCompteur.join(' / '),
            compteurId: factureGroupe.compteurId,
            batchId: newBatch.id
          }
        });
      }

      // Marquer toutes les factures comme payées
      await tx.facture.updateMany({
        where: {
          id: { in: factures.map(f => f.id) }
        },
        data: {
          payee: true,
          batchId: newBatch.id
        }
      });

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

    // Récupérer le batch avec les factures associées
    const batch = await prisma.paymentBatch.findUnique({
      where: { id },
      include: {
        payments: {
          include: {
            compteur: true
          }
        },
        // Inclure les factures payées dans ce batch
        factures: {
          include: {
            sousCompteur: {
              include: {
                compteur: true
              }
            }
          }
        }
      }
    });

    if (!batch) return res.status(404).json({ message: 'Batch non trouvé' });

    // Si vous avez des factures, utilisez-les pour construire la réponse
    if (batch.factures && batch.factures.length > 0) {
      // Grouper les factures par numéro de facture (comme dans le PDF)
      const groupedPayments = Object.values(
        batch.factures.reduce((acc, facture) => {
          const key = facture.numeroFacture || `nofacture-${facture.id}`;
          if (!acc[key]) {
            acc[key] = {
              id: facture.id,
              numeroFacture: facture.numeroFacture,
              montant: facture.montant,
              mois: facture.mois,
              annee: facture.annee,
              typeCompteur: [facture.sousCompteur.typeCompteur],
              numeroCompteur: [facture.sousCompteur.numeroCompteur],
              compteurId: facture.sousCompteur.compteurId,
              compteur: facture.sousCompteur.compteur
            };
          } else {
            acc[key].montant += facture.montant;
            acc[key].typeCompteur.push(facture.sousCompteur.typeCompteur);
            acc[key].numeroCompteur.push(facture.sousCompteur.numeroCompteur);
          }
          return acc;
        }, {})
      );

      const response = {
        ...batch,
        payments: groupedPayments,
        total: parseFloat(batch.total)
      };

      return res.json(response);
    }

    // Fallback vers l'ancienne méthode si pas de factures
    const paymentsWithFloat = batch.payments.map(p => ({
      ...p,
      montant: parseFloat(p.montant)
    }));

    res.json({ ...batch, payments: paymentsWithFloat, total: parseFloat(batch.total) });
  } catch (err) {
    console.error('Erreur récupération batch:', err);
    res.status(500).json({ message: 'Erreur récupération batch' });
  }
});

// DELETE batch - Admin seulement
app.delete('/api/payment-batches/:id', authenticate, requireRole(['ADMIN']), async (req, res) => {
  try {
    const id = Number(req.params.id);

    await prisma.$transaction(async (tx) => {
      // 1. Récupérer tous les paiements du batch avant suppression
      const payments = await tx.payment.findMany({
        where: { batchId: id },
        select: {
          id: true,
          numeroFacture: true,
          montant: true,
          numeroCompteur: true,
          typeCompteur: true,
          compteurId: true
        }
      });

      // 2. Restaurer les informations dans les sous-compteurs correspondants
      for (const payment of payments) {
        // Trouver le sous-compteur correspondant au numéro de compteur et type
        const sousCompteur = await tx.sousCompteur.findFirst({
          where: {
            numeroCompteur: payment.numeroCompteur,
            typeCompteur: payment.typeCompteur,
            compteurId: payment.compteurId
          }
        });
      }

      // 3. Supprimer les paiements
      await tx.payment.deleteMany({ where: { batchId: id } });

      // 4. Supprimer le batch
      await tx.paymentBatch.delete({ where: { id } });
    });

    res.json({ message: 'Historique supprimé et données restaurées' });
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
      include: {
        factures: {
          include: {
            sousCompteur: {
              include: {
                compteur: true
              }
            }
          }
        }
      }
    });
    if (!batch) return res.status(404).json({ message: 'Batch non trouvé' });

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=batch_${id}.pdf`);
    doc.pipe(res);

    // NOUVELLES COLONNES
    const startX = 15;
    const colWidths = [90, 80, 80, 80, 75, 100, 80];
    const headers = ['Propriété', 'Localisation', 'RG', 'Type', 'Mois/Année', 'N° Facture', 'Montant (Ar)'];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    const BASE_LINE_HEIGHT = 16;
    const EXTRA_HEIGHT_PER_LINE = 8;
    const SIGNATURES_HEIGHT_NEEDED = 150;
    const MIN_SPACE_FOR_CONTENT = 200; // Espace minimum requis avant de forcer un saut de page

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

    function checkPageBreak(neededHeight, forceSignaturePage = false) {
      const currentY = doc.y;
      const pageHeight = doc.page.height;
      const bottomMargin = 60;

      // Si on veut forcer les signatures sur la même page
      if (forceSignaturePage) {
        if (currentY + neededHeight > pageHeight - bottomMargin) {
          doc.addPage();
          return true;
        }
        return false;
      }

      // Vérifier s'il reste suffisamment d'espace pour le contenu + signatures
      const remainingSpace = pageHeight - currentY - bottomMargin;
      
      // Si l'espace restant est insuffisant pour le contenu OU s'il reste trop peu d'espace pour être utile
      if (currentY + neededHeight > pageHeight - bottomMargin || 
          remainingSpace < MIN_SPACE_FOR_CONTENT) {
        doc.addPage();
        return true;
      }
      return false;
    }

    function drawTableHeaders() {
      const y = doc.y + 10;

      doc.font('Helvetica-Bold').fontSize(11);
      drawHorizontalLine(y);
      let x = startX;
      headers.forEach((h, i) => {
        doc.text(h, x, y + 8, { width: colWidths[i], align: 'center' });
        x += colWidths[i];
      });
      doc.y = y + 25;
      drawHorizontalLine(doc.y);
      drawVerticalLines(y, doc.y);

      doc.font('Helvetica').fontSize(10);
      return doc.y;
    }

    function getCellHeight(text, columnIndex) {
      const maxWidth = colWidths[columnIndex] - 4;
      const lines = doc.heightOfString(text, {
        width: maxWidth,
        align: 'center'
      }) / BASE_LINE_HEIGHT;

      return Math.max(1, Math.ceil(lines)) * BASE_LINE_HEIGHT + EXTRA_HEIGHT_PER_LINE;
    }

    function getRowHeight(cells) {
      let maxHeight = BASE_LINE_HEIGHT;
      cells.forEach((text, i) => {
        const cellHeight = getCellHeight(text, i);
        if (cellHeight > maxHeight) {
          maxHeight = cellHeight;
        }
      });
      return maxHeight;
    }

    // ======== Logique de regroupement par numéro de facture ========
    const facturesGroupes = Object.values(
      (batch.factures ?? []).reduce((acc, f) => {
        const key = f.numeroFacture ?? `nofacture-${f.id}`;
        if (!acc[key]) {
          acc[key] = {
            ...f,
            typeCompteur: [f.sousCompteur.typeCompteur],
            numeroCompteur: [f.sousCompteur.numeroCompteur],
            montant: f.montant ?? 0,
            compteur: f.sousCompteur.compteur,
            mois: f.mois,
            annee: f.annee
          };
        } else {
          acc[key].typeCompteur.push(f.sousCompteur.typeCompteur);
          acc[key].numeroCompteur.push(f.sousCompteur.numeroCompteur);
          acc[key].montant += f.montant ?? 0;
        }
        return acc;
      }, {})
    );

    // Trier par propriété
    const paiementsTries = facturesGroupes.sort((a, b) => {
      const p1 = a.compteur.nomPropriete?.toLowerCase() || '';
      const p2 = b.compteur.nomPropriete?.toLowerCase() || '';
      return p1.localeCompare(p2);
    });

    const totalGeneral = paiementsTries.reduce((sum, p) => sum + (p.montant || 0), 0);

    // ======== En-tête PDF ========
    const dateBatch = new Date(batch.date);
    const moisPaiementBatch = batch.moisPaiement || new Date(batch.date).getMonth() + 1;
    const anneePaiementBatch = batch.anneePaiement || new Date(batch.date).getFullYear();

    const nomsMois = [
      'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
    ];
    const nomMois = nomsMois[moisPaiementBatch - 1];

    doc.fontSize(14).font('Helvetica-Bold').text('Note: Département comptabilité Générales ARO', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).text(`OBJET: FACTURE JIRAMA MOIS de ${nomMois.toUpperCase()} ${anneePaiementBatch}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).text("Veuillez émettre à l'ordre de la JIRAMA un chèque de ", { continued: true });
    doc.font('Helvetica-Bold').text(`${formatMontant(totalGeneral)} Ariary`, { continued: true });
    doc.font('Helvetica').text(" en règlement des factures ci-après énumérées.", { align: 'left' });
    doc.moveDown(1.5);

    // ======== Tableau ========
    let y = drawTableHeaders();

    let currentPropriete = null;
    let sousTotal = 0;
    let yStartPropriete = y;
    let isNewPage = false;

    for (let i = 0; i < paiementsTries.length; i++) {
      const p = paiementsTries[i];
      const c = p.compteur;
      const propriete = c.nomPropriete || 'Non défini';

      const nomMoisFacture = nomsMois[p.mois - 1] || 'Mois inconnu';

      const cells = [
        propriete,
        c.localisation || '-',
        c.rg || '-',
        Array.isArray(p.typeCompteur) ? p.typeCompteur.join(' / ') : p.typeCompteur || '-',
        `${nomMoisFacture} ${p.annee}`,
        p.numeroFacture || 'N/A',
        formatMontant(p.montant)
      ];

      const rowHeight = getRowHeight(cells);

      // Vérifier s'il faut afficher le sous-total par propriété
      if (currentPropriete && currentPropriete !== propriete) {
        if (checkPageBreak(30)) {
          y = drawTableHeaders();
          yStartPropriete = y;
          isNewPage = true;
        }

        if (!isNewPage) {
          y += 6;
          drawHorizontalLine(y);
          y += 6;
          let x = startX;

          for (let j = 0; j < 5; j++) {
            doc.text('', x, y, { width: colWidths[j], align: 'center' });
            x += colWidths[j];
          }

          doc.font('Helvetica-Bold');
          doc.text(`Sous-total`, x, y, { width: colWidths[5], align: 'center' });
          x += colWidths[5];
          doc.text(formatMontant(sousTotal), x, y, { width: colWidths[6], align: 'center' });
          doc.font('Helvetica');

          y += 20;
          drawHorizontalLine(y);
          drawVerticalLines(yStartPropriete, y);
        } else {
          sousTotal = 0;
        }

        yStartPropriete = y;
        sousTotal = 0;
        isNewPage = false;
      }

      // Vérification optimisée du saut de page
      if (checkPageBreak(rowHeight)) {
        y = drawTableHeaders();
        yStartPropriete = y;
        isNewPage = true;
      }

      currentPropriete = propriete;
      sousTotal += p.montant || 0;

      // Ligne du paiement groupé
      y += 6;
      let x = startX;

      cells.forEach((text, i) => {
        doc.text(text, x, y + (rowHeight - BASE_LINE_HEIGHT) / 2, {
          width: colWidths[i],
          align: 'center',
          height: rowHeight
        });
        x += colWidths[i];
      });

      y += rowHeight;
      drawHorizontalLine(y);
      drawVerticalLines(y - rowHeight - 6, y);
    }

    // Afficher le dernier sous-total
    if (currentPropriete) {
      if (checkPageBreak(30)) {
        y = drawTableHeaders();
        yStartPropriete = y;
      }

      y += 6;
      drawHorizontalLine(y);
      y += 6;
      let x = startX;

      for (let i = 0; i < 5; i++) {
        doc.text('', x, y, { width: colWidths[i], align: 'center' });
        x += colWidths[i];
      }

      doc.font('Helvetica-Bold');
      doc.text(`Sous-total `, x, y, { width: colWidths[5], align: 'center' });
      x += colWidths[5];
      doc.text(formatMontant(sousTotal), x, y, { width: colWidths[6], align: 'center' });
      doc.font('Helvetica');

      y += 20;
      drawHorizontalLine(y);
      drawVerticalLines(yStartPropriete, y);
    }

    // Total général
    const yStartTotal = y;
    y += 6;
    drawHorizontalLine(y);
    y += 6;
    let x = startX;

    for (let i = 0; i < 5; i++) {
      doc.text('', x, y, { width: colWidths[i], align: 'center' });
      x += colWidths[i];
    }

    doc.font('Helvetica-Bold');
    doc.text('TOTAL GÉNÉRAL', x, y, { width: colWidths[5], align: 'center' });
    x += colWidths[5];
    doc.text(formatMontant(totalGeneral), x, y, { width: colWidths[6], align: 'center' });
    doc.font('Helvetica');

    y += 20;
    drawHorizontalLine(y);
    drawVerticalLines(yStartTotal, y);

    // Vérification FORCÉE pour s'assurer que les signatures sont sur la même page
    checkPageBreak(SIGNATURES_HEIGHT_NEEDED, true);

    function montantEnLettres(montant) {
      const chiffres = [
        '', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
        'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
        'dix-sept', 'dix-huit', 'dix-neuf'
      ];
      const dizaines = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];

      function convertirNombre(n, estCentime = false) {
        if (n === 0) return 'zéro';
        if (n < 20) return chiffres[n];
        if (n < 100) {
          let unite = n % 10;
          let dizaine = Math.floor(n / 10);

          if ((dizaine === 7 || dizaine === 9) && unite === 0) {
            return dizaines[dizaine];
          }
          if (dizaine === 8 && unite === 0) {
            return dizaines[dizaine] + 's';
          }
          if (dizaine === 7 || dizaine === 9) {
            return dizaines[dizaine] + '-' + chiffres[10 + unite];
          }

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
            if (reste === 0) texte += 's';
          } else {
            texte = 'cent';
          }

          if (reste > 0) {
            texte += ' ' + convertirNombre(reste);
          }
          return texte;
        }

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
            if (quotient >= 1) {
              texte = convertirNombre(quotient) + ' ' + (quotient > 1 ? echelle.pluriel : echelle.nom);
            } else {
              texte = echelle.nom;
            }

            if (reste > 0) {
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
        let centimesTexte;
        if (centimes < 10) {
          centimesTexte = 'zéro ' + convertirNombre(centimes);
        } else {
          centimesTexte = convertirNombre(centimes);
        }

        result += ' ' + centimesTexte;
      }

      return result.charAt(0).toUpperCase() + result.slice(1);
    }

    // ===== Montant en lettres =====
    y += 17;
    doc.font('Helvetica-Bold').fontSize(12).text(
      `Montant Total : ${montantEnLettres(totalGeneral)}`,
      startX,
      y,
      { align: 'left' }
    );
    y += 25;

    // ===== SIGNATURES =====
    // Pas besoin de vérifier le saut de page ici car déjà fait avec forceSignaturePage
    y += 40;

    const signatures = [
      'Services Etudes et Travaux',
      'Responsable Administratif et Financier',
      'Tolotra RANDRIANALAINA',
      'Haingo RAZAFINIAINA'
    ];

    const sigColWidth = tableWidth / 2 + 20;
    doc.font('Helvetica').fontSize(11);

    // Première ligne de signatures
    doc.text(signatures[0], startX, y, { width: sigColWidth, align: 'center' });
    doc.text(signatures[1], startX + sigColWidth + 20, y, { width: sigColWidth, align: 'center' });

    // Deuxième ligne de signatures
    y += 80;
    doc.text(signatures[2], startX, y, { width: sigColWidth, align: 'center' });
    doc.text(signatures[3], startX + sigColWidth + 20, y, { width: sigColWidth, align: 'center' });

    doc.end();

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur PDF', detail: err.message });
  }
});

/* ===============================
   🔹 Statistiques d'évolution des paiements
================================= */

// GET statistiques d'évolution par compteur et année
app.get('/api/statistiques/evolution', authenticate, async (req, res) => {
  try {
    const { rg, annee } = req.query;

    if (!rg || !annee) {
      return res.status(400).json({
        message: 'Le RG du compteur et l\'année sont requis'
      });
    }

    // Vérifier que le compteur existe
    const compteur = await prisma.compteur.findFirst({
      where: { rg: rg.toString() }
    });

    if (!compteur) {
      return res.status(404).json({
        message: 'Compteur non trouvé avec ce RG'
      });
    }

    // Récupérer toutes les factures payées pour ce compteur sur l'année demandée
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
        },
        batch: true
      }
    });

    // Grouper par mois et calculer les sommes
    const statistiquesMois = {};

    // Initialiser tous les mois de l'année
    for (let mois = 1; mois <= 12; mois++) {
      statistiquesMois[mois] = {
        mois: mois,
        nomMois: new Date(parseInt(annee), mois - 1, 1).toLocaleString('fr-FR', { month: 'long' }),
        montant: 0
      };
    }

    // Calculer les montants par mois de facture
    factures.forEach(facture => {
      const mois = facture.mois; // Utiliser le mois de la facture
      if (mois >= 1 && mois <= 12) {
        statistiquesMois[mois].montant += parseFloat(facture.montant || 0);
      }
    });

    // Convertir en tableau et formater
    const resultat = Object.values(statistiquesMois).map(item => ({
      mois: item.mois,
      nomMois: item.nomMois.charAt(0).toUpperCase() + item.nomMois.slice(1),
      montant: parseFloat(item.montant.toFixed(2))
    }));

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
      totalAnnuel: parseFloat(resultat.reduce((sum, item) => sum + item.montant, 0).toFixed(2))
    });

  } catch (err) {
    console.error('Erreur statistiques évolution:', err);
    res.status(500).json({
      message: 'Erreur lors du calcul des statistiques',
      detail: err.message
    });
  }
});

/* ===============================
   🔹 Statistiques générales des paiements
================================= */

// GET statistiques générales par année
app.get('/api/statistiques/general', authenticate, async (req, res) => {
  try {
    const { annee } = req.query;
    const anneeCourante = annee ? parseInt(annee) : new Date().getFullYear();

    // Récupérer toutes les factures payées de l'année
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

    // Grouper par mois et calculer les sommes
    const statistiquesMois = {};

    // Initialiser tous les mois de l'année
    for (let mois = 1; mois <= 12; mois++) {
      statistiquesMois[mois] = {
        mois: mois,
        nomMois: new Date(anneeCourante, mois - 1, 1).toLocaleString('fr-FR', { month: 'long' }),
        montant: 0,
        nombreFactures: 0
      };
    }

    // Calculer les montants par mois de facture
    factures.forEach(facture => {
      const mois = facture.mois; // Utiliser le mois de la facture
      if (mois >= 1 && mois <= 12) {
        statistiquesMois[mois].montant += parseFloat(facture.montant || 0);
        statistiquesMois[mois].nombreFactures += 1;
      }
    });

    // Convertir en tableau et formater
    const resultat = Object.values(statistiquesMois).map(item => ({
      mois: item.mois,
      nomMois: item.nomMois.charAt(0).toUpperCase() + item.nomMois.slice(1),
      montant: parseFloat(item.montant.toFixed(2)),
      nombrePaiements: item.nombreFactures
    }));

    // Calculer les totaux
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

/* ===============================
   🔹 Export Excel et PDF pour l'évolution
================================= */

// GET export Excel pour l'évolution
app.get('/api/statistiques/evolution/export-excel', authenticate, async (req, res) => {
  try {
    const { rg, annee } = req.query;

    if (!rg || !annee) {
      return res.status(400).json({
        message: 'Le RG du compteur et l\'année sont requis'
      });
    }

    // Récupérer les données (même logique que la route statistiques/evolution)
    const compteur = await prisma.compteur.findFirst({
      where: { rg: rg.toString() }
    });

    if (!compteur) {
      return res.status(404).json({
        message: 'Compteur non trouvé avec ce RG'
      });
    }

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

    // Calculer les statistiques par mois
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

    // Créer le workbook Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Évolution des paiements');

    // Titre du fichier
    const titre = `Évolution des paiements - ${compteur.quartier} - ${compteur.nomPropriete} - RG: ${compteur.rg} - Année: ${annee}`;

    // Ajouter le titre
    worksheet.mergeCells('A1:B1');
    worksheet.getCell('A1').value = titre;
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

    // En-têtes du tableau
    worksheet.addRow(['Mois', 'Montant payé (Ar)']);

    // Style des en-têtes
    const headerRow = worksheet.getRow(2);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8F5E8' }
    };

    // Données
    resultat.forEach(stat => {
      worksheet.addRow([stat.nomMois, stat.montant]);
    });

    // Total annuel
    worksheet.addRow(['TOTAL ANNÉE', totalAnnuel]);
    const totalRow = worksheet.getRow(resultat.length + 3);
    totalRow.font = { bold: true };
    totalRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD4EDDA' }
    };

    // Style des colonnes
    worksheet.columns = [
      { width: 20 },
      { width: 25 }
    ];

    // Générer le fichier
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

// GET export PDF pour l'évolution
app.get('/api/statistiques/evolution/export-pdf', authenticate, async (req, res) => {
  try {
    const { rg, annee } = req.query;

    if (!rg || !annee) {
      return res.status(400).json({
        message: 'Le RG du compteur et l\'année sont requis'
      });
    }

    // Récupérer les données (même logique que la route statistiques/evolution)
    const compteur = await prisma.compteur.findFirst({
      where: { rg: rg.toString() }
    });

    if (!compteur) {
      return res.status(404).json({
        message: 'Compteur non trouvé avec ce RG'
      });
    }

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

    // Calculer les statistiques par mois
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

    // Créer le PDF
    const doc = new PDFDocument({ margin: 40 });

    // En-tête du fichier
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=evolution_paiements_${compteur.rg}_${annee}.pdf`);

    doc.pipe(res);

    // Titre
    const titre = `Évolution des paiements - Année ${annee}`;
    const sousTitre = `${compteur.quartier} - ${compteur.nomPropriete} - RG: ${compteur.rg}`;

    doc.fontSize(18).font('Helvetica-Bold').text(titre, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica').text(sousTitre, { align: 'center' });
    doc.moveDown(1);

    // Configuration du tableau
    const startX = 50;
    const colWidths = [200, 150];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    const rowHeight = 25;
    const headerHeight = 30;

    // Position de départ du tableau
    let yPosition = doc.y;

    // Dessiner le cadre du tableau
    doc.rect(startX, yPosition, tableWidth, headerHeight).stroke();
    doc.rect(startX, yPosition + headerHeight, tableWidth, rowHeight * (resultat.length + 1)).stroke();

    // En-têtes du tableau avec fond coloré
    doc.rect(startX, yPosition, colWidths[0], headerHeight).fillAndStroke('#f8f9fa', '#000');
    doc.rect(startX + colWidths[0], yPosition, colWidths[1], headerHeight).fillAndStroke('#f8f9fa', '#000');

    doc.fontSize(10).font('Helvetica-Bold');
    doc.fillColor('#000');
    doc.text('Mois', startX + 10, yPosition + 10, { width: colWidths[0] - 20, align: 'left' });
    doc.text('Montant payé (Ar)', startX + colWidths[0] + 10, yPosition + 10, { width: colWidths[1] - 20, align: 'right' });

    yPosition += headerHeight;

    // Données du tableau
    doc.fontSize(10).font('Helvetica');

    resultat.forEach((stat, index) => {
      // Ligne de séparation horizontale
      doc.moveTo(startX, yPosition).lineTo(startX + tableWidth, yPosition).stroke();

      // Ligne de séparation verticale
      doc.moveTo(startX + colWidths[0], yPosition).lineTo(startX + colWidths[0], yPosition + rowHeight).stroke();

      // Contenu des cellules
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

    // Ligne de séparation avant le total
    doc.moveTo(startX, yPosition).lineTo(startX + tableWidth, yPosition).stroke();

    // Cellule du total
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

    // Dernière ligne de séparation
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

// Fonction utilitaire pour formater les montants
function formatMontantFR(montant) {
  if (montant == null) return "-";
  return montant.toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true
  }).replace(/\u202F/g, ' ') + " Ar";
}

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