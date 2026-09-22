const express = require('express');
const path = require('path');
const fs = require('fs');
const prisma = require('../prismaClient');
const { authenticate, requireRole } = require('../middleware/auth');
const { upload, uploadDir } = require('../config/upload');
const { writeBatchPdf } = require('../utils/batchPdf');

const router = express.Router();

router.post('/:id/cheque', authenticate, requireRole(['ADMIN', 'INSERTEUR']), upload.single('cheque'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.file) return res.status(400).json({ message: 'Fichier manquant' });

    const updated = await prisma.paymentBatch.update({
      where: { id },
      data: { chequePdf: req.file.filename }
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur upload chèque', detail: err.message });
  }
});

router.get('/:id/cheque', authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({ where: { id } });
    if (!batch || !batch.chequePdf) return res.status(404).json({ message: 'Chèque non trouvé' });

    const filePath = path.join(uploadDir, batch.chequePdf);
    res.download(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur téléchargement chèque', detail: err.message });
  }
});

router.delete('/:id/cheque', authenticate, requireRole(['ADMIN']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({ where: { id } });
    if (!batch || !batch.chequePdf) return res.status(404).json({ message: 'Chèque non trouvé' });

    const filePath = path.join(uploadDir, batch.chequePdf);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await prisma.paymentBatch.update({ where: { id }, data: { chequePdf: null } });
    res.json({ message: 'Chèque supprimé' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur suppression chèque', detail: err.message });
  }
});

router.post('/:id/recu', authenticate, requireRole(['ADMIN', 'INSERTEUR']), upload.single('recu'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.file) return res.status(400).json({ message: 'Fichier manquant' });

    const updated = await prisma.paymentBatch.update({
      where: { id },
      data: { recuPdf: req.file.filename }
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur upload reçu', detail: err.message });
  }
});

router.get('/:id/recu', authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({ where: { id } });
    if (!batch || !batch.recuPdf) return res.status(404).json({ message: 'Reçu non trouvé' });

    const filePath = path.join(uploadDir, batch.recuPdf);
    res.download(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur téléchargement reçu', detail: err.message });
  }
});

router.delete('/:id/recu', authenticate, requireRole(['ADMIN']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({ where: { id } });
    if (!batch || !batch.recuPdf) return res.status(404).json({ message: 'Reçu non trouvé' });

    const filePath = path.join(uploadDir, batch.recuPdf);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await prisma.paymentBatch.update({ where: { id }, data: { recuPdf: null } });
    res.json({ message: 'Reçu supprimé' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur suppression reçu', detail: err.message });
  }
});

router.get('/:id/pdf', authenticate, writeBatchPdf);

router.post('/', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
  try {
    const { moisPaiement, anneePaiement } = req.body;

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

router.get('/', authenticate, async (req, res) => {
  try {
    const batches = await prisma.paymentBatch.findMany({ orderBy: { date: 'desc' } });
    res.json(batches);
  } catch (err) {
    res.status(500).json({ message: 'Erreur récupération historique' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const batch = await prisma.paymentBatch.findUnique({
      where: { id },
      include: {
        payments: {
          include: {
            compteur: true
          }
        },
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

    if (batch.factures && batch.factures.length > 0) {
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

router.delete('/:id', authenticate, requireRole(['ADMIN']), async (req, res) => {
  try {
    const id = Number(req.params.id);

    await prisma.$transaction(async (tx) => {
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

      for (const payment of payments) {
        await tx.sousCompteur.findFirst({
          where: {
            numeroCompteur: payment.numeroCompteur,
            typeCompteur: payment.typeCompteur,
            compteurId: payment.compteurId
          }
        });
      }

      await tx.payment.deleteMany({ where: { batchId: id } });
      await tx.paymentBatch.delete({ where: { id } });
    });

    res.json({ message: 'Historique supprimé et données restaurées' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur suppression batch', detail: err.message });
  }
});

module.exports = router;
