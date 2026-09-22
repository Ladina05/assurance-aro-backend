const express = require('express');
const prisma = require('../prismaClient');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

router.post('/', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
  try {
    const { sousCompteurId, numeroFacture, montant, mois, annee } = req.body;

    console.log('Données reçues:', { sousCompteurId, numeroFacture, montant, mois, annee });

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

router.delete('/:id', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
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

module.exports = router;
